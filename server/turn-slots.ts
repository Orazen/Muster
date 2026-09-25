/** OMB-parity parallel threads: how many of a bot's threads may run a turn
 * at the same time. The DEFAULT stays 1 — one worker per bot, the invariant
 * the turn pipeline (watchdog, provider fallback, delegation watchers,
 * budget ledger, group engine) was built against. Raising the limit only
 * widens the gate for DIRECT bot threads: rooms keep one speaker, the bot's
 * own thread stays strictly serial, and the busy flag remains the
 * composer-locking single source of truth. Fail-safe direction: a leaked
 * slot serializes a bot sooner — it can never over-parallelize. */

const MIN = 1;
const MAX = 8;

export interface ParallelThreadsConfig {
  /** Per-bot overrides. A value outside the clamp means OFF for that bot
   * (it falls back to the deployment default). */
  perBot?: Record<string, number | undefined>;
  /** Deployment-wide default when a bot has no override. Absent = 1. */
  default?: number;
}

export const PARALLEL_THREADS_MIN = MIN;
export const PARALLEL_THREADS_MAX = MAX;

const clamp = (value: number): number | undefined =>
  Number.isFinite(value) && Number.isInteger(value) && value >= MIN && value <= MAX ? value : undefined;

/** The effective width for a bot on a given thread. Group threads are
 * pinned to 1 by Muster's one-speaker room design — the setting never
 * applies to them. A default of exactly 1 is the classic invariant and is
 * reported as 1 (not undefined) so callers can show the live number. */
export function configuredWidth(
  config: ParallelThreadsConfig | undefined,
  botId: string,
  isGroupThread: boolean,
): number {
  if (isGroupThread) return 1;
  const perBot = clamp(Number(config?.perBot?.[botId] ?? Number.NaN));
  if (perBot !== undefined) return perBot;
  const base = clamp(Number(config?.default ?? Number.NaN));
  if (base !== undefined) return base;
  return 1;
}

/** Live slot ledger: botId -> the thread ids currently running a turn. */
const slots = new Map<string, Set<string>>();

/** Is there room for one more turn on `threadId`? Pure counter read — the
 * caller (startTurn) keeps check-and-claim in one synchronous block, so no
 * await can slip between the count and the claim. */
export function hasSlot(botId: string, threadId: string, width: number): boolean {
  const taken = slots.get(botId);
  if (!taken) return true;
  return taken.size < width;
}

/** Count a thread against its bot's width. Called from startTurn after the
 * busy flip, so every turn (including width-1 classic turns) is tracked. */
export function claimSlot(botId: string, threadId: string): void {
  let taken = slots.get(botId);
  if (!taken) {
    taken = new Set();
    slots.set(botId, taken);
  }
  taken.add(threadId);
}

/** Give the slot back. Idempotent: the settle fold and the lost-turn reaper
 * may both run for the same turn. */
export function releaseSlot(botId: string, threadId: string): void {
  const taken = slots.get(botId);
  if (!taken) return;
  taken.delete(threadId);
  if (!taken.size) slots.delete(botId);
}

/** Test/ops seam: forget one bot's ledger (or everything). */
export function clearSlots(botId?: string): void {
  if (botId === undefined) slots.clear();
  else slots.delete(botId);
}

/** The threads currently holding a turn slot for a bot — Stop iterates
 * these so an interrupt reaches every running turn, not just one. */
export function runningThreads(botId: string): string[] {
  return [...(slots.get(botId) ?? [])];
}
