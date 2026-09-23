import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createUpdaterCoordinator, DOWNLOAD_STALL_TIMEOUT_MS } from "./updater-coordinator.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const updater = new EventEmitter();
  // electron-updater has its own error listener; model that without routing it.
  updater.on("error", () => {});
  let state = { status: "idle" };
  const states = [];
  const coordinator = createUpdaterCoordinator(
    updater,
    (patch) => {
      state = { ...state, ...patch };
      states.push({ ...state });
    },
    options,
  );
  return { updater, coordinator, states, getState: () => state };
}

/** Deterministic stand-in for the watchdog's timers: the coordinator gets
 * handles it can cancel, and the test decides exactly when a deadline
 * passes — no sleeps, no flake. */
function fakeTimers() {
  let nextId = 1;
  const live = new Map();
  let cancelled = 0;
  return {
    scheduleTimer(callback, ms) {
      const handle = { id: nextId++, callback, ms };
      live.set(handle.id, handle);
      return handle;
    },
    cancelTimer(handle) {
      cancelled += 1;
      live.delete(handle.id);
    },
    live() {
      return [...live.values()];
    },
    cancelledCount: () => cancelled,
    fireAll() {
      const pending = [...live.values()];
      live.clear();
      for (const handle of pending) handle.callback();
    },
  };
}

function errorStates(states) {
  return states.filter((entry) => entry.status === "error");
}

test("automatic check rejection is handled and returns to idle", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("offline"));

  await assert.doesNotReject(coordinator.check());

  assert.equal(getState().status, "idle");
});

test("manual check rejection is handled as a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("feed failed"));

  await assert.doesNotReject(coordinator.check(true));

  assert.deepEqual(getState(), { status: "error", message: "feed failed" });
});

test("download rejection is handled as a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.downloadUpdate = () => Promise.reject(new Error("download failed"));

  await assert.doesNotReject(coordinator.download());

  assert.deepEqual(getState(), { status: "error", message: "download failed" });
});

test("synchronous check and download throws are handled", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => {
    throw new Error("check threw");
  };

  await assert.doesNotReject(coordinator.check(true));
  assert.deepEqual(getState(), { status: "error", message: "check threw" });

  updater.downloadUpdate = () => {
    throw new Error("download threw");
  };

  await assert.doesNotReject(coordinator.download());
  assert.deepEqual(getState(), { status: "error", message: "download threw" });
});

test("a concurrent background check cannot downgrade a manual check", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  let calls = 0;
  updater.checkForUpdates = () => {
    calls += 1;
    return pending.promise;
  };

  const manual = coordinator.check(true);
  const background = coordinator.check();
  assert.strictEqual(background, manual);
  assert.equal(calls, 1);

  pending.reject(new Error("manual failure"));
  await manual;

  assert.deepEqual(getState(), { status: "error", message: "manual failure" });
});

test("a manual request during a background check preserves user-visible errors", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  let calls = 0;
  updater.checkForUpdates = () => {
    calls += 1;
    return pending.promise;
  };

  const background = coordinator.check();
  const manual = coordinator.check(true);
  assert.strictEqual(manual, background);
  assert.equal(calls, 1);

  pending.reject(new Error("background request failed"));
  await background;

  assert.deepEqual(getState(), { status: "error", message: "background request failed" });
});

test("download reports downloading before the first progress event", async () => {
  const { updater, coordinator, getState, states } = harness();
  const pending = deferred();
  // a real transfer stays silent until bytes arrive; the button must not wait
  updater.downloadUpdate = () => pending.promise;

  const download = coordinator.download();
  assert.deepEqual(getState(), { status: "downloading" });
  assert.equal(states[0].status, "downloading");

  updater.emit("download-progress", { percent: 12 });
  assert.deepEqual(getState(), { status: "downloading", percent: 12 });

  pending.resolve();
  await download;
});

test("an active download state survives a later background check failure", async () => {
  const { updater, coordinator, getState } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 42 });
    return downloadPending.promise;
  };
  updater.checkForUpdates = () => {
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "2.1.0" });
    updater.emit("update-not-available");
    return checkPending.promise;
  };

  const download = coordinator.download();
  assert.deepEqual(getState(), { status: "downloading", percent: 42 });

  const background = coordinator.check();
  checkPending.reject(new Error("background check failed"));
  await background;
  assert.deepEqual(getState(), { status: "downloading", percent: 42 });

  downloadPending.resolve();
  await download;
});

test("a download error remains authoritative after a later background failure", async () => {
  const { updater, coordinator, getState } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 75 });
    return downloadPending.promise;
  };
  updater.checkForUpdates = () => checkPending.promise;

  const download = coordinator.download();
  const background = coordinator.check();

  const downloadError = new Error("download failed first");
  downloadPending.reject(downloadError);
  await download;
  assert.deepEqual(getState(), {
    status: "error",
    percent: 75,
    message: "download failed first",
  });

  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "2.1.0" });
  updater.emit("update-not-available");
  checkPending.reject(new Error("background check failed later"));
  await background;

  assert.deepEqual(getState(), {
    status: "error",
    percent: 75,
    message: "download failed first",
  });
});

test("a background failure stays silent before a later download failure", async () => {
  const { updater, coordinator, getState, states } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.checkForUpdates = () => checkPending.promise;
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 18 });
    return downloadPending.promise;
  };

  const background = coordinator.check();
  const download = coordinator.download();

  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "2.1.0" });
  updater.emit("update-not-available");
  checkPending.reject(new Error("background check failed first"));
  await background;
  assert.deepEqual(getState(), { status: "downloading", percent: 18 });
  assert.equal(errorStates(states).length, 0);

  const downloadError = new Error("download failed later");
  downloadPending.reject(downloadError);
  await download;

  assert.deepEqual(getState(), {
    status: "error",
    percent: 18,
    message: "download failed later",
  });
});

test("available, not-available, progress, and downloaded events preserve success behavior", async () => {
  const available = harness();
  available.updater.checkForUpdates = () => {
    available.updater.emit("checking-for-update");
    queueMicrotask(() => available.updater.emit("update-available", { version: "2.0.0" }));
    return Promise.resolve({ isUpdateAvailable: true });
  };
  await available.coordinator.check(true);
  assert.equal(available.getState().status, "available");
  assert.equal(available.getState().version, "2.0.0");

  available.updater.downloadUpdate = () => {
    available.updater.emit("download-progress", { percent: 42.4 });
    return Promise.resolve().then(() => {
      available.updater.emit("update-downloaded", { version: "2.0.0" });
      return ["update.zip"];
    });
  };
  await available.coordinator.download();
  assert.deepEqual(available.getState(), {
    status: "downloaded",
    version: "2.0.0",
    message: undefined,
    percent: 42,
  });

  const notAvailable = harness();
  notAvailable.updater.checkForUpdates = () => {
    notAvailable.updater.emit("checking-for-update");
    notAvailable.updater.emit("update-not-available");
    return Promise.resolve({ isUpdateAvailable: false });
  };
  await notAvailable.coordinator.check();
  assert.equal(notAvailable.getState().status, "idle");
});

test("an updater error event and rejected promise produce one deterministic state", async () => {
  const check = harness();
  const checkError = new Error("check failed once");
  check.updater.checkForUpdates = () =>
    Promise.reject(checkError).catch((error) => {
      check.updater.emit("error", error);
      throw error;
    });

  await check.coordinator.check(true);
  assert.equal(errorStates(check.states).length, 1);
  assert.deepEqual(check.getState(), { status: "error", message: "check failed once" });

  const download = harness();
  const downloadError = new Error("download failed once");
  download.updater.downloadUpdate = () =>
    Promise.reject(downloadError).catch((error) => {
      download.updater.emit("error", error);
      throw error;
    });

  await download.coordinator.download();
  assert.equal(errorStates(download.states).length, 1);
  assert.deepEqual(download.getState(), { status: "error", message: "download failed once" });
});

// ── manual mac updates (unsigned builds) ───────────────────────────────
test("manualOnly rides on update-available and download is refused", async () => {
  const updater = new EventEmitter();
  let checkForUpdates;
  updater.checkForUpdates = () => {
    checkForUpdates = deferred();
    return checkForUpdates.promise;
  };
  const states = [];
  const coordinator = createUpdaterCoordinator(updater, (patch) => states.push(patch), {
    manualMacUpdates: true,
  });

  const checking = coordinator.check(false);
  updater.emit("update-available", { version: "9.9.9" });
  checkForUpdates.resolve();
  await checking;

  const available = states.find((s) => s.status === "available");
  assert.equal(available.version, "9.9.9");
  assert.equal(available.manualOnly, true);

  // the renderer never shows the button here; a stale window calling
  // download must not kick off a Squirrel transfer that can only hang later
  await coordinator.download();
  assert.ok(!states.some((s) => s.status === "downloading"), "no downloading state in manual mode");
});

test("signed mac builds keep the normal pipeline", async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = () => new Promise(() => {});
  const states = [];
  createUpdaterCoordinator(updater, (patch) => states.push(patch), { manualMacUpdates: false });
  updater.emit("update-available", { version: "1.2.3" });
  const available = states.find((s) => s.status === "available");
  assert.equal(available.manualOnly, undefined);
});

// ── progress, error surfacing, and the stall watchdog ─────────────────

test("download-progress flows a rounded percent into state", () => {
  const { updater, coordinator, getState } = harness();
  updater.downloadUpdate = () => new Promise(() => {});

  coordinator.download();
  assert.equal(getState().status, "downloading");
  assert.equal(getState().percent, undefined); // unknown percent = "starting"

  updater.emit("download-progress", { percent: 42.4 });
  assert.deepEqual(getState(), { status: "downloading", percent: 42 });

  updater.emit("download-progress", { percent: 99.9 });
  assert.deepEqual(getState(), { status: "downloading", percent: 100 });
});

test("update-downloaded transitions to a downloaded state", () => {
  const { updater, coordinator, getState } = harness();
  updater.downloadUpdate = () => new Promise(() => {});

  coordinator.download();
  updater.emit("update-downloaded", { version: "3.0.0" });

  assert.equal(getState().status, "downloaded");
  assert.equal(getState().version, "3.0.0");
});

test("an updater error event surfaces an error even when the promise never settles", () => {
  const { updater, coordinator, getState, states } = harness();
  updater.downloadUpdate = () => new Promise(() => {});

  coordinator.download();
  updater.emit("error", new Error("socket hang up"));

  assert.equal(getState().status, "error");
  assert.match(getState().message, /socket hang up/);
  assert.equal(errorStates(states).length, 1);

  // a repeat of the same failure (event + eventual rejection) is one error
  updater.emit("error", new Error("socket hang up"));
  assert.equal(errorStates(states).length, 1);
});

test("an updater error event from a background check stays silent", async () => {
  const { updater, coordinator, getState, states } = harness();
  updater.checkForUpdates = () => {
    updater.emit("checking-for-update");
    // electron-updater dispatches "error" before its promise rejects
    updater.emit("error", new Error("offline"));
    return Promise.reject(new Error("offline"));
  };

  await coordinator.check(); // background (no manual flag)

  assert.equal(getState().status, "idle");
  assert.equal(errorStates(states).length, 0);
});

test("a silent download trips the stall watchdog into a retry-able error", async () => {
  const timers = fakeTimers();
  const { updater, coordinator, getState, states } = harness({
    scheduleTimer: timers.scheduleTimer,
    cancelTimer: timers.cancelTimer,
  });
  let downloadCalls = 0;
  updater.downloadUpdate = () => {
    downloadCalls += 1;
    return new Promise(() => {});
  };

  coordinator.download();
  assert.equal(getState().status, "downloading");
  assert.equal(timers.live().length, 1, "watchdog armed on download start");
  assert.equal(timers.live()[0].ms, DOWNLOAD_STALL_TIMEOUT_MS);
  assert.equal(DOWNLOAD_STALL_TIMEOUT_MS, 120_000);

  timers.fireAll();

  assert.equal(getState().status, "error");
  assert.match(getState().message, /stalled/i);
  assert.match(getState().message, /try again/i);
  assert.equal(errorStates(states).length, 1);

  // download ownership was released — a retry starts a fresh attempt
  // (deliberately not awaited: the fake transfer never settles)
  void coordinator.download();
  assert.equal(downloadCalls, 2);
});

test("each progress event rearms the stall watchdog", () => {
  const timers = fakeTimers();
  const { updater, coordinator } = harness({
    scheduleTimer: timers.scheduleTimer,
    cancelTimer: timers.cancelTimer,
  });
  updater.downloadUpdate = () => new Promise(() => {});

  coordinator.download();
  assert.equal(timers.live().length, 1);

  updater.emit("download-progress", { percent: 10 });
  assert.equal(timers.cancelledCount(), 1, "previous deadline cancelled");
  assert.equal(timers.live().length, 1, "fresh deadline scheduled");
});

test("the stall watchdog is disarmed once the update is downloaded", () => {
  const timers = fakeTimers();
  const { updater, coordinator, getState } = harness({
    scheduleTimer: timers.scheduleTimer,
    cancelTimer: timers.cancelTimer,
  });
  updater.downloadUpdate = () => new Promise(() => {});

  coordinator.download();
  updater.emit("download-progress", { percent: 50 });
  updater.emit("update-downloaded", { version: "2.0.0" });

  assert.equal(getState().status, "downloaded");
  assert.ok(timers.cancelledCount() >= 1, "watchdog cancelled on completion");
  assert.equal(timers.live().length, 0);

  // even a leaked deadline must not clobber a finished download
  timers.fireAll();
  assert.equal(getState().status, "downloaded");
});
