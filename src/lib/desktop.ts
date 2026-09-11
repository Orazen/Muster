const browserCapabilities: DesktopCapabilities = {
  host: {
    platform: "other",
    label: "Browser",
    session: "unknown",
    packaged: false,
  },
  windowChrome: "native",
  screenPreview: {
    available: false,
    interaction: "none",
    reasonCode: "desktop-app-required",
  },
  dictation: {
    available: false,
    engine: "none",
    onDevice: false,
    reasonCode: "desktop-app-required",
  },
  localComputer: {
    available: false,
    support: "unsupported",
    reasonCode: "desktop-app-required",
  },
};

export type DesktopBridge = Pick<NonNullable<Window["ogb"]>, "platform"> &
  Partial<Pick<NonNullable<Window["ogb"]>, "getCapabilities" | "enableComputerAccess" | "onComputerAccessChanged">>;

export function browserDesktopCapabilities(): DesktopCapabilities {
  return browserCapabilities;
}

export function initialDesktopCapabilities(bridge: DesktopBridge | undefined = globalThis.window?.ogb): DesktopCapabilities {
  const platform = bridge?.platform;
  if (!platform) return browserCapabilities;
  const isMac = platform === "darwin";
  const dictation: DesktopCapabilities["dictation"] = {
    available: isMac,
    engine: isMac ? "apple-speech" : "none",
    onDevice: isMac,
  };
  if (!isMac) dictation.reasonCode = "unsupported-platform";
  return {
    ...browserCapabilities,
    host: {
      ...browserCapabilities.host,
      platform: platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other",
      label: platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform === "win32" ? "Windows" : "Desktop",
    },
    windowChrome: isMac ? "mac-inset" : "native",
    dictation,
    localComputer: {
      ...browserCapabilities.localComputer,
      reasonCode: isMac ? bridge?.enableComputerAccess ? "computer-access-off" : "desktop-upgrade-required" : "unsupported-platform",
    },
  };
}

export async function loadDesktopCapabilities(bridge: DesktopBridge | undefined = globalThis.window?.ogb): Promise<DesktopCapabilities> {
  if (!bridge?.getCapabilities) return initialDesktopCapabilities(bridge);
  return bridge.getCapabilities();
}

export interface DesktopCapabilityState {
  capabilities: DesktopCapabilities;
  ready: boolean;
  refreshing: boolean;
  enabling: boolean;
  canEnable: boolean;
  error: string | null;
  enableError: string | null;
}

/** State shared by all desktop surfaces. Only an explicit enable() call may
 * request host control; mounting and refreshing are read-only operations. */
export class DesktopCapabilitySession {
  private state: DesktopCapabilityState;
  private listeners = new Set<() => void>();
  private active = false;
  private epoch = 0;
  private request = 0;
  private enabling: Promise<void> | null = null;

  constructor(private readonly bridge: DesktopBridge | undefined = globalThis.window?.ogb) {
    this.state = {
      capabilities: initialDesktopCapabilities(bridge), ready: !bridge,
      refreshing: false, enabling: false,
      canEnable: bridge?.platform === "darwin" && !!bridge.enableComputerAccess,
      error: null, enableError: null,
    };
  }

  getSnapshot = (): DesktopCapabilityState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<DesktopCapabilityState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private current(epoch: number): boolean { return this.active && this.epoch === epoch; }

  attach = (): (() => void) => {
    this.active = true;
    const epoch = ++this.epoch;
    // Subscribe before reading so native setup settling across a renderer
    // reload cannot fall into the gap between the initial read and listener.
    const unsubscribe = this.bridge?.onComputerAccessChanged?.(() => {
      if (this.current(epoch)) void this.refresh().catch(() => {});
    });
    void this.refresh().catch(() => {}); // The snapshot exposes read failures.
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      if (this.epoch === epoch) { this.active = false; this.epoch++; this.request++; }
      unsubscribe?.();
    };
  };

  refresh = async (): Promise<void> => {
    if (!this.active) return;
    const epoch = this.epoch, request = ++this.request;
    this.update({ refreshing: true, error: null });
    try {
      const capabilities = await loadDesktopCapabilities(this.bridge);
      if (this.current(epoch) && request === this.request) this.update({ capabilities, ready: true, refreshing: false });
    } catch (cause) {
      if (this.current(epoch) && request === this.request) {
        const error = cause instanceof Error && cause.message.trim() ? cause.message : "Could not refresh desktop capabilities. Try again.";
        this.update({ capabilities: initialDesktopCapabilities(this.bridge), ready: true, refreshing: false, error });
      }
      throw cause;
    }
  };

  enable = (): Promise<void> => {
    const enable = this.bridge?.enableComputerAccess;
    if (!this.active || !this.state.canEnable || !enable) return Promise.resolve();
    if (this.enabling) return this.enabling;
    const epoch = this.epoch;
    // Install the lock before notifying subscribers or crossing a promise
    // boundary, so two surfaces cannot start the same session concurrently.
    const operation = Promise.resolve().then(async () => {
      if (!this.current(epoch)) return;
      let enableError: string | null = null;
      try {
        const result = await enable.call(this.bridge);
        if (result.mode !== "embedded" && result.mode !== "standalone") enableError = result.reason || "Computer access is unavailable. Try enabling it again.";
      } catch (cause) {
        enableError = cause instanceof Error && cause.message.trim() ? cause.message : "Could not enable computer access. Try again.";
      }
      if (!this.current(epoch)) {
        // A new attachment may have read the bridge before this old request
        // finished. Reconcile its current state without publishing old errors.
        if (this.active) try { await this.refresh(); } catch { /* Exposed in current state. */ }
        return;
      }
      // Even a rejected attempt may have changed native availability.
      try { await this.refresh(); } catch { /* The separate refresh error remains visible. */ }
      if (this.current(epoch)) this.update({ enableError });
      else if (this.active) try { await this.refresh(); } catch { /* Reconcile a remount during the read. */ }
    });
    this.enabling = operation;
    this.update({ enabling: true, enableError: null });
    const settle = () => {
      if (this.enabling === operation) {
        this.enabling = null;
        if (this.active) this.update({ enabling: false });
      }
    };
    void operation.then(settle, settle);
    return operation;
  };
}
