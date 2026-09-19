/** Owns only children returned by start after PID/static health verification.
 * start(port, onExit, signal) must stop its own failed probes and return null
 * for an occupied/foreign server. It must never return an existing listener.
 * No automatic restart: retry is an explicit user action on the same origin.
 */
export function createServerLifecycle({ start, stop, onState = () => {} }) {
  let state = { phase: "stopped", port: null, child: null, generation: 0, exitCode: null };
  let active = null;
  let pending = null;
  const snapshot = () => ({ ...state });
  const publish = (patch) => { state = { ...state, ...patch }; onState(snapshot()); };
  const dispose = (child) => {
    if (!child) return;
    try { Promise.resolve(stop(child)).catch(() => {}); } catch { /* teardown is best effort */ }
  };

  function launch(ports) {
    if (state.phase === "quitting") return Promise.resolve(snapshot());
    if (pending) return pending;
    if (state.phase === "running") return Promise.resolve(snapshot());
    const generation = state.generation + 1;
    publish({ phase: "starting", generation, child: null, port: state.port ?? ports[0] ?? null, exitCode: null });
    // Defer dependency invocation until the single-flight promise is installed.
    const operation = Promise.resolve().then(async () => {
      for (const port of ports) {
        if (state.phase === "quitting" || state.generation !== generation) return snapshot();
        const attempt = { generation, port, child: null, exited: false, abort: new AbortController() };
        active = attempt;
        const onExit = (exitCode = null) => {
          attempt.exited = true;
          if (active !== attempt || state.phase === "quitting" || state.generation !== generation) return;
          if (state.phase === "running") {
            active = null;
            publish({ phase: "stopped", child: null, exitCode });
          }
        };
        let child = null;
        try { child = await start(port, onExit, attempt.abort.signal); } catch { /* unavailable stays stopped */ }
        attempt.child = child;
        if (active !== attempt || state.phase === "quitting" || state.generation !== generation) {
          dispose(child);
          return snapshot();
        }
        if (child && !attempt.exited) {
          publish({ phase: "running", port, child });
          return snapshot();
        }
        active = null;
        // An exited child is already gone; a null result owns nothing.
      }
      if (state.phase !== "quitting" && state.generation === generation) publish({ phase: "stopped", child: null });
      return snapshot();
    });
    pending = operation.finally(() => { pending = null; });
    return pending;
  }

  return {
    snapshot,
    allowsRequest(value) {
      if (state.phase !== "running" || !state.child) return false;
      try {
        const url = new URL(value);
        return url.protocol === "http:" && !url.username && !url.password &&
          url.origin === `http://127.0.0.1:${state.port}`;
      } catch { return false; }
    },
    start(ports) {
      if (state.port !== null) return launch([state.port]);
      return launch([...ports]);
    },
    retry() { return state.port === null ? Promise.resolve(snapshot()) : launch([state.port]); },
    quit() {
      if (state.phase === "quitting") return;
      const attempt = active;
      const child = state.child;
      active = null;
      publish({ phase: "quitting", generation: state.generation + 1, child: null });
      attempt?.abort.abort();
      dispose(child);
    },
  };
}
