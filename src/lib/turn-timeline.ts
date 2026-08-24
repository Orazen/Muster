import type { Message } from "@/state/store";

/** One recent action for the execution timeline strip. Derived only from
 * what the harness already recorded as activity messages — this never
 * guesses an action happened. */
export interface TimelineAction {
  id: string;
  /** raw tool name, as the harness reported it */
  name: string;
  /** when the tool run started (ms epoch) */
  at: number;
  /** true while the harness hasn't settled the run yet (`tool.ok` unset) */
  running: boolean;
  failed: boolean;
}

/** Collapse a transcript's activity messages into the most recent actions,
 * latest first, capped for the strip. Errors and bot⇄bot comm chips are
 * turn-level events, not actions — they stay in the thread, not here. */
export function timelineActions(messages: readonly Message[], max = 5): TimelineAction[] {
  const out: TimelineAction[] = [];
  for (const m of messages) {
    if (m.kind !== "activity" || !m.tool || m.comm) continue;
    if (m.tool.name.startsWith("error:")) continue;
    out.push({
      id: m.id,
      name: m.tool.name,
      at: m.at,
      running: m.tool.ok === undefined,
      failed: m.tool.ok === false,
    });
  }
  return out.reverse().slice(0, max);
}

/** Duration-so-far caption for a running action: "12s" under a minute,
 * then "4m 03s". Settled actions show nothing — their outcome is the story. */
export function elapsedSince(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
