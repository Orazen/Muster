// Session orchestration only. Native imports and permission APIs are injected
// by the Electron adapter, and are never consulted during initialization.
const HOST_BUNDLE_ID = "com.muster.app";
const CUA_ENV = { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" };

export function createCuaRuntime({ connectionStore, resolveDriverBinary, loadEmbeddedSdk, wantEmbedded, standaloneSocket, socketAlive, platform = process.platform }) {
  let connection = { mode: "unavailable", reason: "computer-access-off" };
  let initialized = false;
  let stopped = false;
  let epoch = 0;
  let pendingStart = null;
  let pendingStop = null;
  let embeddedHost = null;
  let cleanupBlocked = false;

  const get = () => connection;
  const active = (attempt) => !stopped && epoch === attempt;
  function invalidate(reason) {
    // Capabilities fail closed even if the disk write fails. Callers must treat
    // that exception as fatal before starting the server or completing shutdown.
    connection = { mode: "unavailable", reason };
    connectionStore.persist(connection);
    return connection;
  }
  function initialize() {
    if (stopped) throw new Error("Computer access session has stopped");
    if (initialized) return connection;
    const result = invalidate("computer-access-off");
    initialized = true;
    return result;
  }
  async function releaseHost(host) {
    if (!host) return;
    try {
      try { await host.stop(); }
      finally { host.uniffiDestroy?.(); }
    } catch (error) {
      cleanupBlocked = true;
      throw error;
    }
  }

  async function attemptStart(attempt) {
    let partialHost = null;
    let failurePrefix = "computer access failed";
    try {
      const binary = resolveDriverBinary();
      if (!active(attempt)) return connection;
      if (!binary) return invalidate("cua-driver binary not found");
      let next;
      if (wantEmbedded()) {
        failurePrefix = "embedded host failed";
        const sdk = await loadEmbeddedSdk();
        if (!active(attempt)) return connection;
        const permissions = sdk.requestMacOSPermissions();
        if (!sdk.hasRequiredMacOSPermissions(permissions)) {
          const missing = [!permissions.accessibility && "Accessibility", !permissions.screenRecording && "Screen Recording"].filter(Boolean).join(" and ");
          throw new Error(`${missing || "macOS permissions"} required; grant access in System Settings, then try again`);
        }
        if (!active(attempt)) return connection;
        partialHost = new sdk.EmbeddedCuaDriverHost(binary, HOST_BUNDLE_ID);
        const result = await partialHost.start();
        if (!active(attempt)) return connection;
        next = {
          mode: "embedded", socketPath: result.socketPath, mcpCommand: binary,
          mcpArgs: ["mcp", "--embedded", "--socket", result.socketPath],
          mcpEnv: { ...CUA_ENV, CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID },
        };
      } else {
        const alive = await socketAlive(standaloneSocket);
        if (!active(attempt)) return connection;
        next = alive ? {
          mode: "standalone", socketPath: standaloneSocket, mcpCommand: binary,
          mcpArgs: ["mcp"], mcpEnv: { ...CUA_ENV },
        } : {
          mode: "unavailable",
          reason: "no running cua-driver daemon; start CuaDriver, then try again",
        };
      }
      // Persist before publishing readiness. A failed write must clean up the
      // just-started daemon rather than leave it running without a descriptor.
      connectionStore.persist(next);
      connection = next;
      embeddedHost = partialHost;
      partialHost = null;
      return connection;
    } catch (error) {
      let cleanupError;
      if (partialHost) {
        const host = partialHost; partialHost = null;
        try { await releaseHost(host); } catch (cause) { cleanupError = cause; }
      }
      if (!active(attempt)) return connection;
      const detail = error instanceof Error ? error.message : String(error);
      const cleanup = cleanupError ? "; cleanup could not be confirmed; restart Muster before enabling computer access again" : "";
      return invalidate(`${failurePrefix}: ${detail}${cleanup}`);
    } finally {
      // A quit during SDK/daemon startup cannot publish a usable connection.
      // Stop waits for this attempt so even a late-created daemon is released.
      await releaseHost(partialHost);
    }
  }

  function start() {
    if (!initialized) return Promise.reject(new Error("Initialize computer access before enabling it"));
    if (stopped || cleanupBlocked) return Promise.resolve(connection);
    if (platform !== "darwin") {
      try { return Promise.resolve(invalidate("unsupported-platform")); }
      catch (error) { return Promise.reject(error); }
    }
    if (pendingStart) return pendingStart;
    if (connection.mode === "embedded" || connection.mode === "standalone") return Promise.resolve(connection);
    pendingStart = attemptStart(epoch).finally(() => { pendingStart = null; });
    return pendingStart;
  }

  function stop() {
    if (pendingStop) return pendingStop;
    stopped = true;
    epoch++;
    let invalidationError;
    try { invalidate("desktop-host-stopped"); } catch (error) { invalidationError = error; }
    const starting = pendingStart;
    pendingStop = (async () => {
      if (starting) {
        try { await starting; } catch { /* Cleanup continues after a failed start. */ }
      }
      const host = embeddedHost; embeddedHost = null;
      let cleanupError;
      try { await releaseHost(host); } catch (error) { cleanupError = error; }
      if (invalidationError && cleanupError) {
        throw new AggregateError([invalidationError, cleanupError], "Computer access invalidation and host cleanup failed");
      }
      if (invalidationError) throw invalidationError;
      if (cleanupError) throw cleanupError;
      // Standalone belongs to another app. Invalidating our descriptor does not
      // stop its daemon or revoke any other client's access.
      return connection;
    })();
    return pendingStop;
  }

  return Object.freeze({ initialize, start, stop, get });
}

export function registerCuaRuntimeIpc({ ipcMain, runtime, permissionsStatus, authorizeSender = () => false, onChanged = () => {} }) {
  ipcMain.handle("cua:connection", () => runtime.get());
  ipcMain.handle("cua:permissions", () => permissionsStatus());
  ipcMain.handle("cua:enable", (event) => {
    if (authorizeSender(event) !== true) throw new Error("Computer access can only be enabled by the current app window");
    return Promise.resolve().then(() => runtime.start()).finally(() => {
      // A renderer may have reloaded while native startup was pending. Tell
      // every current window to re-read main's state; send no readiness data.
      try { onChanged(); } catch { /* A closing window cannot break activation. */ }
    });
  });
}
