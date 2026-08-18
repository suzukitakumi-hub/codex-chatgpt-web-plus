// The single serialized entry point for turning a possibly-stale stored ChatGPT credential into a
// usable access token, refreshing (and durably persisting the refreshed tokens) first when the
// stored one is expired or near expiry.
//
// Why this needs to exist at all: ~/.codex-switcher/accounts.json used to be owned and refreshed
// by a separate app, Codex Switcher Plus. That app has been uninstalled, so nothing maintains this
// file any more -- every stored token just ages toward (and eventually past) expiry. This module
// is what makes this launcher take over that maintenance: switching accounts (writeCodexAuth, via
// main.cjs's launcher:switch-account handler) and checking usage (account-usage.cjs) both route
// through `ensureFreshChatGptAuth` below instead of reading the stored token as-is.
//
// ORDERING GUARANTEE, which every caller depends on: refresh -> persist -> return. When a refresh
// returns a new token pair, it is written to accounts.json and that write is confirmed to have
// succeeded BEFORE the new access token is handed back to the caller. ChatGPT refresh tokens are
// single-use and rotate on every use: a rotated token that is not durably saved is gone forever,
// and the account it belonged to is bricked (it can never refresh again, only sign in from
// scratch). If persisting fails for any reason, this function's returned promise rejects instead
// of resolving -- the caller never sees the new token, and accounts.json is never left holding a
// half-applied write (writePrivateFileAtomic either lands the whole new file or leaves the old one
// untouched; see atomic-file.cjs).
//
// SERIALIZATION, and why it exists: OpenAI's refresh tokens are rotating (single-use) -- once a
// refresh succeeds, the refresh token that was spent to get it is dead. Two independent callers
// (e.g. a usage-fetch and an account switch, or two usage polls) that both observe the same
// expired stored token at nearly the same moment would otherwise both send that same refresh token
// to OpenAI; the first succeeds, the second gets rejected with `refresh_token_reused`, which
// surfaces to the user as a mysterious hard failure requiring a full re-login. This exact bug was
// already hit and fixed the same way upstream (see the per-account tokio Mutex in
// codex-switcher/src-tauri/src/auth/token_refresh.rs). Here, an in-process `Map` from account id
// to the in-flight ensure-fresh promise means a second caller that arrives while a refresh for the
// same account is already running is simply handed that same promise -- it never starts a second
// refresh, and it resolves (or rejects) with the exact same outcome as the first caller.
const { switcherAccountsPath, isChatGptAuthData, nonEmptyString, decodeJwtPayload } = require("./accounts.cjs");
const { readAccountsRoot, writeAccountsRoot } = require("./accounts-store.cjs");

// Reference: codex-switcher/src-tauri/src/auth/token_refresh.rs (DEFAULT_ISSUER, CLIENT_ID,
// EXPIRY_SKEW_SECONDS, and the `grant_type=refresh_token` request shape).
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const EXPIRY_SKEW_SECONDS = 60;

// Stable, secret-free message so this can safely cross the Electron IPC boundary (which only
// preserves an Error's `.message`, not custom properties) and be recognized by the renderer to
// show a localized "sign in again" state -- see src/App.tsx's isNeedsReauthError.
const NEEDS_REAUTH_PREFIX = "NEEDS_REAUTH:";

class NeedsReauthError extends Error {
  constructor(accountId) {
    super(`${NEEDS_REAUTH_PREFIX}${accountId}`);
    this.name = "NeedsReauthError";
    this.code = "needs-reauth";
    this.accountId = accountId;
  }
}

// Pure claim reader: null when the token is not a parseable JWT or has no numeric `exp` claim.
function accessTokenExpiry(accessToken) {
  const claims = decodeJwtPayload(accessToken);
  return claims && typeof claims.exp === "number" ? claims.exp : null;
}

// An access token with no parseable `exp` claim is treated as NOT expired -- we cannot prove it
// needs refreshing, and refreshing speculatively on every call is exactly what this module must
// not do (see the "only refresh when actually needed" requirement). This mirrors the reference
// implementation's identical default (`parse_jwt_exp` returning `None` -> not expired).
function isExpiredOrNearExpiry(accessToken, nowSeconds) {
  const exp = accessTokenExpiry(accessToken);
  if (exp === null) return false;
  return exp <= nowSeconds + EXPIRY_SKEW_SECONDS;
}

async function requestTokenRefresh(refreshToken, fetchImpl) {
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(CLIENT_ID)}`;
  let response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error) {
    throw new Error(`Token refresh request failed to send: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    // Deliberately never reads or logs the response body here: there is no legitimate use for it
    // in this codebase, and the safest way to guarantee a token endpoint's response body never
    // ends up in a log or a thrown message is to never look at it at all. The status code alone is
    // enough to act on and to report.
    throw new Error(`Token refresh failed with status ${response.status}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Token refresh response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!payload || typeof payload !== "object" || !nonEmptyString(payload.access_token)) {
    throw new Error("Token refresh response did not include a usable access_token");
  }
  return payload;
}

// Re-reads accounts.json immediately before writing (never trusts the snapshot the refresh
// started from), updates ONLY the target account's auth_data fields, and writes back the full
// root object untouched otherwise -- every other account, and every field on this account this
// module does not know about (created_at, last_used_at, subscription_expires_at, plan_type, the
// chat_g_p_t/api_key discriminator, etc.), survives verbatim.
function persistRefreshedTokens(accountId, nextAuthFields, accountsPath, writeAtomic) {
  const root = readAccountsRoot(accountsPath);
  const index = root.accounts.findIndex((candidate) => candidate?.id === accountId);
  if (index === -1) {
    throw new Error(`Account ${accountId} was not found in ${accountsPath} when persisting refreshed credentials`);
  }
  const target = root.accounts[index];
  root.accounts[index] = {
    ...target,
    auth_data: {
      ...target.auth_data,
      ...nextAuthFields,
    },
  };
  writeAccountsRoot(accountsPath, root, { writeAtomic });
}

// accountId -> Promise<{accessToken, chatgptAccountId} | null>. See the module header for why this
// exists. Entries are removed once their promise settles, so the NEXT (non-concurrent) call always
// re-checks freshness from disk rather than reusing a stale decision.
const refreshLocks = new Map();

// Ensures account `accountId`'s stored ChatGPT access token is usable, refreshing and persisting
// first if it is expired or within EXPIRY_SKEW_SECONDS of expiring. Resolves to:
//   - null                                    if the account does not exist, or is not a ChatGPT
//                                              (as opposed to API-key) account -- there is nothing
//                                              for this function to ensure fresh.
//   - { accessToken, chatgptAccountId }       otherwise, sourced from the now-fresh stored record.
//     chatgptAccountId is null when the account has none. Never id_token or refresh_token.
// Rejects with a NeedsReauthError when the account has no refresh token to fall back on, or the
// refresh attempt itself fails (most likely because the refresh token is also dead) -- callers
// must treat that as "this account must be signed in again through Codex", not a generic failure,
// and must be able to rely on accounts.json being completely untouched when it happens.
// Deliberately NOT declared `async`: an `async function` always wraps its return value in a new
// Promise, so two calls that both synchronously observe the same in-flight `run` and each `return
// run;` would still hand two DIFFERENT (if equivalent) Promise objects to their two callers. Being
// a plain function that returns `run` itself means two concurrent callers are handed the exact
// same Promise instance, not just two promises that happen to settle the same way -- which is what
// actually guarantees a second caller can never independently retrigger work.
function ensureFreshChatGptAuth(accountId, opts = {}) {
  if (typeof accountId !== "string" || !accountId) return Promise.resolve(null);

  const existing = refreshLocks.get(accountId);
  if (existing) return existing;

  const run = performEnsureFreshChatGptAuth(accountId, opts);
  refreshLocks.set(accountId, run);
  // Detach cleanup from the value callers receive: `run` itself still carries the real
  // resolution/rejection to whoever awaits it below and to any concurrent caller that was handed
  // the same promise; this chain only ever removes the now-settled lock entry.
  run.then(
    () => { if (refreshLocks.get(accountId) === run) refreshLocks.delete(accountId); },
    () => { if (refreshLocks.get(accountId) === run) refreshLocks.delete(accountId); },
  );
  return run;
}

async function performEnsureFreshChatGptAuth(accountId, {
  accountsPath = switcherAccountsPath(),
  now = () => Date.now(),
  fetchImpl = fetch,
  writeAtomic,
  logger,
} = {}) {
  const root = readAccountsRoot(accountsPath);
  const account = root.accounts.find((candidate) => candidate?.id === accountId);
  if (!account) return null;
  const authData = account.auth_data;
  if (!isChatGptAuthData(authData)) return null; // API-key or unrecognized: nothing to refresh.

  const storedAccessToken = nonEmptyString(authData.access_token) ? authData.access_token : null;
  const nowSeconds = Math.floor(now() / 1000);

  if (storedAccessToken && !isExpiredOrNearExpiry(storedAccessToken, nowSeconds)) {
    return {
      accessToken: storedAccessToken,
      chatgptAccountId: nonEmptyString(authData.account_id) ? authData.account_id : null,
    };
  }

  if (!nonEmptyString(authData.refresh_token)) {
    throw new NeedsReauthError(accountId);
  }

  let refreshed;
  try {
    refreshed = await requestTokenRefresh(authData.refresh_token, fetchImpl);
  } catch (error) {
    logger?.warn?.("credentials.refresh_failed", {
      accountId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new NeedsReauthError(accountId);
  }

  const nextAccessToken = refreshed.access_token;
  const nextIdToken = nonEmptyString(refreshed.id_token) ? refreshed.id_token : authData.id_token;
  const nextRefreshToken = nonEmptyString(refreshed.refresh_token) ? refreshed.refresh_token : authData.refresh_token;
  const idClaims = decodeJwtPayload(nextIdToken);
  const nextAccountId = (idClaims && nonEmptyString(idClaims.account_id))
    ? idClaims.account_id
    : (nonEmptyString(authData.account_id) ? authData.account_id : null);

  // PERSIST BEFORE RETURN. If this throws, the function's returned promise rejects here and
  // `nextAccessToken` is never handed to the caller -- see the module header's ordering guarantee.
  persistRefreshedTokens(accountId, {
    id_token: nextIdToken,
    access_token: nextAccessToken,
    refresh_token: nextRefreshToken,
    account_id: nextAccountId,
  }, accountsPath, writeAtomic);

  logger?.info?.("credentials.refreshed", { accountId });

  return { accessToken: nextAccessToken, chatgptAccountId: nextAccountId };
}

module.exports = {
  EXPIRY_SKEW_SECONDS,
  NEEDS_REAUTH_PREFIX,
  NeedsReauthError,
  accessTokenExpiry,
  ensureFreshChatGptAuth,
  isExpiredOrNearExpiry,
};
