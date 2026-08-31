/**
 * @param manualMacUpdates macOS builds without Developer ID signing cannot
 *   trust Squirrel.Mac's in-place swap (it downloads fine and then fails or
 *   hangs on apply). The caller detects this once and the coordinator stops
 *   offering download/restart states entirely — the UI switches to one
 *   honest "get the new version" button instead.
 */
export function createUpdaterCoordinator(updater, setState, { manualMacUpdates = false } = {}) {
  let checkOperation = null;
  let downloadOperation = null;

  function handleRejectedOperation(manual, error) {
    if (!manual) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "error", message: String(error?.message ?? error) });
  }

  function checkOwnsState() {
    return !downloadOperation && !checkOperation?.supersededByDownload;
  }

  updater.on("checking-for-update", () => {
    if (checkOwnsState()) setState({ status: "checking" });
  });
  updater.on("update-available", (info) => {
    if (checkOwnsState()) {
      // manualOnly rides along so the renderer picks the right UX in one
      // render pass instead of asking the platform again. Key is omitted
      // entirely on trusted platforms so existing state shapes don't grow
      // an always-undefined field.
      setState(
        manualMacUpdates
          ? { status: "available", version: info?.version, message: undefined, manualOnly: true }
          : { status: "available", version: info?.version, message: undefined },
      );
    }
  });
  updater.on("update-not-available", () => {
    if (checkOwnsState()) setState({ status: "idle" });
  });
  updater.on("download-progress", (progress) =>
    setState({ status: "downloading", percent: Math.round(progress?.percent ?? 0) }),
  );
  updater.on("update-downloaded", (info) =>
    setState({ status: "downloaded", version: info?.version }),
  );

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
      setState({ status: "available", manualOnly: true });
      return Promise.resolve();
    }
    if (checkOperation) checkOperation.supersededByDownload = true;
    if (downloadOperation) return downloadOperation.promise;

    const operation = { promise: null };
    downloadOperation = operation;
    // Own the state before the request goes out: the first "download-progress"
    // can be seconds away (connection setup, redirects), and until then the
    // renderer would still show an untouched "Download" button. No percent yet
    // — the UI reads a missing percent as "starting".
    setState({ status: "downloading" });
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
