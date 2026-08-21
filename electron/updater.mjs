// In-app auto-updater (electron-updater), manual/button-driven — the same
// shape t3code's desktop app uses: autoDownload off, quitAndInstall on the
// user's "Restart to update" click. One state object is broadcast to the
// renderer on every transition; the renderer just renders it.
//
// Only runs in a packaged app; in dev it's a no-op so the browser/dev shell
// is unaffected. This comment used to say "signed+notarized" as if that were
// already true and guarded for — it isn't, Muster's current builds are only
// ad-hoc signed (no paid Apple Developer certificate; see
// build/after-pack-mac.mjs). macOS's own update mechanism (Squirrel.Mac,
// underneath electron-updater) can legitimately fail to APPLY an update it
// already found and downloaded when the running app isn't Developer ID
// signed — the check/download/apply pipeline itself is correct and doesn't
// need special-casing here, but src/components/UpdateBanner.tsx's error
// state offers a direct link to the release page as the fallback for
// exactly this, since "Try again" alone can't fix a signing problem.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app, ipcMain } from "electron";
import { createRequire } from "node:module";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | downloaded | installing | error
let state = { status: "idle" };
let updaterCoordinator = null;

function setState(patch) {
  state = { ...state, ...patch };
  try {
    win?.webContents?.send("update:state", state);
  } catch {
    /* window gone */
  }
}

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", () => state);
  ipcMain.handle("update:check", () => updaterCoordinator?.check(true));
  ipcMain.handle("update:download", () => updaterCoordinator?.download());
  ipcMain.handle("update:install", () => {
    if (!autoUpdater) return;
    // Tearing down the window and relaunching takes a beat; announce it so the
    // button greys out instead of looking like the click was swallowed.
    setState({ status: "installing" });
    // isSilent, isForceRunAfter — relaunch straight into the new version
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (e) {
      setState({ status: "error", message: String(e?.message ?? e) });
    }
  });
}

export function startUpdater(mainWindow) {
  win = mainWindow;
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!app.isPackaged) {
    updaterCoordinator = null;
    setState({ status: "idle" });
    return;
  }
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    updaterCoordinator = null;
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = false; // button-driven download
  autoUpdater.autoInstallOnAppQuit = false; // button-driven install
  autoUpdater.logger = null;

  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState);

  // first check ~15s after launch (let the app settle), then hourly — both
  // silent on failure, hence the arrow: a bare `check` would receive the
  // timer's argument as `manual` and start reporting errors again.
  setTimeout(() => void updaterCoordinator?.check(), 15_000).unref?.();
  setInterval(() => void updaterCoordinator?.check(), 60 * 60 * 1000).unref?.();
}
