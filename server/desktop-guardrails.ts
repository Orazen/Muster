// This-Mac action guardrails — a per-turn screen-action budget and the
// loop stop-reason vocabulary, so bounded autonomy ends back at a human.
//
// Adapted from tiptour-macos (github.com/milind-soni/tiptour-macos),
// MIT License — Copyright (c) 2026 Milind Soni, Portions Copyright (c) 2025
// Farza (Clicky). The stop vocabulary and the `maxSteps = 12` ceiling are
// their `TipTour/Jev/JevPointerLoop.swift` (`finish(reason:message:)` →
// `step_budget` | `app_changed` | `cancelled`, and `JevGrounding.stopReason`
// → `target_absent`), with provenance in
// docs/plans/tiptour-integration-study.md (slice 3). Translated Swift →
// TypeScript; their reason strings are kept as product copy.
//
// WHAT THIS ACTUALLY ENFORCES, stated plainly: only `step_budget`, and only
// by REMOVING an unattended answer — when the turn has spent its budget, a
// desktop action that `autoDecision` would have waved through stops on the
// card for the human instead. It grants nothing, answers nothing, executes
// nothing, and `server/auto-approve.ts` is untouched. `app_changed`,
// `cancelled` and `target_absent` ship as the shared vocabulary plus pure
// helpers for a producer to report; nothing in this repo reports them yet
// (no frontmost-app reader exists server-side, cancellation is engine-side,
// and `target_absent` is produced by server/desktop-grounding.ts).
//
// Pure module: no I/O, no Electron/Express imports — same isolation rule as
// server/desktop-grounding.ts and server/desktop-suggestions.ts.

import type { StopReason } from "./desktop-grounding.ts";

/** The four stop reasons the study asks the guard to speak. `no_candidates`
 * also exists upstream and in `StopReason`; it names "nothing was detected",
 * which is grounding's business, not this guard's. */
export type DesktopStopReason = Extract<
  StopReason,
  "step_budget" | "app_changed" | "cancelled" | "target_absent"
>;

export const DESKTOP_STOP_REASONS = [
  "step_budget",
  "app_changed",
  "cancelled",
  "target_absent",
] as const satisfies readonly DesktopStopReason[];

/** Upstream's loop ceiling (`run(task:..., maxSteps: 12)`), kept as a named
 * constant so the prompt copy, the ledger and the tests can never drift
 * into three different numbers. */
export const DESKTOP_ACTION_BUDGET = 12;

/** Reason → the human line shown with it. Upstream's strings, kept. */
export const STOP_MESSAGES = {
  step_budget: `Stopped after ${DESKTOP_ACTION_BUDGET} actions.`,
  app_changed: "App changed. Start a new command in the app you want to use.",
  cancelled: "Stopped.",
  target_absent:
    "Couldn't find the requested control among the detected targets. Name a visible button or menu.",
} satisfies Record<DesktopStopReason, string>;

/** `reason: message` — the shape a transcript chip can carry verbatim. */
export function stopNote(reason: DesktopStopReason): string {
  return `${reason}: ${STOP_MESSAGES[reason]}`;
}

/** Upstream's pre-click app check, as a pure predicate: the guard has no
 * frontmost-application reader of its own, so a producer supplies both
 * sides. Returns false when either side is unknown — a guard that cannot
 * see the screen must not invent a stop. */
export function appChanged(frontmostApp: string | undefined, expectedApp: string | undefined): boolean {
  const front = frontmostApp?.trim().toLowerCase();
  const expected = expectedApp?.trim().toLowerCase();
  if (!front || !expected) return false;
  return front !== expected;
}

// ── which tool calls are screen actions ───────────────────────────────
// Evidence, not assumption: the local Cua Driver MCP child exposes
// `click`, `type_text`, `press_key`, `scroll`, `hotkey`, `drag`,
// `invoke_menu` (tool names read from node_modules/@trycua/cua-driver);
// the cloud computer proxy (server/computer-proxy.ts) adds `open_url` and
// `computer_batch`.
//
// Deliberately NOT counted: observations (`screenshot`,
// `get_desktop_state`) and the box's shell (`computer_exec`) — upstream's
// budget counts pointer actions, and counting reads would stop a bot that
// is only looking. `browser_*` semantic actions are cloud browsing, not
// This-Mac input. A `computer_batch` call counts as ONE unit: the fold
// sees the tool name, never its argument list, so per-step accounting
// would have to live driver-side.
const ACTION_TOOLS = new Set([
  "click",
  "type_text",
  "press_key",
  "scroll",
  "hotkey",
  "drag",
  "invoke_menu",
  "open_url",
  "computer_batch",
  "computer",
]);

/** True for a tool call that drives the screen. Accepts the bare name, the
 * `mcp__server__tool` spelling, and an ACP title carrying arguments
 * ("click 412, 88") — only the first token is ever considered, so prose
 * that merely starts with a verb-shaped word is the whole risk here and it
 * errs toward counting (a stop asks a human; it never grants one). */
export function isDesktopActionTool(name: string): boolean {
  const bare = name.replace(/^mcp__[^_]+__/, "").trim().split(/\s+/)[0] ?? "";
  return ACTION_TOOLS.has(bare.toLowerCase());
}

// ── the ledger ────────────────────────────────────────────────────────

/** How many screen actions each thread has taken this turn. Bounded by
 * construction: one integer per thread, dropped when the turn settles, so a
 * long-lived server cannot grow from it. Mirrors server/repeat-detector.ts
 * (count, settle, no I/O) with the class exported for tests and the
 * instance living beside its call site in server/index.ts. */
export class DesktopActionBudget {
  private readonly taken = new Map<string, number>();
  private readonly limit: number;

  constructor({ limit = DESKTOP_ACTION_BUDGET }: { limit?: number } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("desktop action budget must be a positive integer");
    this.limit = limit;
  }

  /** Count one executed screen action. Returns the running total. */
  record(threadId: string): number {
    const count = (this.taken.get(threadId) ?? 0) + 1;
    this.taken.set(threadId, count);
    return count;
  }

  count(threadId: string): number {
    return this.taken.get(threadId) ?? 0;
  }

  /** The budget is spent: every further screen action this turn must stop
   * back at the human rather than be answered unattended. */
  exhausted(threadId: string): boolean {
    return this.count(threadId) >= this.limit;
  }

  /** A new turn starts its own count. */
  reset(threadId: string): void {
    this.taken.delete(threadId);
  }

  /** The turn is over — drop the count so the map stays per-active-turn. */
  settle(threadId: string): void {
    this.taken.delete(threadId);
  }
}

/** The card's `held` line when the budget is the reason auto mode stopped.
 * Wording matches the existing `held` lines: it says what happened, and it
 * never implies the action was performed. */
export const DESKTOP_BUDGET_HELD = `Auto mode stopped here — this turn has used its ${DESKTOP_ACTION_BUDGET} screen actions.`;

export interface DesktopBudgetVerdict {
  /** What the card builder should treat as auto mode's answer. */
  settled: string | null;
  /** Why the card is showing, when the budget is the reason. */
  held?: string;
}

/** Apply the budget to an auto-approval decision. The budget only speaks
 * when auto mode would otherwise have answered: a request `autoDecision`
 * already refused keeps ITS reason, and a bot with no unattended answer
 * sees the ordinary card it always saw. */
export function budgetStop(input: {
  autoApproved: string | null;
  desktopAsk: boolean;
  exhausted: boolean;
}): DesktopBudgetVerdict {
  if (!input.exhausted || !input.desktopAsk || !input.autoApproved) {
    return { settled: input.autoApproved };
  }
  return { settled: null, held: DESKTOP_BUDGET_HELD };
}
