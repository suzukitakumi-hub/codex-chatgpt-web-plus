// Reconciles the Codex bridge ROUTE to the user's persisted intent at launcher startup.
//
// `bridgeEnabled` in launcher state is the user's INTENT and must only ever change through an
// explicit user action (the Settings toggle, first-time setup, or uninstall). It must never be
// inferred from the route that happens to be observed at startup, because the route can be
// inactive for reasons that have nothing to do with what the user wants:
//
//   `requestQuit` in main.cjs calls `runtimeHost.restoreBridgeRoute("app-quit-fail-safe")` on
//   EVERY graceful quit. That fail-safe is intentional and must stay -- it exists so a launcher
//   that is going away never leaves Codex's config.toml pointed at a local server that is about
//   to disappear. But it means the route is *always* inactive immediately after a graceful quit,
//   even when the user's intent is (and remains) ON.
//
// Previously, startup synced intent DOWN from that observation ("the route is inactive, so the
// user must want it off"), which meant every graceful quit permanently disabled the bridge.
// Account switching made this worse because it always relaunches through requestQuit.
//
// The fix: on startup, reconcile the ROUTE to the user's INTENT, not the other way around, in
// BOTH directions:
//   - intent ON but the route is inactive -> re-activate it through `runtimeHost.setBridgeEnabled`
//     -- the same entry point the Settings toggle uses -- rather than hand-rolling a config.toml
//     edit here.
//   - intent OFF but the route is (still, or again) active -> deactivate it through
//     `runtimeHost.restoreBridgeRoute`, the same "put the previous route back" entry point the
//     quit and runtime-failure paths already use. Leaving this direction unhandled would recreate
//     the exact failure this project started from: config.toml would keep pointing at
//     `http://127.0.0.1:.../v1` while the launcher deliberately does not start the runtime that
//     serves it (see the early-return contract below), so Codex would sit on a dead endpoint and
//     retry forever.
// Either direction may fail without crashing startup or flipping the user's intent -- the failure
// is only surfaced through the existing log/operation channels so the next launch can retry.
async function reconcileBridgeOnStartup({ runtimeHost, stateStore, logger, publishOperation }) {
  const route = await runtimeHost.bridgeStatus();
  if (!route.installed) return { status: "not-installed", route };

  const intentEnabled = stateStore.read().bridgeEnabled === true;

  if (intentEnabled && !route.active) {
    try {
      await runtimeHost.setBridgeEnabled(true);
    } catch (error) {
      // Re-activation failed. Do not crash startup, and do not silently flip the user's intent
      // to off -- leaving it untouched means the next launch will simply retry. Surface the
      // failure through the existing operation/log channels so the user can see why the bridge
      // did not come back.
      const message = error instanceof Error ? error.message : String(error);
      logger?.error("bridge.route_reactivation_failed", { message });
      publishOperation?.({ name: "bridge-route-reactivate", status: "failed", message });
    }
  } else if (!intentEnabled && route.active) {
    try {
      await runtimeHost.restoreBridgeRoute("bridge-route-deactivate-on-startup");
    } catch (error) {
      // Deactivation failed. Same discipline as above: do not crash startup, do not flip the
      // user's (OFF) intent to on just because we failed to honor it, and surface the failure so
      // it is visible instead of leaving config.toml silently pointed at a dead endpoint.
      const message = error instanceof Error ? error.message : String(error);
      logger?.error("bridge.route_deactivation_failed", { message });
      publishOperation?.({ name: "bridge-route-deactivate", status: "failed", message });
    }
  }

  // Preserve the pre-existing "genuinely disabled" early-return contract: callers use this to
  // skip starting the local runtime entirely when the bridge is (still, deliberately) off.
  if (!intentEnabled) return { status: "bridge-disabled", route };
  return { status: "bridge-enabled", route };
}

module.exports = { reconcileBridgeOnStartup };
