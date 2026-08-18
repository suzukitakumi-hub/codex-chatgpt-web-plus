const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  LEGACY_CHATGPT_PARTITION,
  buildAuthDotJson,
  isCodexRunning,
  partitionForAccount,
  readAccountChatGptAuth,
  readSwitcherAccounts,
  resolveActiveAccountId,
  writeCodexAuth,
} = require("../electron/accounts.cjs");

const FIXED_NOW = new Date("2026-08-18T12:00:00.000Z");

function chatGptAccount(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Work",
    email: "work@example.com",
    plan_type: "plus",
    auth_mode: "chat_g_p_t",
    auth_data: {
      type: "chat_g_p_t",
      id_token: "id-token-value",
      access_token: "access-token-value",
      refresh_token: "refresh-token-value",
      account_id: null,
    },
    subscription_expires_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function apiKeyAccount(overrides = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "API",
    email: null,
    plan_type: null,
    auth_mode: "api_key",
    auth_data: { type: "api_key", key: "sk-abcdefghijklmnopqrstuvwxyz" },
    ...overrides,
  };
}

test("buildAuthDotJson maps a chat_g_p_t account to the exact auth.json token shape", () => {
  const payload = buildAuthDotJson(chatGptAccount(), FIXED_NOW);
  assert.deepEqual(payload, {
    tokens: {
      id_token: "id-token-value",
      access_token: "access-token-value",
      refresh_token: "refresh-token-value",
    },
    last_refresh: "2026-08-18T12:00:00.000Z",
  });
  assert.equal("account_id" in payload.tokens, false);
});

test("buildAuthDotJson keeps account_id when present and never emits null values", () => {
  const account = chatGptAccount({
    auth_data: {
      type: "chat_g_p_t",
      id_token: "id-token-value",
      access_token: "access-token-value",
      refresh_token: "refresh-token-value",
      account_id: "acct_123",
    },
  });
  const payload = buildAuthDotJson(account, FIXED_NOW);
  assert.equal(payload.tokens.account_id, "acct_123");
  assert.equal(JSON.stringify(payload).includes("null"), false);
});

test("buildAuthDotJson maps an api_key account to OPENAI_API_KEY with no tokens field", () => {
  const payload = buildAuthDotJson(apiKeyAccount(), FIXED_NOW);
  assert.deepEqual(payload, { OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz" });
  assert.equal("tokens" in payload, false);
});

test("buildAuthDotJson falls back to token-shape evidence when the discriminator is missing", () => {
  const account = chatGptAccount({ auth_mode: undefined, auth_data: { id_token: "a", access_token: "b", refresh_token: "c" } });
  delete account.auth_data.type;
  const payload = buildAuthDotJson(account, FIXED_NOW);
  assert.deepEqual(payload.tokens, { id_token: "a", access_token: "b", refresh_token: "c" });
});

test("buildAuthDotJson throws a clear error instead of emitting a partial auth.json for unrecognized accounts", () => {
  assert.throws(
    () => buildAuthDotJson({ id: "bad", auth_data: { type: "smart_card" } }, FIXED_NOW),
    /unrecognized auth_data type/,
  );
  assert.throws(() => buildAuthDotJson({ id: "bad" }, FIXED_NOW), /no auth_data/);
});

test("buildAuthDotJson refuses to emit tokens: {} when the discriminator says chat_g_p_t but the tokens are missing or empty", () => {
  assert.throws(
    () => buildAuthDotJson({ id: "x", auth_data: { type: "chat_g_p_t" } }, FIXED_NOW),
    /missing required ChatGPT token\(s\).*id_token.*access_token.*refresh_token/,
  );
  assert.throws(
    () => buildAuthDotJson({
      id: "y",
      auth_data: { type: "chat_g_p_t", id_token: "a", access_token: "", refresh_token: "c" },
    }, FIXED_NOW),
    /missing required ChatGPT token\(s\).*access_token/,
  );
  assert.throws(
    () => buildAuthDotJson({
      id: "z",
      auth_data: { type: "chat_g_p_t", id_token: "a", access_token: "b", refresh_token: undefined },
    }, FIXED_NOW),
    /missing required ChatGPT token\(s\).*refresh_token/,
  );
});

test("buildAuthDotJson treats a whitespace-only ChatGPT token as absent, not a valid credential", () => {
  assert.throws(
    () => buildAuthDotJson({
      id: "ws",
      auth_data: { type: "chat_g_p_t", id_token: "a", access_token: "   ", refresh_token: "c" },
    }, FIXED_NOW),
    /missing required ChatGPT token\(s\).*access_token/,
  );
});

test("buildAuthDotJson drops a whitespace-only account_id instead of writing it into tokens", () => {
  const account = chatGptAccount({
    auth_data: {
      type: "chat_g_p_t",
      id_token: "id-token-value",
      access_token: "access-token-value",
      refresh_token: "refresh-token-value",
      account_id: "   ",
    },
  });
  const payload = buildAuthDotJson(account, FIXED_NOW);
  assert.equal("account_id" in payload.tokens, false);
});

test("buildAuthDotJson treats a whitespace-only API key as absent, not a valid credential", () => {
  assert.throws(
    () => buildAuthDotJson(apiKeyAccount({ auth_data: { type: "api_key", key: "   " } }), FIXED_NOW),
    /missing its API key/,
  );
});

test("partitionForAccount(null) returns the exact legacy partition that preserves the current login", () => {
  assert.equal(partitionForAccount(null), "persist:codex-web-gpt-chatgpt");
  assert.equal(partitionForAccount(undefined), "persist:codex-web-gpt-chatgpt");
  assert.equal(LEGACY_CHATGPT_PARTITION, "persist:codex-web-gpt-chatgpt");
});

test("partitionForAccount derives a per-account partition from a safe id", () => {
  assert.equal(
    partitionForAccount("11111111-1111-4111-8111-111111111111"),
    "persist:codex-web-gpt-chatgpt-11111111-1111-4111-8111-111111111111",
  );
});

test("partitionForAccount rejects hostile or malformed account ids", () => {
  assert.throws(() => partitionForAccount("../../evil"), /not a valid Electron partition suffix/);
  assert.throws(() => partitionForAccount("evil:thing"), /not a valid Electron partition suffix/);
  assert.throws(() => partitionForAccount("evil/thing"), /not a valid Electron partition suffix/);
  assert.throws(() => partitionForAccount("a".repeat(65)), /not a valid Electron partition suffix/);
  assert.throws(() => partitionForAccount(""), /not a valid Electron partition suffix/);
});

test("readSwitcherAccounts returns [] when the file is absent and never leaks secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switcher-accounts-"));
  try {
    const missing = path.join(root, "accounts.json");
    assert.deepEqual(readSwitcherAccounts(missing), []);

    const file = path.join(root, "present.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      accounts: [chatGptAccount(), apiKeyAccount()],
      active_account_id: null,
      masked_account_ids: [],
    }));
    const accounts = readSwitcherAccounts(file);
    assert.deepEqual(accounts, [
      { id: chatGptAccount().id, name: "Work", email: "work@example.com", planType: "plus", authMode: "chat_g_p_t" },
      { id: apiKeyAccount().id, name: "API", email: null, planType: null, authMode: "api_key" },
    ]);
    const serialized = JSON.stringify(accounts);
    for (const secret of ["id-token-value", "access-token-value", "refresh-token-value", "sk-abcdefghijklmnopqrstuvwxyz"]) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readSwitcherAccounts throws a clear error on malformed JSON", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switcher-accounts-bad-"));
  try {
    const file = path.join(root, "accounts.json");
    fs.writeFileSync(file, "{not valid json");
    assert.throws(() => readSwitcherAccounts(file), /invalid JSON/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeCodexAuth re-reads accounts fresh, writes a private atomic file, and leaves no partial file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switcher-write-"));
  try {
    const accountsPath = path.join(root, "accounts.json");
    const codexHome = path.join(root, "codex-home");
    fs.writeFileSync(accountsPath, JSON.stringify({
      version: 1,
      accounts: [chatGptAccount()],
      active_account_id: null,
      masked_account_ids: [],
    }));

    const authPath = writeCodexAuth(chatGptAccount().id, { accountsPath, codexHome, now: FIXED_NOW });
    assert.equal(authPath, path.join(codexHome, "auth.json"));
    const written = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.deepEqual(written, {
      tokens: {
        id_token: "id-token-value",
        access_token: "access-token-value",
        refresh_token: "refresh-token-value",
      },
      last_refresh: "2026-08-18T12:00:00.000Z",
    });
    if (process.platform !== "win32") assert.equal(fs.statSync(authPath).mode & 0o077, 0);
    assert.equal(fs.readdirSync(codexHome).some((name) => name.includes(".tmp-")), false);

    // Simulate Codex Switcher Plus rotating the refresh token between reads: writeCodexAuth must
    // pick up the new value, proving it never trusts a cached snapshot.
    const rotated = chatGptAccount({
      auth_data: {
        type: "chat_g_p_t",
        id_token: "id-token-value",
        access_token: "access-token-value",
        refresh_token: "rotated-refresh-token",
        account_id: null,
      },
    });
    fs.writeFileSync(accountsPath, JSON.stringify({
      version: 1,
      accounts: [rotated],
      active_account_id: null,
      masked_account_ids: [],
    }));
    writeCodexAuth(rotated.id, { accountsPath, codexHome, now: FIXED_NOW });
    const rewritten = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.equal(rewritten.tokens.refresh_token, "rotated-refresh-token");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeCodexAuth preserves the pre-switch auth.json as a private .bak before overwriting it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switcher-backup-"));
  try {
    const accountsPath = path.join(root, "accounts.json");
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    const authPath = path.join(codexHome, "auth.json");
    const previousContent = `${JSON.stringify({ OPENAI_API_KEY: "sk-old-key-still-here" }, null, 2)}\n`;
    fs.writeFileSync(authPath, previousContent, { mode: 0o600 });
    fs.writeFileSync(accountsPath, JSON.stringify({
      version: 1,
      accounts: [chatGptAccount()],
      active_account_id: null,
      masked_account_ids: [],
    }));

    writeCodexAuth(chatGptAccount().id, { accountsPath, codexHome, now: FIXED_NOW });

    const backupPath = `${authPath}.bak`;
    assert.equal(fs.readFileSync(backupPath, "utf8"), previousContent);
    if (process.platform !== "win32") assert.equal(fs.statSync(backupPath).mode & 0o077, 0);
    // The live file must still be the newly switched-to account, not the backup.
    const current = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.equal(current.tokens.refresh_token, "refresh-token-value");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeCodexAuth does not fail the switch when there is no pre-existing auth.json to back up", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switcher-no-backup-"));
  try {
    const accountsPath = path.join(root, "accounts.json");
    const codexHome = path.join(root, "codex-home");
    fs.writeFileSync(accountsPath, JSON.stringify({
      version: 1,
      accounts: [chatGptAccount()],
      active_account_id: null,
      masked_account_ids: [],
    }));

    const authPath = writeCodexAuth(chatGptAccount().id, { accountsPath, codexHome, now: FIXED_NOW });
    assert.equal(fs.existsSync(`${authPath}.bak`), false);
    assert.equal(fs.existsSync(authPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeCodexAuth throws when the account id does not exist, without touching auth.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switcher-missing-"));
  try {
    const accountsPath = path.join(root, "accounts.json");
    const codexHome = path.join(root, "codex-home");
    fs.writeFileSync(accountsPath, JSON.stringify({ version: 1, accounts: [], active_account_id: null, masked_account_ids: [] }));
    assert.throws(() => writeCodexAuth("does-not-exist", { accountsPath, codexHome }), /No Codex Switcher account matches/);
    assert.equal(fs.existsSync(path.join(codexHome, "auth.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readAccountChatGptAuth returns only the access token and account id, never id_token or refresh_token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switcher-chatgpt-auth-"));
  try {
    const accountsPath = path.join(root, "accounts.json");
    fs.writeFileSync(accountsPath, JSON.stringify({
      version: 1,
      accounts: [chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, account_id: "acct_123" } }), apiKeyAccount()],
      active_account_id: null,
      masked_account_ids: [],
    }));

    const auth = readAccountChatGptAuth(chatGptAccount().id, accountsPath);
    assert.deepEqual(auth, { accessToken: "access-token-value", chatgptAccountId: "acct_123" });
    assert.equal("id_token" in auth, false);
    assert.equal("refresh_token" in auth, false);

    assert.equal(readAccountChatGptAuth(apiKeyAccount().id, accountsPath), null);
    assert.equal(readAccountChatGptAuth("does-not-exist", accountsPath), null);
    assert.equal(readAccountChatGptAuth("", accountsPath), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readAccountChatGptAuth returns null account id when the field is absent or blank instead of a header the backend would reject", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switcher-chatgpt-auth-blank-"));
  try {
    const accountsPath = path.join(root, "accounts.json");
    fs.writeFileSync(accountsPath, JSON.stringify({
      version: 1,
      accounts: [chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, account_id: "   " } })],
      active_account_id: null,
      masked_account_ids: [],
    }));

    const auth = readAccountChatGptAuth(chatGptAccount().id, accountsPath);
    assert.equal(auth.chatgptAccountId, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("isCodexRunning fails closed and surfaces the reason when the process probe itself errors", () => {
  const failingSpawn = () => ({ error: new Error("command not found") });
  const result = isCodexRunning({ platform: "linux", spawn: failingSpawn });
  assert.equal(result.running, true);
  assert.match(result.reason, /command not found/);
});

test("isCodexRunning on win32 matches codex.exe exactly and does not substring-match the launcher itself", () => {
  const running = isCodexRunning({
    platform: "win32",
    spawn: () => ({ status: 0, stdout: '"codex.exe","1234","Console","1","12,345 K"\r\n' }),
  });
  assert.deepEqual(running, { running: true, reason: null });

  const notRunning = isCodexRunning({
    platform: "win32",
    spawn: () => ({ status: 0, stdout: "INFO: No tasks are running which match the specified criteria.\r\n" }),
  });
  assert.deepEqual(notRunning, { running: false, reason: null });

  const decoyProcess = isCodexRunning({
    platform: "win32",
    spawn: () => ({ status: 0, stdout: '"codex-chatgpt-web-plus.exe","4321","Console","1","1 K"\r\n' }),
  });
  assert.deepEqual(decoyProcess, { running: false, reason: null });
});

test("isCodexRunning on posix uses an exact pgrep match", () => {
  assert.deepEqual(isCodexRunning({ platform: "linux", spawn: () => ({ status: 0, stdout: "4242\n" }) }), {
    running: true,
    reason: null,
  });
  assert.deepEqual(isCodexRunning({ platform: "darwin", spawn: () => ({ status: 1, stdout: "" }) }), {
    running: false,
    reason: null,
  });
});

function base64UrlEncode(text) {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeIdToken(payload) {
  return `${base64UrlEncode(JSON.stringify({ alg: "none" }))}.${base64UrlEncode(JSON.stringify(payload))}.signature`;
}

function writeAccountsFile(accountsPath, accounts) {
  fs.writeFileSync(accountsPath, JSON.stringify({
    version: 1,
    accounts,
    active_account_id: null,
    masked_account_ids: [],
  }));
}

function resolveFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-switcher-resolve-active-"));
  return {
    root,
    accountsPath: path.join(root, "accounts.json"),
    codexHome: path.join(root, "codex-home"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeAuthDotJson(codexHome, payload) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(payload));
}

test("resolveActiveAccountId matches on tokens.account_id when both sides have one", () => {
  const fixture = resolveFixture();
  try {
    const work = chatGptAccount({
      id: "work-account",
      auth_data: {
        type: "chat_g_p_t",
        id_token: makeIdToken({ email: "work@example.com" }),
        access_token: "a",
        refresh_token: "r",
        account_id: "acct_work",
      },
    });
    const personal = chatGptAccount({
      id: "personal-account",
      auth_data: {
        type: "chat_g_p_t",
        id_token: makeIdToken({ email: "personal@example.com" }),
        access_token: "a",
        refresh_token: "r",
        account_id: "acct_personal",
      },
    });
    writeAccountsFile(fixture.accountsPath, [work, personal]);
    writeAuthDotJson(fixture.codexHome, {
      tokens: {
        id_token: makeIdToken({ email: "personal@example.com" }),
        access_token: "current-access",
        refresh_token: "current-refresh",
        account_id: "acct_work",
      },
    });

    const resolved = resolveActiveAccountId({ accountsPath: fixture.accountsPath, codexHome: fixture.codexHome });
    // account_id takes priority over the (deliberately mismatched) email claim above.
    assert.equal(resolved, "work-account");
  } finally {
    fixture.cleanup();
  }
});

test("resolveActiveAccountId falls back to the email claim decoded from tokens.id_token", () => {
  const fixture = resolveFixture();
  try {
    const work = chatGptAccount({
      id: "work-account",
      auth_data: {
        type: "chat_g_p_t",
        id_token: makeIdToken({ email: "work@example.com" }),
        access_token: "a",
        refresh_token: "r",
        account_id: null,
      },
    });
    writeAccountsFile(fixture.accountsPath, [work]);
    writeAuthDotJson(fixture.codexHome, {
      tokens: {
        id_token: makeIdToken({ email: "work@example.com" }),
        access_token: "current-access",
        refresh_token: "current-refresh",
      },
    });

    const resolved = resolveActiveAccountId({ accountsPath: fixture.accountsPath, codexHome: fixture.codexHome });
    assert.equal(resolved, "work-account");
  } finally {
    fixture.cleanup();
  }
});

test("resolveActiveAccountId matches API-key auth on the stored key", () => {
  const fixture = resolveFixture();
  try {
    const key = apiKeyAccount({ id: "api-account" });
    writeAccountsFile(fixture.accountsPath, [key]);
    writeAuthDotJson(fixture.codexHome, { OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz" });

    const resolved = resolveActiveAccountId({ accountsPath: fixture.accountsPath, codexHome: fixture.codexHome });
    assert.equal(resolved, "api-account");
  } finally {
    fixture.cleanup();
  }
});

test("resolveActiveAccountId treats a malformed/garbage id_token as no match instead of throwing", () => {
  const fixture = resolveFixture();
  try {
    const work = chatGptAccount({
      id: "work-account",
      auth_data: {
        type: "chat_g_p_t",
        id_token: makeIdToken({ email: "work@example.com" }),
        access_token: "a",
        refresh_token: "r",
        account_id: null,
      },
    });
    writeAccountsFile(fixture.accountsPath, [work]);
    writeAuthDotJson(fixture.codexHome, {
      tokens: {
        id_token: "not-a-real-jwt",
        access_token: "current-access",
        refresh_token: "current-refresh",
      },
    });

    let resolved;
    assert.doesNotThrow(() => {
      resolved = resolveActiveAccountId({ accountsPath: fixture.accountsPath, codexHome: fixture.codexHome });
    });
    assert.equal(resolved, null);
  } finally {
    fixture.cleanup();
  }
});

test("resolveActiveAccountId returns null when auth.json is absent", () => {
  const fixture = resolveFixture();
  try {
    writeAccountsFile(fixture.accountsPath, [chatGptAccount({ id: "work-account" })]);
    // codexHome is never created, so auth.json cannot exist.
    const resolved = resolveActiveAccountId({ accountsPath: fixture.accountsPath, codexHome: fixture.codexHome });
    assert.equal(resolved, null);
  } finally {
    fixture.cleanup();
  }
});

test("resolveActiveAccountId returns null, not a stale id, when auth.json matches none of the known accounts", () => {
  const fixture = resolveFixture();
  try {
    const work = chatGptAccount({
      id: "work-account",
      auth_data: {
        type: "chat_g_p_t",
        id_token: makeIdToken({ email: "work@example.com" }),
        access_token: "a",
        refresh_token: "r",
        account_id: "acct_work",
      },
    });
    writeAccountsFile(fixture.accountsPath, [work]);
    writeAuthDotJson(fixture.codexHome, {
      tokens: {
        id_token: makeIdToken({ email: "someone-else@example.com" }),
        access_token: "current-access",
        refresh_token: "current-refresh",
        account_id: "acct_unknown",
      },
    });

    const resolved = resolveActiveAccountId({ accountsPath: fixture.accountsPath, codexHome: fixture.codexHome });
    assert.equal(resolved, null);
  } finally {
    fixture.cleanup();
  }
});

test("resolveActiveAccountId never leaks token, key, or JWT material in its return value", () => {
  const fixture = resolveFixture();
  try {
    const idToken = makeIdToken({ email: "work@example.com" });
    const work = chatGptAccount({
      id: "work-account",
      auth_data: {
        type: "chat_g_p_t",
        id_token: idToken,
        access_token: "super-secret-access-token",
        refresh_token: "super-secret-refresh-token",
        account_id: "acct_work",
      },
    });
    const key = apiKeyAccount({ id: "api-account", auth_data: { type: "api_key", key: "sk-super-secret-key-value" } });
    writeAccountsFile(fixture.accountsPath, [work, key]);
    writeAuthDotJson(fixture.codexHome, {
      tokens: {
        id_token: idToken,
        access_token: "current-secret-access-token",
        refresh_token: "current-secret-refresh-token",
        account_id: "acct_work",
      },
    });

    const resolved = resolveActiveAccountId({ accountsPath: fixture.accountsPath, codexHome: fixture.codexHome });
    assert.equal(resolved, "work-account");
    assert.equal(typeof resolved, "string");
    const serialized = JSON.stringify(resolved);
    for (const secret of [
      idToken,
      "super-secret-access-token",
      "super-secret-refresh-token",
      "sk-super-secret-key-value",
      "current-secret-access-token",
      "current-secret-refresh-token",
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally {
    fixture.cleanup();
  }
});
