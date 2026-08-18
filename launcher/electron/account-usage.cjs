// Per-account ChatGPT rate-limit usage, ported from Codex Switcher Plus
// (src-tauri/src/api/usage.rs: send_chatgpt_warmup_request / build_chatgpt_headers /
// extract_rate_limits / RateLimitWindow / RateLimitDetails).
//
// CRITICAL: this module must never refresh tokens. ~/.codex-switcher/accounts.json is owned by
// Codex Switcher Plus; we only ever read it (via accounts.cjs). ChatGPT refresh tokens are
// single-use and rotate on every refresh. If this module refreshed a token, the rotated value
// would not be written back to accounts.json, so that account's stored refresh_token would go
// stale -- and the NEXT account switch would write the now-dead token into ~/.codex/auth.json,
// breaking that account's login with refresh_token_reused 401s. So: use the stored access_token
// as-is, and on 401/403 report usage as unavailable. Never retry with a refreshed token.
const { readAccountChatGptAuth } = require("./accounts.cjs");

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CODEX_RESPONSES_URL = `${CHATGPT_ORIGIN}/backend-api/codex/responses`;
const DEFAULT_TIMEOUT_MS = 10_000;

// Matches the reference implementation's window-length constants exactly, so the same
// primary/secondary swap heuristic below stays correct if the backend ever reorders the windows.
const SESSION_WINDOW_SECONDS = 5 * 60 * 60;
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

// A browser-like User-Agent, mirroring the reference client, so Cloudflare does not flag this
// request as a bot and return a challenge page instead of the real response.
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// The smallest request that still reaches the Codex responses pipeline and gets a rate_limit
// payload back. stream: false and max_output_tokens: 1 keep the round trip and the account's
// token spend both minimal -- this call exists to read rate-limit metadata, not to chat.
const WARMUP_PAYLOAD = Object.freeze({
  model: "gpt-5.1-codex-mini",
  instructions: "You are Codex.",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Hi" }],
    },
  ],
  tools: [],
  tool_choice: "auto",
  parallel_tool_calls: false,
  reasoning: { effort: "low" },
  store: false,
  stream: false,
  max_output_tokens: 1,
});

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function buildChatGptHeaders(accessToken, chatgptAccountId) {
  const headers = {
    "user-agent": BROWSER_USER_AGENT,
    authorization: `Bearer ${accessToken}`,
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    origin: CHATGPT_ORIGIN,
    referer: CHATGPT_ORIGIN,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  if (nonEmptyString(chatgptAccountId)) headers["chatgpt-account-id"] = chatgptAccountId;
  return headers;
}

// Parses one raw `primary_window`/`secondary_window` entry. Anything that is not an object, or
// that lacks a numeric used_percent, is not a usable window -- return null rather than guessing.
function parseRawWindow(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!isFiniteNumber(raw.used_percent)) return null;
  return {
    usedPercent: raw.used_percent,
    limitWindowSeconds: isFiniteNumber(raw.limit_window_seconds) ? raw.limit_window_seconds : null,
    resetAt: isFiniteNumber(raw.reset_at) ? raw.reset_at : null,
  };
}

function isSessionWindow(window) {
  return window?.limitWindowSeconds === SESSION_WINDOW_SECONDS;
}

function isWeeklyWindow(window) {
  return window?.limitWindowSeconds === WEEKLY_WINDOW_SECONDS;
}

// Same swap heuristic as the reference `extract_rate_limits`: the backend can temporarily omit
// one window and promote the other into `primary_window`, or hand the two windows back in the
// wrong slots. Restore "primary is always the session/short window, secondary is always weekly"
// so every caller can rely on that meaning regardless of what the backend actually sent.
function extractRateLimitWindows(rateLimit) {
  if (!rateLimit || typeof rateLimit !== "object") return { primary: null, secondary: null };
  const primary = parseRawWindow(rateLimit.primary_window);
  const secondary = parseRawWindow(rateLimit.secondary_window);

  if (primary && !secondary && isWeeklyWindow(primary)) return { primary: null, secondary: primary };
  if (!primary && secondary && isSessionWindow(secondary)) return { primary: secondary, secondary: null };
  if (primary && secondary && isWeeklyWindow(primary) && isSessionWindow(secondary)) {
    return { primary: secondary, secondary: primary };
  }
  return { primary, secondary };
}

function toPublicWindow(window) {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    windowMinutes: window.limitWindowSeconds !== null ? Math.ceil(window.limitWindowSeconds / 60) : null,
    resetsAt: window.resetAt,
  };
}

// Pure normalizer: takes whatever JSON body the codex/responses warm-up call returned (which may
// be missing `rate_limit` entirely, or malformed in any way) and produces the small plain shape
// the renderer displays. Never throws -- a payload this function cannot make sense of just comes
// back with null windows, exactly like a payload with no rate_limit at all.
function normalizeRateLimitPayload(payload) {
  const isObject = payload !== null && typeof payload === "object" && !Array.isArray(payload);
  const rateLimit = isObject ? payload.rate_limit : null;
  const { primary, secondary } = extractRateLimitWindows(rateLimit);
  const planType = isObject && nonEmptyString(payload.plan_type) ? payload.plan_type : null;
  return {
    planType,
    primary: toPublicWindow(primary),
    secondary: toPublicWindow(secondary),
  };
}

function unavailable(accountId, reason) {
  return {
    accountId,
    available: false,
    reason,
    planType: null,
    primary: null,
    secondary: null,
  };
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fetches and normalizes rate-limit usage for one Codex Switcher Plus account. Always resolves --
// including on a missing account, a network failure/timeout, a non-2xx response, or invalid JSON
// -- with an `available: false` result carrying a short human-readable `reason`. This function
// never throws and never retries with a refreshed token; see the module header for why.
async function fetchAccountUsage(accountId, {
  accountsPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger,
  fetchImpl = fetch,
} = {}) {
  if (typeof accountId !== "string" || !accountId) {
    return unavailable(accountId, "Account id is required");
  }

  let auth;
  try {
    auth = readAccountChatGptAuth(accountId, accountsPath);
  } catch (error) {
    logger?.error?.("account_usage.read_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return unavailable(accountId, "Could not read the stored ChatGPT account");
  }
  if (!auth) return unavailable(accountId, "This account does not use ChatGPT sign-in");

  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, CODEX_RESPONSES_URL, {
      method: "POST",
      headers: buildChatGptHeaders(auth.accessToken, auth.chatgptAccountId),
      body: JSON.stringify(WARMUP_PAYLOAD),
    }, timeoutMs);
  } catch (error) {
    // Covers both network failures and the AbortController timeout above. Never logs the
    // request/response body or headers -- only that the attempt failed.
    logger?.warn?.("account_usage.request_failed", {
      accountId,
      message: error instanceof Error ? error.message : String(error),
    });
    return unavailable(accountId, "The ChatGPT usage request failed or timed out");
  }

  if (response.status === 401 || response.status === 403) {
    // Genuinely expired/rejected token. Reporting "unavailable" here -- and never attempting a
    // refresh -- is the whole point of this module; see the header comment.
    logger?.warn?.("account_usage.unauthorized", { accountId, status: response.status });
    return unavailable(accountId, "The stored ChatGPT session for this account is no longer valid");
  }
  if (!response.ok) {
    logger?.warn?.("account_usage.error_status", { accountId, status: response.status });
    return unavailable(accountId, `ChatGPT usage request returned status ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    logger?.warn?.("account_usage.invalid_json", { accountId });
    return unavailable(accountId, "The ChatGPT usage response could not be parsed");
  }

  const normalized = normalizeRateLimitPayload(payload);
  return { accountId, available: true, reason: null, ...normalized };
}

module.exports = {
  CODEX_RESPONSES_URL,
  SESSION_WINDOW_SECONDS,
  WEEKLY_WINDOW_SECONDS,
  buildChatGptHeaders,
  fetchAccountUsage,
  normalizeRateLimitPayload,
};
