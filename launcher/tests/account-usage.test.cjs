const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CODEX_RESPONSES_URL,
  buildChatGptHeaders,
  fetchAccountUsage,
  normalizeUsageHeaders,
} = require("../electron/account-usage.cjs");

function headerMap(overrides = {}) {
  return {
    "x-codex-plan-type": "prolite",
    "x-codex-active-limit": "premium",
    "x-codex-primary-used-percent": "31",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-at": "1787196872",
    "x-codex-primary-reset-after-seconds": "146718",
    "x-codex-secondary-used-percent": "0",
    "x-codex-secondary-window-minutes": "0",
    "x-codex-secondary-reset-at": "",
    "x-codex-secondary-reset-after-seconds": "0",
    "x-codex-credits-balance": "0",
    "x-codex-credits-has-credits": "False",
    "x-codex-credits-unlimited": "False",
    ...overrides,
  };
}

test("normalizeUsageHeaders parses both windows when both are present", () => {
  const result = normalizeUsageHeaders(headerMap({
    "x-codex-secondary-used-percent": "82",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "1787999999",
  }));
  assert.equal(result.planType, "prolite");
  assert.equal(result.primary.usedPercent, 31);
  assert.equal(result.primary.windowMinutes, 10080);
  assert.equal(result.primary.resetsAt, 1787196872);
  assert.equal(result.secondary.usedPercent, 82);
  assert.equal(result.secondary.windowMinutes, 10080);
  assert.equal(result.secondary.resetsAt, 1787999999);
});

test("normalizeUsageHeaders treats an empty secondary reset-at as no secondary window", () => {
  const result = normalizeUsageHeaders(headerMap({
    "x-codex-secondary-used-percent": "0",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "",
  }));
  assert.equal(result.secondary, null);
  assert.equal(result.primary.usedPercent, 31);
});

test("normalizeUsageHeaders treats a zero secondary window-minutes as no secondary window", () => {
  const result = normalizeUsageHeaders(headerMap({
    "x-codex-secondary-used-percent": "0",
    "x-codex-secondary-window-minutes": "0",
    "x-codex-secondary-reset-at": "1787999999",
  }));
  assert.equal(result.secondary, null);
  assert.equal(result.primary.usedPercent, 31);
});

test("normalizeUsageHeaders returns null windows and plan type when headers are entirely missing", () => {
  const result = normalizeUsageHeaders({});
  assert.equal(result.planType, null);
  assert.equal(result.primary, null);
  assert.equal(result.secondary, null);
});

test("normalizeUsageHeaders never throws on garbage header values", () => {
  for (const headers of [
    null,
    undefined,
    "not an object",
    42,
    headerMap({ "x-codex-primary-used-percent": "not-a-number" }),
    headerMap({ "x-codex-primary-window-minutes": "NaN" }),
    headerMap({ "x-codex-primary-reset-at": "soon" }),
    { "x-codex-plan-type": "" },
    { "x-codex-plan-type": 42 },
  ]) {
    let result;
    assert.doesNotThrow(() => { result = normalizeUsageHeaders(headers); });
    assert.equal(typeof result, "object");
  }
});

test("normalizeUsageHeaders works against a real Headers-like object with a .get method", () => {
  const map = headerMap();
  const headers = { get: (name) => (name.toLowerCase() in map ? map[name.toLowerCase()] : null) };
  const result = normalizeUsageHeaders(headers);
  assert.equal(result.planType, "prolite");
  assert.equal(result.primary.usedPercent, 31);
  assert.equal(result.secondary, null);
});

test("buildChatGptHeaders sets the bearer token, streaming accept header, and optional account id header", () => {
  const withAccountId = buildChatGptHeaders("token-value", "acct_123");
  assert.equal(withAccountId.authorization, "Bearer token-value");
  assert.equal(withAccountId.accept, "text/event-stream");
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

function fakeResponse({ ok, status, headers = {} }) {
  let cancelled = false;
  return {
    ok,
    status,
    headers,
    body: {
      cancel() {
        cancelled = true;
      },
    },
    get bodyCancelled() {
      return cancelled;
    },
  };
}

test("fetchAccountUsage returns unavailable for an unknown account id without making a network call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-unknown-"));
  try {
    const accountsPath = writeAccountsFile(root, []);
    let called = false;
    const result = await fetchAccountUsage("does-not-exist", {
      accountsPath,
      codexHome: path.join(root, "codex-home"),
      fetchImpl: async () => { called = true; throw new Error("must not be called"); },
    });
    assert.equal(called, false);
    assert.equal(result.available, false);
    assert.equal(result.reason, "no-account");
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
      codexHome: path.join(root, "codex-home"),
      fetchImpl: async () => { called = true; throw new Error("must not be called"); },
    });
    assert.equal(called, false);
    assert.equal(result.available, false);
    assert.equal(result.reason, "no-account");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage sends the streaming request and normalizes a successful response from headers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-success-"));
  try {
    const accountsPath = writeAccountsFile(root, [chatGptAccount()]);
    let seenUrl = null;
    let seenHeaders = null;
    let seenBody = null;
    let seenSignal = null;
    let response;
    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      codexHome: path.join(root, "codex-home"),
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
        seenBody = JSON.parse(init.body);
        seenSignal = init.signal;
        response = fakeResponse({ ok: true, status: 200, headers: headerMap() });
        return response;
      },
    });
    assert.equal(seenUrl, CODEX_RESPONSES_URL);
    assert.equal(seenHeaders.authorization, "Bearer access-token-value");
    assert.equal(seenHeaders["chatgpt-account-id"], "acct_work");
    assert.equal(seenHeaders.accept, "text/event-stream");
    assert.equal(seenBody.model, "gpt-5.4-mini");
    assert.equal(seenBody.stream, true);
    // The live API now rejects this parameter outright ("Unsupported parameter:
    // max_output_tokens"); it must never come back.
    assert.equal("max_output_tokens" in seenBody, false);
    assert.ok(seenSignal, "an AbortSignal must be passed so the request is bounded by a timeout");
    assert.equal(result.available, true);
    assert.equal(result.planType, "prolite");
    assert.equal(result.primary.usedPercent, 31);
    assert.equal(result.secondary, null);
    assert.equal(response.bodyCancelled, true, "the streamed response body must never be downloaded");
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
      codexHome: path.join(root, "codex-home"),
      fetchImpl: async () => {
        callCount += 1;
        return fakeResponse({ ok: false, status: 401 });
      },
    });
    assert.equal(callCount, 1, "a 401 must not trigger any retry attempt");
    assert.equal(result.available, false);
    assert.equal(result.reason, "token-invalid");
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
      codexHome: path.join(root, "codex-home"),
      fetchImpl: async () => { callCount += 1; return fakeResponse({ ok: false, status: 403 }); },
    });
    assert.equal(callCount, 1);
    assert.equal(result.available, false);
    assert.equal(result.reason, "token-invalid");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage reports a non-2xx, non-auth status as request-failed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-400-"));
  try {
    const accountsPath = writeAccountsFile(root, [chatGptAccount()]);
    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      codexHome: path.join(root, "codex-home"),
      fetchImpl: async () => fakeResponse({ ok: false, status: 400 }),
    });
    assert.equal(result.available, false);
    assert.equal(result.reason, "request-failed");
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
        codexHome: path.join(root, "codex-home"),
        fetchImpl: async () => { throw new Error("ECONNRESET"); },
      });
    });
    assert.equal(result.available, false);
    assert.equal(result.reason, "request-failed");
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
      codexHome: path.join(root, "codex-home"),
      fetchImpl: async () => fakeResponse({ ok: true, status: 200, headers: headerMap() }),
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
      codexHome: path.join(root, "codex-home"),
      timeoutMs: 10,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });
    assert.equal(result.available, false);
    assert.equal(result.reason, "request-failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage aborting the controller after a successful header read is not misreported as a failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-abort-ok-"));
  try {
    const accountsPath = writeAccountsFile(root, [chatGptAccount()]);
    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      codexHome: path.join(root, "codex-home"),
      fetchImpl: async (_url, init) => {
        const response = fakeResponse({ ok: true, status: 200, headers: headerMap() });
        // Simulate a fetch implementation that rejects further body access once aborted -- this
        // must not affect the already-resolved result below.
        init.signal.addEventListener("abort", () => {});
        return response;
      },
    });
    assert.equal(result.available, true);
    assert.equal(result.primary.usedPercent, 31);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeAuthDotJson(codexHome, payload) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(payload));
}

function base64UrlEncode(text) {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeToken(payload) {
  return `${base64UrlEncode(JSON.stringify({ alg: "none" }))}.${base64UrlEncode(JSON.stringify(payload))}.signature`;
}

function okJsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => "" };
}

test("fetchAccountUsage refreshes and persists an expired stored token (when auth.json does not belong to this account) before using it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-refresh-"));
  try {
    const codexHome = path.join(root, "codex-home");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiredAccessToken = makeToken({ exp: nowSeconds - 1000, account_id: "acct_work" });
    const accountsPath = writeAccountsFile(root, [chatGptAccount({
      auth_data: {
        type: "chat_g_p_t",
        id_token: "id-token-value",
        access_token: expiredAccessToken,
        refresh_token: "stored-refresh-token",
        account_id: "acct_work",
      },
    })]);
    // auth.json is absent, so there is nothing to prefer over the stored (expired) token.
    let tokenRefreshCalls = 0;
    let seenHeaders = null;
    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      codexHome,
      tokenFetchImpl: async () => {
        tokenRefreshCalls += 1;
        return okJsonResponse({ access_token: "freshly-refreshed-access-token", refresh_token: "freshly-refreshed-refresh-token" });
      },
      fetchImpl: async (_url, init) => {
        seenHeaders = init.headers;
        return fakeResponse({ ok: true, status: 200, headers: headerMap() });
      },
    });

    assert.equal(tokenRefreshCalls, 1);
    assert.equal(seenHeaders.authorization, "Bearer freshly-refreshed-access-token");
    assert.equal(result.available, true);

    const persisted = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    assert.equal(persisted.accounts[0].auth_data.access_token, "freshly-refreshed-access-token");
    assert.equal(persisted.accounts[0].auth_data.refresh_token, "freshly-refreshed-refresh-token");

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("freshly-refreshed-refresh-token"), false);
    assert.equal(serialized.includes("stored-refresh-token"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage reports needs-reauth, without a usage request, when the stored refresh token is dead", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-needs-reauth-"));
  try {
    const codexHome = path.join(root, "codex-home");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiredAccessToken = makeToken({ exp: nowSeconds - 1000 });
    const accountsPath = writeAccountsFile(root, [chatGptAccount({
      auth_data: {
        type: "chat_g_p_t",
        id_token: "id-token-value",
        access_token: expiredAccessToken,
        refresh_token: "dead-refresh-token",
        account_id: "acct_work",
      },
    })]);
    const before = fs.readFileSync(accountsPath, "utf8");
    let usageRequestCalled = false;

    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      codexHome,
      tokenFetchImpl: async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "invalid_grant" }),
      fetchImpl: async () => { usageRequestCalled = true; throw new Error("must not be called"); },
    });

    assert.equal(result.available, false);
    assert.equal(result.reason, "needs-reauth");
    assert.equal(usageRequestCalled, false);
    // accounts.json must be left completely untouched when the refresh itself fails.
    assert.equal(fs.readFileSync(accountsPath, "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage sends the fresher ~/.codex/auth.json access_token when it currently belongs to the requested account", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-fresh-auth-"));
  try {
    const codexHome = path.join(root, "codex-home");
    const accountsPath = writeAccountsFile(root, [chatGptAccount()]);
    // accounts.json's stored token is stale; auth.json (continuously refreshed by Codex) currently
    // authenticates as this same account (matched on account_id) and must be preferred.
    writeAuthDotJson(codexHome, {
      tokens: {
        id_token: "unrelated-id-token",
        access_token: "fresh-auth-json-access-token",
        refresh_token: "fresh-auth-json-refresh-token",
        account_id: "acct_work",
      },
    });
    let seenHeaders = null;
    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      codexHome,
      fetchImpl: async (_url, init) => {
        seenHeaders = init.headers;
        return fakeResponse({ ok: true, status: 200, headers: headerMap() });
      },
    });
    assert.equal(seenHeaders.authorization, "Bearer fresh-auth-json-access-token");
    assert.equal(seenHeaders["chatgpt-account-id"], "acct_work");
    assert.equal(result.available, true);
    // The stale stored token, and any other auth.json secret, must never appear in the result.
    const serialized = JSON.stringify(result);
    for (const secret of ["access-token-value", "unrelated-id-token", "fresh-auth-json-refresh-token"]) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage uses the stored token when auth.json belongs to a different account", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-other-account-"));
  try {
    const codexHome = path.join(root, "codex-home");
    const accountsPath = writeAccountsFile(root, [
      chatGptAccount(),
      chatGptAccount({
        id: "other-account",
        auth_data: {
          type: "chat_g_p_t",
          id_token: "id-token-value",
          access_token: "other-access-token",
          refresh_token: "other-refresh-token",
          account_id: "acct_other",
        },
      }),
    ]);
    // auth.json is currently authenticated as "other-account", not the requested "work-account".
    writeAuthDotJson(codexHome, {
      tokens: {
        id_token: "id-token-value",
        access_token: "fresh-other-access-token",
        refresh_token: "r",
        account_id: "acct_other",
      },
    });
    let seenHeaders = null;
    const result = await fetchAccountUsage("work-account", {
      accountsPath,
      codexHome,
      fetchImpl: async (_url, init) => {
        seenHeaders = init.headers;
        return fakeResponse({ ok: true, status: 200, headers: headerMap() });
      },
    });
    assert.equal(seenHeaders.authorization, "Bearer access-token-value");
    assert.equal(result.available, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchAccountUsage falls back to the stored token, never sending a malformed request, when auth.json holds an API-key credential", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-apikey-active-"));
  try {
    const codexHome = path.join(root, "codex-home");
    // The requested account itself is API-key based, and auth.json currently holds that exact
    // key -- so it is the "active" account, but there is no bearer token available for this
    // ChatGPT-only usage endpoint.
    const accountsPath = writeAccountsFile(root, [{
      id: "api-account",
      name: "API",
      auth_mode: "api_key",
      auth_data: { type: "api_key", key: "sk-abcdefghijklmnopqrstuvwxyz" },
    }]);
    writeAuthDotJson(codexHome, { OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz" });
    let called = false;
    const result = await fetchAccountUsage("api-account", {
      accountsPath,
      codexHome,
      fetchImpl: async () => { called = true; throw new Error("must not be called"); },
    });
    assert.equal(called, false, "no network call should be attempted without a usable bearer token");
    assert.equal(result.available, false);
    assert.equal(result.reason, "no-account");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
