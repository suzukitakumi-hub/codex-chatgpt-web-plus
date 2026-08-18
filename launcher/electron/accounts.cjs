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

// Codex Switcher Plus owns this file; we only ever read it, and always fresh from disk (never
// cached) so callers can't act on a stale snapshot.
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
  buildAuthDotJson,
  codexHomeDir,
  isCodexRunning,
  partitionForAccount,
  readSwitcherAccounts,
  switcherAccountsPath,
  writeCodexAuth,
};
