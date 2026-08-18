const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcileBridgeOnStartup } = require("../electron/bridge-reconcile.cjs");

function fakeStateStore(initial) {
  let state = { ...initial };
  return {
    read: () => ({ ...state }),
    update(patch) {
      state = { ...state, ...patch };
      return { ...state };
    },
  };
}

// Mirrors the real RuntimeHost route lifecycle closely enough to encode the regression: quitting
// deactivates the route (the app-quit-fail-safe in requestQuit), reconnecting reactivates it
// (the same path launcher:set-bridge-enabled uses), and restoreBridgeRoute is also the entry
// point startup reuses to deactivate a route the user's intent says should be off.
function fakeRuntimeHost({ installed = true, active = true, setBridgeEnabledImpl, restoreBridgeRouteImpl } = {}) {
  const calls = { setBridgeEnabled: [], restoreBridgeRoute: [], bridgeStatus: 0 };
  const host = {
    installed,
    active,
    async bridgeStatus() {
      calls.bridgeStatus += 1;
      return { installed: host.installed, active: host.active, errors: [] };
    },
    async restoreBridgeRoute(operationName) {
      calls.restoreBridgeRoute.push(operationName);
      if (restoreBridgeRouteImpl) return restoreBridgeRouteImpl(operationName, host);
      // Simulates requestQuit's "app-quit-fail-safe" (and the real restoreBridgeRoute): tears
      // the route down unconditionally.
      host.active = false;
      return { installed: host.installed, active: false, errors: [] };
    },
    async setBridgeEnabled(enabled) {
      calls.setBridgeEnabled.push(enabled);
      if (setBridgeEnabledImpl) return setBridgeEnabledImpl(enabled, host);
      host.active = enabled === true;
      return { installed: host.installed, active: host.active, errors: [] };
    },
  };
  return { host, calls };
}

function fakeLogger() {
  const errors = [];
  return { logger: { error: (event, fields) => errors.push({ event, fields }), warn() {}, info() {} }, errors };
}

test("regression: a graceful quit followed by a startup with intent ON ends with the route active", async () => {
  const { host, calls } = fakeRuntimeHost({ installed: true, active: true });
  const stateStore = fakeStateStore({ bridgeEnabled: true });
  const { logger, errors } = fakeLogger();
  const operations = [];

  // Simulate what requestQuit does on every graceful quit: the fail-safe tears the route down.
  // Crucially, this must NOT touch the persisted intent.
  await host.restoreBridgeRoute("app-quit-fail-safe");
  assert.equal(host.active, false);
  assert.equal(stateStore.read().bridgeEnabled, true, "quitting must never touch the user's intent");

  // Simulate the next startup, with the user's intent still ON.
  const result = await reconcileBridgeOnStartup({
    runtimeHost: host,
    stateStore,
    logger,
    publishOperation: (op) => operations.push(op),
  });

  assert.equal(host.active, true, "the route must be reactivated to match the user's intent");
  assert.equal(stateStore.read().bridgeEnabled, true, "intent must remain ON, unchanged by the reconciliation");
  assert.equal(result.status, "bridge-enabled");
  assert.deepEqual(calls.setBridgeEnabled, [true]);
  assert.deepEqual(errors, []);
  assert.deepEqual(operations, []);
});

test("does not reactivate, and makes no extra calls, when intent is ON and the route is already active", async () => {
  const { host, calls } = fakeRuntimeHost({ installed: true, active: true });
  const stateStore = fakeStateStore({ bridgeEnabled: true });
  const { logger } = fakeLogger();

  const result = await reconcileBridgeOnStartup({ runtimeHost: host, stateStore, logger, publishOperation: () => {} });

  assert.equal(result.status, "bridge-enabled");
  assert.deepEqual(calls.setBridgeEnabled, []);
});

test("leaves a deliberately disabled bridge disabled and does not reactivate the route", async () => {
  const { host, calls } = fakeRuntimeHost({ installed: true, active: false });
  const stateStore = fakeStateStore({ bridgeEnabled: false });
  const { logger } = fakeLogger();

  const result = await reconcileBridgeOnStartup({ runtimeHost: host, stateStore, logger, publishOperation: () => {} });

  assert.equal(result.status, "bridge-disabled");
  assert.equal(host.active, false);
  assert.deepEqual(calls.setBridgeEnabled, []);
  assert.equal(stateStore.read().bridgeEnabled, false);
});

test("does not crash startup and does not flip intent to off when reactivation fails", async () => {
  const { host, calls } = fakeRuntimeHost({
    installed: true,
    active: false,
    setBridgeEnabledImpl: async () => { throw new Error("runtime is unreachable"); },
  });
  const stateStore = fakeStateStore({ bridgeEnabled: true });
  const { logger, errors } = fakeLogger();
  const operations = [];

  const result = await reconcileBridgeOnStartup({
    runtimeHost: host,
    stateStore,
    logger,
    publishOperation: (op) => operations.push(op),
  });

  assert.equal(result.status, "bridge-enabled", "startup must not report the bridge as disabled");
  assert.equal(stateStore.read().bridgeEnabled, true, "a failed reactivation must not silently flip the user's intent off");
  assert.equal(host.active, false, "the route stays inactive; nothing here should crash the process");
  assert.deepEqual(calls.setBridgeEnabled, [true]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].fields.message, /runtime is unreachable/);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].status, "failed");
});

test("does nothing when the integration is not installed", async () => {
  const { host, calls } = fakeRuntimeHost({ installed: false, active: false });
  const stateStore = fakeStateStore({ bridgeEnabled: true });
  const { logger } = fakeLogger();

  const result = await reconcileBridgeOnStartup({ runtimeHost: host, stateStore, logger, publishOperation: () => {} });

  assert.equal(result.status, "not-installed");
  assert.deepEqual(calls.setBridgeEnabled, []);
});

// This is the other reconciliation direction: intent OFF but the route was left (or came back)
// active. Leaving this direction unhandled would recreate the exact failure this project started
// from -- config.toml would keep pointing Codex at a local endpoint the launcher deliberately
// never starts a runtime for (the "bridge-disabled" early-return skips runtimeSupervisor
// startup), so Codex would sit on a dead endpoint and retry forever.
test("deactivates the route when intent is OFF but the route is observed active, without flipping intent", async () => {
  const { host, calls } = fakeRuntimeHost({ installed: true, active: true });
  const stateStore = fakeStateStore({ bridgeEnabled: false });
  const { logger, errors } = fakeLogger();
  const operations = [];

  const result = await reconcileBridgeOnStartup({
    runtimeHost: host,
    stateStore,
    logger,
    publishOperation: (op) => operations.push(op),
  });

  assert.equal(host.active, false, "the route must be deactivated to match the user's OFF intent");
  assert.equal(stateStore.read().bridgeEnabled, false, "intent must remain OFF, unchanged by the reconciliation");
  assert.equal(result.status, "bridge-disabled");
  assert.deepEqual(calls.restoreBridgeRoute, ["bridge-route-deactivate-on-startup"]);
  assert.deepEqual(calls.setBridgeEnabled, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(operations, []);
});

test("does not crash startup and does not flip intent to on when deactivation fails, and surfaces it", async () => {
  const { host, calls } = fakeRuntimeHost({
    installed: true,
    active: true,
    restoreBridgeRouteImpl: async () => { throw new Error("route command failed"); },
  });
  const stateStore = fakeStateStore({ bridgeEnabled: false });
  const { logger, errors } = fakeLogger();
  const operations = [];

  const result = await reconcileBridgeOnStartup({
    runtimeHost: host,
    stateStore,
    logger,
    publishOperation: (op) => operations.push(op),
  });

  assert.equal(result.status, "bridge-disabled", "intent is still OFF, regardless of whether deactivation succeeded");
  assert.equal(stateStore.read().bridgeEnabled, false, "a failed deactivation must not silently flip the user's intent on");
  assert.equal(host.active, true, "the route stays active; nothing here should crash the process");
  assert.deepEqual(calls.restoreBridgeRoute, ["bridge-route-deactivate-on-startup"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].fields.message, /route command failed/);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].status, "failed");
});
