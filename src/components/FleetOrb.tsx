// The FleetOrb — Muster's ambient presence glyph, the Jarvis "pebble" idea
// wearing the musterbot identity: one floating bloom in the corner of every
// surface whose color IS the fleet's state. Clear means nothing is happening
// (a promise); orange pulse = agents working; amber pulse = someone is
// waiting on you (click to jump straight into that thread); green flash =
// work settled since you last looked. One glance answers "does my team need
// me?" from any screen — chat, settings, Muster OS, anything.
//
// Derives everything from the shared store: no polling, no new transports —
// the same SSE stream the chat folds.
import { useMemo, useRef, useState } from "react";
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
  idle: { core: "rgba(255,255,255,0.28)", halo: "rgba(255,255,255,0.06)", label: "All agents idle", anim: "still" },
  working: { core: "#f08a24", halo: "rgba(240,138,36,0.35)", label: "Agents working", anim: "breathe" },
  attention: { core: "#ffb020", halo: "rgba(255,176,32,0.5)", label: "Waiting on you", anim: "pulse" },
  settled: { core: "#00c26e", halo: "rgba(0,194,110,0.4)", label: "Work settled — take a look", anim: "flash" },
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

  const visible = state.bots.filter((b) => !b.hidden);
  const { state: orbState, settledCount } = useMemo(() => orbStateFor(visible), [visible]);
  const mood = MOODS[orbState];
  const workingCount = visible.filter((b) => b.busy).length;
  const waitingList = visible.filter((b) => b.activity === "waiting-on-you");

  const openBot = (bot: Bot) => {
    dispatch({ type: "select", id: bot.id });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="fleet-orb-root">
      {open && (waitingList.length > 0 || orbState === "working" || orbState === "settled") && (
        <div className="fleet-orb-menu" role="dialog" aria-label="Fleet status">
          {waitingList.length > 0 && (
            <>
              <div className="fleet-orb-menu-label">Waiting on you</div>
              {waitingList.map((bot) => (
                <button key={bot.id} type="button" className="fleet-orb-row" onClick={() => openBot(bot)}>
                  <span className="fleet-orb-dot" style={{ background: "#ffb020" }} aria-hidden="true" />
                  {bot.name}
                </button>
              ))}
            </>
          )}
          {workingCount > 0 && (
            <>
              <div className="fleet-orb-menu-label">Working</div>
              {visible
                .filter((b) => b.busy)
                .map((bot) => (
                  <button key={bot.id} type="button" className="fleet-orb-row" onClick={() => openBot(bot)}>
                    <span className="fleet-orb-dot fleet-orb-dot-live" style={{ background: "#f08a24" }} aria-hidden="true" />
                    {bot.name}
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
                    <span className="fleet-orb-dot" style={{ background: "#00c26e" }} aria-hidden="true" />
                    {bot.name}
                  </button>
                ))}
            </>
          )}
        </div>
      )}
      <button
        type="button"
        aria-label={`${mood.label}${waitingList.length > 0 ? ` — ${waitingList.length} waiting` : workingCount > 0 ? ` — ${workingCount} working` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={mood.label}
        className={cn("fleet-orb", `fleet-orb-${mood.anim}`)}
        style={{ background: mood.halo }}
      >
        <span className="fleet-orb-core" style={{ background: mood.core, boxShadow: `0 0 18px 2px ${mood.halo}` }} aria-hidden="true" />
        {waitingList.length > 0 && <span className="fleet-orb-badge">{waitingList.length}</span>}
        {waitingList.length === 0 && workingCount > 0 && <span className="fleet-orb-badge fleet-orb-badge-quiet">{workingCount}</span>}
      </button>
    </div>
  );
}
