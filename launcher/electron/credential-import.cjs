// Adopts fresh credentials that Codex itself just wrote into ~/.codex/auth.json -- most commonly
// because the user ran `codex login` (or signed in some other way directly through Codex) rather
// than through this launcher's account switcher -- into ~/.codex-switcher/accounts.json, the file
// this launcher now owns and maintains (see credential-provider.cjs's header for the rest of that
// story). Without this, a sign-in performed directly through Codex is invisible to accounts.json
// forever: nothing else here ever looks at auth.json to update the stored snapshot, and the
// "add a new account" capability that used to live in Codex Switcher Plus (now uninstalled) would
// otherwise be gone entirely.
//
// Direction is strictly one-way: auth.json -> accounts.json. This module NEVER writes auth.json;
// writeCodexAuth (accounts.cjs) remains its only writer. Every exported function here resolves to
// a status object and NEVER throws -- a failed import must never block launcher startup (this
// runs there automatically) or crash the explicit "check now" action in the account UI -- and
// never returns or logs token material, only account ids and stable status strings.
const crypto = require("node:crypto");
const {
  authDotJsonPath,
  decodeIdTokenEmail,
  decodeJwtPayload,
  isChatGptAuthData,
  nonEmptyString,
  readAuthDotJson,
  resolveActiveAccountId,
  switcherAccountsPath,
} = require("./accounts.cjs");
const { readAccountsRoot, writeAccountsRoot } = require("./accounts-store.cjs");

function accessTokenExpiry(accessToken) {
  const claims = decodeJwtPayload(accessToken);
  return claims && typeof claims.exp === "number" ? claims.exp : null;
}

function buildChatGptAccount({ tokens, email, now }) {
  return {
    id: crypto.randomUUID(),
    name: email || "Imported Account",
    email: email ?? null,
    plan_type: null,
    auth_mode: "chat_g_p_t",
    auth_data: {
      type: "chat_g_p_t",
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: nonEmptyString(tokens.account_id) ? tokens.account_id : null,
    },
    subscription_expires_at: null,
    created_at: now.toISOString(),
    last_used_at: null,
  };
}

function buildApiKeyAccount(apiKey, now) {
  return {
    id: crypto.randomUUID(),
    name: "Imported Account",
    email: null,
    plan_type: null,
    auth_mode: "api_key",
    auth_data: { type: "api_key", key: apiKey },
    subscription_expires_at: null,
    created_at: now.toISOString(),
    last_used_at: null,
  };
}

function appendNewAccount(accountsPath, account) {
  const root = readAccountsRoot(accountsPath);
  root.accounts.push(account);
  writeAccountsRoot(accountsPath, root);
  return account.id;
}

// Updates ONLY the matched account's ChatGPT auth_data fields with auth.json's newer tokens,
// preserving every other account and every other field on this one (name, email, plan_type,
// created_at, last_used_at, subscription_expires_at, ...) verbatim, and re-reading accounts.json
// immediately before writing so this never trusts an earlier snapshot.
function adoptTokensIntoAccount(accountsPath, accountId, tokens) {
  const root = readAccountsRoot(accountsPath);
  const index = root.accounts.findIndex((candidate) => candidate?.id === accountId);
  if (index === -1) return false;
  const existing = root.accounts[index];
  root.accounts[index] = {
    ...existing,
    auth_data: {
      ...existing.auth_data,
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: nonEmptyString(tokens.account_id) ? tokens.account_id : (existing.auth_data?.account_id ?? null),
    },
  };
  writeAccountsRoot(accountsPath, root);
  return true;
}

// Imports whatever ~/.codex/auth.json currently holds into ~/.codex-switcher/accounts.json.
// Resolves to a status object describing what happened:
//   { status: "no-auth-file" }              auth.json is missing or unparsable -- nothing to do.
//   { status: "unrecognized" }               auth.json parsed but had neither a usable
//                                             OPENAI_API_KEY nor a complete ChatGPT tokens object.
//   { status: "unchanged", accountId }       matched an existing account, but auth.json is not
//                                             newer (or, for an API key, already matches) --
//                                             nothing to adopt.
//   { status: "updated", accountId }         matched an existing account and adopted auth.json's
//                                             newer ChatGPT tokens into it.
//   { status: "added", accountId }           auth.json matched no known account, so a new one was
//                                             created from it -- this is also how a sign-in
//                                             performed directly through Codex becomes a new
//                                             switchable account again, restoring the capability
//                                             Codex Switcher Plus used to provide.
//   { status: "error", message }             something unexpected went wrong (e.g. accounts.json
//                                             present but not valid JSON); `message` never
//                                             contains token material.
function importFromAuthDotJson({ accountsPath = switcherAccountsPath(), codexHome, now = () => new Date() } = {}) {
  try {
    return importFromAuthDotJsonUnsafe({ accountsPath, codexHome, now });
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

function importFromAuthDotJsonUnsafe({ accountsPath, codexHome, now }) {
  const auth = readAuthDotJson(authDotJsonPath(codexHome));
  if (!auth) return { status: "no-auth-file" };

  const apiKey = nonEmptyString(auth.OPENAI_API_KEY) ? auth.OPENAI_API_KEY : null;
  const tokens = auth.tokens && typeof auth.tokens === "object" ? auth.tokens : null;
  const hasCompleteChatGptTokens = Boolean(
    tokens
    && nonEmptyString(tokens.id_token)
    && nonEmptyString(tokens.access_token)
    && nonEmptyString(tokens.refresh_token),
  );
  if (!apiKey && !hasCompleteChatGptTokens) return { status: "unrecognized" };

  // Reuse the exact identity match writeCodexAuth/account-usage already rely on (resolveActiveAccountId),
  // rather than a second matcher that could disagree with it about which account this is.
  const matchedAccountId = resolveActiveAccountId({ accountsPath, codexHome });

  if (apiKey) {
    // API keys neither expire nor rotate, so an exact match is already fully up to date -- there
    // is nothing to adopt. A non-match is genuinely new information, which is when this restores
    // the "add a new account" capability for API-key sign-ins.
    if (matchedAccountId) return { status: "unchanged", accountId: matchedAccountId };
    const accountId = appendNewAccount(accountsPath, buildApiKeyAccount(apiKey, now()));
    return { status: "added", accountId };
  }

  if (matchedAccountId) {
    const root = readAccountsRoot(accountsPath);
    const existing = root.accounts.find((candidate) => candidate?.id === matchedAccountId);
    if (!existing || !isChatGptAuthData(existing.auth_data)) {
      // Defensive: resolveActiveAccountId matched something that is not (or no longer) a ChatGPT
      // account. The OPENAI_API_KEY branch above already covers the legitimate API-key case, so
      // this should not normally happen -- treat it as nothing sensible to adopt rather than
      // guessing.
      return { status: "unchanged", accountId: matchedAccountId };
    }
    const storedExpiry = accessTokenExpiry(existing.auth_data.access_token);
    const authExpiry = accessTokenExpiry(tokens.access_token);
    // Compare by the access token's `exp` claim, never by wall-clock arrival order: an
    // unparsable auth.json token, or one that is not strictly newer than what is already stored,
    // must never overwrite a newer stored token with an older (or merely equal) one.
    if (authExpiry === null) return { status: "unchanged", accountId: matchedAccountId };
    if (storedExpiry !== null && authExpiry <= storedExpiry) {
      return { status: "unchanged", accountId: matchedAccountId };
    }
    adoptTokensIntoAccount(accountsPath, matchedAccountId, tokens);
    return { status: "updated", accountId: matchedAccountId };
  }

  const email = decodeIdTokenEmail(tokens.id_token);
  const accountId = appendNewAccount(accountsPath, buildChatGptAccount({ tokens, email, now: now() }));
  return { status: "added", accountId };
}

module.exports = { importFromAuthDotJson };
