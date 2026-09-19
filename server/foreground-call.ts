import { createHash, timingSafeEqual } from "node:crypto";

export interface CallScope { ownerId: string | null; botId: string; token: string }
export interface CallTurn {
  requestId: string;
  state: "starting" | "working" | "completed" | "failed" | "uncertain" | "cancelled";
  messageId?: string;
  reply?: string;
  error?: string;
}
export interface CallView {
  id: string; botId: string; threadId: string;
  state: "ringing" | "connected" | "ended";
  revision: number; expiresAt: number; endReason?: string; turn?: CallTurn;
}
export class ForegroundCallError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export interface CallDispatch {
  ownerId: string | null; botId: string; threadId: string; requestId: string; text: string;
  isValid(): boolean;
  setCancel(cancel: () => void | Promise<void>): void;
  update(patch: Partial<Omit<CallTurn, "requestId">>): void;
}
interface Receipt { dispatched?: boolean; text: string; turn: CallTurn; cancel?: () => void | Promise<void>; cancellation?: Promise<void> }
interface Entry { ownerId: string | null; hash: Buffer; view: CallView; receipts: Map<string, Receipt>; current?: Receipt; endedAt?: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const TERMINAL = new Set<CallTurn["state"]>(["completed", "failed", "uncertain", "cancelled"]);
function fail(status: number, message: string): never { throw new ForegroundCallError(status, message); }
function validId(value: string) { if (!UUID.test(value)) fail(400, "A valid request identifier is required."); }
function tokenHash(token: string) {
  if (!TOKEN.test(token)) fail(400, "A call capability is required.");
  return createHash("sha256").update(token).digest();
}

/** Ephemeral foreground sessions. No provider dispatch is retried or queued. */
export class ForegroundCallRegistry {
  private readonly calls = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly retentionMs: number;
  private readonly maxCalls: number;
  private readonly dispatch: (input: CallDispatch) => void | Promise<void>;
  constructor(options: { dispatch: (input: CallDispatch) => void | Promise<void>; now?: () => number; leaseMs?: number; retentionMs?: number; maxCalls?: number }) {
    this.dispatch = options.dispatch;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 45_000;
    this.retentionMs = options.retentionMs ?? 300_000;
    this.maxCalls = Math.min(200, Math.max(1, options.maxCalls ?? 200));
  }
  private copy(entry: Entry, receipt = entry.current): CallView {
    const result = { ...entry.view };
    if (receipt) result.turn = { ...receipt.turn };
    return result;
  }
  private expire(entry: Entry) {
    if (entry.view.state !== "ended" && entry.view.expiresAt <= this.now()) {
      this.invalidate(entry, "Foreground call lease expired.");
      void this.cancel(entry).catch(() => {});
    }
  }
  private lookup(scope: CallScope, id: string): Entry {
    validId(id);
    const hash = tokenHash(scope.token);
    const entry = this.calls.get(id);
    if (!entry || entry.ownerId !== scope.ownerId || entry.view.botId !== scope.botId || !timingSafeEqual(entry.hash, hash)) fail(404, "Call not found.");
    this.expire(entry);
    return entry;
  }
  private invalidate(entry: Entry, reason: string) {
    if (entry.view.state === "ended") return;
    entry.view.state = "ended";
    entry.view.endReason = reason;
    entry.endedAt = this.now();
    entry.view.revision++;
    if (entry.current && !TERMINAL.has(entry.current.turn.state)) entry.current.turn.state = entry.current.dispatched ? "uncertain" : "cancelled";
  }
  private cancel(entry: Entry, receipt = entry.current): Promise<void> {
    if (!receipt?.cancel || receipt.turn.state === "completed" || receipt.turn.state === "failed") return Promise.resolve();
    if (receipt.cancellation) return receipt.cancellation;
    receipt.cancellation = Promise.resolve().then(() => receipt.cancel!()).then(() => {
      if (entry.current === receipt && entry.view.state === "ended") {
        receipt.turn.state = "cancelled";
        entry.view.revision++;
      }
    }).catch(() => { throw new ForegroundCallError(503, "The call ended, but stopping its work could not be confirmed."); });
    return receipt.cancellation;
  }
  private prune() {
    for (const [id, entry] of this.calls) {
      this.expire(entry);
      if (entry.endedAt !== undefined && this.now() - entry.endedAt >= this.retentionMs) this.calls.delete(id);
    }
  }
  ring(scope: CallScope, input: { requestId: string; threadId: string }): CallView {
    validId(input.requestId);
    const hash = tokenHash(scope.token);
    if (!input.threadId.trim()) fail(400, "A thread is required.");
    this.prune();
    if (this.calls.has(input.requestId)) {
      const entry = this.lookup(scope, input.requestId);
      if (entry.view.threadId !== input.threadId) fail(409, "This request identifier was used for another thread.");
      return this.copy(entry);
    }
    if (this.calls.size >= this.maxCalls) {
      const oldest = [...this.calls.values()].filter(entry => entry.endedAt !== undefined).sort((a, b) => a.endedAt! - b.endedAt!)[0];
      if (!oldest) fail(429, "Too many active calls. End a call before starting another.");
      this.calls.delete(oldest.view.id);
    }
    const entry: Entry = { ownerId: scope.ownerId, hash, receipts: new Map(), view: {
      id: input.requestId, botId: scope.botId, threadId: input.threadId, state: "ringing", revision: 1, expiresAt: this.now() + this.leaseMs,
    } };
    this.calls.set(input.requestId, entry);
    return this.copy(entry);
  }
  peek(scope: CallScope, id: string): CallView {
    return this.copy(this.lookup(scope, id));
  }
  get(scope: CallScope, id: string): CallView {
    const entry = this.lookup(scope, id);
    if (entry.view.state !== "ended") { entry.view.expiresAt = this.now() + this.leaseMs; entry.view.revision++; }
    return this.copy(entry);
  }
  accept(scope: CallScope, id: string): CallView {
    const entry = this.lookup(scope, id);
    if (entry.view.state === "ended") fail(409, "This call has ended.");
    if (entry.view.state === "ringing") { entry.view.state = "connected"; entry.view.revision++; }
    return this.copy(entry);
  }
  message(scope: CallScope, id: string, input: { requestId: string; text: string }): CallView {
    validId(input.requestId);
    const entry = this.lookup(scope, id);
    const text = input.text.trim();
    if (!text || text.length > 8000) fail(400, "A message must contain 1 to 8000 characters.");
    const prior = entry.receipts.get(input.requestId);
    if (prior) {
      if (prior.text !== text) fail(409, "This request identifier was used for another message.");
      return this.copy(entry, prior);
    }
    if (entry.view.state !== "connected") fail(409, "Accept an active call before sending a message.");
    if (entry.current && !["completed", "failed", "cancelled"].includes(entry.current.turn.state)) fail(409, "The previous message is still working or its outcome is unknown.");
    if (entry.receipts.size >= 200) fail(429, "This call has reached its message limit. End it before starting another.");
    const receipt: Receipt = { text, turn: { requestId: input.requestId, state: "starting" } };
    entry.receipts.set(input.requestId, receipt);
    entry.current = receipt;
    entry.view.revision++;
    const isValid = () => {
      this.expire(entry);
      return this.calls.get(id) === entry && entry.view.state === "connected" && entry.current === receipt && !TERMINAL.has(receipt.turn.state);
    };
    const update: CallDispatch["update"] = (patch) => {
      if (!isValid()) return;
      if (patch.state) receipt.turn.state = patch.state;
      if (patch.messageId !== undefined) receipt.turn.messageId = patch.messageId;
      if (patch.reply !== undefined) receipt.turn.reply = patch.reply.slice(0, 16000);
      if (patch.error !== undefined) receipt.turn.error = "The message could not be completed. Check its status before trying again.";
      entry.view.revision++;
    };
    void Promise.resolve().then(() => {
      if (!isValid()) return;
      receipt.dispatched = true;
      return this.dispatch({ ownerId: scope.ownerId, botId: scope.botId, threadId: entry.view.threadId, requestId: input.requestId, text, isValid,
        setCancel: (cancel) => {
          if (receipt.cancel) return;
          receipt.cancel = cancel;
          if (entry.view.state === "ended") void this.cancel(entry, receipt).catch(() => {});
        }, update });
    }).catch(() => update({ state: "uncertain", error: "dispatch" }));
    return this.copy(entry);
  }
  async end(scope: CallScope, id: string, reason = "Call ended."): Promise<CallView> {
    const entry = this.lookup(scope, id);
    this.invalidate(entry, reason);
    await this.cancel(entry);
    return this.copy(entry);
  }
  async sweep(): Promise<void> {
    this.prune();
    await Promise.allSettled([...this.calls.values()].map(entry => entry.current?.cancellation));
  }
}
