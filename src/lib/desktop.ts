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
  Partial<Pick<NonNullable<Window["ogb"]>, "getCapabilities" | "enableComputerAccess" | "onComputerAccessChanged" | "permOpenSettings">>;

/** Privacy panes the repair path can open. `accessibility` is the This-Mac
 * control permission; mic/screen/speech are the voice and preview panes. */
export type PrivacyPane = NonNullable<Parameters<NonNullable<DesktopBridge["permOpenSettings"]>>[0]>;

/** The repair a blocked computer-access session needs: words plus the exact
 * privacy panes to open, or none when a pane cannot help.
 *
 * WHY this exists as a named contract: the failure is easy to misread in both
 * directions. macOS keys privacy grants to the BINARY that uses them, and the
 * screenshots for local computer control are taken by CuaDriver
 * (`com.trycua.driver`) — a separately signed app — not by Muster. A person
 * who grants Screen Recording to Muster, as the old copy invited them to, has
 * changed nothing for the driver, and then concludes the app is broken. The
 * honest repair names the app that needs the grant and opens the exact panes;
 * "computer access is off" (a user preference) gets no privacy buttons at all,
 * because a settings pane cannot fix a toggle. */
export interface LocalComputerRepair {
  message: string;
  panes: PrivacyPane[];
}

export function localComputerRepair(input: {
  platform: string;
  reasonCode: string | undefined;
}): LocalComputerRepair {
  const { platform } = input;
  const reasonCode = input.reasonCode ?? "";
  if (platform !== "mac") {
    return { message: "CUA Driver isn't ready for local computer control.", panes: [] };
  }
  if (reasonCode === "computer-access-off") {
    return { message: "Computer access is off for this session. Enable it below.", panes: [] };
  }
  if (reasonCode === "desktop-upgrade-required" || reasonCode === "unsupported-platform") {
    return { message: "Local computer control requires the desktop app.", panes: [] };
  }
  return {
    message:
      "Computer access needs Screen Recording and Accessibility for CuaDriver. macOS grants privacy per app — " +
      "in System Settings add CuaDriver (not just Muster), then try again.",
    panes: ["screen", "accessibility"],
  };
}

// ── permission presentation destination ───────────────────────────────
// Adapted from tiptour-macos (github.com/milind-soni/tiptour-macos), MIT
// License — Copyright (c) 2026 Milind Soni, Portions Copyright (c) 2025
// Farza (Clicky): `TipTour/Utilities/WindowPositionManager.swift`
// (`PermissionRequestPresentationDestination` +
// `permissionRequestPresentationDestination(hasPermissionNow:hasAttemptedSystemPrompt:)`),
// provenance in docs/plans/tiptour-integration-study.md (row 15, slice 4).
// Their rule, kept verbatim: ONE permission path per tap — never the system
// prompt and the System Settings pane at the same time.

export type PermissionRequestDestination = "alreadyGranted" | "systemPrompt" | "systemSettings";

export function permissionRequestPresentationDestination(input: {
  hasPermissionNow: boolean;
  hasAttemptedSystemPrompt: boolean;
}): PermissionRequestDestination {
  if (input.hasPermissionNow) return "alreadyGranted";
  return input.hasAttemptedSystemPrompt ? "systemSettings" : "systemPrompt";
}

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
  /** This session has already made its host permission request (the `enable`
   * tap). Upstream's once-per-launch prompt flag, mapped onto the one tap
   * Muster owns: after it, a permission still off is repaired in System
   * Settings instead of being asked for again. Never reset — a new session
   * object is a new "launch". */
  permissionRequestAttempted: boolean;
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
      permissionRequestAttempted: false,
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
      // The one prompt attempt for this session (upstream's
      // `hasAttempted…DuringCurrentLaunch`): record it BEFORE the request
      // crosses the bridge, so a tap that lands mid-flight can never queue a
      // second one. Everything after this tap repairs through System Settings.
      this.update({ permissionRequestAttempted: true });
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

  /** Report — and act on — where a permission tap goes this time.
   *
   * `alreadyGranted` and `systemPrompt` are reported only: the request
   * itself stays the panel's own control, so this method can never put the
   * prompt and the Settings pane in front of the user together (upstream's
   * one-path-per-tap rule). Only `systemSettings` opens anything.
   *
   * NO last-known-granted fallback is adopted here, deliberately, and the
   * reason is Muster's own documented one rather than an oversight:
   * `electron/main.mjs` records that every pre-grant mechanism for Screen
   * Recording is broken on macOS 15+ (`getMediaAccessStatus("screen")`
   * caches per-process and stays "denied" for the whole session after a
   * grant), so `permStatus` reports `mic` only and `src/types/ogb.d.ts`
   * says the screen status is deliberately absent. There is no
   * false-negative API to fall back FROM — and inventing a remembered
   * "granted" flag would claim access the platform has not confirmed,
   * which this project does not do. Reported state stays what the host
   * reports; the copy still says macOS MAY ask. */
  openPrivacySettings = (pane: PrivacyPane): PermissionRequestDestination => {
    const destination = permissionRequestPresentationDestination({
      hasPermissionNow: this.state.capabilities.localComputer.available,
      hasAttemptedSystemPrompt: this.state.permissionRequestAttempted,
    });
    if (destination !== "systemSettings") return destination;
    try {
      void this.bridge?.permOpenSettings?.(pane)?.catch(() => { /* reported either way */ });
    } catch { /* an older shell may throw synchronously — nothing opened */ }
    return destination;
  };
}
