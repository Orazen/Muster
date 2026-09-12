import { z } from "zod";

export interface StopCleanupRecovery {
  /** Opaque server receipt; never substitute the currently selected task. */
  receipt: string | null;
  threadId: string;
  message: string;
}
export interface StopCleanupAction {
  pending: "stop" | "cleanup" | null;
  recovery: StopCleanupRecovery | null;
}
export type StopCleanupActions = Readonly<Record<string, StopCleanupAction>>;
export const EMPTY_STOP_ACTION: StopCleanupAction = Object.freeze({ pending: null, recovery: null });

interface StopBot { id: string; threadId: string; busy?: boolean; hidden?: boolean }
interface StopCleanupDependencies {
  accountId: string;
  getAccountId: () => string;
  getBot: (botId: string) => StopBot | undefined;
  request: (url: string, init: RequestInit) => Promise<Response>;
  onUnauthorized: () => void;
}
const UNKNOWN_STOP = "Muster could not confirm that this turn stopped. Review this bot’s current work before stopping it again.";
const RETRY_FAILED = "Muster could not confirm the cleanup. You can retry the original cleanup request.";
const STALE_STOP = "This cleanup request is no longer current. Review this bot’s current work before stopping it again.";
const responseBodySchema = z.object({
  ok: z.boolean().optional(), code: z.string().max(100).optional(),
  error: z.string().trim().min(1).max(1_000).optional(),
  cleanupReceipt: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

/** One authenticated provider owns this in-memory ledger. It intentionally does
 * not survive a reload: a lost initial response cannot manufacture a receipt.
 * Task/bot navigation preserves recovery; unmount/account changes retire it. */
export class StopCleanupSession {
  private actions: StopCleanupActions = {};
  private listeners = new Set<() => void>();
  private active = false;
  private epoch = 0;
  private requests = new Map<string, AbortController>();
  constructor(private readonly dependencies: StopCleanupDependencies) {}
  getSnapshot = (): StopCleanupActions => this.actions;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  action(botId: string): StopCleanupAction { return this.actions[botId] ?? EMPTY_STOP_ACTION; }
  attach(): () => void {
    this.active = true;
    this.epoch++;
    return () => {
      this.active = false;
      this.epoch++;
      for (const controller of this.requests.values()) controller.abort();
      this.requests.clear();
      this.actions = {};
    };
  }
  interrupt(botId: string): Promise<void> { return this.run(botId, "stop"); }
  retry(botId: string): Promise<void> { return this.run(botId, "cleanup"); }
  dismiss(botId: string): void {
    if (!this.current() || this.action(botId).pending) return;
    this.publish(botId, EMPTY_STOP_ACTION);
  }
  private current(): boolean {
    return this.active && this.dependencies.getAccountId() === this.dependencies.accountId;
  }
  private publish(botId: string, action: StopCleanupAction): void {
    this.actions = { ...this.actions, [botId]: action };
    for (const listener of this.listeners) listener();
  }
  private async run(botId: string, operation: "stop" | "cleanup"): Promise<void> {
    const bot = this.dependencies.getBot(botId);
    const previous = this.action(botId);
    if (!this.current() || !bot || bot.hidden || previous.pending) return;
    if (operation === "stop" && !bot.busy) return;
    const original = previous.recovery;
    if (operation === "cleanup" && !original?.receipt) return;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.requests.set(botId, controller);
    // This assignment happens before the first await, shared by every Stop
    // entrypoint; React's next render is not the duplicate-request boundary.
    this.publish(botId, { pending: operation, recovery: operation === "cleanup" ? original : null });
    const acceptsResult = () => this.current() && this.epoch === epoch
      && this.requests.get(botId) === controller && Boolean(this.dependencies.getBot(botId));
    const timer = setTimeout(() => controller.abort(), 10_000);
    let stopListening = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new Error("Stop request cancelled."));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      stopListening = () => controller.signal.removeEventListener("abort", onAbort);
    });
    let recovery: StopCleanupRecovery | null = null;
    try {
      const init: RequestInit = {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      };
      if (operation === "cleanup") init.body = JSON.stringify({ receipt: original!.receipt });
      const exchange = this.dependencies.request(`/api/bots/${encodeURIComponent(botId)}/${operation === "stop" ? "interrupt" : "stop-cleanup"}`, init)
        .then(async (response) => {
          const parsed = responseBodySchema.safeParse(await response.json().catch(() => null));
          return { response, body: parsed.success ? parsed.data : null };
        });
      const { response, body } = await Promise.race([exchange, aborted]);
      if (!acceptsResult()) return;
      if (response.status === 401) {
        this.active = false;
        this.epoch++;
        for (const request of this.requests.values()) request.abort();
        this.requests.clear();
        this.actions = {};
        for (const listener of this.listeners) listener();
        this.dependencies.onUnauthorized();
        return;
      }
      if (response.ok && body?.ok === true) return;
      const threadId = original && operation === "cleanup" ? original.threadId : bot.threadId;
      if (response.status === 503 && body?.code === "STOP_CLEANUP_PENDING" && body.cleanupReceipt
        && (operation === "stop" || body.cleanupReceipt === original?.receipt)) {
        recovery = { threadId, receipt: body.cleanupReceipt, message: body.error ?? RETRY_FAILED };
      } else if (operation === "cleanup" && (response.status >= 500 || response.ok)) {
        recovery = { ...original!, message: RETRY_FAILED };
      } else {
        recovery = { threadId, receipt: null, message: operation === "cleanup" ? STALE_STOP : body?.error ?? UNKNOWN_STOP };
      }
    } catch {
      recovery = operation === "cleanup" ? { ...original!, message: RETRY_FAILED }
        : { threadId: bot.threadId, receipt: null, message: UNKNOWN_STOP };
    } finally {
      clearTimeout(timer);
      stopListening();
      const accepted = acceptsResult();
      if (this.requests.get(botId) === controller) this.requests.delete(botId);
      if (accepted) this.publish(botId, { pending: null, recovery });
    }
  }
}
