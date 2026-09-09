import type { RuntimeEvent } from "./contracts.ts";

export interface PlanRehearsal {
  plannedSteps: number;
  matchedSteps: number;
  matchedRuns: number;
  reviewedRuns: number;
  summary: string;
}

/** Explicit protocol only: PLAN TOOLS: followed by 2–20 bullet lines of
 * exact tool identifiers. Prose, arguments and truncated plans are never
 * silently interpreted as executable steps. This compares names/order,
 * not arguments, screen states, or the probability of future success. */
export function statedPlan(summary: string): string[] | null {
  if (summary.length > 8000) return null;
  const lines = summary.split(/\r?\n/);
  const header = lines.findIndex((line) => line.trim() === "PLAN TOOLS:");
  if (header < 0) return null;
  const steps = lines.slice(header + 1).map((line) => line.trim()).filter(Boolean);
  if (steps.length < 2 || steps.length > 20) return null;
  if (steps.some((line) => !/^- [A-Za-z][\w.:/-]{0,127}$/.test(line))) return null;
  return steps.map((line) => line.slice(2));
}

/** Only complete, successful turns with paired successful tool events count.
 * A tail starting mid-turn, a failed tool, a duplicate item, or overlapping
 * tool calls cannot supply an ordered successful sequence. Caller supplies
 * only the requesting bot's own thread, in append order. */
export function rehearsePlan(summary: string, events: RuntimeEvent[]): PlanRehearsal | undefined {
  const plan = statedPlan(summary);
  if (!plan) return undefined;
  let active: { id: string; steps: string[]; pending: { id: string; name: string } | null; seen: Set<string>; invalid: boolean } | undefined;
  let matchedSteps = 0;
  let matchedRuns = 0;
  let reviewedRuns = 0;
  for (const event of events) {
    if (event.type === "turn.started") {
      active = event.turnId ? { id: event.turnId, steps: [], pending: null, seen: new Set(), invalid: false } : undefined;
      continue;
    }
    if (!active || event.turnId !== active.id) continue;
    if (event.type === "runtime.error" || event.type === "session.exited") active.invalid = true;
    if (event.type === "item.started" && event.itemType === "tool") {
      if (active.pending || !event.itemId || !event.title || active.seen.has(event.itemId)) active.invalid = true;
      if (event.itemId && event.title) {
        active.seen.add(event.itemId);
        active.pending = { id: event.itemId, name: event.title };
      }
    }
    if (event.type === "item.completed" && event.itemType === "tool") {
      if (!event.ok || !active.pending || active.pending.id !== event.itemId) active.invalid = true;
      else active.steps.push(active.pending.name);
      active.pending = null;
    }
    if (event.type === "turn.completed") {
      if (event.ok && !active.invalid && !active.pending) {
        reviewedRuns++;
        // Contiguous prefix coverage within one run; never stitch different
        // tasks together or count one historic step twice for repeated steps.
        let best = 0;
        for (let start = 0; start < active.steps.length; start++) {
          let count = 0;
          while (count < plan.length && active.steps[start + count] === plan[count]) count++;
          best = Math.max(best, count);
        }
        matchedSteps = Math.max(matchedSteps, best);
        if (best === plan.length) matchedRuns++;
      }
      active = undefined;
    }
  }
  return {
    plannedSteps: plan.length, matchedSteps, matchedRuns, reviewedRuns,
    summary: `Plan rehearsal: ${matchedSteps}/${plan.length} tool steps matched in order; ${matchedRuns} completed runs matched the full sequence (${reviewedRuns} reviewed). Recent history in this thread only. Tool names and order only; arguments and screen states were not checked.`,
  };
}

/** Accept a plan stated by the assistant in this exact running turn, never
 * a user message or a previous turn. Some engines only emit text deltas. */
export function currentPlan(summary: string, events: RuntimeEvent[], turnId?: string): string | undefined {
  if (statedPlan(summary)) return summary;
  if (!turnId) return undefined;
  let text = "";
  let plan: string | undefined;
  for (const event of events) {
    if (event.turnId !== turnId) continue;
    if (event.type === "turn.started") { text = ""; plan = undefined; }
    if (event.type === "content.delta" && event.streamKind === "assistant_text") {
      text = (text + event.delta).slice(-8001);
    }
    if (event.type === "item.completed" && event.itemType === "assistant_text") {
      text = event.text;
      if (text.includes("PLAN TOOLS:")) plan = statedPlan(text) ? text : undefined;
      text = "";
    }
  }
  if (text.includes("PLAN TOOLS:")) return statedPlan(text) ? text : undefined;
  return plan;
}
