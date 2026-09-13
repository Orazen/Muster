import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DelegationSnapshot } from "./delegations.ts";

export const STOP_CLEANUP_PENDING = "STOP_CLEANUP_PENDING";
export const STOP_CLEANUP_STALE = "STOP_CLEANUP_STALE";
export const STOP_CLEANUP_PENDING_MESSAGE = "Queued handoffs could not be durably canceled. Retry cleanup before restarting Muster.";
export const STOP_CLEANUP_STALE_MESSAGE = "This cleanup request is no longer current. Check this bot's current work before stopping it again.";
/** What a restart says when it finished the cleanup the failed Stop could not. */
export const STOP_CLEANUP_RESTART_SETTLED = "error: the app restarted while a Stop was canceling queued handoffs — cleanup finished at startup; that work was not resumed";
/** What a restart says when the cleanup still could not be confirmed. */
export const STOP_CLEANUP_RESTART_UNRESOLVED = "error: the app restarted while a Stop was canceling queued handoffs — cleanup could not be confirmed; check this bot's current work before stopping it again";
export const STOP_CLEANUP_RESTART_SETTLED_MESSAGE = "This Stop's queued handoffs were canceled when Muster restarted. That work was not resumed; check this bot's current work.";
export const STOP_CLEANUP_RESTART_UNRESOLVED_MESSAGE = "This Stop's queued handoffs still could not be canceled. Check this bot's current work before stopping it again.";

interface Generation { id: string; ownerId: string }
interface Receipt {
  token: string;
  generation: Generation;
  snapshots: DelegationSnapshot[];
  failedAt: number;
  expiresAt: number;
  complete: boolean;
}

/** One failed Stop, in the shape a database row can hold. `snapshots` is the
 * exact original capture: a later cleanup may only remove those IDs. */
export interface StopCleanupReceiptRecord {
  botId: string;
  ownerId: string;
  generationId: string;
  token: string;
  snapshots: DelegationSnapshot[];
  failedAt: number;
  reason: string;
}
/** The stored capture, validated where it is read back off disk. */
export const stopCleanupSnapshotsSchema = z.array(z.object({
  threadId: z.string().min(1),
  itemIds: z.array(z.string().min(1)),
}));
export type StopCleanupReceiptStatus = "pending" | "settled";
export interface StopCleanupDurableState {
  status: StopCleanupReceiptStatus;
  failedAt: number;
  reason: string;
}

/** Where a failed Stop outlives the process that failed it. Implemented by the
 * transcript database (`stopCleanupJournal` in message-db.ts) so a Stop that
 * could not be written to the handoff queue still cannot be resumed by a
 * reload or a restart. Every method is synchronous, like the cleanup itself. */
export interface StopCleanupJournal {
  record(record: StopCleanupReceiptRecord): void;
  clear(botId: string): void;
  pending(): StopCleanupReceiptRecord[];
  settle(botId: string, token: string, at: number): boolean;
  state(botId: string, token: string): StopCleanupDurableState | undefined;
}

/** Cleanup authority, never a provider Stop command. Within one process a new
 * generation, later admitted turn, changed owner, deletion or expiry retires
 * old receipts; a journal, when supplied, retires the durable record with them
 * and keeps the failure across a restart. Keep one bounded receipt per bot,
 * including completed receipts for idempotency. */
export class StopCleanupRegistry {
  private generations = new Map<string, Generation>();
  private receipts = new Map<string, Receipt>();
  private now: () => number;
  private ttlMs: number;
  private journal: StopCleanupJournal | undefined;
  constructor(now = Date.now, ttlMs = 24 * 60 * 60_000, journal?: StopCleanupJournal) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.journal = journal;
  }

  /** Invoke synchronously at BOTH direct and room busy claims, before setup. */
  begin(botId: string, ownerId: string): void {
    this.invalidate(botId);
    this.generations.set(botId, { id: randomUUID(), ownerId });
  }

  invalidate(botId: string): void {
    this.generations.delete(botId);
    this.receipts.delete(botId);
    this.forget(botId);
  }

  /** Called before awaiting interruption. Same-generation repeated Stops reuse
   * the token, so a late first response cannot replace a newer valid receipt.
   * The durable record is written here, before any await, because a process
   * that dies mid-Stop is exactly what it has to survive. */
  issue(botId: string, ownerId: string, snapshots: readonly DelegationSnapshot[], reason = STOP_CLEANUP_PENDING_MESSAGE): string {
    if (this.generations.get(botId)?.ownerId !== ownerId) this.begin(botId, ownerId);
    const generation = this.generations.get(botId)!;
    const prior = this.receipts.get(botId);
    const receipt = prior?.generation === generation && this.now() < prior.expiresAt
      ? prior
      : { token: randomBytes(32).toString("hex"), generation, snapshots: [], failedAt: this.now(), expiresAt: this.now() + this.ttlMs, complete: false };
    for (const snapshot of snapshots) {
      const existing = receipt.snapshots.find((item) => item.threadId === snapshot.threadId);
      if (existing) existing.itemIds = [...new Set([...existing.itemIds, ...snapshot.itemIds])];
      else receipt.snapshots.push({ threadId: snapshot.threadId, itemIds: [...snapshot.itemIds] });
    }
    receipt.complete = false;
    this.receipts.set(botId, receipt);
    if (receipt.snapshots.some((snapshot) => snapshot.itemIds.length)) {
      try {
        // Copy the capture: the journal must not be handed live authority.
        this.journal?.record({
          botId, ownerId, generationId: receipt.generation.id, token: receipt.token,
          snapshots: receipt.snapshots.map((snapshot) => ({ threadId: snapshot.threadId, itemIds: [...snapshot.itemIds] })),
          failedAt: receipt.failedAt, reason,
        });
      } catch (error) {
        // The in-memory receipt still works; only survival across a restart is lost.
        console.error("stop-cleanup: could not durably record the failed Stop", error);
      }
    }
    return receipt.token;
  }

  current(botId: string, ownerId: string, token: string): boolean {
    const receipt = this.receipts.get(botId);
    if (!receipt || receipt.token !== token || receipt.generation.ownerId !== ownerId) return false;
    if (receipt.generation !== this.generations.get(botId) || this.now() >= receipt.expiresAt) {
      this.receipts.delete(botId);
      this.forget(botId);
      return false;
    }
    return true;
  }

  /** Synchronous by design: no await may separate current owner/generation/task
   * validation from exact-ID disk removal. HTTP requests therefore serialize
   * here; a duplicate success makes no further storage writes. */
  retry(botId: string, ownerId: string, token: string,
    hasTask: (threadId: string) => boolean,
    cleanup: (snapshot: DelegationSnapshot) => boolean,
  ): "ok" | "pending" | "stale" {
    if (!this.current(botId, ownerId, token)) return "stale";
    const receipt = this.receipts.get(botId)!;
    if (!receipt.snapshots.every((snapshot) => hasTask(snapshot.threadId))) {
      this.invalidate(botId);
      return "stale";
    }
    if (receipt.complete) return "ok";
    let complete = true;
    for (const snapshot of receipt.snapshots) if (!cleanup(snapshot)) complete = false;
    receipt.complete = complete;
    // The cleanup is done: nothing is left to resume, so nothing stays durable.
    if (complete) this.forget(botId);
    return complete ? "ok" : "pending";
  }

  /** What the durable record says about a receipt this process never issued —
   * what a reload or restart left behind. Undefined when there is no such row. */
  durableState(botId: string, token: string): StopCleanupDurableState | undefined {
    return this.journal?.state(botId, token);
  }

  private forget(botId: string): void {
    try {
      this.journal?.clear(botId);
    } catch (error) {
      // A row that outlives its in-memory receipt is applied at the next boot,
      // which errs toward the Stop the user asked for, never toward resuming it.
      console.error("stop-cleanup: could not retire the durable Stop receipt", error);
    }
  }
}

export type StopCleanupBootState = "settled" | "unresolved" | "retired";
export interface StopCleanupBootResult {
  botId: string;
  state: StopCleanupBootState;
  /** the bot's current conversation, when the receipt could still be addressed */
  threadId?: string;
  /** the exact line to append to that conversation; chosen here so no caller
   * invents its own wording for an uncertain outcome */
  note?: string;
  /** task threads this receipt captured; an unresolved receipt keeps them out
   * of this boot's handoff drain */
  capturedThreads: string[];
}
export interface StopCleanupBootDeps {
  journal: Pick<StopCleanupJournal, "pending" | "settle">;
  /** false when the durable handoff queue could not be read: nothing was loaded,
   * so "already removed" cannot be told from "never seen", and no receipt is
   * consumed — the next boot with a readable queue retries it */
  queueLoaded: boolean;
  /** current owner of the bot, or undefined when the bot no longer exists */
  botOwner: (botId: string) => string | undefined;
  botThread: (botId: string) => string | undefined;
  isLiveTask: (botId: string, threadId: string) => boolean;
  cancelQueue: (snapshot: DelegationSnapshot) => boolean;
  now?: () => number;
}

/** Startup half of the failed-Stop contract. A receipt records work the user
 * stopped and the previous process could not remove. This applies each one to
 * its exact captured IDs — never a sweep of whatever the thread holds now —
 * and consumes it once, so the boot drain cannot run the stopped work and a
 * second restart cannot apply the same receipt again. */
export function settleInterruptedStopCleanups(deps: StopCleanupBootDeps): StopCleanupBootResult[] {
  const results: StopCleanupBootResult[] = [];
  const at = deps.now ?? Date.now;
  for (const record of deps.journal.pending()) {
    const owner = deps.botOwner(record.botId);
    const addressed = owner !== undefined && owner === record.ownerId;
    const threadId = addressed ? deps.botThread(record.botId) : undefined;
    const live = addressed ? record.snapshots.filter((snapshot) => deps.isLiveTask(record.botId, snapshot.threadId)) : [];
    if (!deps.queueLoaded || !live.every((snapshot) => deps.cancelQueue(snapshot))) {
      // Nothing was resumed: the receipt stays pending for the next boot, and
      // its captured threads stay out of this boot's drain.
      const unresolved: StopCleanupBootResult = {
        botId: record.botId, state: "unresolved",
        capturedThreads: record.snapshots.map((snapshot) => snapshot.threadId),
      };
      if (threadId) { unresolved.threadId = threadId; unresolved.note = STOP_CLEANUP_RESTART_UNRESOLVED; }
      results.push(unresolved);
      continue;
    }
    // Exactly once: a second boot, or a second process, loses this race.
    if (!deps.journal.settle(record.botId, record.token, at())) continue;
    if (!addressed) {
      // The bot is gone or changed hands; its queue can no longer dispatch
      // under the receipt's owner, so the receipt is retired without a note.
      results.push({ botId: record.botId, state: "retired", capturedThreads: [] });
      continue;
    }
    const settled: StopCleanupBootResult = {
      botId: record.botId, state: "settled",
      capturedThreads: live.map((snapshot) => snapshot.threadId),
    };
    if (threadId) { settled.threadId = threadId; settled.note = STOP_CLEANUP_RESTART_SETTLED; }
    results.push(settled);
  }
  return results;
}
