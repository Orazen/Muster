// Configure an explicitly selected profile before any dependency captures
// Electron paths or creates credentials, logs, sockets or child processes.
import { desktopProfile } from "./profile-paths.mjs";
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, MenuItem, nativeImage, safeStorage, session, shell, systemPreferences, Tray, utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeCua, getCuaConnection, stopCua, registerCuaIpc } from "./cua.mjs";
import { isComputerAccessSender } from "./computer-access-sender.mjs";
import { finishSpeech, startSpeech, stopSpeech } from "./speech.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { startUpdater, registerUpdaterIpc } from "./updater.mjs";
import capabilitiesModule from "./capabilities.cjs";
import { createServerLifecycle } from "./server-lifecycle.mjs";
import { badgeText, countWaitingOnYou, pendingMenuLabel, trayTooltip } from "./tray-badge.mjs";

const { desktopCapabilities } = capabilitiesModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
const DEFAULT_COMPOSIO_BROKER_URL = "https://muster-composio.orazen.workers.dev";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");

// The tray companion (the mascot's desktop home): a small always-on-top
// window rendering the same flower character from the built tray.html.
// It is its own surface — it never modifies the app window, and its poll
// pauses whenever it is hidden. Tray state lives in dev in the vite dev
// server (tray.html at DEV_URL) and in the package in the built UI dir.
let trayWindow = null;
function trayUrl() {
  if (app.isPackaged) return `http://127.0.0.1:${SERVER_PORT}/tray.html`;
  return `${DEV_URL}/tray.html`;
}
function toggleTrayWindow() {
  if (trayWindow && !trayWindow.isDestroyed()) {
    if (trayWindow.isVisible()) {
      trayWindow.hide();
      return;
    }
    trayWindow.show();
    trayWindow.focus();
    return;
  }
  trayWindow = new BrowserWindow({
    width: 280,
    height: 300,
    minWidth: 240,
    minHeight: 240,
    show: false,
    icon: APP_ICON,
    backgroundColor: "#070707",
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    resizable: true,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  trayWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  trayWindow.once("ready-to-show", () => trayWindow?.show());
  trayWindow.on("closed", () => {
    trayWindow = null;
  });
  trayWindow.loadURL(trayUrl()).catch(() => {
    // The embedded server may still be starting; the menu item can retry.
    trayWindow?.close();
  });
}
function registerTrayIpc() {
  ipcMain.handle("tray:toggle", () => {
    toggleTrayWindow();
  });
  // The tray page asks the main process to reveal a bot in the main window.
  ipcMain.handle("tray:focus-app", () => {
    focusAppWindow();
  });
}

/** Focus the app window a human decides in (never the tray companion).
 * Answers false when every window is closed — the caller decides whether
 * that means "open a fresh one". */
function focusAppWindow() {
  const win = BrowserWindow.getAllWindows().find((candidate) => candidate !== trayWindow && !candidate.isDestroyed());
  if (!win) return false;
  win.show();
  win.focus();
  return true;
}

// ── menu-bar status item ───────────────────────────────────────────────
// A tray icon beside the mascot window (tiptour study, slice 5): it shows
// how many bots are waiting on a human, so pending approvals are visible
// without opening anything. Presentation only — the badge reads, it never
// answers a card: a click opens the window where the human decides, and
// the context menu runs the SAME functions the tray:* IPC handlers run
// (one path, no second behavior). The count polls the same slim roster
// feed the tray window uses (no transcripts), from the main process so it
// keeps ticking while that window is hidden.
const STATUS_POLL_MS = 10_000;
const STATUS_FETCH_TIMEOUT_MS = 4_000;
let statusItem = null;
let statusCount = 0;
let statusPollTimer = null;
let statusPollBusy = false;

function statusMenuTemplate() {
  return [
    { label: "Open Muster", click: () => openAppWindow() },
    { label: "Mascot Companion", click: () => toggleTrayWindow() },
    { type: "separator" },
    // A disabled read-out, not an action: approving stays on the card.
    { label: pendingMenuLabel(statusCount), enabled: false },
    { type: "separator" },
    { label: "Quit Muster", click: () => app.quit() },
  ];
}

function openAppWindow() {
  // macOS keeps running with every window closed — "Open Muster" must
  // never be a dead click from the menu bar.
  if (!focusAppWindow()) createWindow();
}

function applyPendingCount(count) {
  if (!statusItem || statusItem.isDestroyed() || count === statusCount) return;
  statusCount = count;
  statusItem.setToolTip(trayTooltip(count));
  // setTitle draws the badge line beside the icon; it is a macOS API.
  if (process.platform === "darwin") statusItem.setTitle(badgeText(count));
  statusItem.setContextMenu(Menu.buildFromTemplate(statusMenuTemplate()));
  slog(`status item waiting=${count}`);
}

async function pollPendingCount() {
  if (statusPollBusy || !statusItem || statusItem.isDestroyed()) return;
  // Packaged: while the embedded server is down there is nothing to read —
  // keep the last count instead of flashing zero over a restart.
  if (app.isPackaged && !serverReady) return;
  statusPollBusy = true;
  try {
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/bots?messages=0`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(STATUS_FETCH_TIMEOUT_MS),
    });
    if (response.ok) applyPendingCount(countWaitingOnYou(await response.json()));
  } catch {
    // A restarting server answers with a dead socket; the next tick re-reads.
  } finally {
    statusPollBusy = false;
  }
}

function startStatusItem() {
  try {
    // The window icon ships at 512px; the menu bar wants a small one.
    const icon = nativeImage.createFromPath(APP_ICON).resize({ width: 32, height: 32 });
    statusItem = new Tray(icon.isEmpty() ? APP_ICON : icon);
  } catch (error) {
    // A host without a system tray (some Linux sessions) simply runs
    // without a status item — the View-menu toggle still reaches the tray.
    slog(`status item unavailable: ${error instanceof Error ? error.message : error}`);
    return;
  }
  statusItem.setToolTip(trayTooltip(statusCount));
  if (process.platform === "darwin") statusItem.setTitle(badgeText(statusCount));
  statusItem.setContextMenu(Menu.buildFromTemplate(statusMenuTemplate()));
  // Left click opens the app window: the badge marks work waiting on a
  // human, so it goes where that human decides — the mascot companion
  // stays one menu item away.
  statusItem.on("click", () => openAppWindow());
  void pollPendingCount();
  statusPollTimer = setInterval(() => void pollPendingCount(), STATUS_POLL_MS);
}

function stopStatusItem() {
  if (statusPollTimer !== null) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

// GNOME groups the window with its installed desktop entry only when both
// identities match. This must run before Electron becomes ready.
if (process.platform === "linux") app.setDesktopName("com.muster.app.desktop");

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
let serverReady = true;
let secureCredentials = {};

// Config files, HTTP payloads, and renderer IPC arguments arrive untyped.
// Decode text once here so every handler branches on a real string or null.
const asText = (value) => (Object.prototype.toString.call(value) === "[object String]" ? value : null);

const CREDENTIALS_FILE = path.join(app.getPath("userData"), "credentials.bin");

async function loadSecureCredentials() {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE) || !(await safeStorage.isAsyncEncryptionAvailable())) return {};
    const decrypted = await safeStorage.decryptStringAsync(fs.readFileSync(CREDENTIALS_FILE));
    return JSON.parse(decrypted.result);
  } catch (error) {
    slog(`credential load failed: ${error?.message ?? error}`);
    return {};
  }
}

async function saveSecureCredentials(credentials) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credentials));
  const temporary = `${CREDENTIALS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
  fs.renameSync(temporary, CREDENTIALS_FILE);
}

async function secureComposioConfig() {
  const dataDir = process.env.OMB_DATA_DIR || path.join(app.getPath("home"), ".muster");
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const composio = Object.prototype.toString.call(config?.composio) === "[object Object]" ? config.composio : null;
    if (!composio) return;
    let changed = false;
    const apiKeyText = asText(composio.apiKey)?.trim();
    if (apiKeyText) {
      if (apiKeyText.startsWith("ak_") && !secureCredentials.composioApiKey) {
        secureCredentials.composioApiKey = apiKeyText;
        await saveSecureCredentials(secureCredentials);
      }
      composio.apiKey = "";
      changed = true;
    }
    // These were the old Connect credential and endpoint. They are no longer
    // read; remove them during the upgrade so an unused secret is not left in
    // plaintext indefinitely.
    for (const field of ["key", "url"]) {
      if (Object.hasOwn(config.composio, field)) {
        delete config.composio[field];
        changed = true;
      }
    }
    if (!changed) return;
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") slog(`credential migration failed: ${error?.message ?? error}`);
  }
}

function composioBrokerUrl() {
  const configured = process.env.OMB_COMPOSIO_BROKER_URL?.trim();
  return configured || (app.isPackaged ? DEFAULT_COMPOSIO_BROKER_URL : "");
}

async function ensureManagedComposioCredentials() {
  const brokerUrl = composioBrokerUrl();
  if (!brokerUrl) return;
  if (/^[0-9a-f]{64}$/.test(secureCredentials.composioBrokerToken ?? "")) {
    try {
      const check = await fetch(`${brokerUrl}/v1/me`, {
        headers: { authorization: `Bearer ${secureCredentials.composioBrokerToken}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (check.ok) return;
      // Only a definitive auth failure rotates the credential. A transient
      // outage keeps the existing identity so reconnecting cannot strand
      // the user's already-authorized accounts under a new installation.
      if (check.status !== 401) return;
      delete secureCredentials.composioBrokerToken;
      delete secureCredentials.composioInstallationId;
    } catch {
      return;
    }
  }
  try {
    const response = await fetch(`${brokerUrl}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    if (!/^[0-9a-f]{64}$/.test(body?.token ?? "") || asText(body?.installationId) === null) {
      throw new Error("the connected-apps service returned invalid credentials");
    }
    secureCredentials.composioBrokerToken = body.token;
    secureCredentials.composioInstallationId = body.installationId;
    await saveSecureCredentials(secureCredentials);
    slog("connected-apps installation registered");
  } catch (error) {
    // Never block app startup on a hosted integration. A user running their
    // own Composio project key still has the local fallback below.
    slog(`connected-apps registration failed: ${error?.message ?? error}`);
  }
}

// The packaged app has no terminal: everything about the server child's life
// goes to server.log in the OS log dir (~/Library/Logs/Muster on macOS,
// Console.app-visible; %APPDATA%\Muster\logs on Windows), which is also
// why stdio is piped, not inherited — under a Finder/Explorer launch the
// parent's stdio leads nowhere and a failed boot is otherwise undiagnosable.
const LOG_DIR = app.getPath("logs");
let logStream = null;
import {
  companionPairing,
  companionCloudDesktopAccess,
  companionRevoke,
  companionSetAccess,
  companionState,
  reviveCompanionAtLaunch,
  setCompanionKeepAwake,
  startCompanion,
  stopCompanion,
  stopForeignCompanion,
} from "./companion.mjs";

function slog(line) {
  try {
    if (!logStream) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logStream = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
    }
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break startup */
  }
}

async function startServerOn(port, onExit, signal) {
  if (signal.aborted) return null;
  const entry = path.join(process.resourcesPath, "server", "index.js");
  slog(`fork ${entry} port=${port}`);
  const childEnv = {
    ...process.env,
    OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
    OMB_PORT: String(port),
    OMB_USER_DATA: app.getPath("userData"),
    // The emergency sign-ups-closed stopgap (server/index.ts) exists
    // because a SHARED deployment's server state has no per-user
    // isolation yet. That risk doesn't exist here: this is a single
    // machine's own local server, one person, their own data — the
    // whole point of "local-first." Without this flag, a fresh install
    // of the desktop app couldn't create its first account at all.
    OMB_DESKTOP_APP: "true",
  };
  if (secureCredentials.composioApiKey) {
    childEnv.COMPOSIO_API_KEY = secureCredentials.composioApiKey;
  }
  if (composioBrokerUrl() && secureCredentials.composioBrokerToken) {
    childEnv.OMB_COMPOSIO_BROKER_URL = composioBrokerUrl();
    childEnv.OMB_COMPOSIO_BROKER_TOKEN = secureCredentials.composioBrokerToken;
  }
  const childOptions = {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (desktopProfile) childOptions.cwd = desktopProfile.cwd;
  const proc = utilityProcess.fork(entry, [], childOptions);
  proc.stdout?.on("data", (d) => slog(`[out] ${String(d).trimEnd()}`));
  proc.stderr?.on("data", (d) => slog(`[err] ${String(d).trimEnd()}`));
  proc.once("spawn", () => slog(`spawned pid=${proc.pid}`));
  const abort = () => { try { proc.kill(); } catch {} };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let exited = false;
  proc.once("exit", (code) => {
    signal.removeEventListener("abort", abort);
    exited = true;
    slog(`exited code=${code}`);
    onExit(code);
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  for (let i = 0; i < 40; i++) {
    if (exited || signal.aborted) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (!exited && !signal.aborted && body?.app === "muster" && body.pid === proc.pid && body.static) return proc;
        break; // someone else owns this port — try the next one
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    proc.kill();
  } catch {}
  return null;
}

// Keep the renderer alive after a backend exit: its unsent draft is still in
// memory. Only a failed main-document navigation gets the local recovery page.
const recoveryViews = new Map();
let recoveryPrompt = null;
let recoveryMenuItem = null;
const serverLifecycle = createServerLifecycle({
  start: startServerOn,
  stop: (child) => { try { child.kill(); } catch {} },
  onState(state) {
    serverReady = state.phase === "running";
    if (state.port !== null) SERVER_PORT = state.port;
    if (recoveryMenuItem) recoveryMenuItem.enabled = state.phase === "stopped" ||
      (state.phase === "running" && [...recoveryViews.values()].some((view) => view.failed));
    if (state.phase === "stopped") void offerServerRecovery();
  },
});

const ERROR_PAGE = "data:text/html;charset=utf-8," + encodeURIComponent(
  `<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><main style="max-width:380px;padding:24px;text-align:center"><h2>Muster’s local server is unavailable</h2><p style="line-height:1.6;color:#b5b5b5">Use Retry in the recovery dialog, or Reconnect local server in the View menu. Reconnecting does not resend your tasks.</p></main></body>`,
);

function ownServerUrl(value) {
  try { return new URL(value).origin === `http://127.0.0.1:${SERVER_PORT}`; }
  catch { return false; }
}

async function retryLocalServer() {
  const phase = serverLifecycle.snapshot().phase;
  if (phase === "stopped") await serverLifecycle.retry();
  if (serverLifecycle.snapshot().phase !== "running") return;
  for (const [contents, view] of recoveryViews) {
    if (serverLifecycle.snapshot().phase !== "running") return;
    if (contents.isDestroyed() || !view.failed) continue;
    // A loaded application reconnects its own streams without a reload. Only
    // replace our recovery document; never disturb a later OAuth/navigation.
    if (contents.getURL() !== ERROR_PAGE) continue;
    view.failed = false;
    await contents.loadURL(ownServerUrl(view.url) ? view.url : `http://127.0.0.1:${SERVER_PORT}/app`)
      .catch((error) => slog(`main navigation failed: ${error?.message ?? error}`));
  }
  if (recoveryMenuItem) recoveryMenuItem.enabled = [...recoveryViews.values()].some((view) => view.failed);
}

function needsServerRecovery() {
  const phase = serverLifecycle.snapshot().phase;
  return phase === "stopped" || (phase === "running" && [...recoveryViews.values()].some((view) => view.failed));
}

async function offerServerRecovery() {
  if (recoveryPrompt || !needsServerRecovery()) return;
  const view = [...recoveryViews.values()].find((entry) => !entry.win.isDestroyed());
  if (!view) return;
  const generation = serverLifecycle.snapshot().generation;
  recoveryPrompt = dialog.showMessageBox(view.win, {
    type: "warning", title: "Muster’s local server is unavailable",
    message: "Reconnect to your local workspace?",
    detail: "Your open conversation stays in place. Retry starts Muster’s server on the same address and does not resend any task. If another process is using that address, it will be left alone.",
    buttons: ["Retry", "Later"], defaultId: 0, cancelId: 1,
  });
  let result;
  try { result = await recoveryPrompt; }
  catch (error) { slog(`recovery dialog failed: ${error?.message ?? error}`); }
  finally { recoveryPrompt = null; }
  const state = serverLifecycle.snapshot();
  if (result?.response === 0 && needsServerRecovery() && state.generation === generation) {
    await retryLocalServer();
    if (needsServerRecovery()) void offerServerRecovery();
  }
}

function showServerRecoveryDocument(contents) {
  const view = recoveryViews.get(contents);
  if (!view || contents.isDestroyed() || serverLifecycle.snapshot().phase === "quitting") return;
  view.failed = true;
  if (recoveryMenuItem) recoveryMenuItem.enabled = needsServerRecovery();
  if (contents.getURL() !== ERROR_PAGE) void contents.loadURL(ERROR_PAGE).catch((error) => slog(`recovery page failed: ${error?.message ?? error}`));
  if (needsServerRecovery()) void offerServerRecovery();
}

const appContents = new Set();

function createWindow() {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: process.platform !== "darwin",
    // macOS keeps inset traffic lights, Windows keeps its custom overlay,
    // and Linux uses the native desktop title bar and window controls.
    ...(isMac
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden",
            // height MUST match the ChatView/GroupView header strip (px-5 py-3
            // around a 36px control row = 60). Windows draws the caption buttons
            // to fill the overlay, so anything shorter leaves a dead band under
            // them and anything taller overhangs the header.
            titleBarOverlay: { color: "#070707", symbolColor: "#b5b5b5", height: 60 },
          }
        : {}),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  const contents = win.webContents;
  appContents.add(contents);
  if (app.isPackaged) {
    const view = { win, url: `http://127.0.0.1:${SERVER_PORT}/app`, pendingUrl: null, failed: !serverReady };
    recoveryViews.set(contents, view);
    contents.once("destroyed", () => recoveryViews.delete(contents));
    const remember = (_event, url) => { if (ownServerUrl(url)) view.url = url; };
    contents.on("did-start-navigation", (_event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) view.pendingUrl = url;
    });
    contents.on("did-navigate", (event, url) => {
      view.pendingUrl = null;
      remember(event, url);
      if (ownServerUrl(url)) {
        view.failed = false;
        if (recoveryMenuItem) recoveryMenuItem.enabled = needsServerRecovery();
      }
    });
    contents.on("did-navigate-in-page", remember);
    contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && view.pendingUrl === url && ownServerUrl(url)) showServerRecoveryDocument(contents);
    });
  }
  contents.once("destroyed", () => appContents.delete(contents));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Packaged CI smoke hook. It validates the real renderer/preload bridge and
  // same-origin embedded server, then follows the normal window-close path.
  // No debugging port or sandbox override is needed.
  if (process.env.OMB_SMOKE_TEST === "1") {
    win.webContents.once("did-finish-load", async () => {
      try {
        const result = await win.webContents.executeJavaScript(`
          (async () => {
            if (!window.ogb?.getCapabilities) throw new Error("desktop preload bridge is unavailable");
            const [capabilities, healthResponse] = await Promise.all([
              window.ogb.getCapabilities(),
              fetch("/api/health"),
            ]);
            if (!healthResponse.ok) {
              throw new Error(\`health request failed: \${healthResponse.status} \${healthResponse.statusText}\`);
            }
            const health = await healthResponse.json();
            // The desktop app's own root route redirects straight to
            // /sign-in when signed out (src/App.tsx's RootRoute) — but
            // that's a client-side <Navigate>, not a document navigation,
            // so it hasn't necessarily run yet the instant did-finish-load
            // fires (found live in CI: this raced both ways, landing on
            // "/sign-in" once and bare "/" the next run). Poll for the
            // real settled URL instead of reading it once immediately.
            const deadline = Date.now() + 5000;
            while (window.location.pathname === "/" && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 50));
            }
            return { capabilities, health, location: window.location.href, title: document.title };
          })()
        `);
        // This smoke run starts with no session, so /sign-in is the one
        // correct settled destination for a signed-out desktop launch.
        const expectedLocation = `http://127.0.0.1:${SERVER_PORT}/sign-in?next=%2Fapp`;
        if (result.location !== expectedLocation) {
          throw new Error(
            `unexpected packaged renderer URL: ${result.location} (expected ${expectedLocation})`,
          );
        }
        console.log(`[smoke] renderer-ready ${JSON.stringify(result)}`);
      } catch (error) {
        console.error(`[smoke] renderer-failed ${error?.stack ?? error}`);
      } finally {
        win.close();
      }
    });
  }

  if (app.isPackaged) {
    void win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : ERROR_PAGE)
      .catch((error) => slog(`main navigation failed: ${error?.message ?? error}`));
    if (!serverReady) void offerServerRecovery();
  } else {
    win.loadURL(DEV_URL);
  }
  return win;
}

// "This Mac" screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", async () => {
  if (process.platform !== "darwin") return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

// Onboarding permission checks. Status reads are free; the mic request
// pops the real TCC prompt attributed to the app.
//
// Screen Recording deliberately has NO request path here. On macOS 15+
// every pre-grant mechanism is broken: getMediaAccessStatus("screen")
// wraps CGPreflightScreenCaptureAccess, which caches per-process (stays
// "denied" for the whole session after the user grants); a helper child
// binary gets TCC-attributed to ITSELF on macOS 26, not the app, and
// plain executables no longer appear in the Settings pane at all; and
// Sequoia+ re-prompts periodically regardless, so a pre-grant expires.
// The one reliable path is the first real in-process capture
// (screen:frame above / getDisplayMedia via the handler below) — macOS
// prompts then, attributed correctly, at the moment of actual use. The
// perm:open-settings deep link stays as the repair path for denials.
// Copy the engine command, then open a blank terminal. Renderer-controlled
// text must never become a process argument: the user reviews and pastes it.
// Returns false when the renderer should show the clipboard fallback.
ipcMain.handle("engine:open-terminal", async (_event, command) => {
  const commandText = asText(command);
  if (!commandText?.trim()) return false;
  clipboard.writeText(commandText);
  return openBlankTerminal();
});

// OAuth/connect links are returned asynchronously, after Chromium's direct
// click gesture has ended. Opening them through window.open can therefore be
// rejected as a popup before setWindowOpenHandler ever sees the URL. Keep the
// renderer sandboxed and let the main process open only ordinary web links.
// A bot's working folder: the native picker, so the path is real and the
// user never types one. Returns null when they cancel.
ipcMain.handle("desktop:pick-folder", async (event, current) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const options = {
    title: "Choose a working folder",
    properties: ["openDirectory", "createDirectory"],
  };
  const currentText = asText(current);
  if (currentText) options.defaultPath = currentText;
  const result = await dialog.showOpenDialog(win, options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("desktop:open-external", async (_event, rawUrl) => {
  if (asText(rawUrl) === null) throw new Error("A web address is required");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That web address is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web links can be opened");
  }
  await shell.openExternal(url.toString());
  return true;
});

// ---- Remote client mode: "Connect to another computer" --------------------
//
// A Muster server is also a web app, so this desktop can act as a CLIENT for
// another computer's Muster: a dedicated window loads that server's /app and
// signs in through the server's own pairing link (/claim#CODE). The local
// workspace, local server and companion are untouched — the window is
// exactly as trustworthy as opening the same URL in a browser, minus the
// browser.
//
// Hardening, because a remote document must never get app powers:
//  - its own partition ("persist:remote-client") → separate cookies, and
//    NOT the defaultSession the app authenticates against;
//  - no preload at all → window.ogb never exists there;
//  - permission and permission-check handlers DENY everything for this
//    session, so a remote page cannot even ask for camera/mic/notifications;
//  - popups open in the system browser (never inside the window);
//  - navigation is pinned to the exact origin the user connected to, so a
//    redirect to some other host cannot ride along.
const remoteClientWindows = new Map(); // partition → BrowserWindow

function remoteClientSession(partition) {
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(false));
  ses.setPermissionCheckHandler((_wc, _permission) => false);
  return ses;
}

ipcMain.handle("desktop:open-remote-client", async (event, rawUrl) => {
  if (asText(rawUrl) === null) throw new Error("A web address is required");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That web address is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web addresses can be connected to");
  }
  // Plain HTTP is the local-network shape (muster up prints exactly such a
  // link); everywhere else Muster is HTTPS-only. This mirrors the renderer
  // validator so the boundary does not depend on it.
  const host = url.hostname.toLowerCase();
  const lanHost = host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost") ||
    host.startsWith("127.") || host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.startsWith("169.254.");
  if (!lanHost && url.protocol !== "https:") {
    throw new Error("Remote connections must use HTTPS");
  }

  const origin = url.origin;
  const partition = `persist:remote-client-${origin}`;
  const existing = remoteClientWindows.get(partition);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return true;
  }

  const win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: process.platform !== "darwin",
    title: "Muster — remote",
    webPreferences: {
      contextIsolation: true,
      // No preload: the remote surface gets none of the desktop bridge.
      nodeIntegration: false,
      sandbox: true,
      session: remoteClientSession(partition),
    },
  });
  remoteClientWindows.set(partition, win);
  win.on("closed", () => remoteClientWindows.delete(partition));
  win.webContents.setWindowOpenHandler(({ url: popup }) => {
    // Popups from the remote surface go to the system browser, like any web
    // page — never a second in-app window we would have to police.
    if (popup.startsWith("http:")) shell.openExternal(popup);
    else if (popup.startsWith("https:")) shell.openExternal(popup);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (navEvent, target) => {
    // Pin to the origin the user connected to. The app's own routes stay;
    // anything else (a redirect to another host, a hijacked asset) is sent
    // to the system browser instead of loading in the window.
    try {
      if (new URL(target).origin === origin) return;
    } catch {
      /* fall through to the refusal below */
    }
    navEvent.preventDefault();
    if (/^https?:/.test(target)) shell.openExternal(target);
  });
  win.webContents.on("did-fail-load", (failEvent, code, _description, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      // The page itself explains connection problems; a dead-end dialog on
      // top of it adds nothing.
      slog(`remote client load failed: ${failedUrl} (${code})`);
    }
  });
  void win.loadURL(url.toString()).catch((error) => slog(`remote client open failed: ${error?.message ?? error}`));
  return true;
});

// Desktop Google sign-in handoff. The cloud bounce lands on
// http://127.0.0.1:<port>/oauth/finish#code=… — a loopback URL only the
// Muster server can serve, and the session cookie it sets must land in the
// APP's cookie jar (defaultSession), not the system browser's. Opening the
// flow in Safari/Chrome signed the user in there while the app polled its
// own jar forever: the browser proudly said "Signed in as …" and the app
// never noticed. So the auth start URL opens a small in-app window (same
// session as the app → same jar), the cloud's redirect loads locally, the
// finish page's exchange sets the cookie where the renderer's get-session
// poll can see it, and the window closes itself. Any other external URL
// keeps the old system-browser behavior.
let handoffWindow = null;
function openHandoffWindow(startUrl) {
  handoffWindow?.close();
  handoffWindow = new BrowserWindow({
    width: 520,
    height: 680,
    show: false,
    autoHideMenuBar: true,
    title: "Sign in to Muster",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  handoffWindow.once("ready-to-show", () => handoffWindow?.show());
  handoffWindow.on("closed", () => {
    handoffWindow = null;
  });
  // Any navigation away from the cloud identity surface ends the handoff —
  // the finish page closes its own window after the exchange.
  handoffWindow.webContents.on("will-navigate", (_event, target) => {
    if (!target.startsWith(startUrl)) handoffWindow?.close();
  });
  void handoffWindow.loadURL(startUrl);
}

ipcMain.handle("desktop:open-auth-handoff", async (_event, rawUrl) => {
  if (asText(rawUrl) === null) throw new Error("A web address is required");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That web address is invalid");
  }
  // The handoff window is only for the cloud sign-in start. It must never
  // load arbitrary content with app-session cookies attached.
  const allowed = new URL(String(process.env.OMB_PAIR_CLOUD_URL || "https://muster.today"));
  if (url.protocol !== "https:" || url.host !== allowed.host) {
    throw new Error("Only the configured cloud sign-in page can open here");
  }
  openHandoffWindow(url.toString());
  return true;
});

// Windows paints its caption buttons from the native titleBarOverlay, which
// cannot read CSS variables — so the renderer pushes the active skin's
// colors across the bridge whenever the skin changes (src/lib/skins.ts).
// Everywhere else this is a deliberate no-op: macOS traffic lights are
// native and Linux keeps the desktop title bar.
ipcMain.handle("desktop:set-titlebar-overlay", (event, overlay) => {
  if (process.platform !== "win32") return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const color = asText(overlay?.color);
  const symbolColor = asText(overlay?.symbolColor);
  // Literal hex only — a CSS var name or any other paint the shell can't
  // resolve would come out black or throw deep inside Chromium.
  if (!/^#[0-9a-fA-F]{6}$/.test(color ?? "") || !/^#[0-9a-fA-F]{6}$/.test(symbolColor ?? "")) {
    throw new Error("Overlay colors must be #rrggbb hex values");
  }
  // Height MUST keep matching the header strip (createWindow) — the
  // renderer may change the paint, never the geometry.
  win.setTitleBarOverlay({ color, symbolColor, height: 60 });
  return true;
});

ipcMain.handle("perm:status", () => ({
  mic:
    process.platform === "darwin"
      ? systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown"
      : "unsupported",
}));
ipcMain.handle("perm:request-mic", async () => {
  if (process.platform !== "darwin") return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane.
ipcMain.handle("perm:open-settings", (_event, pane) => {
  if (process.platform !== "darwin") return false;
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    speech: "Privacy_SpeechRecognition",
    // This-Mac control permission — the repair path after a denied
    // Accessibility grant (tiptour integration study, slice 4).
    accessibility: "Privacy_Accessibility",
  };
  // own-property lookup only — a renderer-supplied "__proto__"/"constructor"
  // would otherwise resolve up the prototype chain to a truthy object
  const anchor = Object.hasOwn(panes, pane) ? panes[pane] : "Privacy";
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
});

ipcMain.handle("speech:start", (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (process.platform !== "darwin") {
    win.webContents.send("speech:end", { code: 2, reason: "unsupported-platform" });
    return;
  }
  startSpeech(win, options);
});
ipcMain.handle("speech:stop", () => {
  if (process.platform === "darwin") stopSpeech();
});
ipcMain.handle("speech:finish", () => {
  if (process.platform === "darwin") finishSpeech();
});

// ── companion sidecar ──────────────────────────────────────────────────
// The renderer gets these and nothing else: it can turn the companion on and
// off, look at it, open or cancel a pairing window, remove a device, and —
// when the port is held by a foreign sidecar — ask for that one to be stopped
// in the user's place. It cannot reach the sidecar's control port itself.
ipcMain.handle("companion:state", () => companionState());
ipcMain.handle("companion:start", () =>
  startCompanion({ resourcesPath: process.resourcesPath, harnessPort: SERVER_PORT, log: slog }),
);
ipcMain.handle("companion:stop", () => stopCompanion());
ipcMain.handle("companion:stop-foreign", () => stopForeignCompanion());
ipcMain.handle("companion:keep-awake", (_event, enabled) => setCompanionKeepAwake(Boolean(enabled)));
ipcMain.handle("companion:pairing", (_event, open, access) => companionPairing(Boolean(open), access));
ipcMain.handle("companion:access", (_event, deviceId, access) => companionSetAccess(deviceId, access));
ipcMain.handle("companion:cloud-desktop", (_event, deviceId, allowed) =>
  companionCloudDesktopAccess(deviceId, Boolean(allowed)),
);
ipcMain.handle("companion:revoke", (_event, deviceId) => companionRevoke(deviceId));

ipcMain.handle("desktop:capabilities", async () =>
  desktopCapabilities({
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: getCuaConnection(),
  }),
);

ipcMain.handle("credential:set", async (_event, name, value) => {
  if (name !== "composioApiKey" || asText(value) === null) {
    throw new Error("Unsupported credential");
  }
  if (app.isPackaged && !(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  // In development the server is a separately launched process, so it cannot
  // receive credentials from Electron at boot. Keep its established local
  // config path there; production always uses the encrypted external store.
  const secretStorage = app.isPackaged ? "?secretStorage=external" : "";
  const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config${secretStorage}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ composio: { apiKey: value.trim() } }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `Could not save credential (HTTP ${response.status})`);
  if (app.isPackaged) {
    if (value.trim()) secureCredentials.composioApiKey = value.trim();
    else delete secureCredentials.composioApiKey;
    await saveSecureCredentials(secureCredentials);
  }
  return body;
});

app.whenReady().then(async () => {
  // Every app session begins with computer control off. Invalidate the exact
  // profile's previous descriptor before starting a server or accepting IPC.
  // If this write fails, do not let a stale connection reach the harness.
  try {
    initializeCua();
  } catch (error) {
    dialog.showErrorBox("Could not prepare computer access", "Muster could not reset computer access for this session. Check that its app data folder is writable, then reopen the app.");
    slog(`computer access initialization failed: ${error?.message ?? error}`);
    app.quit();
    return;
  }
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  if (app.isPackaged) {
    secureCredentials = await loadSecureCredentials();
    await secureComposioConfig();
    await ensureManagedComposioCredentials();
  }
  // getDisplayMedia in the renderer → this handler → ScreenCaptureKit, all
  // inside the app's own processes — the one capture path macOS reliably
  // attributes to the app (registers it in the Screen Recording pane and
  // prompts). Used by the onboarding "Enable screen preview" button.
  if (process.platform === "darwin") {
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ["screen"] })
          .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
          .catch(() => callback({}));
      },
      { useSystemPicker: false },
    );
  }
  registerCuaIpc((event) => isComputerAccessSender(event, appContents,
    app.isPackaged ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL), () => {
    for (const contents of appContents) {
      try { if (!contents.isDestroyed()) contents.send("cua:changed"); } catch { /* Window closed during startup. */ }
    }
  });
  registerUpdaterIpc();
  registerTrayIpc();
  startStatusItem();
  // View menu gains the tray companion toggle (all platforms). A hidden
  // tray window is reachable again from here even after it was closed.
  const menu = Menu.getApplicationMenu();
  if (menu) {
    const viewItem = menu.getMenuItemById("view") ?? menu.items.find((item) => item.label === "View");
    if (viewItem?.submenu) {
      if (app.isPackaged) {
        recoveryMenuItem = new MenuItem({
          label: "Reconnect local server", enabled: false,
          click: () => { void retryLocalServer().then(() => offerServerRecovery()); },
        });
        viewItem.submenu.append(recoveryMenuItem);
      }
      viewItem.submenu.append(new MenuItem({
        label: "Mascot Companion",
        accelerator: "CommandOrControl+Shift+M",
        click: () => toggleTrayWindow(),
      }));
      Menu.setApplicationMenu(menu);
    }
  }
  // The driver and its permission prompts start only after the explicit
  // Enable for this session action in the bot's Computer panel.
  if (app.isPackaged) {
    // A stopped server releases its port. Until our new child proves its
    // identity, renderer reconnects must not send session headers or accept
    // responses from an unrelated process that happens to bind that address.
    session.defaultSession.webRequest.onBeforeSendHeaders({
      urls: [8799, 18799, 28799].map((port) => `http://127.0.0.1:${port}/*`),
    }, (details, callback) => {
      callback({ cancel: !serverLifecycle.allowsRequest(details.url) });
    });
    await serverLifecycle.start([8799, 18799, 28799, 8799, 18799, 28799]);
  }
  if (serverLifecycle.snapshot().phase === "quitting") return;
  const win = createWindow();
  // Revive a companion that was on last time, once the window exists to report
  // a failure in and SERVER_PORT has settled. Fire-and-forget: a companion
  // that will not come up must not delay the app.
  void reviveCompanionAtLaunch({ resourcesPath: process.resourcesPath, harnessPort: SERVER_PORT, log: slog });
  // in-app auto-update (packaged only) — checks GitHub releases, downloads on
  // the user's click, installs on "Restart to update"
  startUpdater(win);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// EMBEDDING.md lifecycle rule: defer the first quit until the embedded
// daemon's async cleanup completes — it can't run after the host exits.
// Cap the defer so a wedged daemon cannot keep the app alive forever.
const CUA_STOP_TIMEOUT_MS = 2500;
let cuaCleanedUp = false;
let quitCleanupStarted = false;
app.on("before-quit", (e) => {
  stopStatusItem();
  if (cuaCleanedUp) { slog("desktop shutdown final quit accepted"); return; }
  e.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  slog("desktop shutdown cleanup started");
  serverLifecycle.quit();
  // the sidecar holds a socket that is reachable from off this machine —
  // it should not outlive the window by even a moment
  void stopCompanion();
  // a live dictation session runs its own helper child that holds the mic —
  // stop it here so quitting never orphans a recording process
  stopSpeech();
  const cleanup = Promise.race([
    stopCua().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, CUA_STOP_TIMEOUT_MS).unref()),
  ]);
  cleanup.then(() => {
    cuaCleanedUp = true;
    slog("desktop shutdown cleanup completed");
    // A synchronously settled cleanup must not re-enter the native quit
    // request from its before-quit microtask. Resume on the next event turn.
    setImmediate(() => { slog("desktop shutdown resuming quit"); app.quit(); });
  });
});
