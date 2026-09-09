// The FleetOrb — Muster's ambient presence glyph, the Jarvis "pebble" idea
// wearing the musterbot identity: a compact status row whose color reflects
// the fleet's state. Clear means nothing is happening
// (a promise); orange pulse = agents working; amber pulse = someone is
// waiting on you (click to jump straight into that thread); green flash =
// work settled since you last looked. One glance answers "does my team need
// me?" without covering the conversation's controls.
//
// Derives everything from the shared store: no polling, no new transports —
// the same SSE stream the chat folds.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";

type OrbState = "idle" | "working" | "attention" | "settled";

interface OrbMood {
  /** css color of the core */
  core: string;
  /** css color of the halo */
  halo: string;
  /** label for aria + tooltip */
  label: string;
  /** animation class suffix */
  anim: "still" | "breathe" | "pulse" | "flash";
}

const MOODS = {
  // clear glass = nothing is happening, and that's a promise
  idle: {
    core: "color-mix(in srgb, var(--color-ink) 28%, transparent)",
    halo: "color-mix(in srgb, var(--color-ink) 7%, transparent)",
    label: "All agents idle",
    anim: "still",
  },
  working: {
    core: "var(--color-live)",
    halo: "color-mix(in srgb, var(--color-live) 38%, transparent)",
    label: "Agents working",
    anim: "breathe",
  },
  attention: {
    core: "var(--color-warning)",
    halo: "color-mix(in srgb, var(--color-warning) 55%, transparent)",
    label: "Waiting on you",
    anim: "pulse",
  },
  settled: {
    core: "var(--color-success)",
    halo: "color-mix(in srgb, var(--color-success) 45%, transparent)",
    label: "Work settled — take a look",
    anim: "flash",
  },
} as const satisfies Record<OrbState, OrbMood>;

/** Pick the state with the strongest claim on your attention. Each return
 * literal is one of OrbState's own members, so inference is the contract. */
function orbStateFor(bots: Bot[]) {
  const waiting = bots.find((b) => b.activity === "waiting-on-you");
  if (waiting) return { state: "attention", attentionBot: waiting, settledCount: 0 } as const;
  const working = bots.some((b) => b.busy);
  if (working) return { state: "working", attentionBot: null, settledCount: 0 } as const;
  const settled = bots.filter((b) => b.unread).length;
  if (settled > 0) return { state: "settled", attentionBot: null, settledCount: settled } as const;
  return { state: "idle", attentionBot: null, settledCount: 0 } as const;
}

export function FleetOrb() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const visible = state.bots.filter((b) => !b.hidden);
  const { state: orbState, settledCount } = useMemo(() => orbStateFor(visible), [visible]);
  // the ambient wash reacts to the fleet: amber-bright when someone needs you
  useEffect(() => {
    document.documentElement.dataset.ambient = orbState === "attention" ? "attention" : "calm";
    return () => {
      delete document.documentElement.dataset.ambient;
    };
  }, [orbState]);
  const mood = MOODS[orbState];
  const workingList = visible.filter((b) => b.busy && b.activity !== "waiting-on-you");
  const workingCount = workingList.length;
  const waitingList = visible.filter((b) => b.activity === "waiting-on-you");
  const hasMenu = waitingList.length > 0 || orbState === "working" || orbState === "settled";
  const expanded = open && hasMenu;
  const label = waitingList.length > 0
    ? `${waitingList.length} waiting on you`
    : workingCount > 0
      ? `${workingCount} working`
      : settledCount > 0
        ? `${settledCount} with unread updates`
        : mood.label;

  useEffect(() => {
    if (!hasMenu) setOpen(false);
  }, [hasMenu]);

  useEffect(() => {
    if (!expanded) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [expanded]);

  const openBot = (bot: Bot) => {
    dispatch({ type: "select", id: bot.id });
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div ref={rootRef} className="fleet-orb-root">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Fleet status: ${label}`}
        aria-expanded={hasMenu ? expanded : undefined}
        aria-controls={hasMenu ? menuId : undefined}
        aria-haspopup={hasMenu ? "dialog" : undefined}
        disabled={!hasMenu}
        onClick={() => setOpen((value) => !value)}
        className="fleet-orb-trigger"
      >
        <span className={cn("fleet-orb", `fleet-orb-${mood.anim}`)} style={{ background: mood.halo }} aria-hidden="true">
          <span className="fleet-orb-core" style={{ background: mood.core, boxShadow: `0 0 18px 2px ${mood.halo}` }} />
        </span>
        <span className="fleet-orb-status" aria-live="polite">{label}</span>
        {hasMenu && <ChevronUp size={14} aria-hidden="true" className={cn("shrink-0 transition-transform", expanded && "rotate-180")} />}
      </button>
      {expanded && (
        <div ref={menuRef} id={menuId} className="fleet-orb-menu" role="dialog" aria-label="Fleet status">
          {waitingList.length > 0 && (
            <>
              <div className="fleet-orb-menu-label">Waiting on you</div>
              {waitingList.map((bot) => (
                <button key={bot.id} type="button" className="fleet-orb-row" onClick={() => openBot(bot)}>
                  <span className="fleet-orb-dot" style={{ background: "var(--color-warning)" }} aria-hidden="true" />
                  <span className="min-w-0 truncate">{bot.name}</span>
                </button>
              ))}
            </>
          )}
          {workingCount > 0 && (
            <>
              <div className="fleet-orb-menu-label">Working</div>
              {workingList.map((bot) => (
                  <button key={bot.id} type="button" className="fleet-orb-row" onClick={() => openBot(bot)}>
                    <span className="fleet-orb-dot fleet-orb-dot-live" style={{ background: "var(--color-live)" }} aria-hidden="true" />
                    <span className="min-w-0 truncate">{bot.name}</span>
                  </button>
                ))}
            </>
          )}
          {orbState === "settled" && settledCount > 0 && (
            <>
              <div className="fleet-orb-menu-label">Settled</div>
              {visible
                .filter((b) => b.unread)
                .slice(0, 5)
                .map((bot) => (
                  <button key={bot.id} type="button" className="fleet-orb-row" onClick={() => openBot(bot)}>
                    <span className="fleet-orb-dot" style={{ background: "var(--color-success)" }} aria-hidden="true" />
                    <span className="min-w-0 truncate">{bot.name}</span>
                  </button>
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
