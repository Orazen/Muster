/**
 * How long a "downloading" state may go without a single progress or
 * downloaded event before the coordinator reports it as a retry-able error.
 *
 * This watchdog exists because nothing else can move that state:
 * - electron-updater's request timeout is inert on the packaged mac path: it
 *   attaches via `request.on("socket", …)`, an event Electron's
 *   net.ClientRequest never emits, so a mid-transfer stall never errors.
 * - a feed served WITHOUT a content-length header (which is how
 *   muster's /downloads static handler serves the release zips today)
 *   never gets a ProgressCallbackTransform installed, so a healthy
 *   transfer emits zero download-progress events the whole way down.
 *
 * @see electron/updater.mjs, and the "error" listener below for the third
 *   leg (events that fire but whose promise never settles).
 */
export const DOWNLOAD_STALL_TIMEOUT_MS = 120_000;

const DOWNLOAD_STALL_MESSAGE =
  "Download stalled — no update progress for 2 minutes. Check your connection and try again, or download the update manually.";

/**
 * @param manualMacUpdates macOS builds without Developer ID signing cannot
 *   trust Squirrel.Mac's in-place swap (it downloads fine and then fails or
 *   hangs on apply). The caller detects this once and the coordinator stops
 *   offering download/restart states entirely — the UI switches to one
 *   honest "get the new version" button instead.
 * @param stallTimeoutMs grace period for a silent download (see above).
 * @param scheduleTimer timer injection for deterministic tests; both default
 *   to setTimeout/clearTimeout and the scheduled handle is unref'd when it
 *   supports it, so the watchdog never keeps the process alive.
 */
export function createUpdaterCoordinator(
  updater,
  setState,
  {
    manualMacUpdates = false,
    stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS,
    scheduleTimer = (callback, ms) => setTimeout(callback, ms),
    cancelTimer = (handle) => clearTimeout(handle),
  } = {},
) {
  let checkOperation = null;
  let downloadOperation = null;
  // The coordinator's own merged view of the state it has published. Used to
  // guard the stall watchdog and to drop a duplicate report of one failure —
  // electron-updater dispatches an "error" event AND rejects the matching
  // promise, and both must resolve to exactly one user-visible error.
  let published = { status: "idle" };
  let stallTimer = null;

  function disarmStallWatchdog() {
    if (stallTimer == null) return;
    cancelTimer(stallTimer);
    stallTimer = null;
  }

  function onStall() {
    stallTimer = null;
    if (published.status !== "downloading") return;
    // The transfer produced nothing for the whole grace period and its
    // promise may never settle at all. Release download ownership so the
    // renderer's retry starts a fresh attempt instead of re-awaiting the
    // dead one, then report an honest, retry-able error.
    downloadOperation = null;
    emit({ status: "error", message: DOWNLOAD_STALL_MESSAGE });
  }

  function armStallWatchdog() {
    disarmStallWatchdog();
    stallTimer = scheduleTimer(onStall, stallTimeoutMs);
    stallTimer?.unref?.();
  }

  function emit(patch) {
    const next = { ...published, ...patch };
    if (published.status === "error" && next.status === "error" && next.message === published.message) {
      return; // the "error" event and the promise rejection are one failure
    }
    published = next;
    if (published.status !== "downloading") disarmStallWatchdog();
    setState(patch);
  }

  function handleRejectedOperation(manual, error) {
    if (!manual) {
      emit({ status: "idle" });
      return;
    }
    emit({ status: "error", message: String(error?.message ?? error) });
  }

  function checkOwnsState() {
    return !downloadOperation && !checkOperation?.supersededByDownload;
  }

  updater.on("checking-for-update", () => {
    if (checkOwnsState()) emit({ status: "checking" });
  });
  updater.on("update-available", (info) => {
    if (checkOwnsState()) {
      // manualOnly rides along so the renderer picks the right UX in one
      // render pass instead of asking the platform again. Key is omitted
      // entirely on trusted platforms so existing state shapes don't grow
      // an always-undefined field.
      emit(
        manualMacUpdates
          ? { status: "available", version: info?.version, message: undefined, manualOnly: true }
          : { status: "available", version: info?.version, message: undefined },
      );
    }
  });
  updater.on("update-not-available", () => {
    if (checkOwnsState()) emit({ status: "idle" });
  });
  updater.on("download-progress", (progress) => {
    emit({ status: "downloading", percent: Math.round(progress?.percent ?? 0) });
    // any progress resets the stall clock
    armStallWatchdog();
  });
  updater.on("update-downloaded", (info) => emit({ status: "downloaded", version: info?.version }));
  updater.on("error", (error) => {
    // electron-updater's constructor registers its own "error" listener that
    // only logs, so an error that fires without the matching promise ever
    // settling used to vanish entirely. Surface it whenever user-driven work
    // is in flight; background (hourly) check failures stay silent — their
    // rejection already lands on idle.
    const userDriven =
      downloadOperation != null || checkOperation?.manual === true || published.status === "downloading";
    if (!userDriven) return;
    emit({ status: "error", message: String(error?.message ?? error) });
  });

  function check(manual = false) {
    if (checkOperation) {
      // A manual caller upgrades the shared operation; a timer never downgrades it.
      if (manual) checkOperation.manual = true;
      return checkOperation.promise;
    }

    const operation = { manual, supersededByDownload: Boolean(downloadOperation), promise: null };
    checkOperation = operation;
    try {
      operation.promise = Promise.resolve(updater.checkForUpdates())
        .catch((error) => {
          if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
        })
        .finally(() => {
          if (checkOperation === operation) checkOperation = null;
        });
    } catch (error) {
      if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
      checkOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  function download() {
    if (manualMacUpdates) {
      // Defensive: the renderer never shows the button in this mode, but a
      // stale window from before an update must not kick off a Squirrel
      // download whose only possible end is the hang we're avoiding.
      emit({ status: "available", manualOnly: true });
      return Promise.resolve();
    }
    if (checkOperation) checkOperation.supersededByDownload = true;
    if (downloadOperation) return downloadOperation.promise;

    const operation = { promise: null };
    downloadOperation = operation;
    // Own the state before the request goes out: the first "download-progress"
    // can be seconds away (connection setup, redirects), and until then the
    // renderer would still show an untouched "Download" button. No percent yet
    //  — the UI reads a missing percent as "starting".
    emit({ status: "downloading" });
    // …and start the clock immediately: if nothing at all reports in, the
    // watchdog turns the silence into an error instead of an eternal spinner.
    armStallWatchdog();
    try {
      operation.promise = Promise.resolve(updater.downloadUpdate())
        .catch((error) => handleRejectedOperation(true, error))
        .finally(() => {
          if (downloadOperation === operation) downloadOperation = null;
        });
    } catch (error) {
      handleRejectedOperation(true, error);
      downloadOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  return { check, download };
}
