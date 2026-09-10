// An address-driven preview session. Agent browsing and page input are not
// connected to this panel; the legacy server takeControl flag is ignored.
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Globe, Loader2, RotateCw, X } from "lucide-react";
import { api, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  createBrowserPreviewSession,
  emptyBrowserPreview,
  type BrowserPreviewSnapshot,
} from "./browser-preview-session";

export function BrowserPanel({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  // Changing bots remounts the address draft and all received state immediately.
  return <BrowserPanelSession key={bot.id} bot={bot} onClose={onClose} />;
}

function BrowserPanelSession({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState(emptyBrowserPreview);
  const [address, setAddress] = useState("");
  const session = useRef<ReturnType<typeof createBrowserPreviewSession> | null>(null);
  const [overlay, setOverlay] = useState(() => globalThis.window?.matchMedia("(width < 80rem)").matches ?? false);
  const [launcher] = useState(() => {
    const active = globalThis.document?.activeElement;
    return active && active instanceof HTMLElement ? active : null;
  });

  useEffect(() => {
    const query = window.matchMedia("(width < 80rem)");
    const update = () => setOverlay(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => () => restoreBrowserPreviewFocus(launcher), [launcher]);

  useEffect(() => {
    const current = createBrowserPreviewSession(bot.id, api, setSnapshot);
    session.current = current;
    void current.pull();
    const poll = window.setInterval(() => void current.pull(), 900);
    return () => {
      window.clearInterval(poll);
      current.dispose();
      session.current = null;
    };
  }, [bot.id]);

  return (
    <BrowserPreviewSurface overlay={overlay} onClose={onClose}>
      <BrowserPanelView
      botName={bot.name}
      snapshot={snapshot}
      address={address}
      onAddressChange={setAddress}
      onClose={onClose}
      onRetry={() => void session.current?.pull()}
      onStart={(profile) => void session.current?.start(profile)}
      onStop={() => void session.current?.stop()}
      onNavigate={(url) => void session.current?.navigate(url)}
      onSwitchProfile={(profile) => void session.current?.switchProfile(profile)}
      />
    </BrowserPreviewSurface>
  );
}

export function restoreBrowserPreviewFocus(launcher: Pick<HTMLElement, "isConnected" | "focus"> | null) {
  if (launcher?.isConnected) launcher.focus({ preventScroll: true });
}

/** Use the existing dialog focus scope for the opaque overlay. Keeping this
 * below the session preserves its draft and requests when the viewport changes. */
export function BrowserPreviewSurface({ overlay, onClose, children }: { overlay: boolean; onClose: () => void; children: ReactNode }) {
  if (!overlay) {
    return <div className="glass-panel relative z-40 h-full w-[420px] min-w-0 shrink-0">{children}</div>;
  }
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Content
        aria-label="Browser preview"
        aria-modal="true"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="glass-panel absolute inset-0 z-40 h-full w-full min-w-0 outline-none [--glass-fill:var(--color-panel)]"
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
}

type BrowserPanelViewProps = {
  botName: string;
  snapshot: BrowserPreviewSnapshot;
  address: string;
  onAddressChange: (address: string) => void;
  onClose: () => void;
  onRetry: () => void;
  onStart: (profile: "bot" | "guest") => void;
  onStop: () => void;
  onNavigate: (url: string) => void;
  onSwitchProfile: (profile: "bot" | "guest") => void;
};

export function BrowserPanelView({
  botName, snapshot, address, onAddressChange, onClose, onRetry, onStart, onStop, onNavigate, onSwitchProfile,
}: BrowserPanelViewProps) {
  const { state, frame, busy, error, pollError } = snapshot;
  const status = busy
    ? { start: "Opening preview…", stop: "Closing preview…", navigate: "Loading address…", profile: "Switching profile…" }[busy]
    : pollError ? "Preview refresh unavailable"
    : state?.error ? "Preview needs attention"
    : state ? state.running ? "Preview open" : "No preview open"
    : "Checking preview…";
  const hasError = Boolean(error || pollError || state?.error);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto" data-testid="browser-panel">
      <div className="flex shrink-0 items-start gap-2 border-b border-hairline/40 px-3 py-2">
        <Globe size={15} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-medium text-ink">Browser preview</h2>
          <p className="mt-0.5 text-[11.5px] text-ink-secondary [overflow-wrap:anywhere]">{botName}</p>
        </div>
        <button type="button" aria-label="Close browser preview panel" onClick={onClose}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink">
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="shrink-0 border-b border-hairline/40 px-3 py-2 text-[11.5px] leading-relaxed text-ink-secondary">
        Enter an address to preview a page. This preview is separate from agent browsing.
        Clicking or typing on the page image is not supported.
      </div>
      <div role="status" className="flex shrink-0 items-center gap-2 px-3 py-2 text-[11.5px] text-ink-secondary">
        {(busy || (!state && !pollError)) && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
        {status}
      </div>

      {hasError && (
        <div role="alert" className="mx-3 mb-2 shrink-0 rounded-lg border border-danger/25 bg-danger/10 p-2 text-[12px] leading-relaxed text-danger [overflow-wrap:anywhere]">
          {error && <p>{error}</p>}
          {state?.error && state.error !== error && <p>{state.error}</p>}
          {pollError && <p>Could not refresh this preview. {frame ? "The last received image is shown. " : ""}{pollError}</p>}
          {pollError && <button type="button" onClick={onRetry} disabled={Boolean(busy)} className="mt-1 font-semibold underline disabled:opacity-50">Retry preview</button>}
        </div>
      )}

      {!state?.running ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-6 text-center">
          <Globe size={28} className="text-ink-secondary" aria-hidden="true" />
          <p className="max-w-[280px] text-[13px] leading-relaxed text-ink-secondary">
            Open a preview, then enter a public web address. Choose the bot profile to keep this preview's browsing data between sessions, or Guest for temporary browsing data.
          </p>
          <div className="flex max-w-full flex-wrap justify-center gap-2">
            <button type="button" onClick={() => onStart("bot")} disabled={Boolean(busy) || !state}
              className="max-w-full rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-white hover:bg-accent/90 disabled:opacity-50">
              Open preview
            </button>
            <button type="button" onClick={() => onStart("guest")} disabled={Boolean(busy) || !state}
              className="max-w-full rounded-lg bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50">
              Guest preview
            </button>
          </div>
        </div>
      ) : (
        <>
          <form className="flex shrink-0 items-center gap-1.5 border-b border-hairline/40 px-2.5 py-2"
            onSubmit={(event) => { event.preventDefault(); if (!busy && address.trim()) onNavigate(address); }}>
            <input value={address} onChange={(event) => onAddressChange(event.target.value)}
              placeholder="Enter a web address" aria-label="Web address" autoComplete="off" spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none" />
            <button type="submit" disabled={Boolean(busy) || !address.trim()}
              className="shrink-0 rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-accent/90 disabled:opacity-50">Go</button>
            <button type="button" aria-label="Stop browser preview" onClick={onStop} disabled={Boolean(busy)} title="Stop preview session"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-50">
              <X size={13} aria-hidden="true" />
            </button>
          </form>

          <div className="min-h-[160px] flex-1 overflow-hidden bg-black/90">
            {frame ? (
              <img src={`data:image/jpeg;base64,${frame}`} alt={`Latest received page image${state.title ? `: ${state.title}` : ""}`}
                className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 p-3 text-center text-[12px] text-ink-secondary">
                {!hasError && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                {hasError ? "Page preview unavailable." : "Waiting for a page preview…"}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-hairline/40 px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1 text-[11.5px] text-ink-secondary [overflow-wrap:anywhere]">
                <p>{state.title || "Current page"}</p>
                <p>{state.url || "No address loaded"}</p>
              </div>
              <button type="button" onClick={() => { if (state.url && !busy) onNavigate(state.url); }} aria-label="Reload current page"
                disabled={Boolean(busy) || !state.url || !/^https?:\/\//i.test(state.url)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50">
                <RotateCw size={12} aria-hidden="true" />
              </button>
            </div>
            <p className="mt-1 text-[10.5px] text-ink-secondary">Page images may lag while navigation loads.</p>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Preview profile">
              <span className="text-[11px] text-ink-secondary">Profile</span>
              {([{ id: "bot", label: `${botName}'s profile` }, { id: "guest", label: "Guest" }] as const).map((profile) => (
                <button key={profile.id} type="button" onClick={() => onSwitchProfile(profile.id)}
                  disabled={Boolean(busy) || state.profile === profile.id} aria-pressed={state.profile === profile.id}
                  className={cn("min-w-0 max-w-full rounded-xl px-2.5 py-1 text-left text-[11px] transition-colors [overflow-wrap:anywhere] disabled:cursor-default",
                    state.profile === profile.id ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary hover:text-ink disabled:opacity-50")}>
                  {profile.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] leading-snug text-ink-secondary">
              Bot profile keeps this preview's browsing data between sessions. Guest uses temporary browsing data and is cleared when the preview closes.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
