const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { importFromAuthDotJson } = require("../electron/credential-import.cjs");

const FIXED_NOW = new Date("2026-08-18T12:00:00.000Z");
const NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);

function base64UrlEncode(text) {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeToken(payload) {
  return `${base64UrlEncode(JSON.stringify({ alg: "none" }))}.${base64UrlEncode(JSON.stringify(payload))}.signature`;
}

function chatGptAccount(overrides = {}) {
  return {
    id: "work-account",
    name: "Work",
    email: "work@example.com",
    plan_type: "plus",
    auth_mode: "chat_g_p_t",
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: "2026-08-01T00:00:00.000Z",
    auth_data: {
      type: "chat_g_p_t",
      id_token: makeToken({ email: "work@example.com", account_id: "acct_work" }),
      access_token: makeToken({ exp: NOW_SECONDS - 1000, account_id: "acct_work" }),
      refresh_token: "stored-refresh-token",
      account_id: "acct_work",
    },
    ...overrides,
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-credential-import-"));
  return {
    root,
    accountsPath: path.join(root, "accounts.json"),
    codexHome: path.join(root, "codex-home"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeAccountsRoot(accountsPath, accounts, rootOverrides = {}) {
  const root = {
    version: 1,
    accounts,
    active_account_id: null,
    masked_account_ids: [],
    ...rootOverrides,
  };
  fs.writeFileSync(accountsPath, JSON.stringify(root, null, 2));
  return root;
}

function writeAuthDotJson(codexHome, payload) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(payload));
}

function readAccountsRoot(accountsPath) {
  return JSON.parse(fs.readFileSync(accountsPath, "utf8"));
}

test("importFromAuthDotJson reports no-auth-file when auth.json is absent", () => {
  const { accountsPath, codexHome, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount()]);
    const result = importFromAuthDotJson({ accountsPath, codexHome, now: () => FIXED_NOW });
    assert.deepEqual(result, { status: "no-auth-file" });
  } finally {
    cleanup();
  }
});

test("importFromAuthDotJson reports unrecognized for a parseable but unusable auth.json", () => {
  const { accountsPath, codexHome, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount()]);
    writeAuthDotJson(codexHome, { something_else: true });
    const result = importFromAuthDotJson({ accountsPath, codexHome, now: () => FIXED_NOW });
    assert.equal(result.status, "unrecognized");
  } finally {
    cleanup();
  }
});

test("importFromAuthDotJson adopts a newer auth.json token into the matched existing account", () => {
  const { accountsPath, codexHome, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount()], { active_account_id: "work-account" });
    const newerAccessToken = makeToken({ exp: NOW_SECONDS + 3600, account_id: "acct_work" });
    writeAuthDotJson(codexHome, {
      tokens: {
        id_token: makeToken({ email: "work@example.com", account_id: "acct_work" }),
        access_token: newerAccessToken,
        refresh_token: "fresh-refresh-token",
        account_id: "acct_work",
      },
    });

    const result = importFromAuthDotJson({ accountsPath, codexHome, now: () => FIXED_NOW });
    assert.deepEqual(result, { status: "updated", accountId: "work-account" });

    const persisted = readAccountsRoot(accountsPath);
    const account = persisted.accounts.find((candidate) => candidate.id === "work-account");
    assert.equal(account.auth_data.access_token, newerAccessToken);
    assert.equal(account.auth_data.refresh_token, "fresh-refresh-token");
    // Everything else about the account is preserved.
    assert.equal(account.name, "Work");
    assert.equal(account.plan_type, "plus");
    assert.equal(account.created_at, "2026-01-01T00:00:00.000Z");
    assert.equal(account.last_used_at, "2026-08-01T00:00:00.000Z");
  } finally {
    cleanup();
  }
});

test("importFromAuthDotJson refuses an older auth.json token and leaves the stored one untouched", () => {
  const { accountsPath, codexHome, cleanup } = fixture();
  try {
    const freshStoredAccessToken = makeToken({ exp: NOW_SECONDS + 7200, account_id: "acct_work" });
    writeAccountsRoot(accountsPath, [chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, access_token: freshStoredAccessToken } })], { active_account_id: "work-account" });
    const olderAccessToken = makeToken({ exp: NOW_SECONDS - 5000, account_id: "acct_work" });
    writeAuthDotJson(codexHome, {
      tokens: {
        id_token: makeToken({ email: "work@example.com", account_id: "acct_work" }),
        access_token: olderAccessToken,
        refresh_token: "older-refresh-token",
        account_id: "acct_work",
      },
    });

    const result = importFromAuthDotJson({ accountsPath, codexHome, now: () => FIXED_NOW });
    assert.deepEqual(result, { status: "unchanged", accountId: "work-account" });

    const persisted = readAccountsRoot(accountsPath);
    const account = persisted.accounts.find((candidate) => candidate.id === "work-account");
    assert.equal(account.auth_data.access_token, freshStoredAccessToken);
    assert.equal(account.auth_data.refresh_token, "stored-refresh-token");
  } finally {
    cleanup();
  }
});

test("importFromAuthDotJson refuses an auth.json token with no parseable exp claim rather than guessing it is newer", () => {
  const { accountsPath, codexHome, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount()], { active_account_id: "work-account" });
    writeAuthDotJson(codexHome, {
      tokens: {
        id_token: makeToken({ email: "work@example.com", account_id: "acct_work" }),
        access_token: "not-a-jwt-access-token",
        refresh_token: "some-refresh-token",
        account_id: "acct_work",
      },
    });

    const result = importFromAuthDotJson({ accountsPath, codexHome, now: () => FIXED_NOW });
    assert.deepEqual(result, { status: "unchanged", accountId: "work-account" });
    const persisted = readAccountsRoot(accountsPath);
    assert.equal(persisted.accounts[0].auth_data.access_token, chatGptAccount().auth_data.access_token);
  } finally {
    cleanup();
  }
});

test("importFromAuthDotJson adds a genuinely new ChatGPT account without disturbing existing ones", () => {
  const { accountsPath, codexHome, cleanup } = fixture();
  try {
    const existing = chatGptAccount();
    writeAccountsRoot(accountsPath, [existing], { active_account_id: "work-account" });
    writeAuthDotJson(codexHome, {
      tokens: {
        id_token: makeToken({ email: "new-person@example.com", account_id: "acct_new" }),
        access_token: makeToken({ exp: NOW_SECONDS + 3600, account_id: "acct_new" }),
        refresh_token: "new-person-refresh-token",
        account_id: "acct_new",
      },
    });

    const result = importFromAuthDotJson({ accountsPath, codexHome, now: () => FIXED_NOW });
    assert.equal(result.status, "added");
    assert.ok(result.accountId && result.accountId !== "work-account");

    const persisted = readAccountsRoot(accountsPath);
    assert.equal(persisted.accounts.length, 2);
    // The pre-existing account is completely untouched.
    assert.deepEqual(persisted.accounts.find((account) => account.id === "work-account"), existing);

    const added = persisted.accounts.find((account) => account.id === result.accountId);
    assert.equal(added.name, "new-person@example.com");
    assert.equal(added.email, "new-person@example.com");
    assert.equal(added.auth_mode, "chat_g_p_t");
    assert.equal(added.auth_data.account_id, "acct_new");
    assert.equal(typeof added.id, "string");
    assert.notEqual(added.id, "work-account");
  } finally {
    cleanup();
  }
});

test("importFromAuthDotJson handles an API-key auth.json without malformed output: unchanged when it matches, added when it does not", () => {
  const { accountsPath, codexHome, cleanup } = fixture();
  try {
    const apiKeyAccountFixture = {
      id: "api-account",
      name: "API",
      auth_mode: "api_key",
      auth_data: { type: "api_key", key: "sk-existing-key-value" },
    };
    writeAccountsRoot(accountsPath, [apiKeyAccountFixture], { active_account_id: "api-account" });
    writeAuthDotJson(codexHome, { OPENAI_API_KEY: "sk-existing-key-value" });

    const matched = importFromAuthDotJson({ accountsPath, codexHome, now: () => FIXED_NOW });
    assert.deepEqual(matched, { status: "unchanged", accountId: "api-account" });

    writeAuthDotJson(codexHome, { OPENAI_API_KEY: "sk-a-different-key-entirely" });
    const added = importFromAuthDotJson({ accountsPath, codexHome, now: () => FIXED_NOW });
    assert.equal(added.status, "added");
    const persisted = readAccountsRoot(accountsPath);
    assert.equal(persisted.accounts.length, 2);
    const newAccount = persisted.accounts.find((account) => account.id === added.accountId);
    assert.equal(newAccount.auth_mode, "api_key");
    assert.equal(newAccount.auth_data.key, "sk-a-different-key-entirely");
    assert.equal("access_token" in newAccount.auth_data, false);
    assert.equal("tokens" in newAccount, false);
  } finally {
    cleanup();
  }
});

test("importFromAuthDotJson never throws and reports error status on an unreadable accounts.json instead of crashing startup", () => {
  const { accountsPath, codexHome, cleanup } = fixture();
  try {
    fs.mkdirSync(path.dirname(accountsPath), { recursive: true });
    fs.writeFileSync(accountsPath, "{not valid json");
    writeAuthDotJson(codexHome, {
      tokens: {
        id_token: makeToken({ email: "someone@example.com" }),
        access_token: makeToken({ exp: NOW_SECONDS + 3600 }),
        refresh_token: "r",
      },
    });
    let result;
    assert.doesNotThrow(() => { result = importFromAuthDotJson({ accountsPath, codexHome, now: () => FIXED_NOW }); });
    assert.equal(result.status, "error");
    assert.equal(typeof result.message, "string");
  } finally {
    cleanup();
  }
});

test("importFromAuthDotJson never returns or leaks token material in its result", () => {
  const { accountsPath, codexHome, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount()], { active_account_id: "work-account" });
    const secretAccessToken = makeToken({ exp: NOW_SECONDS + 3600, account_id: "acct_work" });
    writeAuthDotJson(codexHome, {
      tokens: {
        id_token: makeToken({ email: "work@example.com", account_id: "acct_work" }),
        access_token: secretAccessToken,
        refresh_token: "super-secret-refresh-token",
        account_id: "acct_work",
      },
    });
    const result = importFromAuthDotJson({ accountsPath, codexHome, now: () => FIXED_NOW });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secretAccessToken), false);
    assert.equal(serialized.includes("super-secret-refresh-token"), false);
  } finally {
    cleanup();
  }
});
