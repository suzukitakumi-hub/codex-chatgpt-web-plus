const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  EXPIRY_SKEW_SECONDS,
  NeedsReauthError,
  accessTokenExpiry,
  ensureFreshChatGptAuth,
  isExpiredOrNearExpiry,
} = require("../electron/credential-provider.cjs");

const FIXED_NOW = new Date("2026-08-18T12:00:00.000Z");
const NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);

function base64UrlEncode(text) {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeToken(payload) {
  return `${base64UrlEncode(JSON.stringify({ alg: "none" }))}.${base64UrlEncode(JSON.stringify(payload))}.signature`;
}

function freshAccessToken(extra = {}) {
  return makeToken({ exp: NOW_SECONDS + 3600, ...extra });
}

function expiredAccessToken(extra = {}) {
  return makeToken({ exp: NOW_SECONDS - 10, ...extra });
}

function nearExpiryAccessToken(extra = {}) {
  return makeToken({ exp: NOW_SECONDS + 30, ...extra }); // inside the 60s skew window
}

function chatGptAccount(overrides = {}) {
  return {
    id: "work-account",
    name: "Work",
    email: "work@example.com",
    plan_type: "plus",
    auth_mode: "chat_g_p_t",
    subscription_expires_at: "2027-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: "2026-08-01T00:00:00.000Z",
    custom_future_field: "preserve-me",
    auth_data: {
      type: "chat_g_p_t",
      id_token: "id-token-value",
      access_token: freshAccessToken(),
      refresh_token: "refresh-token-value",
      account_id: "acct_work",
    },
    ...overrides,
  };
}

function apiKeyAccount(overrides = {}) {
  return {
    id: "api-account",
    name: "API",
    auth_mode: "api_key",
    auth_data: { type: "api_key", key: "sk-abcdefghijklmnopqrstuvwxyz" },
    ...overrides,
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-credential-provider-"));
  return {
    root,
    accountsPath: path.join(root, "accounts.json"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeAccountsRoot(accountsPath, accounts, rootOverrides = {}) {
  const root = {
    version: 1,
    accounts,
    active_account_id: null,
    masked_account_ids: [],
    some_unknown_top_level_field: "keep-me",
    ...rootOverrides,
  };
  fs.writeFileSync(accountsPath, JSON.stringify(root, null, 2));
  return root;
}

function okJsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => "" };
}

function errorResponse(status) {
  return { ok: false, status, json: async () => ({}), text: async () => "invalid_grant" };
}

test("isExpiredOrNearExpiry: pure expiry rule", () => {
  assert.equal(isExpiredOrNearExpiry(freshAccessToken(), NOW_SECONDS), false);
  assert.equal(isExpiredOrNearExpiry(expiredAccessToken(), NOW_SECONDS), true);
  assert.equal(isExpiredOrNearExpiry(nearExpiryAccessToken(), NOW_SECONDS), true);
  // A token exactly at the skew boundary counts as near-expiry.
  const boundary = makeToken({ exp: NOW_SECONDS + EXPIRY_SKEW_SECONDS });
  assert.equal(isExpiredOrNearExpiry(boundary, NOW_SECONDS), true);
  // Unparsable/non-JWT tokens can never be proven expired, so must not be treated as expired --
  // this is what stops the provider from ever refreshing speculatively for tokens it cannot read.
  assert.equal(isExpiredOrNearExpiry("not-a-jwt", NOW_SECONDS), false);
  assert.equal(isExpiredOrNearExpiry("", NOW_SECONDS), false);
});

test("accessTokenExpiry returns null for anything that is not a parseable JWT with a numeric exp", () => {
  assert.equal(accessTokenExpiry("not-a-jwt"), null);
  assert.equal(accessTokenExpiry(freshAccessToken()), NOW_SECONDS + 3600);
});

test("ensureFreshChatGptAuth returns the stored token unchanged, without any network call, when it is not near expiry", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount()]);
    let called = false;
    const result = await ensureFreshChatGptAuth("work-account", {
      accountsPath,
      now: () => FIXED_NOW.getTime(),
      fetchImpl: async () => { called = true; throw new Error("must not be called"); },
    });
    assert.equal(called, false);
    assert.deepEqual(result, { accessToken: chatGptAccount().auth_data.access_token, chatgptAccountId: "acct_work" });
  } finally {
    cleanup();
  }
});

test("ensureFreshChatGptAuth returns null for an API-key account without any network call", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [apiKeyAccount()]);
    let called = false;
    const result = await ensureFreshChatGptAuth("api-account", {
      accountsPath,
      fetchImpl: async () => { called = true; throw new Error("must not be called"); },
    });
    assert.equal(result, null);
    assert.equal(called, false);
  } finally {
    cleanup();
  }
});

test("ensureFreshChatGptAuth returns null for a missing account id", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount()]);
    const result = await ensureFreshChatGptAuth("does-not-exist", { accountsPath });
    assert.equal(result, null);
  } finally {
    cleanup();
  }
});

test("refresh persists the new tokens to accounts.json before the caller ever sees the new access token, and returns it", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, access_token: expiredAccessToken() } })]);
    const newAccessToken = "brand-new-access-token";
    const newRefreshToken = "brand-new-refresh-token";
    const newIdToken = makeToken({ email: "work@example.com", account_id: "acct_work" });

    const result = await ensureFreshChatGptAuth("work-account", {
      accountsPath,
      now: () => FIXED_NOW.getTime(),
      fetchImpl: async () => okJsonResponse({ access_token: newAccessToken, refresh_token: newRefreshToken, id_token: newIdToken }),
    });

    assert.deepEqual(result, { accessToken: newAccessToken, chatgptAccountId: "acct_work" });

    const persisted = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    const persistedAccount = persisted.accounts.find((account) => account.id === "work-account");
    assert.equal(persistedAccount.auth_data.access_token, newAccessToken);
    assert.equal(persistedAccount.auth_data.refresh_token, newRefreshToken);
    assert.equal(persistedAccount.auth_data.id_token, newIdToken);
  } finally {
    cleanup();
  }
});

test("a failed persist does not hand out the new token, and the caller's promise rejects instead of resolving", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, access_token: expiredAccessToken() } })]);
    const before = fs.readFileSync(accountsPath, "utf8");

    await assert.rejects(
      ensureFreshChatGptAuth("work-account", {
        accountsPath,
        now: () => FIXED_NOW.getTime(),
        fetchImpl: async () => okJsonResponse({ access_token: "should-never-be-returned", refresh_token: "rotated" }),
        writeAtomic: () => { throw new Error("simulated disk failure"); },
      }),
      /simulated disk failure/,
    );

    // The refresh token was already "spent" against the (mocked) OAuth endpoint above, but since
    // the persist failed, accounts.json must be completely unchanged -- proving the new token was
    // never handed out anywhere it could be acted on.
    assert.equal(fs.readFileSync(accountsPath, "utf8"), before);
  } finally {
    cleanup();
  }
});

test("two concurrent requests for the same account trigger exactly one refresh and share its result", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, access_token: expiredAccessToken() } })]);
    let callCount = 0;
    const opts = {
      accountsPath,
      now: () => FIXED_NOW.getTime(),
      fetchImpl: async () => {
        callCount += 1;
        return okJsonResponse({ access_token: "single-refresh-access-token", refresh_token: "single-refresh-refresh-token" });
      },
    };

    // Deliberately not awaited between the two calls, so both observe the same expired token
    // before either has had a chance to persist a refreshed one.
    const first = ensureFreshChatGptAuth("work-account", opts);
    const second = ensureFreshChatGptAuth("work-account", opts);
    assert.equal(first, second, "the second caller must be handed the exact same in-flight promise, not start its own refresh");

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(callCount, 1);
    assert.deepEqual(firstResult, secondResult);
    assert.equal(firstResult.accessToken, "single-refresh-access-token");
  } finally {
    cleanup();
  }
});

test("a later, non-concurrent call re-checks freshness instead of reusing a settled decision", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, access_token: expiredAccessToken() } })]);
    let callCount = 0;
    const opts = {
      accountsPath,
      now: () => FIXED_NOW.getTime(),
      fetchImpl: async () => {
        callCount += 1;
        return okJsonResponse({ access_token: freshAccessToken(), refresh_token: "rotated-once" });
      },
    };
    await ensureFreshChatGptAuth("work-account", opts);
    await ensureFreshChatGptAuth("work-account", opts);
    // The second call sees the now-fresh stored token from the first call's persist and must not
    // refresh again.
    assert.equal(callCount, 1);
  } finally {
    cleanup();
  }
});

test("a failed refresh (dead refresh token) leaves accounts.json byte-identical and rejects with NeedsReauthError", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, access_token: expiredAccessToken() } })]);
    const before = fs.readFileSync(accountsPath, "utf8");

    await assert.rejects(
      ensureFreshChatGptAuth("work-account", {
        accountsPath,
        now: () => FIXED_NOW.getTime(),
        fetchImpl: async () => errorResponse(400),
      }),
      (error) => error instanceof NeedsReauthError && error.accountId === "work-account",
    );

    assert.equal(fs.readFileSync(accountsPath, "utf8"), before);
  } finally {
    cleanup();
  }
});

test("an account with no access token and no refresh token needs reauth without attempting a network call", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount({
      auth_data: { type: "chat_g_p_t", id_token: "id", access_token: "", refresh_token: "" },
    })]);
    let called = false;
    await assert.rejects(
      ensureFreshChatGptAuth("work-account", {
        accountsPath,
        fetchImpl: async () => { called = true; throw new Error("must not be called"); },
      }),
      NeedsReauthError,
    );
    assert.equal(called, false);
  } finally {
    cleanup();
  }
});

test("unrelated accounts and unknown fields survive a refresh-triggered write verbatim", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    const untouched = chatGptAccount({
      id: "other-account",
      name: "Other",
      email: "other@example.com",
      plan_type: "team",
      subscription_expires_at: "2028-05-01T00:00:00.000Z",
      created_at: "2025-12-31T00:00:00.000Z",
      last_used_at: "2026-07-15T00:00:00.000Z",
      custom_future_field: "still-here",
      auth_data: {
        type: "chat_g_p_t",
        id_token: "other-id-token",
        access_token: "other-access-token",
        refresh_token: "other-refresh-token",
        account_id: "acct_other",
      },
    });
    const target = chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, access_token: expiredAccessToken() } });
    writeAccountsRoot(accountsPath, [untouched, target], { active_account_id: "other-account" });

    await ensureFreshChatGptAuth("work-account", {
      accountsPath,
      now: () => FIXED_NOW.getTime(),
      fetchImpl: async () => okJsonResponse({ access_token: "refreshed-access-token", refresh_token: "refreshed-refresh-token" }),
    });

    const persisted = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    assert.equal(persisted.active_account_id, "other-account");
    assert.equal(persisted.some_unknown_top_level_field, "keep-me");
    assert.deepEqual(persisted.accounts.find((account) => account.id === "other-account"), untouched);

    const updated = persisted.accounts.find((account) => account.id === "work-account");
    assert.equal(updated.name, "Work");
    assert.equal(updated.plan_type, "plus");
    assert.equal(updated.subscription_expires_at, "2027-01-01T00:00:00.000Z");
    assert.equal(updated.created_at, "2026-01-01T00:00:00.000Z");
    assert.equal(updated.last_used_at, "2026-08-01T00:00:00.000Z");
    assert.equal(updated.custom_future_field, "preserve-me");
    assert.equal(updated.auth_data.access_token, "refreshed-access-token");
  } finally {
    cleanup();
  }
});

test(".bak holds the pre-refresh content of accounts.json", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, access_token: expiredAccessToken() } })]);
    const before = fs.readFileSync(accountsPath, "utf8");

    await ensureFreshChatGptAuth("work-account", {
      accountsPath,
      now: () => FIXED_NOW.getTime(),
      fetchImpl: async () => okJsonResponse({ access_token: "refreshed-access-token", refresh_token: "refreshed-refresh-token" }),
    });

    const backupPath = `${accountsPath}.bak`;
    assert.equal(fs.readFileSync(backupPath, "utf8"), before);
  } finally {
    cleanup();
  }
});

test("never returns or logs access_token/refresh_token/id_token material, on success or failure", async () => {
  const { accountsPath, cleanup } = fixture();
  try {
    writeAccountsRoot(accountsPath, [chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, access_token: expiredAccessToken(), refresh_token: "super-secret-stored-refresh-token" } })]);
    const logged = [];
    const logger = {
      info: (event, detail) => logged.push(JSON.stringify({ event, detail })),
      warn: (event, detail) => logged.push(JSON.stringify({ event, detail })),
      error: (event, detail) => logged.push(JSON.stringify({ event, detail })),
    };

    const result = await ensureFreshChatGptAuth("work-account", {
      accountsPath,
      logger,
      now: () => FIXED_NOW.getTime(),
      fetchImpl: async () => okJsonResponse({ access_token: "new-secret-access-token", refresh_token: "new-secret-refresh-token", id_token: "new-secret-id-token" }),
    });

    const resultSerialized = JSON.stringify(result);
    const logSerialized = logged.join("\n");
    for (const secret of ["new-secret-access-token", "new-secret-refresh-token", "new-secret-id-token", "super-secret-stored-refresh-token"]) {
      assert.equal(logSerialized.includes(secret), false, `log output must never contain ${secret}`);
    }
    // The access token is legitimately part of the successful return value; only the log output
    // (and the refresh/id tokens, even in the return value) must stay clean.
    assert.equal(resultSerialized.includes("new-secret-refresh-token"), false);
    assert.equal(resultSerialized.includes("new-secret-id-token"), false);

    // And on the reauth-needed path, the error's own message (the only part of it that survives
    // across an IPC boundary) must also carry no secret material -- only the stable marker.
    writeAccountsRoot(accountsPath, [chatGptAccount({ auth_data: { ...chatGptAccount().auth_data, access_token: expiredAccessToken(), refresh_token: "super-secret-stored-refresh-token" } })]);
    try {
      await ensureFreshChatGptAuth("work-account", {
        accountsPath,
        logger,
        now: () => FIXED_NOW.getTime(),
        fetchImpl: async () => errorResponse(400),
      });
      assert.fail("expected ensureFreshChatGptAuth to reject");
    } catch (error) {
      assert.equal(error.message.includes("super-secret-stored-refresh-token"), false);
    }
  } finally {
    cleanup();
  }
});
