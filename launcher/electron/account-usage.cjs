// Per-account ChatGPT rate-limit usage.
//
// This was originally ported from Codex Switcher Plus's Rust reference
// (src-tauri/src/api/usage.rs: send_chatgpt_warmup_request / build_chatgpt_headers /
// extract_rate_limits / RateLimitWindow / RateLimitDetails), but that reference is now OUT OF
// DATE relative to the live ChatGPT backend and must not be treated as the source of truth:
//   - The model name it used (gpt-5.1-codex-mini) is now rejected by the API for ChatGPT accounts.
//   - `stream: false` is now rejected outright ("Stream must be set to true").
//   - With the correct model and streaming enabled, the response body no longer carries a
//     `rate_limit` JSON object at all -- every rate-limit field now arrives as a response HEADER
//     (see `normalizeUsageHeaders` below for the exact set).
//
// CRITICAL: this module must never refresh tokens. ~/.codex-switcher/accounts.json is owned by
// Codex Switcher Plus, an app that is no longer installed on this machine; we only ever read it
// (via accounts.cjs), and any token stored there just ages out over time since nothing refreshes
// it. ChatGPT refresh tokens are single-use and rotate on every refresh: if this module refreshed
// one, the rotated value would not be written back to accounts.json, so that account's stored
// refresh_token would go stale -- and the NEXT account switch would write the now-dead token into
// ~/.codex/auth.json, breaking that account's login with refresh_token_reused 401s. So: use
// whichever access_token accounts.cjs's resolveAccountChatGptAuth hands back as-is (it prefers the
// continuously-refreshed ~/.codex/auth.json when that file currently belongs to this account, and
// otherwise falls back to the stored, possibly-stale token), and on 401/403 report usage as
// unavailable. Never retry with a refreshed token.
const { resolveAccountChatGptAuth } = require("./accounts.cjs");

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CODEX_RESPONSES_URL = `${CHATGPT_ORIGIN}/backend-api/codex/responses`;
const DEFAULT_TIMEOUT_MS = 10_000;

// A browser-like User-Agent, mirroring the reference client, so Cloudflare does not flag this
// request as a bot and return a challenge page instead of the real response.
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// The smallest request that still reaches the Codex responses pipeline and gets rate-limit
// headers back. `stream: true` is mandatory (the API rejects `false` with "Stream must be set to
// true"). `max_output_tokens` is deliberately absent -- the API now rejects it outright
// ("Unsupported parameter: max_output_tokens") -- so nothing here bounds how much the model could
// produce. That is fine: we never read the streamed body (see `abortResponseBody`), so the
// account is never charged for output nobody downloads, regardless of how much the model queues
// up before we cancel the stream.
const WARMUP_PAYLOAD = Object.freeze({
  model: "gpt-5.4-mini",
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
  stream: true,
});

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function buildChatGptHeaders(accessToken, chatgptAccountId) {
  const headers = {
    "user-agent": BROWSER_USER_AGENT,
    authorization: `Bearer ${accessToken}`,
    accept: "text/event-stream",
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

// Reads one header value regardless of whether `headers` is a real Fetch `Headers` object (which
// exposes `.get`) or a plain object (as used by the unit tests). Always case-insensitive, since
// HTTP header names are. Returns null for anything that is not a usable string -- never throws.
function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    try {
      const value = headers.get(name);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }
  if (typeof headers === "object") {
    const lowerName = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== lowerName) continue;
      const value = headers[key];
      return typeof value === "string" ? value : null;
    }
  }
  return null;
}

// Parses one header's text as a finite number. An absent header, an empty/whitespace-only string
// (the API's way of signalling "no secondary window" on `x-codex-secondary-reset-at`), or any
// non-numeric garbage all resolve to null rather than to 0 or NaN -- callers must be able to tell
// "no value" apart from "the value is zero".
function readNumericHeader(headers, name) {
  const raw = readHeader(headers, name);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// One rate-limit window (primary/session or secondary/weekly) from its three headers. The API
// signals "this window does not apply right now" two ways -- an empty-string `*-reset-at`, or a
// zero `*-window-minutes` -- either of which must produce a null window here, not a window that
// falsely reports 0% used. A missing/garbage `*-used-percent` is just as unusable, so it also
// yields null.
function readUsageWindow(headers, prefix) {
  const usedPercent = readNumericHeader(headers, `x-codex-${prefix}-used-percent`);
  const windowMinutes = readNumericHeader(headers, `x-codex-${prefix}-window-minutes`);
  const resetsAt = readNumericHeader(headers, `x-codex-${prefix}-reset-at`);
  if (usedPercent === null || windowMinutes === null || windowMinutes <= 0 || resetsAt === null) {
    return null;
  }
  return { usedPercent, windowMinutes, resetsAt };
}

// Pure normalizer: takes the response headers from the codex/responses warm-up call (a plain
// object, a Headers-like object with `.get`, or anything else) and produces the small plain shape
// the renderer displays. Never throws -- headers this function cannot make sense of just come
// back as null windows / null plan type, exactly like a response with none of these headers set.
function normalizeUsageHeaders(headers) {
  const planTypeRaw = readHeader(headers, "x-codex-plan-type");
  return {
    planType: nonEmptyString(planTypeRaw) ? planTypeRaw : null,
    primary: readUsageWindow(headers, "primary"),
    secondary: readUsageWindow(headers, "secondary"),
  };
}

// Stable reason codes for an unavailable result. The renderer (src/i18n.ts) owns the localized
// text for each of these; this module must never ship English prose up to the UI.
//   - "no-account": this Codex Switcher account has no usable ChatGPT sign-in to ask on behalf of.
//   - "token-invalid": the stored session was rejected (401/403); never refreshed, see header.
//   - "request-failed": anything else that kept us from getting a usable answer (network error,
//     timeout, non-2xx status, unreadable accounts file).
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

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, controller) {
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Once we have the response object, its headers are already fully available -- everything this
// module needs. We must not let the caller (or anything else) go on to read the body: with
// `stream: true` the body is a live, still-generating model response, and downloading it would
// needlessly spend the account's quota and the user's time on output nobody will see. Cancelling
// the stream and aborting the controller both best-effort-release the connection; either failing
// (e.g. because the body was already fully consumed, or the fetch implementation does not expose
// a cancellable body) must never surface as an error from this function.
function abortResponseBody(response, controller) {
  try {
    response?.body?.cancel?.();
  } catch {
    // Best-effort only.
  }
  try {
    controller.abort();
  } catch {
    // Best-effort only.
  }
}

// Fetches and normalizes rate-limit usage for one Codex Switcher Plus account. Always resolves --
// including on a missing account, a network failure/timeout, a non-2xx response, or headers this
// module cannot parse -- with an `available: false` result carrying a stable `reason` code (see
// `unavailable` above). This function never throws, never downloads the streamed response body,
// and never retries with a refreshed token; see the module header for why.
async function fetchAccountUsage(accountId, {
  accountsPath,
  codexHome,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger,
  fetchImpl = fetch,
} = {}) {
  if (typeof accountId !== "string" || !accountId) {
    return unavailable(accountId, "no-account");
  }

  let auth;
  try {
    auth = resolveAccountChatGptAuth(accountId, { accountsPath, codexHome });
  } catch (error) {
    logger?.error?.("account_usage.read_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return unavailable(accountId, "request-failed");
  }
  if (!auth) return unavailable(accountId, "no-account");

  const controller = new AbortController();
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, CODEX_RESPONSES_URL, {
      method: "POST",
      headers: buildChatGptHeaders(auth.accessToken, auth.chatgptAccountId),
      body: JSON.stringify(WARMUP_PAYLOAD),
    }, timeoutMs, controller);
  } catch (error) {
    // Covers both network failures and the AbortController timeout above. Never logs the
    // request/response body or headers -- only that the attempt failed.
    logger?.warn?.("account_usage.request_failed", {
      accountId,
      message: error instanceof Error ? error.message : String(error),
    });
    return unavailable(accountId, "request-failed");
  }

  // From here on we only ever look at `response.status`/`response.headers`, both already fully
  // available on the resolved response -- so cancelling the body now costs us nothing we need.
  abortResponseBody(response, controller);

  if (response.status === 401 || response.status === 403) {
    // Genuinely expired/rejected token. Reporting "unavailable" here -- and never attempting a
    // refresh -- is the whole point of this module; see the header comment.
    logger?.warn?.("account_usage.unauthorized", { accountId, status: response.status });
    return unavailable(accountId, "token-invalid");
  }
  if (!response.ok) {
    logger?.warn?.("account_usage.error_status", { accountId, status: response.status });
    return unavailable(accountId, "request-failed");
  }

  const normalized = normalizeUsageHeaders(response.headers);
  return { accountId, available: true, reason: null, ...normalized };
}

module.exports = {
  CODEX_RESPONSES_URL,
  buildChatGptHeaders,
  fetchAccountUsage,
  normalizeUsageHeaders,
};
