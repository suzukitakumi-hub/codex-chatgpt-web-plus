const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CODEX_RESPONSES_URL,
  SESSION_WINDOW_SECONDS,
  WEEKLY_WINDOW_SECONDS,
  buildChatGptHeaders,
  fetchAccountUsage,
  normalizeRateLimitPayload,
} = require("../electron/account-usage.cjs");

function rateLimitWindow(usedPercent, windowSeconds, resetAt = 1_800_000_000) {
  return { used_percent: usedPercent, limit_window_seconds: windowSeconds, reset_at: resetAt };
}

test("normalizeRateLimitPayload keeps session/primary and weekly/secondary windows in their slots", () => {
  const result = normalizeRateLimitPayload({
    plan_type: "plus",
    rate_limit: {
      primary_window: rateLimitWindow(27, SESSION_WINDOW_SECONDS),
      secondary_window: rateLimitWindow(82, WEEKLY_WINDOW_SECONDS),
    },
  });
  assert.equal(result.planType, "plus");
  assert.equal(result.primary.usedPercent, 27);
  assert.equal(result.primary.windowMinutes, (SESSION_WINDOW_SECONDS / 60));
  assert.equal(result.primary.resetsAt, 1_800_000_000);
  assert.equal(result.secondary.usedPercent, 82);
  assert.equal(result.secondary.windowMinutes, (WEEKLY_WINDOW_SECONDS / 60));
});

test("normalizeRateLimitPayload restores primary/secondary order when the backend swaps the windows", () => {
  const result = normalizeRateLimitPayload({
    plan_type: "plus",
    rate_limit: {
      primary_window: rateLimitWindow(82, WEEKLY_WINDOW_SECONDS),
      secondary_window: rateLimitWindow(27, SESSION_WINDOW_SECONDS),
    },
  });
  assert.equal(result.primary.usedPercent, 27);
  assert.equal(result.secondary.usedPercent, 82);
});

test("normalizeRateLimitPayload handles only one window being present", () => {
  const weeklyOnlyAsPrimary = normalizeRateLimitPayload({
    plan_type: "pro",
    rate_limit: { primary_window: rateLimitWindow(35, WEEKLY_WINDOW_SECONDS), secondary_window: null },
  });
  assert.equal(weeklyOnlyAsPrimary.primary, null);
  assert.equal(weeklyOnlyAsPrimary.secondary.usedPercent, 35);

  const sessionOnlyAsSecondary = normalizeRateLimitPayload({
    plan_type: "pro",
    rate_limit: { primary_window: null, secondary_window: rateLimitWindow(41, SESSION_WINDOW_SECONDS) },
  });
  assert.equal(sessionOnlyAsSecondary.secondary, null);
  assert.equal(sessionOnlyAsSecondary.primary.usedPercent, 41);
});

test("normalizeRateLimitPayload preserves unrecognized window lengths by backend position", () => {
  const result = normalizeRateLimitPayload({
    plan_type: "plus",
    rate_limit: {
      primary_window: rateLimitWindow(11, 60 * 60),
      secondary_window: rateLimitWindow(22, 30 * 24 * 60 * 60),
    },
  });
  assert.equal(result.primary.usedPercent, 11);
  assert.equal(result.secondary.usedPercent, 22);
});

test("normalizeRateLimitPayload returns null windows when rate_limit is entirely missing", () => {
  const result = normalizeRateLimitPayload({ plan_type: "free" });
  assert.equal(result.planType, "free");
  assert.equal(result.primary, null);
  assert.equal(result.secondary, null);
});

test("normalizeRateLimitPayload never throws on a malformed payload", () => {
  for (const payload of [null, undefined, "not an object", 42, [], { rate_limit: "also not an object" }, { rate_limit: { primary_window: "nope", secondary_window: 5 } }]) {
    let result;
    assert.doesNotThrow(() => { result = normalizeRateLimitPayload(payload); });
    assert.equal(result.primary, null);
    assert.equal(result.secondary, null);
    assert.equal(result.planType, null);
  }
});

test("buildChatGptHeaders sets the bearer token and optional account id header", () => {
  const withAccountId = buildChatGptHeaders("token-value", "acct_123");
  assert.equal(withAccountId.authorization, "Bearer token-value");
  assert.equal(withAccountId["chatgpt-account-id"], "acct_123");

  const withoutAccountId = buildChatGptHeaders("token-value", null);
  assert.equal("chatgpt-account-id" in withoutAccountId, false);
});

function writeAccountsFile(root, accounts) {
  const accountsPath = path.join(root, "accounts.json");
  fs.writeFileSync(accountsPath, JSON.stringify({
    version: 1,
    accounts,
    active_account_id: null,
    masked_account_ids: [],
  }));
  return accountsPath;
}

function chatGptAccount(overrides = {}) {
  return {
    id: "work-account",
    name: "Work",
    email: "work@example.com",
    plan_type: "plus",
    auth_mode: "chat_g_p_t",
    auth_data: {
      type: "chat_g_p_t",
      id_token: "id-token-value",
      access_token: "access-token-value",
      refresh_token: "refresh-token-value",
      account_id: "acct_work",
    },
    ...overrides,
  };
}

test("fetchAccountUsage returns unavailable for an unknown account id without making a network call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-unknown-"));
  try {
    const accountsPath = writeAccountsFile(root, []);
    let called = false;
    const result = await fetchAccountUsage("does-not-exist", {
      accountsPath,
      fetchImpl: async () => { called = true; throw new Error("must not be called"); },
    });
    assert.equal(called, false);
    assert.equal(result.available, false);
    assert.match(result.reason, /does not use ChatGPT sign-in/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage reports API-key accounts as unavailable without a network call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-apikey-"));
  try {
    const accountsPath = writeAccountsFile(root, [{
      id: "api-account",
      name: "API",
      auth_mode: "api_key",
      auth_data: { type: "api_key", key: "sk-abcdefghijklmnopqrstuvwxyz" },
    }]);
    let called = false;
    const result = await fetchAccountUsage("api-account", {
      accountsPath,
      fetchImpl: async () => { called = true; throw new Error("must not be called"); },
    });
    assert.equal(called, false);
    assert.equal(result.available, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage sends the bearer token and account id header, then normalizes a successful response", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-success-"));
  try {
    const accountsPath = writeAccountsFile(root, [chatGptAccount()]);
    let seenUrl = null;
    let seenHeaders = null;
    let seenSignal = null;
    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
        seenSignal = init.signal;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            plan_type: "plus",
            rate_limit: {
              primary_window: rateLimitWindow(12, SESSION_WINDOW_SECONDS),
              secondary_window: rateLimitWindow(56, WEEKLY_WINDOW_SECONDS),
            },
          }),
        };
      },
    });
    assert.equal(seenUrl, CODEX_RESPONSES_URL);
    assert.equal(seenHeaders.authorization, "Bearer access-token-value");
    assert.equal(seenHeaders["chatgpt-account-id"], "acct_work");
    assert.ok(seenSignal, "an AbortSignal must be passed so the request is bounded by a timeout");
    assert.equal(result.available, true);
    assert.equal(result.planType, "plus");
    assert.equal(result.primary.usedPercent, 12);
    assert.equal(result.secondary.usedPercent, 56);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage treats 401 as unavailable and never attempts a token refresh or retry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-401-"));
  try {
    const accountsPath = writeAccountsFile(root, [chatGptAccount()]);
    let callCount = 0;
    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      fetchImpl: async () => {
        callCount += 1;
        return { ok: false, status: 401, json: async () => ({}) };
      },
    });
    assert.equal(callCount, 1, "a 401 must not trigger any retry attempt");
    assert.equal(result.available, false);
    assert.match(result.reason, /no longer valid/);
    // Prove the accounts.json this test wrote was never mutated by the call above.
    assert.deepEqual(JSON.parse(fs.readFileSync(accountsPath, "utf8")).accounts[0].auth_data.access_token, "access-token-value");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage treats 403 as unavailable without refreshing, same as 401", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-403-"));
  try {
    const accountsPath = writeAccountsFile(root, [chatGptAccount()]);
    let callCount = 0;
    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      fetchImpl: async () => { callCount += 1; return { ok: false, status: 403, json: async () => ({}) }; },
    });
    assert.equal(callCount, 1);
    assert.equal(result.available, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage degrades to unavailable on a network failure instead of throwing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-network-"));
  try {
    const accountsPath = writeAccountsFile(root, [chatGptAccount()]);
    let result;
    await assert.doesNotReject(async () => {
      result = await fetchAccountUsage("work-account", {
        accountsPath,
        fetchImpl: async () => { throw new Error("ECONNRESET"); },
      });
    });
    assert.equal(result.available, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage never leaks the access token into its return value", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-leak-"));
  try {
    const accountsPath = writeAccountsFile(root, [chatGptAccount()]);
    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ plan_type: "plus" }),
      }),
    });
    assert.equal(JSON.stringify(result).includes("access-token-value"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage times out and reports unavailable when the request hangs past the deadline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-timeout-"));
  try {
    const accountsPath = writeAccountsFile(root, [chatGptAccount()]);
    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      timeoutMs: 10,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });
    assert.equal(result.available, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
