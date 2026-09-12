import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

const bearerSchema = z.string().regex(/^Bearer [a-f0-9]{64}$/);

export interface PeerLeaseContext {
  botId: string;
  threadId: string;
  taskId: string;
  ownerId: string;
  depth: number;
}

/** Harness-owned identity. Never reconstructed from an HTTP caller's fields. */
export interface PeerLease extends Readonly<PeerLeaseContext> {
  readonly id: string;
  readonly expiresAt: number;
}

interface Entry {
  lease: PeerLease;
  token?: string;
  instanceId?: string;
  turnId?: string;
}

/** One credential per dispatch, with the same absolute ceiling as the watchdog.
 * No credential is persisted. Accepted delegations persist separate provenance. */
export class PeerCapabilities {
  private byBot = new Map<string, Entry>();
  private byToken = new Map<string, Entry>();
  private now: () => number;
  private ttlMs: number;
  private onExpired: (lease: PeerLease) => void;

  constructor(now = Date.now, ttlMs = 24 * 60 * 60_000, onExpired: (lease: PeerLease) => void = () => {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.onExpired = onExpired;
  }

  begin(context: PeerLeaseContext): PeerLease {
    if (!Number.isInteger(context.depth) || context.depth < 0) throw new Error("invalid peer depth");
    this.revokeBot(context.botId);
    const lease = Object.freeze({ ...context, id: randomUUID(), expiresAt: this.now() + this.ttlMs });
    this.byBot.set(lease.botId, { lease });
    return lease;
  }

  current(lease: PeerLease): boolean {
    if (this.byBot.get(lease.botId)?.lease !== lease) return false;
    if (this.now() >= lease.expiresAt) {
      this.revoke(lease);
      this.onExpired(lease);
      return false;
    }
    return true;
  }

  /** Call immediately before invoking the adapter, after final setup checks. */
  activate(lease: PeerLease, instanceId: string, allowPeers: boolean): string | undefined {
    if (!this.current(lease)) throw new Error("dispatch is no longer current");
    const entry = this.byBot.get(lease.botId)!;
    if (entry.instanceId) throw new Error("dispatch was already activated");
    entry.instanceId = instanceId;
    if (!allowPeers || lease.depth !== 0) return undefined;
    entry.token = randomBytes(32).toString("hex");
    this.byToken.set(entry.token, entry);
    return entry.token;
  }

  resolve(header: string | string[] | undefined): PeerLease | undefined {
    const bearer = bearerSchema.safeParse(header);
    if (!bearer.success) return;
    const entry = this.byToken.get(bearer.data.slice(7));
    return entry && this.current(entry.lease) ? entry.lease : undefined;
  }

  bindTurn(lease: PeerLease, instanceId: string, turnId: string | undefined): void {
    if (!turnId || !this.current(lease)) return;
    const entry = this.byBot.get(lease.botId)!;
    if (entry.instanceId !== instanceId || (entry.turnId && entry.turnId !== turnId)) return;
    entry.turnId = turnId;
  }

  /** Registered before fold/drain subscribers. Old terminal events cannot
   * revoke a new dispatch even if the task and provider session are reused. */
  onEvent(event: { type: string; threadId: string; providerInstanceId?: string; turnId?: string }): PeerLease | undefined {
    const entry = [...this.byBot.values()].find((e) => e.lease.threadId === event.threadId);
    if (!entry || !event.providerInstanceId || entry.instanceId !== event.providerInstanceId) return;
    if (event.type === "turn.started") this.bindTurn(entry.lease, event.providerInstanceId, event.turnId);
    else if ((event.type === "turn.completed" || event.type === "session.exited") &&
      event.turnId && entry.turnId === event.turnId && this.current(entry.lease)) {
      this.revoke(entry.lease);
      return entry.lease;
    }
  }

  forBot(botId: string): PeerLease | undefined {
    const lease = this.byBot.get(botId)?.lease;
    return lease && this.current(lease) ? lease : undefined;
  }

  revoke(lease: PeerLease): void {
    const entry = this.byBot.get(lease.botId);
    if (entry?.lease !== lease) return;
    if (entry.token) this.byToken.delete(entry.token);
    this.byBot.delete(lease.botId);
  }

  revokeBot(botId: string): void {
    const lease = this.byBot.get(botId)?.lease;
    if (lease) this.revoke(lease);
  }

  revokeThread(threadId: string, turnId?: string): void {
    for (const entry of this.byBot.values()) {
      if (entry.lease.threadId === threadId && (turnId === undefined || entry.turnId === turnId)) this.revoke(entry.lease);
    }
  }

  clear(): void {
    this.byBot.clear();
    this.byToken.clear();
  }
}
