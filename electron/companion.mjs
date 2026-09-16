// The companion sidecar's lifecycle, as seen by the desktop app.
//
// The sidecar is a separate process on purpose — it is the only thing here
// that listens off-machine, and keeping it out of the harness is what lets
// the harness stay loopback-only and unpatched. But "separate process" does
// not have to mean "open a terminal": the app already forks the harness the
// same way, and a toggle in Settings is what anyone actually wants.
//
// The renderer never talks to the sidecar's control port directly. It calls
// through here, which keeps the UI on one origin, avoids CORS, and means the
// narrow list of things the renderer may ask for is written down in one
// place rather than implied by whatever the control server happens to serve.
import { app, powerSaveBlocker, utilityProcess } from "electron";
import { desktopProfile } from "./profile-paths.mjs";
import { readCompanionSettings, writeCompanionSettings } from "./companion-settings.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Passed to the fork rather than left to the sidecar's own defaults, so the
// port this file fetches the control API on cannot drift from the port the
// sidecar opened. They must stay clear of the harness, which takes 8799 for
// itself and 8800 for its webhook receiver — the sidecar refuses to start on
// either and says which, rather than racing it for the socket.
const CONTROL_PORT = 8811;
const COMPANION_PORT = 8810;

let proc = null;
let lastError = null;
/** The sidecar that got to the control port first, when it was not ours:
 * { pid, dir }. The panel offers one action for it — stop it and retry —
 * because "go find the process in a terminal" is a dead end. */
let foreign = null;
/** The options the last start() was called with, so the retry-after-stop
 * path can re-run the identical start without the renderer resupplying
 * anything (it does not know resourcesPath or the harness port). */
let lastStartOptions = null;

/** Where the remembered preferences live. userData, not the companion's own
 * directory: this is a fact about the app's own setting, and it must be
 * readable before the sidecar has ever run. */
const settingsFile = () => path.join(app.getPath("userData"), "companion-settings.json");

/** The preferences as last written. Read once and kept, so the panel and the
 * keep-awake holder cannot disagree about what the file says. */
let preferences = null;

function loadPreferences() {
  if (!preferences) preferences = readCompanionSettings(settingsFile());
  return preferences;
}

function savePreferences(next) {
  preferences = { enabled: next.enabled === true, keepAwake: next.keepAwake === true };
  writeCompanionSettings(settingsFile(), preferences);
  return preferences;
}

/** The keep-awake blocker, held only while the companion is running and the
 * user asked for it. A laptop that sleeps stops serving the phones already
 * paired to it, which reads as the companion having failed rather than as a
 * power setting the user never found. */
let keepAwakeId = null;

function syncKeepAwake(running) {
  const wanted = running && loadPreferences().keepAwake;
  if (wanted && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!wanted && keepAwakeId !== null) {
    try {
      powerSaveBlocker.stop(keepAwakeId);
    } catch {
      /* already stopped */
    }
    keepAwakeId = null;
  }
}

/** The companion directory a child forked right now would use — the same
 * resolution the sidecar itself performs (OMB_COMPANION_DIR, else the shared
 * default). A foreign sidecar reporting THIS dir is a stale copy of ours. */
const expectedCompanionDir = () =>
  process.env.OMB_COMPANION_DIR || path.join(os.homedir(), ".muster-companion");

/** Ask the (foreign) sidecar to die, then wait for the control port to go
 * quiet. The pid came from a loopback /state answer shaped like our schema,
 * and is validated here as a positive integer before anything is signalled. */
async function stopForeignSidecar(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ESRCH: already gone — the port check below decides whether we can start.
  }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      await control("GET", "/state");
    } catch {
      return true; // port answered nothing anymore — it is free
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Where the sidecar's compiled entry lives.
 *
 * Packaged, it is staged into resources alongside the harness. In dev there
 * is no such directory, so it comes from dist-companion — which means
 * `pnpm build:companion` has to have been run at least once. Returning null
 * rather than a path that does not exist is what lets the toggle say so
 * instead of failing with a spawn error nobody can read. */
const entryPoint = (resourcesPath) => {
  const packaged = path.join(resourcesPath, "companion", "index.js");
  if (app.isPackaged) return fs.existsSync(packaged) ? packaged : null;
  const built = path.join(app.getAppPath(), "dist-companion", "index.js");
  return fs.existsSync(built) ? built : null;
};

/** Ask the sidecar's own control server, which is the same API the standalone
 * page uses. Short timeout: this is loopback, and a spinner in Settings that
 * never resolves is worse than an error. */
async function control(method, urlPath) {
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${urlPath}`, {
    method,
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok && res.status !== 404) throw new Error(`companion control ${res.status}`);
  return res.json();
}

/** Ask the control port who is listening when it is not our child. Returns
 * { pid, dir } for a sidecar that answers our schema, or null when the port is
 * silent or answers something we do not recognise — an unrelated service must
 * never be reported as a stoppable companion. */
async function probeControlOwner() {
  try {
    const state = await control("GET", "/state");
    if (!Number.isInteger(state?.pid) || state.pid <= 0) return null;
    return { pid: state.pid, dir: state.dir ?? "unknown" };
  } catch {
    return null;
  }
}

/** Whether this process owns a running sidecar. */
export function companionRunning() {
  return proc !== null;
}

// Every lifecycle transition runs to completion before the next one begins.
//
// Without this the guards below look sufficient and are not, because each one
// is a check followed by an await. Three things go wrong, and all of them end
// with the toggle and reality disagreeing: two concurrent starts both pass
// `if (proc)` and fork two sidecars; a failed start overwrites the `proc` a
// successful one just published; and a stop issued mid-startup finds `proc`
// still null, so it kills nothing and the start it raced then publishes a
// sidecar the user has already asked to shut down.
let transition = Promise.resolve();

/** Queue a lifecycle transition behind whatever is already in flight. */
const serialize = (work) => {
  const next = transition.then(work, work);
  // The chain itself must never carry a rejection forward, or one failed
  // transition would poison every transition after it.
  transition = next.then(
    () => {},
    () => {},
  );
  return next;
};

/** Fork the sidecar and wait for it to answer. Resolves with the panel's
 * state either way — a failed start is a message, never a thrown error. */
export function startCompanion(options) {
  return serialize(() => start(options));
}

/** Stop the sidecar and wait for it to actually be gone. */
export function stopCompanion() {
  return serialize(() => stop());
}

/** The panel's answer to "another companion is holding the port": stop THAT
 * process (only ever one the user explicitly asked about) and start ours in
 * its place. A no-op when nothing foreign is recorded. */
export function stopForeignCompanion() {
  return serialize(async () => {
    const target = foreign;
    if (!target) return companionState();
    foreign = null;
    const freed = await stopForeignSidecar(target.pid);
    if (!freed) {
      lastError = "the other companion did not stop — it may have restarted under a new process";
      return companionState();
    }
    if (!lastStartOptions) {
      lastError = null;
      return companionState();
    }
    return start(lastStartOptions, true);
  });
}

/** startCompanion's body, run inside the transition queue. */
async function start(options, retried = false) {
  if (proc) return companionState();
  lastStartOptions = options;
  const { resourcesPath, harnessPort, log } = options;
  lastError = null;
  const entry = entryPoint(resourcesPath);
  if (!entry) {
    lastError = app.isPackaged
      ? "the companion is missing from this build"
      : "run `pnpm build:companion` once, then try again";
    return companionState();
  }
  log?.(`companion fork ${entry}`);

  const childOptions = {
    env: {
      ...process.env,
      OMB_PORT: String(harnessPort),
      OMB_COMPANION_PORT: String(COMPANION_PORT),
      OMB_CONTROL_PORT: String(CONTROL_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (desktopProfile) childOptions.cwd = desktopProfile.cwd;
  const child = utilityProcess.fork(entry, [], childOptions);
  child.stdout?.on("data", (d) => log?.(`[companion] ${String(d).trimEnd()}`));
  child.stderr?.on("data", (d) => log?.(`[companion err] ${String(d).trimEnd()}`));

  let exited = false;
  child.once("exit", (code) => {
    exited = true;
    // A non-zero exit before we saw it answer is the interesting case: the
    // usual cause is the port already being taken, and the sidecar's own
    // message says which one and why.
    if (proc === child) proc = null;
    log?.(`companion exited code=${code}`);
  });

  // Wait for the control port rather than assuming the fork worked. Without
  // this the toggle would flip to "on" and the panel would then fail every
  // request, which reads as a broken app rather than a failed start.
  for (let i = 0; i < 40; i++) {
    if (exited) {
      // The usual cause is the control port being held by a sidecar we did not
      // fork: a stale copy left by a previous run, or another install. The
      // child dies on the bind before it can answer, so "check the log" is all
      // this branch could say — and it is a dead end for the user, because the
      // panel then offers no action. Ask the port directly who owns it
      // instead, which turns the failure into the stop-it-and-retry action
      // stopForeignCompanion already implements.
      const owner = await probeControlOwner();
      if (owner) {
        foreign = owner;
        lastError = `port ${CONTROL_PORT} is already serving another companion (pid ${owner.pid}) — stop it and try again`;
        return companionState();
      }
      lastError = "the companion could not start — check the log";
      return companionState();
    }
    try {
      const state = await control("GET", "/state");
      // An answer on the control port proves something is listening there,
      // not that it is the child we just forked. A sidecar started by hand,
      // or one left behind by a previous run, answers exactly the same and
      // would be adopted as ours — after which the toggle drives a process
      // it does not own and stopping it does nothing visible. Match the pid.
      if (state?.pid !== undefined && child.pid !== undefined && state.pid !== child.pid) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        // Whose companion is it? The sidecar reports the directory holding
        // its paired fleet. Ours (a stale copy from a previous run of THIS
        // profile) is stopped and replaced without ceremony — leaving the
        // toggle broken would be the worse outcome, and the phones it serves
        // reconnect to the fresh copy. Someone else's companion is not ours
        // to kill: it may be another profile's install with its own paired
        // phones, so the panel asks before acting.
        if (state.dir && state.dir === expectedCompanionDir()) {
          log?.(`companion: stopping stale same-profile sidecar pid ${state.pid}`);
          if (!retried && (await stopForeignSidecar(state.pid))) {
            return start(options, true);
          }
          lastError = "the old companion would not release the port — try again";
          return companionState();
        }
        foreign = Number.isInteger(state.pid) && state.pid > 0 ? { pid: state.pid, dir: state.dir ?? "unknown" } : null;
        lastError = `port ${CONTROL_PORT} is already serving another companion (pid ${state.pid}) — stop it and try again`;
        return companionState();
      }
      proc = child;
      foreign = null;
      savePreferences({ ...loadPreferences(), enabled: true });
      syncKeepAwake(true);
      return companionState();
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  lastError = "the companion did not come up in time";
  return companionState();
}

/** stopCompanion's body, run inside the transition queue. */
async function stop() {
  const child = proc;
  proc = null;
  lastError = null;
  foreign = null;
  if (!child) return companionState();
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  // kill() asks. Returning before the process is actually gone means the
  // next start races a sidecar still holding the port, and the user sees the
  // toggle fail for a reason that has already stopped being true. Wait for
  // the exit, bounded — a wedged child must not leave Settings stuck either.
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once("exit", finish);
    setTimeout(finish, 5_000).unref?.();
  });
  return companionState();
}

/** Everything the panel renders. Shaped so "off" is a complete answer rather
 * than an absence — the panel should never have to guess. */
export async function companionState() {
  const settings = loadPreferences();
  if (!proc) {
    const state = { enabled: false, keepAwake: settings.keepAwake, port: COMPANION_PORT, devices: [], pairing: null };
    // a complete answer names why the companion is off when it is known
    if (lastError) state.error = lastError;
    // and names the process to stop when the panel can offer that action
    if (foreign) state.foreign = foreign;
    return state;
  }
  try {
    const state = await control("GET", "/state");
    return { enabled: true, keepAwake: settings.keepAwake, ...state };
  } catch {
    // running but unreachable: report it rather than claiming health
    return {
      enabled: true,
      keepAwake: settings.keepAwake,
      port: COMPANION_PORT,
      devices: [],
      pairing: null,
      error: "the companion is not responding",
    };
  }
}

/** Turn the keep-awake preference on or off and apply it immediately.
 * Separate from start/stop because it is orthogonal to whether the companion
 * is running: the user may set it before turning the companion on, and it
 * takes effect the moment the companion next runs. */
export function setCompanionKeepAwake(enabled) {
  return serialize(() => {
    savePreferences({ ...loadPreferences(), keepAwake: Boolean(enabled) });
    syncKeepAwake(proc !== null);
    return companionState();
  });
}

/** Start the companion at launch when it was on last time.
 *
 * Without this a relaunch silently strands every paired phone: the sidecar is
 * off, nothing tells the user why, and the pairing code they would need to
 * re-pair with has to be minted from the very panel they have not opened yet.
 * A failure here is recorded in lastError like any other start — the app
 * still comes up, and the panel explains what happened. */
export async function reviveCompanionAtLaunch(options) {
  if (!loadPreferences().enabled) {
    // Honour the preference even when it is off, so a keep-awake left set
    // from a previous run cannot keep the machine awake for nothing.
    syncKeepAwake(false);
    return companionState();
  }
  return startCompanion(options);
}

/** Open or close a pairing window on the running sidecar. */
export async function companionPairing(open) {
  if (!proc) return companionState();
  await control(open ? "POST" : "DELETE", "/pairing").catch(() => {});
  return companionState();
}

/** Unpair one device. Ignores an id the renderer should not have sent. */
export async function companionRevoke(deviceId) {
  if (!proc) return companionState();
  // the id came from the renderer, so it does not get to shape a path
  if (!/^[\w-]{1,64}$/.test(String(deviceId ?? ""))) return companionState();
  await control("DELETE", `/devices/${deviceId}`).catch(() => {});
  return companionState();
}

/** Enable or remove interactive cloud-desktop access for one paired phone. */
export async function companionCloudDesktopAccess(deviceId, allowed) {
  if (!proc) return companionState();
  if (!/^[\w-]{1,64}$/.test(String(deviceId ?? ""))) return companionState();
  await control(allowed ? "POST" : "DELETE", `/devices/${deviceId}/cloud-desktop`).catch(() => {});
  return companionState();
}
