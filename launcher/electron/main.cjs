const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Tray,
} = require("electron");
const {
  isCodexRunning,
  partitionForAccount,
  readSwitcherAccounts,
  resolveActiveAccountId,
  writeCodexAuth,
} = require("./accounts.cjs");
const { fetchAccountUsage } = require("./account-usage.cjs");
const { ensureFreshChatGptAuth } = require("./credential-provider.cjs");
const { importFromAuthDotJson } = require("./credential-import.cjs");
const { reconcileBridgeOnStartup } = require("./bridge-reconcile.cjs");
const { BrowserHost } = require("./browser-host.cjs");
const { BrowserControlServer } = require("./control-server.cjs");
const { getAutostart, setAutostart } = require("./autostart.cjs");
const {
  createLogger,
  installProcessDiagnosticGuards,
  registerLoggedIpc,
} = require("./logging.cjs");
const { RuntimeHost } = require("./runtime.cjs");
const { ensurePackagedRuntime } = require("./runtime-install.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");
const { createUpdateController } = require("./update.cjs");
const { resolveUserDataDir } = require("./user-data-dir.cjs");
const {
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
} = require("./state.cjs");
const {
  MIN_WINDOW_BOUNDS,
  readWindowState,
  trackWindowState,
} = require("./window-state.cjs");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const SOURCE_ROOT = path.resolve(__dirname, "../..");
function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}
const CORE_HOME = process.env.CODEX_CHATGPT_WEB_HOME?.trim()
  ? resolveUserPath(process.env.CODEX_CHATGPT_WEB_HOME.trim())
  : path.join(os.homedir(), ".codex-chatgpt-web");
const BROWSER_DESCRIPTOR_PATH = path.join(CORE_HOME, "runtime", "launcher-browser.json");
const BROWSER_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "runtime", "app", "browser-helper.cjs")
  : path.join(SOURCE_ROOT, ".launcher-runtime", "browser-helper.cjs");
const PRODUCT_NAME = "Codex Master";
const GITHUB_URL = "https://github.com/suzukitakumi-hub/codex-chatgpt-web-plus";
const X_URL = "https://x.com/yukime_jiyoung";
const CONNECTORS_URL = "https://chatgpt.com/#settings/Plugins";
const TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";
const KEYS_URL = "https://platform.openai.com/settings/organization/api-keys";
const ALLOWED_EXTERNAL_URLS = new Set([GITHUB_URL, X_URL, CONNECTORS_URL, TUNNELS_URL, KEYS_URL]);
const PACKAGED_RENDERER_URL = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
const APP_ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");

app.setName(PRODUCT_NAME);
if (process.platform === "win32") app.setAppUserModelId("com.suzukitakumi.codex-chatgpt-web-plus");
// Resolves (and, on first run after the rebrand, migrates) the userData directory. This runs
// before the logger exists, so the outcome is logged once `start()` creates one; see the
// `launcher.user_data_dir_resolved` log line below.
const userDataResolution = resolveUserDataDir({
  appDataRoot: app.getPath("appData"),
  envOverride: process.env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR,
  existsSync: fs.existsSync,
  renameSync: fs.renameSync,
});
const launcherUserData = userDataResolution.dir;
fs.mkdirSync(launcherUserData, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") fs.chmodSync(launcherUserData, 0o700);
app.setPath("userData", launcherUserData);
installProcessDiagnosticGuards({
  filePath: path.join(launcherUserData, "logs", "process-stream-errors.log"),
});

let mainWindow = null;
let browserHost = null;
let runtimeHost = null;
let logger = null;
let browserControl = null;
let runtimeSupervisor = null;
let tray = null;
let quitting = false;
let shutdownInProgress = false;
let exitCommitted = false;
let smokePassedThisSession = false;
let cdpPort = 0;
let lastOperation = null;
let catalogVerificationTimer = null;
let catalogVerificationInFlight = false;
let updateController = null;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function publishOperation(operation) {
  lastOperation = operation;
  send("launcher:operation", operation);
}

function stopCatalogVerificationMonitor() {
  if (catalogVerificationTimer) clearInterval(catalogVerificationTimer);
  catalogVerificationTimer = null;
}

function startCatalogVerificationMonitor({ logger, stateStore }) {
  stopCatalogVerificationMonitor();
  const check = async () => {
    const current = stateStore.read();
    if (current.coreSetupComplete !== true || current.codexCatalogVerified === true) {
      stopCatalogVerificationMonitor();
      return;
    }
    if (catalogVerificationInFlight || !runtimeSupervisor) return;
    catalogVerificationInFlight = true;
    try {
      const config = runtimeSupervisor.readConfig();
      const health = await runtimeSupervisor.proxyHealthPayload(config);
      if (!Number.isInteger(health?.successful_model_catalog_requests)
        || health.successful_model_catalog_requests < 1) return;
      const state = stateStore.update({
        codexCatalogVerified: true,
        codexRestartRequired: false,
      });
      logger.info("codex.model_catalog_verified", {
        requests: health.successful_model_catalog_requests,
        at: health.last_successful_model_catalog_request_at,
      });
      send("launcher:state-changed", state);
      stopCatalogVerificationMonitor();
    } catch (error) {
      logger.debug("codex.model_catalog_verification_pending", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      catalogVerificationInFlight = false;
    }
  };
  catalogVerificationTimer = setInterval(() => { void check(); }, 2_000);
  catalogVerificationTimer.unref?.();
  void check();
}

async function restoreCodexRouteAfterRuntimeFailure({ logger, stateStore }) {
  try {
    const route = await runtimeHost.restoreBridgeRoute("runtime-start-fail-safe");
    if (!route.installed || route.active) return { restored: false };
    const state = stateStore.update({
      bridgeEnabled: false,
      codexCatalogVerified: false,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    logger.warn("bridge.route_restored_after_runtime_failure", {
      changed: route.changed === true,
    });
    return { restored: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("bridge.route_restore_after_runtime_failure_failed", { message });
    return { restored: false, error: message };
  }
}

function trayImage() {
  if (process.platform !== "darwin") {
    return nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 18, height: 18 });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M4.1 3.4h6.4l3.4 3.4v7.8H7.5l-3.4-3.4V3.4Z" fill="none" stroke="white" stroke-width="1.5" stroke-linejoin="round"/><path d="m7 7 2-2 2 2M7 11l2 2 2-2" fill="none" stroke="white" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  image.setTemplateImage(true);
  return image;
}

function createTray(logger) {
  try {
    tray = new Tray(trayImage());
    tray.setToolTip(PRODUCT_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Open ${PRODUCT_NAME}`, click: () => showMainWindow() },
      { type: "separator" },
      { label: "Quit", click: () => { void requestQuit(); } },
    ]));
    tray.on("click", () => showMainWindow());
    return true;
  } catch (error) {
    tray = null;
    logger.warn("launcher.tray_unavailable", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function openWebUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing to open a non-web URL: ${parsed.protocol}`);
  }
  await shell.openExternal(parsed.toString());
}

function rendererNavigationAllowed(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (isDev) {
    try {
      return target.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin;
    } catch {
      return false;
    }
  }
  target.hash = "";
  target.search = "";
  return target.href === PACKAGED_RENDERER_URL;
}

function windowStateSnapshot(window) {
  return {
    fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
  };
}

function createWindow({ logger, stateStore, windowStatePath, startHidden }) {
  const isMac = process.platform === "darwin";
  const state = stateStore.read();
  const windowState = readWindowState(windowStatePath, screen.getAllDisplays());
  const window = new BrowserWindow({
    width: windowState.bounds.width,
    height: windowState.bounds.height,
    ...(Number.isFinite(windowState.bounds.x) && Number.isFinite(windowState.bounds.y)
      ? { x: windowState.bounds.x, y: windowState.bounds.y }
      : {}),
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    title: PRODUCT_NAME,
    icon: APP_ICON_PATH,
    show: false,
    backgroundColor: isMac ? "#00000000" : "#181818",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    transparent: isMac,
    ...(isMac ? {
      trafficLightPosition: { x: 16, y: 17 },
      vibrancy: "under-window",
      visualEffectState: "active",
    } : {
      titleBarOverlay: {
        color: "#181818",
        symbolColor: "#a8a8a8",
        height: 46,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      v8CacheOptions: "bypassHeatCheckAndEagerCompile",
    },
  });
  window.setMenuBarVisibility(false);
  const guardRendererNavigation = (event, url) => {
    if (rendererNavigationAllowed(url)) return;
    event.preventDefault();
    let destination = "invalid URL";
    try { destination = new URL(url).origin; } catch {}
    logger.warn("launcher.renderer_navigation_blocked", { destination });
  };
  window.webContents.on("will-navigate", guardRendererNavigation);
  window.webContents.on("will-redirect", guardRendererNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openWebUrl(url).catch((error) => {
      logger.warn("launcher.external_url_rejected", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { action: "deny" };
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (stateStore.read().keepRunningOnClose && tray) window.hide();
    else void requestQuit();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  for (const event of ["enter-full-screen", "leave-full-screen", "maximize", "unmaximize"]) {
    window.on(event, () => send("launcher:window-state-changed", windowStateSnapshot(window)));
  }
  window.once("ready-to-show", () => {
    if (!state.onboardingComplete && !Number.isFinite(windowState.bounds.x)) window.center();
    if (windowState.maximized) window.maximize();
    if (windowState.fullscreen) window.setFullScreen(true);
    if (!startHidden) window.show();
  });
  trackWindowState(window, windowStatePath, (error) => {
    logger.warn("launcher.window_state_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  logger.info("launcher.window_created", { platform: process.platform, cdpPort });
  return window;
}

async function loadRenderer(window) {
  if (isDev) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function validateLanguage(value) {
  if (value !== "en" && value !== "zh-CN" && value !== "ja") throw new Error("Language must be en, zh-CN, or ja");
  return value;
}

function validateBounds(value) {
  if (!value || typeof value !== "object") throw new Error("Browser bounds are required");
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(value[key])) throw new Error(`Browser bounds ${key} must be finite`);
  }
  return value;
}

function smokePassedForCurrentVersion(state) {
  return state.browserSmokePassed === true && state.browserSmokeVersion === app.getVersion();
}

function registerIpc({ logger, stateStore }) {
  const handle = (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, handler);
  handle("launcher:snapshot", async () => ({
    state: stateStore.read(),
    browser: browserHost?.snapshot() ?? null,
    connectorName: runtimeHost.browserConnectorName(),
    mcpCredentialsConfigured: runtimeHost?.mcpCredentialsConfigured() ?? false,
    logs: logger.recent(),
    urls: { github: GITHUB_URL, x: X_URL, connectors: CONNECTORS_URL, tunnels: TUNNELS_URL, keys: KEYS_URL },
    platform: process.platform,
    packaged: app.isPackaged,
    version: app.getVersion(),
    smokePassed: smokePassedThisSession || smokePassedForCurrentVersion(stateStore.read()),
    operation: lastOperation,
    update: updateController?.getState() ?? { status: "disabled" },
  }));

  handle("launcher:set-language", (_event, language) => stateStore.update({ language: validateLanguage(language) }));
  handle("launcher:open-social", async (_event, target) => {
    const url = target === "github" ? GITHUB_URL : target === "x" ? X_URL : null;
    if (!url) throw new Error("Unknown social target");
    await openWebUrl(url);
    const patch = target === "github" ? { githubOpened: true } : { xOpened: true };
    return stateStore.update(patch);
  });
  handle("launcher:complete-onboarding", (_event, language) => {
    const current = stateStore.read();
    if (!current.githubOpened || !current.xOpened) throw new Error("Open the GitHub and X pages before continuing");
    if (current.autoStart) setAutostart(app, true);
    const next = stateStore.update({ language: validateLanguage(language), onboardingComplete: true });
    logger.info("launcher.onboarding_completed", { language: next.language });
    return next;
  });

  handle("launcher:open-external", async (_event, url) => {
    if (!ALLOWED_EXTERNAL_URLS.has(url)) throw new Error("External URL is not allowlisted");
    await openWebUrl(url);
    return true;
  });

  handle("launcher:browser-bounds", (_event, bounds) => {
    browserHost?.setBounds(validateBounds(bounds));
    return true;
  });
  handle("launcher:browser-surface-active", (_event, active) => browserHost.setSurfaceActive(active === true));
  handle("launcher:browser-show", () => browserHost.reveal());
  handle("launcher:browser-hide", () => { browserHost?.hide(); return browserHost?.snapshot(); });
  handle("launcher:browser-navigate", (_event, action) => browserHost.navigate(action));
  handle("launcher:browser-navigate-home", (_event, url) => browserHost.navigateHome(url));
  handle("launcher:browser-zoom", (_event, action) => browserHost.zoom(action));
  handle("launcher:browser-tab-select", (_event, tabId) => browserHost.selectTab(tabId));
  handle("launcher:browser-tab-close", (_event, tabId) => browserHost.closeTab(tabId));
  handle("launcher:browser-login", async () => {
    const browser = await browserHost.openLogin();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
    }
    return browser;
  });
  handle("launcher:browser-logout", async () => {
    const browser = await browserHost.logout();
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return { browser, state };
  });
  handle("launcher:session-reminder-dismiss", () => {
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:browser-smoke", async () => {
    const result = await browserHost.smokeTest();
    stateStore.update({ browserSmokePassed: true, browserSmokeVersion: app.getVersion() });
    smokePassedThisSession = true;
    return result;
  });
  handle("launcher:mcp-verify", async () => {
    const operationName = "mcp-verification";
    publishOperation({ name: operationName, status: "running", message: "Checking local runtime" });
    const report = await runtimeHost.doctor();
    if (!report.ok) {
      const message = report.checks
        .filter((check) => check.status === "error")
        .map((check) => check.message)
        .filter(Boolean)
        .join("; ") || "The local MCP runtime is not healthy";
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      return report;
    }
    try {
      publishOperation({ name: operationName, status: "running", message: "Checking ChatGPT connector" });
      await browserHost.verifyConnector(runtimeHost.mcpConnectorName());
      const state = stateStore.update({ mcpSetupComplete: true });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "completed", message: "Runtime and connector verified" });
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      throw error;
    }
  });

  handle("launcher:doctor", () => runtimeHost.doctor());
  handle("launcher:cancel-turns", () => runtimeHost.cancelBrowserTurns());
  handle("launcher:bridge-enabled", async (_event, enabled) => {
    const result = await runtimeHost.setBridgeEnabled(enabled === true);
    const state = stateStore.update({
      bridgeEnabled: result.active,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    if (result.active) startCatalogVerificationMonitor({ logger, stateStore });
    else stopCatalogVerificationMonitor();
    return state;
  });
  handle("launcher:uninstall-integration", async () => {
    const language = stateStore.read().language;
    const chinese = language === "zh-CN";
    const japanese = language === "ja";
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: chinese ? ["取消", "移除"] : japanese ? ["キャンセル", "削除"] : ["Cancel", "Remove"],
      defaultId: 0,
      cancelId: 0,
      title: chinese ? `移除 ${PRODUCT_NAME}` : japanese ? `${PRODUCT_NAME} を削除` : `Remove ${PRODUCT_NAME}`,
      message: chinese
        ? "从 Codex 中移除 ChatGPT Web 模型并恢复此前的模型路由？"
        : japanese
          ? "ChatGPT Web モデルを Codex から削除し、以前のモデルルートを復元しますか？"
          : "Remove the ChatGPT Web models from Codex and restore the previous model route?",
      detail: chinese
        ? "启动器中的 ChatGPT 登录 profile 会保留。Codex 需要重启一次。"
        : japanese
          ? "ランチャーの ChatGPT ログインプロファイルは保持されます。Codex を一度再起動してください。"
          : "The launcher's ChatGPT login profile will be preserved. Codex must be restarted once.",
      noLink: true,
    });
    if (confirmation.response !== 1) return { cancelled: true };
    try {
      await runtimeHost.uninstallIntegration();
    } finally {
      browserHost.writeDescriptor();
    }
    const state = stateStore.update({
      coreSetupComplete: false,
      bridgeEnabled: false,
      codexCatalogVerified: false,
      mcpSetupComplete: false,
      mcpRuntimeInstalled: false,
      mcpGuideStep: 0,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    return { cancelled: false, state };
  });
  handle("launcher:setup-core", async () => {
    const browser = await browserHost.probeAuthentication();
    if (!browser.authenticated) throw new Error("Sign in to ChatGPT before installing the Codex integration");
    const setupState = stateStore.read();
    if (!setupState.coreSetupComplete
      && !(smokePassedThisSession || smokePassedForCurrentVersion(setupState))) {
      throw new Error("Run the browser smoke test before installing the Codex integration");
    }
    const result = await runtimeHost.setupCore();
    stateStore.update({
      bridgeEnabled: true,
      coreSetupComplete: true,
      codexCatalogVerified: false,
      codexRestartRequired: true,
      ...(result.mode === "full" ? {
        mcpRuntimeInstalled: true,
        mcpSetupComplete: false,
        mcpGuideStep: 2,
      } : {
        mcpSetupComplete: false,
        mcpRuntimeInstalled: false,
        mcpGuideStep: 0,
      }),
    });
    await browserHost.returnToIdle().catch((error) => {
      logger.warn("browser.idle_cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    startCatalogVerificationMonitor({ logger, stateStore });
    return { ok: true, stdout: result.stdout, restartRequired: true };
  });
  handle("launcher:setup-mcp", async (_event, input) => {
    await browserHost.reveal();
    const result = await runtimeHost.setupMcp({
      tunnelId: typeof input?.tunnelId === "string" ? input.tunnelId.trim() : "",
      runtimeKey: typeof input?.runtimeKey === "string" ? input.runtimeKey : "",
      replace: input?.replace === true,
    });
    stateStore.update({
      mcpRuntimeInstalled: true,
      mcpSetupComplete: false,
      mcpGuideStep: 2,
      codexRestartRequired: true,
    });
    return { ok: true, stdout: result.stdout };
  });
  handle("launcher:set-mcp-step", (_event, step) => {
    if (!Number.isInteger(step) || step < 0 || step > 2) throw new Error("Invalid MCP guide step");
    return stateStore.update({ mcpGuideStep: step });
  });

  handle("launcher:autostart", (_event, enabled) => {
    const desired = enabled === true;
    const autostart = setAutostart(app, desired);
    return {
      state: stateStore.update({ autoStart: desired }),
      ...autostart,
    };
  });
  handle("launcher:set-preference", (_event, key, value) => {
    if (key !== "keepRunningOnClose" && key !== "showBrowserDuringTurns") {
      throw new Error("Unknown preference");
    }
    return stateStore.update({ [key]: value === true });
  });
  handle("launcher:sidebar-state", (_event, value) => stateStore.update(validateSidebarState(value)));
  handle("launcher:list-accounts", () => {
    const storedActiveAccountId = stateStore.read().activeAccountId;
    // `auth.json` -- not the stored preference above -- is the real source of truth for which
    // account Codex is authenticated as: it can be rewritten out from under the launcher by other
    // tools (e.g. `codex login` run directly), and the UI must reflect that reality rather than a
    // stale stored id. The stored value is still what the partition decision elsewhere uses; it
    // is only reported here so the UI can flag drift honestly.
    const activeAccountId = resolveActiveAccountId();
    return {
      accounts: readSwitcherAccounts(),
      activeAccountId,
      storedActiveAccountId,
      activeAccountDrift: activeAccountId !== storedActiveAccountId,
    };
  });
  handle("launcher:switch-account", async (_event, accountId) => {
    if (typeof accountId !== "string" || !accountId) throw new Error("Account id is required");
    const probe = isCodexRunning();
    if (probe.running) {
      throw new Error(
        `Quit Codex before switching accounts, then try again.${probe.reason ? ` (${probe.reason})` : ""}`,
      );
    }
    const accounts = readSwitcherAccounts();
    if (!accounts.some((account) => account.id === accountId)) {
      throw new Error(`No Codex Switcher account matches id ${accountId}`);
    }
    // Ensure the stored ChatGPT token is fresh -- refreshing and durably persisting it into
    // accounts.json FIRST -- before writeCodexAuth reads accounts.json and writes whatever it
    // finds into ~/.codex/auth.json. This is the fix for the actual bug: switching to an account
    // whose token has quietly expired (nothing has maintained accounts.json since Codex Switcher
    // Plus was uninstalled) used to write that dead token straight into auth.json. If the account
    // cannot be refreshed (e.g. its refresh token is also dead), this throws a NeedsReauthError
    // whose message is the stable "NEEDS_REAUTH:<id>" marker the renderer recognizes -- and
    // accounts.json is left completely untouched.
    await ensureFreshChatGptAuth(accountId, { logger });
    writeCodexAuth(accountId);
    const state = stateStore.update({ activeAccountId: accountId });
    send("launcher:state-changed", state);
    logger.info("launcher.account_switched", { accountId });
    // The already-constructed BrowserHost only reads `partition` once, at construction, so it
    // keeps serving the OLD account's ChatGPT Web session even though auth.json above now
    // authenticates Codex as the NEW account. Leaving that mismatch in place would silently burn
    // the old account's ChatGPT quota, so a relaunch onto the new per-account partition is
    // mandatory, not advisory. Reuse the normal shutdown path so the Codex bridge route restore
    // and ChatGPT session persistence still happen.
    const result = await requestQuit({ relaunch: true });
    if (!result.ok) {
      // auth.json is already switched at this point; leaving that half-applied without a clear
      // signal would let the user believe the switch is complete while ChatGPT Web still runs as
      // the previous account. Say so plainly instead of leaving it implicit.
      throw new Error(
        `Codex is now configured for the "${accountId}" account, but ${PRODUCT_NAME} could not `
        + `restart automatically to match (${result.message}). Quit and reopen ${PRODUCT_NAME} `
        + "manually now, or ChatGPT Web will keep running as the previous account.",
      );
    }
    return state;
  });
  handle("launcher:account-usage", async (_event, accountId) => {
    if (typeof accountId !== "string" || !accountId) throw new Error("Account id is required");
    // Fetched lazily, only when the caller (the Settings account UI) asks -- never on a startup
    // timer or a poll. Always resolves to a plain usage-or-unavailable object: fetchAccountUsage
    // itself never throws. It may refresh (and durably persist) the account's stored ChatGPT
    // token via credential-provider.cjs when it is expired or near expiry -- see that module's
    // header for why that is now safe to do here.
    return await fetchAccountUsage(accountId, { logger });
  });
  handle("launcher:import-codex-auth", () => {
    // Explicit, user-triggered counterpart to the same import that also runs once automatically at
    // startup (see start(), below) -- lets the account UI offer "check for a new Codex sign-in"
    // on demand instead of only after a relaunch. Never throws; see credential-import.cjs.
    const result = importFromAuthDotJson();
    logger.info("accounts.auth_import", { status: result.status, accountId: result.accountId ?? null });
    return result;
  });
  handle("launcher:logs", (_event, limit) => logger.recent(limit));
  handle("launcher:open-logs", async () => {
    const error = await shell.openPath(path.dirname(logger.filePath));
    if (error) throw new Error(`Could not open the launcher log directory: ${error}`);
    return logger.filePath;
  });
  handle("launcher:update-install", async () => {
    if (!updateController) throw new Error("Launcher updates are unavailable");
    const launch = await updateController.beginInstall();
    const result = await requestQuit();
    if (!result.ok) {
      updateController.cancelInstall(launch);
      throw new Error(result.message);
    }
    return true;
  });
  handle("launcher:window-state", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return windowStateSnapshot(window);
  });
  ipcMain.on("launcher:window-control", (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (action === "close") window.close();
    else if (action === "minimize") window.minimize();
    else if (action === "zoom") window.isMaximized() ? window.unmaximize() : window.maximize();
  });
}

// `relaunch: true` schedules `app.relaunch()` immediately before `app.quit()`, once every check
// above has already passed and quitting is certain to proceed. It must stay there: calling
// `app.relaunch()` any earlier (e.g. before the activeOperation check) would leave a relaunch
// scheduled for whatever quit happens next, even a normal one, if this call ends up throwing.
async function requestQuit({ relaunch = false } = {}) {
  if (shutdownInProgress || exitCommitted) {
    return { ok: false, message: "Launcher shutdown is already in progress" };
  }
  shutdownInProgress = true;
  try {
    const activeOperation = runtimeHost?.currentOperation() || browserHost?.currentOperation();
    if (activeOperation) {
      throw new Error(`Wait for ${activeOperation} to finish before quitting ${PRODUCT_NAME}`);
    }
    // This launcher is the only thing keeping Codex's model route pointed at a live server.
    // Once this process exits, nothing is left to serve that route, so restore Codex's previous
    // route now instead of leaving config.toml pointed at an endpoint this quit is about to kill.
    if (runtimeHost) {
      try {
        await runtimeHost.restoreBridgeRoute("app-quit-fail-safe");
      } catch (error) {
        logger?.error("bridge.route_restore_before_quit_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await runtimeSupervisor?.shutdown();
    stopCatalogVerificationMonitor();
    quitting = true;
    await browserHost?.persistSession();
    browserHost?.destroy();
    await browserControl?.close();
    exitCommitted = true;
    if (relaunch) app.relaunch();
    app.quit();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    quitting = false;
    showMainWindow();
    publishOperation({ name: "launcher-quit", status: "failed", message });
    return { ok: false, message };
  } finally {
    shutdownInProgress = false;
  }
}

let crashRecoveryInFlight = false;

// An uncaught exception normally takes this process down with no cleanup, leaving Codex's
// config.toml pointed at the local server this crash is about to silence. Best-effort route
// restore first, bounded so a hung restore cannot turn a crash into a frozen process.
async function crashRecoverAndExit(context, error) {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  try {
    fs.appendFileSync(
      path.join(app.getPath("logs"), "launcher-fatal.log"),
      `${new Date().toISOString()} [${context}] ${message}\n`,
    );
  } catch {}
  if (!crashRecoveryInFlight && runtimeHost) {
    crashRecoveryInFlight = true;
    try {
      await Promise.race([
        runtimeHost.restoreBridgeRoute("app-crash-fail-safe"),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("route restore timed out")), 10_000)),
      ]);
    } catch (restoreError) {
      try {
        fs.appendFileSync(
          path.join(app.getPath("logs"), "launcher-fatal.log"),
          `${new Date().toISOString()} [${context}] route restore failed: `
          + `${restoreError instanceof Error ? restoreError.message : String(restoreError)}\n`,
        );
      } catch {}
    }
  }
  process.exit(1);
}

process.on("uncaughtException", (error) => { void crashRecoverAndExit("uncaughtException", error); });
process.on("unhandledRejection", (reason) => { void crashRecoverAndExit("unhandledRejection", reason); });

async function start() {
  cdpPort = await findFreePort();
  if (process.platform === "linux") app.commandLine.appendSwitch("class", "codex-web-gpt");
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => showMainWindow());
  await app.whenReady();
  let installedRuntimeRoot = null;
  let runtimeRootResolved = false;
  const runtimeRootProvider = () => {
    const packagedRuntimeWasRemoved = app.isPackaged
      && (!installedRuntimeRoot || !fs.existsSync(installedRuntimeRoot));
    if (!runtimeRootResolved || packagedRuntimeWasRemoved) {
      installedRuntimeRoot = ensurePackagedRuntime({
        app,
        coreHome: CORE_HOME,
        resourcesPath: process.resourcesPath,
      });
      runtimeRootResolved = true;
    }
    return installedRuntimeRoot;
  };

  const stateStore = createStateStore(path.join(app.getPath("userData"), "launcher-state.json"));
  if (stateStore.read().sessionRefreshReminderAt === null) {
    stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
  }
  const persistedState = stateStore.read();
  if (persistedState.coreSetupComplete === true && persistedState.codexCatalogVerified === undefined) {
    stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      codexRestartRequired: false,
    });
  }
  const autostart = getAutostart(app);
  if (stateStore.read().onboardingComplete && autostart.supported && stateStore.read().autoStart !== autostart.enabled) {
    setAutostart(app, stateStore.read().autoStart);
  }
  logger = createLogger({
    filePath: path.join(app.getPath("logs"), "launcher.jsonl"),
    publish: (record) => send("launcher:log", record),
  });
  // Adopt whatever credentials Codex itself currently has in ~/.codex/auth.json into
  // accounts.json on every launch -- e.g. because the user signed in directly through Codex
  // (`codex login`) rather than through this launcher -- so that sign-in becomes a switchable
  // account here too, without waiting for the user to discover the manual "check now" action in
  // Settings. Synchronous (a few small local file reads/writes) and never throws by contract
  // (see credential-import.cjs), so this cannot meaningfully delay or fail startup.
  try {
    const importResult = importFromAuthDotJson();
    logger.info("accounts.auth_import_startup", {
      status: importResult.status,
      accountId: importResult.accountId ?? null,
    });
  } catch (error) {
    // importFromAuthDotJson is documented to never throw; this guard exists only so a future
    // change to that contract can never turn into a startup crash.
    logger.warn("accounts.auth_import_startup_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (userDataResolution.outcome === "migration-failed") {
    logger.warn("launcher.user_data_dir_resolved", {
      dir: launcherUserData,
      outcome: userDataResolution.outcome,
      detail: userDataResolution.detail,
    });
  } else {
    logger.info("launcher.user_data_dir_resolved", {
      dir: launcherUserData,
      outcome: userDataResolution.outcome,
      detail: userDataResolution.detail,
    });
  }
  const startHidden = process.argv.includes("--hidden") && stateStore.read().onboardingComplete;
  nativeTheme.themeSource = "system";
  mainWindow = createWindow({
    logger,
    stateStore,
    windowStatePath: path.join(app.getPath("userData"), "window-state.json"),
    startHidden,
  });
  browserControl = await new BrowserControlServer({
    logger,
    getBrowserHost: () => browserHost,
    getPreferences: () => stateStore.read(),
  }).start();
  runtimeSupervisor = new RuntimeSupervisor({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome: CORE_HOME,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    publishOperation,
  });
  runtimeHost = new RuntimeHost({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    publishOperation,
    supervisor: runtimeSupervisor,
  });
  browserHost = new BrowserHost({
    window: mainWindow,
    descriptorPath: BROWSER_DESCRIPTOR_PATH,
    cdpPort,
    control: browserControl.descriptor(),
    getConnectorName: () => runtimeHost.browserConnectorName(),
    helper: { executable: process.execPath, script: BROWSER_HELPER_PATH },
    logger,
    publishState: (state) => send("launcher:browser-state", state),
    partition: partitionForAccount(stateStore.read().activeAccountId),
  });
  await browserHost.ready();
  const updaterRuntimeRoot = runtimeRootProvider();
  updateController = createUpdateController({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    executablePath: process.execPath,
    runtimeExecutable: updaterRuntimeRoot
      ? runtimeBundlePaths(updaterRuntimeRoot, process.platform).executable
      : null,
    logsDirectory: app.getPath("logs"),
    publish: (state) => send("launcher:update-state", state),
    logger,
  });
  registerIpc({ logger, stateStore });
  const trayAvailable = createTray(logger);
  if (startHidden && !trayAvailable) mainWindow.once("ready-to-show", () => showMainWindow());
  const launcherSmokeTest = process.argv.includes("--launcher-smoke-test");
  if (!launcherSmokeTest) {
    void browserHost.refreshAuthentication().catch((error) => {
      logger.warn("browser.session_refresh_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  await loadRenderer(mainWindow);
  if (!launcherSmokeTest) void updateController.checkOnce();
  if (launcherSmokeTest) {
    const smokeRuntimeRoot = runtimeRootProvider();
    if (app.isPackaged && !smokeRuntimeRoot) {
      throw new Error("Packaged launcher smoke test could not install its durable runtime");
    }
    const versionInvocation = runtimeSupervisor.runtimeCommand(["--version"]);
    const versionResult = spawnSync(versionInvocation.executable, versionInvocation.args, {
      cwd: versionInvocation.cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    if (versionResult.error) throw versionResult.error;
    if (versionResult.status !== 0 || versionResult.stdout.trim() !== app.getVersion()) {
      throw new Error(
        `Installed launcher runtime is not executable`
        + ` (status=${versionResult.status ?? "unknown"}, stdout=${JSON.stringify(versionResult.stdout.trim())},`
        + ` stderr=${JSON.stringify(versionResult.stderr.trim())})`,
      );
    }
    const markerPath = process.env.CODEX_WEB_GPT_SMOKE_FILE?.trim();
    if (!markerPath || !path.isAbsolute(markerPath)) {
      throw new Error("Packaged launcher smoke test requires an absolute CODEX_WEB_GPT_SMOKE_FILE");
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      ok: true,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      runtimeVerified: true,
    })}\n`);
    browserHost.destroy();
    await browserControl.close();
    mainWindow.destroy();
    app.quit();
    return;
  }
  void (async () => {
    const upgrade = await runtimeHost.upgradeManagedRuntime();
    if (upgrade.updated) {
      // Do NOT write `bridgeEnabled` here. `upgrade.bridgeEnabled` reports the route's observed
      // state around the upgrade (upgradeManagedRuntime mechanically disconnects the route while
      // it swaps runtime binaries), not the user's intent. `bridgeEnabled` in launcher state is
      // the user's INTENT and must only change through a genuine user action (Settings toggle,
      // first-time setup, explicit uninstall) -- see bridge-reconcile.cjs. reconcileBridgeOnStartup
      // runs immediately below and brings the route back in line with the persisted intent, so no
      // restore logic is needed here; overwriting the intent with this transient upgrade side
      // effect would silently disable the bridge on every version upgrade.
      const state = stateStore.update({
        coreSetupComplete: true,
        codexCatalogVerified: false,
        codexRestartRequired: true,
        ...(upgrade.mode === "full" ? {
          mcpRuntimeInstalled: true,
          mcpSetupComplete: false,
          mcpGuideStep: 2,
        } : {
          mcpRuntimeInstalled: false,
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        }),
      });
      send("launcher:state-changed", state);
      logger.info("runtime.release_upgraded", {
        fromVersion: upgrade.fromVersion,
        toVersion: upgrade.toVersion,
        mode: upgrade.mode,
        bridgeEnabled: upgrade.bridgeEnabled,
        connectorMigrated: upgrade.connectorMigrated,
      });
    }
    try {
      const reconciled = await reconcileBridgeOnStartup({ runtimeHost, stateStore, logger, publishOperation });
      if (reconciled.status === "bridge-disabled") return { status: "bridge-disabled" };
    } catch (error) {
      logger.warn("bridge.route_status_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return runtimeSupervisor.startIfConfigured();
  })().then(async (runtime) => {
    if (runtime.status === "bridge-disabled") {
      stopCatalogVerificationMonitor();
      return;
    }
    if (runtime.status === "ready") {
      const config = runtimeSupervisor.readConfig();
      const current = stateStore.read();
      const patch = {
        mcpRuntimeInstalled: config.mode === "full",
        ...(config.mode === "browser-only" ? {
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        } : {}),
      };
      if (Object.entries(patch).some(([key, value]) => current[key] !== value)) {
        const state = stateStore.update(patch);
        send("launcher:state-changed", state);
      }
      startCatalogVerificationMonitor({ logger, stateStore });
      return;
    }
    if (runtime.status === "not-configured") {
      const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
      const current = stateStore.read();
      if (current.coreSetupComplete || current.mcpRuntimeInstalled || current.mcpSetupComplete) {
        const state = stateStore.update({
          coreSetupComplete: false,
          codexCatalogVerified: false,
          mcpRuntimeInstalled: false,
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        });
        send("launcher:state-changed", state);
      }
      if (routeRecovery.error) {
        publishOperation({
          name: "runtime-start",
          status: "failed",
          message: `Local runtime is not configured; restoring the previous Codex route also failed: ${routeRecovery.error}`,
        });
      }
      return;
    }
    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    if (runtime.status === "external" || runtime.status === "needs-setup") {
      const detail = runtime.detail || (
        runtime.status === "external"
          ? `Another process owns the configured ${PRODUCT_NAME} runtime`
          : "The installed runtime configuration must be repaired from Setup"
      );
      publishOperation({
        name: "runtime-start",
        status: "failed",
        message: routeRecovery.error
          ? `${detail}; restoring the previous Codex route also failed: ${routeRecovery.error}`
          : routeRecovery.restored
            ? `${detail}; the previous Codex route was restored, restart Codex once`
            : detail,
      });
    }
  }).catch(async (error) => {
    const primary = error instanceof Error ? error.message : String(error);
    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
    const message = routeRecovery.error
      ? `${primary}; restoring the previous Codex route also failed: ${routeRecovery.error}`
      : routeRecovery.restored
        ? `${primary}; the previous Codex route was restored, restart Codex once`
        : primary;
    logger.error("runtime.startup_failed", { message });
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    publishOperation({ name: "runtime-start", status: "failed", message });
  });

  app.on("activate", () => showMainWindow());
  app.on("before-quit", (event) => {
    if (exitCommitted) return;
    event.preventDefault();
    void requestQuit();
  });
  process.once("SIGINT", () => { void requestQuit(); });
  process.once("SIGTERM", () => { void requestQuit(); });
}

void start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    fs.appendFileSync(path.join(app.getPath("logs"), "launcher-fatal.log"), `${new Date().toISOString()} ${error?.stack || error}\n`);
  } catch {}
  try {
    dialog.showErrorBox(`${PRODUCT_NAME} could not start`, message);
  } catch {}
  app.exit(1);
});
