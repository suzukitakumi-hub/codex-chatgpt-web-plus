const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

// This is the same partition Codex Switcher Plus and the launcher have always used for a single
// ChatGPT session. Keeping it as the "no account selected" default is what preserves the user's
// existing ChatGPT login across this feature landing.
const LEGACY_CHATGPT_PARTITION = "persist:codex-web-gpt-chatgpt";
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function expandHomePath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function switcherAccountsPath() {
  return path.join(os.homedir(), ".codex-switcher", "accounts.json");
}

function codexHomeDir() {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? expandHomePath(configured) : path.join(os.homedir(), ".codex");
}

// This project now owns and maintains this file: credential-provider.cjs refreshes and persists
// ChatGPT tokens back into it (see that module's header for the single-writer, serialize-per
// -account discipline that requires), and credential-import.cjs adopts fresh credentials from
// ~/.codex/auth.json into it. The app that used to own it, Codex Switcher Plus, has been
// uninstalled, and nothing else maintains this file's contents.
//
// This particular function remains a pure, always-fresh read (never cached) so callers here can't
// act on a stale snapshot -- it is not one of the writers.
function readRawSwitcherAccounts(filePath = switcherAccountsPath()) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Codex Switcher accounts file is invalid JSON: ${filePath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.accounts)) {
    throw new Error(`Codex Switcher accounts file has an unexpected shape: ${filePath}`);
  }
  return parsed.accounts;
}

function sanitizeAccount(raw) {
  return {
    id: raw?.id,
    name: raw?.name,
    email: raw?.email ?? null,
    planType: raw?.plan_type ?? null,
    authMode: raw?.auth_mode ?? null,
  };
}

// Never returns tokens/keys: this is the shape the (future) UI is allowed to see.
function readSwitcherAccounts(filePath) {
  return readRawSwitcherAccounts(filePath).map(sanitizeAccount);
}

// The producing app's `auth_mode`/`auth_data.type` discriminator is normally "chat_g_p_t" or
// "api_key", but tolerate a record whose discriminator is missing or unexpected by falling back
// to the shape of auth_data itself, so a schema drift in the producing app degrades to a clear
// error instead of a silent wrong-branch write.
function isChatGptAuthData(authData) {
  return authData?.type === "chat_g_p_t"
    || typeof authData?.id_token === "string"
    || typeof authData?.access_token === "string"
    || typeof authData?.refresh_token === "string";
}

function isApiKeyAuthData(authData) {
  return authData?.type === "api_key" || typeof authData?.key === "string";
}

// A string field only counts as present when it is non-empty: an empty string is exactly as
// useless to Codex as a missing field, and must be rejected the same way. A whitespace-only
// string (e.g. " ") is just as useless — Codex cannot authenticate with it either — so it is
// trimmed before the emptiness test. The original, untrimmed value is still what gets written.
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Pure mapping from one raw Codex Switcher Plus account to the exact ~/.codex/auth.json shape.
// `now` is injectable so tests are deterministic.
function buildAuthDotJson(account, now = new Date()) {
  const id = account?.id ?? "<unknown>";
  const authData = account?.auth_data;
  if (!authData || typeof authData !== "object") {
    throw new Error(`Codex Switcher account ${id} has no auth_data`);
  }
  if (isChatGptAuthData(authData)) {
    // A discriminator of chat_g_p_t with no usable tokens is not a smaller-but-valid auth.json —
    // it is a file Codex cannot authenticate with. Fail closed instead of writing `tokens: {}`
    // over a working login.
    const missing = ["id_token", "access_token", "refresh_token"]
      .filter((key) => !nonEmptyString(authData[key]));
    if (missing.length > 0) {
      throw new Error(
        `Codex Switcher account ${id} is missing required ChatGPT token(s): ${missing.join(", ")}`,
      );
    }
    const tokens = {
      id_token: authData.id_token,
      access_token: authData.access_token,
      refresh_token: authData.refresh_token,
    };
    if (nonEmptyString(authData.account_id)) tokens.account_id = authData.account_id;
    return { tokens, last_refresh: now.toISOString() };
  }
  if (isApiKeyAuthData(authData)) {
    if (!nonEmptyString(authData.key)) {
      throw new Error(`Codex Switcher account ${id} is missing its API key`);
    }
    return { OPENAI_API_KEY: authData.key };
  }
  throw new Error(`Codex Switcher account ${id} has an unrecognized auth_data type`);
}

// Best-effort local recovery copy of whatever auth.json held before this switch. `auth.json` is
// the file whose corruption breaks Codex startup, so Codex Switcher Plus's own writer keeps the
// same kind of backup; a failed backup must never block the switch the user asked for, so any
// error here is swallowed.
function backupExistingAuthFile(authPath) {
  try {
    if (!fs.existsSync(authPath)) return;
    const backupPath = `${authPath}.bak`;
    fs.copyFileSync(authPath, backupPath);
    try { fs.chmodSync(backupPath, 0o600); } catch {}
  } catch {
    // Non-fatal by design; see comment above.
  }
}

// CRITICAL: ChatGPT refresh tokens are single-use/rotating. Always re-read accounts.json here
// instead of trusting an earlier snapshot (e.g. one returned from readSwitcherAccounts a moment
// ago) — writing an already-consumed refresh_token produces 401 refresh_token_reused failures the
// next time Codex tries to refresh.
//
// This function itself never refreshes anything -- it faithfully writes whatever is currently
// stored for `accountId`. Callers that care whether that stored token is still usable (in
// particular the account-switch flow) must call credential-provider.cjs's ensureFreshChatGptAuth
// first, which refreshes AND durably persists a near-expiry token into accounts.json before this
// function ever reads it -- otherwise a stale stored token (nothing has maintained this file since
// Codex Switcher Plus was uninstalled) gets written straight into auth.json and silently breaks
// that account's login.
function writeCodexAuth(accountId, { accountsPath, codexHome, now } = {}) {
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("Account id is required to switch Codex authentication");
  }
  const accounts = readRawSwitcherAccounts(accountsPath);
  const account = accounts.find((candidate) => candidate?.id === accountId);
  if (!account) throw new Error(`No Codex Switcher account matches id ${accountId}`);
  const payload = buildAuthDotJson(account, now ?? new Date());
  const home = codexHome ? expandHomePath(codexHome) : codexHomeDir();
  const authPath = path.join(home, "auth.json");
  backupExistingAuthFile(authPath);
  writePrivateFileAtomic(authPath, `${JSON.stringify(payload, null, 2)}\n`);
  return authPath;
}

function authDotJsonPath(codexHome) {
  const home = codexHome ? expandHomePath(codexHome) : codexHomeDir();
  return path.join(home, "auth.json");
}

// `~/.codex/auth.json` can be rewritten by other tools (e.g. running `codex` and logging in
// directly), so it is read fresh every time and never cached.
function readAuthDotJson(authPath) {
  let text;
  try {
    text = fs.readFileSync(authPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // A corrupt auth.json is exactly as "no active account" as a missing one -- never throw here.
    return null;
  }
}

function base64UrlDecode(segment) {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + "=".repeat(padLength), "base64").toString("utf8");
}

// Defensive JWT payload decode, shared by every claim reader in this codebase (email here,
// `exp`/`account_id` in credential-provider.cjs and credential-import.cjs). Any malformed/garbage
// token (wrong segment count, invalid base64url, invalid JSON payload) resolves to null rather
// than throwing -- a broken token is never grounds to crash account resolution, refresh, or
// import. Never validates the signature: every caller already trusts the source (our own stored
// accounts.json, or a freshly issued response from the token endpoint), so this is a claims
// reader, not an auth check.
function decodeJwtPayload(token) {
  if (typeof token !== "string" || !token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function decodeIdTokenEmail(idToken) {
  const payload = decodeJwtPayload(idToken);
  return typeof payload?.email === "string" && payload.email ? payload.email : null;
}

// Derives which Codex Switcher Plus account (if any) the CURRENT ~/.codex/auth.json corresponds
// to. auth.json -- not the launcher's persisted `activeAccountId` -- is the real source of truth
// for "which account is Codex authenticated as", since other tools (e.g. `codex login` run
// directly) can rewrite it out from under the launcher. This never trusts a stored id; it always
// re-derives from what is actually on disk right now.
//
// Match priority: tokens.account_id when both the current auth.json and a candidate account have
// one; otherwise the `email` claim decoded from tokens.id_token; for API-key auth, the stored key
// itself. Returns the matching account id, or null when auth.json is absent, unparsable, or
// matches no known account.
//
// NEVER returns or logs token values, the API key, or the raw JWT -- only an account id or null.
function resolveActiveAccountId({ accountsPath, codexHome } = {}) {
  const auth = readAuthDotJson(authDotJsonPath(codexHome));
  if (!auth) return null;
  const accounts = readRawSwitcherAccounts(accountsPath);

  if (nonEmptyString(auth.OPENAI_API_KEY)) {
    const match = accounts.find((candidate) => (
      typeof candidate?.id === "string" && candidate.id
      && isApiKeyAuthData(candidate.auth_data)
      && nonEmptyString(candidate.auth_data.key)
      && candidate.auth_data.key === auth.OPENAI_API_KEY
    ));
    return match ? match.id : null;
  }

  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const chatGptCandidates = accounts.filter((candidate) => (
    typeof candidate?.id === "string" && candidate.id && isChatGptAuthData(candidate?.auth_data)
  ));

  if (nonEmptyString(tokens.account_id)) {
    const match = chatGptCandidates.find((candidate) => (
      nonEmptyString(candidate.auth_data.account_id)
      && candidate.auth_data.account_id === tokens.account_id
    ));
    if (match) return match.id;
  }

  const authEmail = decodeIdTokenEmail(tokens.id_token);
  if (authEmail) {
    const match = chatGptCandidates.find((candidate) => decodeIdTokenEmail(candidate.auth_data.id_token) === authEmail);
    if (match) return match.id;
  }

  return null;
}

// Returns only what a ChatGPT-authenticated network call needs (the bearer token and the
// optional chatgpt-account-id header value) for one Codex Switcher Plus account, or null when the
// account does not exist or is not signed in with ChatGPT (e.g. it uses an API key). Never returns
// id_token or refresh_token: callers of this accessor have no legitimate use for either, and
// keeping them out here means a bug in a caller can never leak them.
function readAccountChatGptAuth(accountId, filePath) {
  if (typeof accountId !== "string" || !accountId) return null;
  const accounts = readRawSwitcherAccounts(filePath);
  const account = accounts.find((candidate) => candidate?.id === accountId);
  if (!account) return null;
  const authData = account.auth_data;
  if (!isChatGptAuthData(authData) || !nonEmptyString(authData.access_token)) return null;
  return {
    accessToken: authData.access_token,
    chatgptAccountId: nonEmptyString(authData.account_id) ? authData.account_id : null,
  };
}

// Resolves the ChatGPT bearer credential to use for one Codex Switcher Plus account, preferring
// ~/.codex/auth.json's access_token when it currently belongs to this same account -- per
// resolveActiveAccountId, which already does this exact identity match, reused here rather than
// re-implemented -- since Codex keeps that file continuously fresh in real time for whichever
// account it is actively authenticated as. Otherwise falls back to whatever is currently stored in
// accounts.json, exactly as-is. auth.json may also hold an API-key credential instead of ChatGPT
// OAuth tokens; that has no bearer token usable here, so it falls back to the stored token (or
// null) the same as any other non-match, rather than returning something malformed.
//
// This function never refreshes a token and never writes to accounts.json or auth.json -- it is a
// pure, read-only resolver, kept around because "give me whatever is currently valid, without
// side effects" is still a legitimate, separate need from "make sure this is not about to expire"
// (that need is credential-provider.cjs's ensureFreshChatGptAuth, which account-usage.cjs now
// composes with the same auth.json preference below instead of calling this function). Returns
// only the same {accessToken, chatgptAccountId} shape as readAccountChatGptAuth -- never id_token
// or refresh_token.
function resolveAccountChatGptAuth(accountId, { accountsPath, codexHome } = {}) {
  if (typeof accountId !== "string" || !accountId) return null;
  if (resolveActiveAccountId({ accountsPath, codexHome }) === accountId) {
    const auth = readAuthDotJson(authDotJsonPath(codexHome));
    const tokens = auth?.tokens;
    if (tokens && typeof tokens === "object" && nonEmptyString(tokens.access_token)) {
      return {
        accessToken: tokens.access_token,
        chatgptAccountId: nonEmptyString(tokens.account_id) ? tokens.account_id : null,
      };
    }
  }
  return readAccountChatGptAuth(accountId, accountsPath);
}

function partitionForAccount(accountId) {
  if (accountId === null || accountId === undefined) return LEGACY_CHATGPT_PARTITION;
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error(`Account id is not a valid Electron partition suffix: ${JSON.stringify(accountId)}`);
  }
  return `${LEGACY_CHATGPT_PARTITION}-${accountId}`;
}

function firstCsvField(line) {
  if (!line.startsWith('"')) return null;
  const end = line.indexOf('"', 1);
  if (end === -1) return null;
  return line.slice(1, end);
}

// Fails closed: if the probe itself cannot run (missing tasklist/pgrep, unexpected exit code),
// we report Codex as running so a broken probe can never let writeCodexAuth clobber auth.json
// underneath a live Codex process.
function isCodexRunning({ platform = process.platform, spawn = spawnSync } = {}) {
  try {
    if (platform === "win32") {
      const result = spawn("tasklist", ["/FI", "IMAGENAME eq codex.exe", "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      if (result.error) throw result.error;
      if (typeof result.status === "number" && result.status !== 0) {
        throw new Error(`tasklist exited with status ${result.status}`);
      }
      const rows = (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const running = rows.some((line) => {
        const imageName = firstCsvField(line);
        return imageName !== null && imageName.toLowerCase() === "codex.exe";
      });
      return { running, reason: null };
    }
    // pgrep -x matches the exact process name; exit 0 means at least one match, exit 1 means none.
    const result = spawn("pgrep", ["-x", "codex"], { encoding: "utf8", timeout: 10_000 });
    if (result.error) throw result.error;
    if (result.status === 0) return { running: true, reason: null };
    if (result.status === 1) return { running: false, reason: null };
    throw new Error(`pgrep exited with status ${result.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      running: true,
      reason: `Codex process check failed, assuming Codex is running to be safe: ${message}`,
    };
  }
}

module.exports = {
  LEGACY_CHATGPT_PARTITION,
  authDotJsonPath,
  buildAuthDotJson,
  codexHomeDir,
  decodeIdTokenEmail,
  decodeJwtPayload,
  isApiKeyAuthData,
  isChatGptAuthData,
  isCodexRunning,
  nonEmptyString,
  partitionForAccount,
  readAccountChatGptAuth,
  readAuthDotJson,
  readRawSwitcherAccounts,
  readSwitcherAccounts,
  resolveAccountChatGptAuth,
  resolveActiveAccountId,
  switcherAccountsPath,
  writeCodexAuth,
};
