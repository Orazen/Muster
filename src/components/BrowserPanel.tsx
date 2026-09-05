// The Browser side panel — a human-visible browser for this bot, in the
// chat's right panel next to the Computer panel. OpenMausBot's "Quill's
// browser" shape: an address bar, the live page (screencast frames from the
// harness-owned Chromium), a take-control flag, and profile switching
// ("Bot's own" keeps logins; "Guest" is wiped on switch). A bot with its
// browser tools mounted rides the SAME session in a later step; today the
// panel is the human's window, and Take control marks the takeover so the
// bot's attach layer can yield.
import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, Loader2, RotateCw, X } from "lucide-react";
import { api, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";

type PanelState = {
  running: boolean;
  url: string | null;
  title: string | null;
  profile: "bot" | "guest";
  takeControl: boolean;
  error: string | null;
};

const IDLE: PanelState = { running: false, url: null, title: null, profile: "bot", takeControl: false, error: null };

export function BrowserPanel({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [state, setState] = useState<PanelState>(IDLE);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const pull = useCallback(async () => {
    try {
      // SAFETY: /api/bots/:id/browser-panel/frame is this repo's own endpoint;
      // its reply is the {frame, state} shape read below.
      const data = (await api(`/api/bots/${bot.id}/browser-panel/frame`)) as {
        frame: string | null;
        state: PanelState;
      };
      setState(data.state);
      setFrame(data.frame);
    } catch {
      /* transient — next tick retries */
    }
  }, [bot.id]);

  useEffect(() => {
    void pull();
    pollRef.current = window.setInterval(() => void pull(), 900);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [pull]);

  const start = async (profile: "bot" | "guest") => {
    setBusy(true);
    setError(null);
    try {
      // SAFETY: own endpoint; the reply is the BrowserPanelState shape.
      const s = (await api(`/api/bots/${bot.id}/browser-panel/start`, {
        method: "POST",
        body: JSON.stringify({ profile }),
      })) as PanelState;
      setState(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    await api(`/api/bots/${bot.id}/browser-panel/stop`, { method: "POST" }).catch(() => {});
    setFrame(null);
    setState(IDLE);
  };

  const go = async () => {
    if (!address.trim() || !state.running) return;
    setBusy(true);
    setError(null);
    try {
      // SAFETY: own endpoint; the reply is the BrowserPanelState shape.
      const s = (await api(`/api/bots/${bot.id}/browser-panel/navigate`, {
        method: "POST",
        body: JSON.stringify({ url: address }),
      })) as PanelState;
      setState(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setControl = async (on: boolean) => {
    // SAFETY: own endpoint; the reply is the BrowserPanelState shape.
    const s = (await api(`/api/bots/${bot.id}/browser-panel/control`, {
      method: "POST",
      body: JSON.stringify({ on }),
    })) as PanelState;
    setState(s);
  };

  const switchProfile = async (profile: "bot" | "guest") => {
    if (state.profile === profile) return;
    await stop();
    await start(profile);
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-app" data-testid="browser-panel">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-hairline/40 px-3 py-2">
        <Globe size={15} className="shrink-0 text-ink-secondary" />
        <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {bot.name}'s browser
        </div>
        <button
          type="button"
          aria-label="Close browser panel"
          onClick={onClose}
          className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>

      {!state.running ? (
        /* empty state — start or the guest split */
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <Globe size={28} className="text-ink-secondary" />
          <div className="max-w-[280px] text-[13px] leading-relaxed text-ink-secondary">
            Nothing open yet. Open a browser to watch {bot.name}'s web work live — enter an address, or
            ask the bot to look something up.
          </div>
          {busy ? (
            <Loader2 size={16} className="animate-spin text-ink-secondary" />
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void start("bot")}
                className="rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-white hover:bg-accent/90"
              >
                Open browser
              </button>
              <button
                type="button"
                onClick={() => void start("guest")}
                className="rounded-lg bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover"
              >
                Guest session
              </button>
            </div>
          )}
          {error && <div className="max-w-[300px] text-[12px] text-danger">{error}</div>}
        </div>
      ) : (
        <>
          {/* address bar */}
          <form
            className="flex items-center gap-1.5 border-b border-hairline/40 px-2.5 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              void go();
            }}
          >
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Enter a web address"
              aria-label="Web address"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !address.trim()}
              className="shrink-0 rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
            >
              Go
            </button>
            <button
              type="button"
              aria-label="Stop browser"
              onClick={() => void stop()}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-danger"
              title="Close browser"
            >
              <X size={13} />
            </button>
          </form>

          {/* takeover banner */}
          {state.takeControl && (
            <div className="border-b border-warning/25 bg-warning/10 px-3 py-1.5 text-[11.5px] text-warning">
              You're driving — the bot pauses while you take over.{" "}
              <button type="button" onClick={() => void setControl(false)} className="font-semibold underline">
                Hand back
              </button>
            </div>
          )}

          {/* live page */}
          <div className="min-h-0 flex-1 overflow-hidden bg-black/90">
            {frame ? (
              <img
                src={`data:image/jpeg;base64,${frame}`}
                alt={state.title ?? "live page"}
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <Loader2 size={16} className="animate-spin text-ink-secondary" />
                <span className="text-[12px] text-ink-secondary">Waiting for the first frame…</span>
              </div>
            )}
          </div>

          {/* footer: current page + profiles */}
          <div className="border-t border-hairline/40 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1 truncate text-[11.5px] text-ink-secondary">
                {state.title || state.url || "New tab"}
              </div>
              <button
                type="button"
                onClick={() => address && void go()}
                aria-label="Reload page"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <RotateCw size={12} />
              </button>
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <span className="text-[11px] text-ink-secondary">Profile</span>
              {(
                [
                  { id: "bot", label: `${bot.name}'s own` },
                  { id: "guest", label: "Guest" },
                ] as const
              ).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => void switchProfile(p.id)}
                  aria-pressed={state.profile === p.id}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] transition-colors",
                    state.profile === p.id ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary hover:text-ink",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="mt-1.5 text-[10.5px] leading-snug text-ink-secondary">
              Profiles keep logins separate. "{bot.name}'s own" is private to this bot; Guest is cleared
              when you switch away.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
