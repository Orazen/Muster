import { randomBytes, randomUUID } from "node:crypto";
import type { DelegationSnapshot } from "./delegations.ts";

export const STOP_CLEANUP_PENDING = "STOP_CLEANUP_PENDING";
export const STOP_CLEANUP_STALE = "STOP_CLEANUP_STALE";
export const STOP_CLEANUP_PENDING_MESSAGE = "Queued handoffs could not be durably canceled. Retry cleanup before restarting Muster.";
export const STOP_CLEANUP_STALE_MESSAGE = "This cleanup request is no longer current. Check this bot's current work before stopping it again.";

interface Generation { id: string; ownerId: string }
interface Receipt {
  token: string;
  generation: Generation;
  snapshots: DelegationSnapshot[];
  expiresAt: number;
  complete: boolean;
}

/** Process-local cleanup authority, never a provider Stop command. A new process,
 * later admitted turn, changed owner, deletion or reload retires old receipts.
 * Keep one bounded receipt per bot, including completed receipts for idempotency. */
export class StopCleanupRegistry {
  private generations = new Map<string, Generation>();
  private receipts = new Map<string, Receipt>();
  private now: () => number;
  private ttlMs: number;
  constructor(now = Date.now, ttlMs = 24 * 60 * 60_000) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  /** Invoke synchronously at BOTH direct and room busy claims, before setup. */
  begin(botId: string, ownerId: string): void {
    this.invalidate(botId);
    this.generations.set(botId, { id: randomUUID(), ownerId });
  }

  invalidate(botId: string): void {
    this.generations.delete(botId);
    this.receipts.delete(botId);
  }

  /** Called before awaiting interruption. Same-generation repeated Stops reuse
   * the token, so a late first response cannot replace a newer valid receipt. */
  issue(botId: string, ownerId: string, snapshots: readonly DelegationSnapshot[]): string {
    if (this.generations.get(botId)?.ownerId !== ownerId) this.begin(botId, ownerId);
    const generation = this.generations.get(botId)!;
    const prior = this.receipts.get(botId);
    const receipt = prior?.generation === generation && this.now() < prior.expiresAt
      ? prior
      : { token: randomBytes(32).toString("hex"), generation, snapshots: [], expiresAt: this.now() + this.ttlMs, complete: false };
    for (const snapshot of snapshots) {
      const existing = receipt.snapshots.find((item) => item.threadId === snapshot.threadId);
      if (existing) existing.itemIds = [...new Set([...existing.itemIds, ...snapshot.itemIds])];
      else receipt.snapshots.push({ threadId: snapshot.threadId, itemIds: [...snapshot.itemIds] });
    }
    receipt.complete = false;
    this.receipts.set(botId, receipt);
    return receipt.token;
  }

  current(botId: string, ownerId: string, token: string): boolean {
    const receipt = this.receipts.get(botId);
    if (!receipt || receipt.token !== token || receipt.generation.ownerId !== ownerId) return false;
    if (receipt.generation !== this.generations.get(botId) || this.now() >= receipt.expiresAt) {
      this.receipts.delete(botId);
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
    return complete ? "ok" : "pending";
  }
}
