import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { DesktopCapabilitySession, permissionRequestPresentationDestination, type DesktopCapabilityState, type PermissionRequestDestination, type PrivacyPane } from "@/lib/desktop";

type DesktopState = DesktopCapabilityState & {
  refresh(): Promise<void>;
  enable(): Promise<void>;
  /** Destination pattern (tiptour integration study, slice 4): report where
   * this tap goes, acting only on the System Settings branch. */
  openPrivacySettings(pane: PrivacyPane): PermissionRequestDestination;
};
const fallback = new DesktopCapabilitySession();
const DesktopContext = createContext<DesktopState>({
  ...fallback.getSnapshot(), refresh: async () => {}, enable: async () => {},
  openPrivacySettings: fallback.openPrivacySettings,
});

export function DesktopCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [session] = useState(() => new DesktopCapabilitySession());
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(session.attach, [session]);
  return <DesktopContext.Provider value={{ ...state, refresh: session.refresh, enable: session.enable, openPrivacySettings: session.openPrivacySettings }}>{children}</DesktopContext.Provider>;
}

export function useDesktopCapabilities(): DesktopState {
  return useContext(DesktopContext);
}

export function ComputerAccessView({ state, onEnable, onRefresh, onOpenSettings }: {
  state: DesktopCapabilityState;
  onEnable(): void;
  onRefresh(): void;
  /** Optional: absent on surfaces that only report capabilities. The
   * Settings repair path is offered only when this session has already made
   * its permission request — one path per tap, never both. */
  onOpenSettings?(): void;
}) {
  const errors = [...new Set([state.enableError, state.error].filter((value) => value !== null))];
  const available = state.capabilities.localComputer.available;
  const settingsDestination = permissionRequestPresentationDestination({
    hasPermissionNow: available,
    hasAttemptedSystemPrompt: state.permissionRequestAttempted,
  });
  return (
    <section aria-label="This Mac access" className="mt-3 min-w-0 space-y-2 rounded-lg border border-hairline/40 p-3 text-[12px] leading-relaxed text-ink-secondary">
      {state.canEnable ? (
        <>
          <p role="status" className="font-medium text-ink">
            {!state.ready || state.refreshing ? "Checking computer access…"
              : state.error ? "Computer access could not be confirmed."
                : state.enabling ? "Enabling computer access…"
                  : available ? "This Mac is enabled for this session." : "Computer access is off for this session."}
          </p>
          <p>Available to bots assigned This Mac, and Auto when it uses this Mac, until you quit Muster. Each bot’s Off setting still blocks computer use.</p>
          <p>macOS may ask for Accessibility and Screen Recording permissions.</p>
          {!available && (
            <button type="button" onClick={onEnable} disabled={!state.ready || state.enabling || state.refreshing} aria-busy={state.enabling}
              className="w-full whitespace-normal break-words rounded-lg bg-accent px-3 py-2 font-medium text-white disabled:opacity-50">
              {state.enabling ? "Enabling computer access…" : "Enable for this session"}
            </button>
          )}
          {/* The repair path (tiptour destination pattern): after this
              session's request, a permission still off opens System Settings
              instead of asking again. Report-only — it claims no grant. */}
          {!available && settingsDestination === "systemSettings" && onOpenSettings && !state.enabling && !state.refreshing && (
            <button type="button" onClick={onOpenSettings}
              className="w-full whitespace-normal break-words rounded-lg bg-raised px-3 py-2 font-medium text-ink hover:bg-raised-hover">
              Open Privacy Settings
            </button>
          )}
        </>
      ) : (
        <p>{state.capabilities.host.platform === "darwin"
          ? "Update the desktop app to enable computer access for a session."
          : "Session computer control requires the macOS desktop app."}</p>
      )}
      {errors.map((error) => <p key={error} role="alert" className="break-words text-danger">{error}</p>)}
      {state.error && (
        <button type="button" onClick={onRefresh} disabled={state.refreshing || state.enabling} className="w-full whitespace-normal rounded-lg bg-raised px-3 py-2 text-ink disabled:opacity-50">Retry capability check</button>
      )}
    </section>
  );
}

export function ComputerAccessControl() {
  const state = useDesktopCapabilities();
  const inFlight = useRef(false);
  const enable = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    void state.enable().catch(() => {}).finally(() => { inFlight.current = false; });
  };
  return <ComputerAccessView state={state} onEnable={enable} onRefresh={() => { void state.refresh().catch(() => {}); }}
    onOpenSettings={() => { state.openPrivacySettings("accessibility"); }} />;
}
