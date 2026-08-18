const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const browserHostSource = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");

test("embedded ChatGPT is measured only after its animated surface mounts", () => {
  assert.match(appSource, /const \[browserSlot, setBrowserSlot\] = useState<HTMLDivElement \| null>\(null\)/);
  assert.match(appSource, /setBrowserSurfaceActive\(browserSurfaceActive\)\.then\(\(\) => \{/);
  assert.match(appSource, /observer\.observe\(browserSlot\)/);
  assert.match(appSource, /ref=\{browserSlotRef\}/);
});

test("closing the launcher follows the persisted background-runtime preference", () => {
  assert.match(
    electronMain,
    /if \(stateStore\.read\(\)\.keepRunningOnClose && tray\) window\.hide\(\);\s*else void requestQuit\(\);/,
  );
  assert.match(appSource, /setPreference\("keepRunningOnClose", checked\)/);
});

test("normal shutdown persists the ChatGPT session before closing browser views", () => {
  const persist = electronMain.indexOf("await browserHost?.persistSession()");
  const destroy = electronMain.indexOf("browserHost?.destroy()", persist);
  assert.ok(persist >= 0, "shutdown must persist the ChatGPT session");
  assert.ok(destroy > persist, "browser views must close only after session persistence completes");
});

test("quitting the launcher restores the Codex route before the runtime that serves it stops", () => {
  const requestQuitStart = electronMain.indexOf("async function requestQuit(");
  const restoreCall = electronMain.indexOf("runtimeHost.restoreBridgeRoute(\"app-quit-fail-safe\")", requestQuitStart);
  const supervisorShutdown = electronMain.indexOf("await runtimeSupervisor?.shutdown()", requestQuitStart);
  assert.ok(requestQuitStart >= 0, "requestQuit must exist");
  assert.ok(restoreCall > requestQuitStart, "requestQuit must restore the Codex route");
  assert.ok(
    supervisorShutdown > restoreCall,
    "the route must be restored before the runtime serving it is shut down",
  );
});

test("switching accounts relaunches the app onto the new partition instead of leaving BrowserHost stale", () => {
  const switchStart = electronMain.indexOf('handle("launcher:switch-account"');
  const switchEnd = electronMain.indexOf('handle("launcher:logs"', switchStart);
  const handler = electronMain.slice(switchStart, switchEnd);
  assert.ok(switchStart >= 0 && switchEnd > switchStart, "switch-account handler must remain registered");
  assert.match(handler, /writeCodexAuth\(accountId\)/);
  const writeIndex = handler.indexOf("writeCodexAuth(accountId)");
  const relaunchIndex = handler.indexOf("requestQuit({ relaunch: true })");
  assert.ok(relaunchIndex > writeIndex, "the switch must relaunch after auth.json is rewritten");
  assert.match(handler, /if \(!result\.ok\)/);
  assert.match(handler, /could not/);
});

test("requestQuit only schedules a relaunch once quitting is certain to proceed", () => {
  const requestQuitStart = electronMain.indexOf("async function requestQuit(");
  const relaunchCall = electronMain.indexOf("app.relaunch()", requestQuitStart);
  const quitCall = electronMain.indexOf("app.quit()", requestQuitStart);
  const exitCommitted = electronMain.indexOf("exitCommitted = true", requestQuitStart);
  assert.ok(relaunchCall > exitCommitted, "app.relaunch() must be scheduled only after quitting is committed");
  assert.ok(quitCall > relaunchCall, "app.relaunch() must run before app.quit() actually exits");
});

test("an uncaught exception or rejection restores the Codex route before the process exits", () => {
  assert.match(
    electronMain,
    /process\.on\("uncaughtException", \(error\) => \{ void crashRecoverAndExit\("uncaughtException", error\); \}\);/,
  );
  assert.match(
    electronMain,
    /process\.on\("unhandledRejection", \(reason\) => \{ void crashRecoverAndExit\("unhandledRejection", reason\); \}\);/,
  );
  const crashRecoverStart = electronMain.indexOf("async function crashRecoverAndExit(");
  const restoreCall = electronMain.indexOf("runtimeHost.restoreBridgeRoute(\"app-crash-fail-safe\")", crashRecoverStart);
  const exitCall = electronMain.indexOf("process.exit(1)", crashRecoverStart);
  assert.ok(crashRecoverStart >= 0, "crashRecoverAndExit must exist");
  assert.ok(restoreCall > crashRecoverStart, "crashRecoverAndExit must restore the Codex route");
  assert.ok(exitCall > restoreCall, "the process must exit only after the restore attempt settles");
});

test("the renderer bridge switch reaches the fail-closed runtime route", () => {
  assert.match(appSource, /api!\.setBridgeEnabled\(enabled\)/);
  assert.match(electronMain, /runtimeHost\.setBridgeEnabled\(enabled === true\)/);
  assert.match(electronMain, /codexRestartRequired:\s*true/);
});

test("MCP connection remains unavailable until the model catalog is verified", () => {
  assert.match(
    appSource,
    /snapshot\.state\.codexCatalogVerified \? copy\.mcpStepTwoHint : copy\.mcpCatalogRequired/,
  );
  assert.match(appSource, /\|\| !snapshot\.state\.codexCatalogVerified/);
});

test("MCP navigation remains locked while an operation is active", () => {
  assert.match(appSource, /<McpSurface[\s\S]*?operation=\{operation\}/);
  assert.match(appSource, /const busy = localBusy \|\| operation\?\.status === "running"/);
  assert.match(appSource, /const safeMove = async \(next: number\) => \{\s*if \(busy\) return;/);
  assert.match(appSource, /disabled=\{busy \|\| index > step\}/);
});

test("failed doctor reports retain every failed check", () => {
  assert.match(
    appSource,
    /report\.ok\s*\?\s*report\.checks\.slice\(-6\)\s*:\s*report\.checks\.filter\(\(check\) => check\.status !== "ok"\)/,
  );
  assert.match(appSource, /visibleChecks\.map\(\(check\) =>/);
});

test("MCP verification proves runtime health before checking the connector", () => {
  const start = electronMain.indexOf('handle("launcher:mcp-verify"');
  const end = electronMain.indexOf('handle("launcher:doctor"', start);
  const handler = electronMain.slice(start, end);

  assert.ok(start >= 0 && end > start, "MCP verification handler must remain registered");
  assert.match(
    handler,
    /Checking local runtime[\s\S]*?await runtimeHost\.doctor\(\)[\s\S]*?if \(!report\.ok\)[\s\S]*?return report;[\s\S]*?Checking ChatGPT connector[\s\S]*?await browserHost\.verifyConnector/,
  );
  assert.match(handler, /publishOperation\(\{ name: operationName, status: "completed"/);
  assert.match(appSource, /onClick=\{\(\) => void \(doctor\?\.ok \? onDone\(\) : verify\(\)\)\}/);
  assert.match(appSource, /operation\?\.name === "mcp-verification"/);
});

test("saved ChatGPT authentication is refreshed before setup is presented", () => {
  assert.match(electronMain, /browserHost\.refreshAuthentication\(\)/);
  assert.match(appSource, /browser\?\.status === "loading" \? copy\.checkingSignIn/);
});

test("completed model setup remains a repeatable capability probe", () => {
  assert.match(appSource, /<SetupRow[\s\S]*?onAction=\{install\}[\s\S]*?repeatable/);
  assert.match(appSource, /complete && !repeatable/);
  assert.match(
    electronMain,
    /!setupState\.coreSetupComplete[\s\S]*?smokePassedThisSession[\s\S]*?smokePassedForCurrentVersion\(setupState\)/,
  );
});

test("a completed runtime upgrade never writes bridgeEnabled, so it cannot clobber the user's intent", () => {
  // `upgradeManagedRuntime()` mechanically disconnects the Codex bridge route while it swaps
  // runtime binaries, then reports that transient observation back as `upgrade.bridgeEnabled`.
  // That is diagnostic information about what the upgrade *did* to the route, not a statement of
  // what the user *wants*. `bridgeEnabled` in launcher state is the user's persisted INTENT and
  // must only change through a genuine user action (Settings toggle, first-time setup, explicit
  // uninstall) -- see bridge-reconcile.cjs. If this startup block ever writes
  // `bridgeEnabled: upgrade.bridgeEnabled` into stateStore.update(...), it silently overwrites the
  // user's real intent with the upgrade's mechanical side effect, and because this runs BEFORE
  // reconcileBridgeOnStartup, the reconciler then faithfully "honors" the clobbered value and
  // leaves the bridge off after every version upgrade. Assert the key is absent from that patch.
  const upgradeStart = electronMain.indexOf("const upgrade = await runtimeHost.upgradeManagedRuntime();");
  assert.ok(upgradeStart >= 0, "the runtime-upgrade startup step must remain in main.cjs");
  const updateStart = electronMain.indexOf("const state = stateStore.update({", upgradeStart);
  const updateEnd = electronMain.indexOf("});", updateStart);
  assert.ok(updateStart > upgradeStart && updateEnd > updateStart, "the upgrade's stateStore.update(...) call must remain in main.cjs");
  const patch = electronMain.slice(updateStart, updateEnd);
  assert.doesNotMatch(patch, /bridgeEnabled/, "the upgrade path must not overwrite the user's persisted bridge intent");
  assert.match(patch, /coreSetupComplete:\s*true/, "the rest of the upgrade patch must remain intact");

  // The diagnostic log line downstream may still report the observed value -- that is useful and
  // must stay -- it just must never be persisted as intent.
  const logStart = electronMain.indexOf('logger.info("runtime.release_upgraded"', updateEnd);
  assert.ok(logStart > updateEnd, "the runtime.release_upgraded diagnostic log must remain");
  const logEnd = electronMain.indexOf("});", logStart);
  assert.match(electronMain.slice(logStart, logEnd), /bridgeEnabled:\s*upgrade\.bridgeEnabled/);

  // reconcileBridgeOnStartup must run immediately after, so any transient teardown from the
  // upgrade gets reconciled back to the user's real (untouched) intent.
  const reconcileCall = electronMain.indexOf("reconcileBridgeOnStartup(", updateEnd);
  assert.ok(reconcileCall > updateEnd, "startup must reconcile the route to intent right after the upgrade step");
});

test("session reminders expose dismissal and a real storage-clearing logout", () => {
  assert.match(electronMain, /sessionRefreshReminderAt:\s*nextSessionRefreshReminderAt\(\)/);
  assert.match(electronMain, /launcher:session-reminder-dismiss/);
  assert.match(electronMain, /launcher:browser-logout[\s\S]*?browserHost\.logout\(\)/);
  assert.match(preloadSource, /dismissSessionReminder:[\s\S]*?launcher:session-reminder-dismiss/);
  assert.match(preloadSource, /logoutChatGpt:[\s\S]*?launcher:browser-logout/);
  assert.match(browserHostSource, /session\.clearStorageData\(\)/);
});
