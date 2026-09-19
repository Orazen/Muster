import type { RuntimeEvent } from "./contracts.ts";
import type { CallDispatch, CallTurn } from "./foreground-call.ts";
import type { PeerLease } from "./peer-capabilities.ts";

interface Entry { lease: PeerLease; input: CallDispatch; provider?: string; turnId?: string; reply: string }
/** Correlates only the captured provider turn, before peer terminal revocation. */
export class ForegroundCallDispatchTracker {
  private readonly byBot = new Map<string, Entry>();
  private readonly leaseCurrent: (lease: PeerLease) => boolean;
  constructor(leaseCurrent: (lease: PeerLease) => boolean = () => true) { this.leaseCurrent = leaseCurrent; }
  attach(lease: PeerLease, input: CallDispatch): void {
    const previous = this.byBot.get(lease.botId);
    if (previous?.lease === lease) return;
    if (previous) this.finish(previous, "uncertain");
    if (input.botId !== lease.botId || input.threadId !== lease.threadId || !input.isValid()) return;
    this.byBot.set(lease.botId, { lease, input, reply: "" });
  }
  private current(lease: PeerLease): Entry | undefined {
    const entry = this.byBot.get(lease.botId);
    if (!entry || entry.lease !== lease) return;
    if (!entry.input.isValid()) { this.forget(lease); return; }
    if (!this.leaseCurrent(lease)) { this.finish(entry, "uncertain"); return; }
    return entry;
  }
  activate(lease: PeerLease, providerInstanceId: string): void {
    const entry = this.current(lease);
    if (entry && !entry.provider && providerInstanceId) entry.provider = providerInstanceId;
  }
  bindTurn(lease: PeerLease, providerInstanceId: string, turnId: string): void {
    const entry = this.current(lease);
    if (!entry || !turnId || entry.provider !== providerInstanceId || (entry.turnId && entry.turnId !== turnId)) return;
    entry.turnId = turnId;
    entry.input.update({ state: "working" });
  }
  fail(lease: PeerLease, uncertain: boolean): void {
    const entry = this.current(lease);
    if (entry) this.finish(entry, uncertain ? "uncertain" : "failed");
  }
  private finish(entry: Entry, state: CallTurn["state"]): void {
    this.forget(entry.lease);
    if (!entry.input.isValid()) return;
    const patch: Partial<Omit<CallTurn, "requestId">> = { state, reply: entry.reply };
    if (state !== "completed") patch.error = "The message could not be completed. Check its status before trying again.";
    entry.input.update(patch);
  }
  onEvent(event: RuntimeEvent): void {
    for (const candidate of this.byBot.values()) {
      const entry = this.current(candidate.lease);
      if (!entry || entry.lease.threadId !== event.threadId || !event.providerInstanceId || entry.provider !== event.providerInstanceId) continue;
      if (event.type === "turn.started") {
        if (event.turnId) this.bindTurn(entry.lease, event.providerInstanceId, event.turnId);
        continue;
      }
      // An untagged terminal event cannot confirm whose work completed.
      // Retain uncertainty rather than claim a successful/stopped captured turn.
      if (!event.turnId && (event.type === "turn.completed" || event.type === "session.exited")) {
        this.finish(entry, "uncertain");
        continue;
      }
      if (!entry.turnId || !event.turnId || event.turnId !== entry.turnId) continue;
      if (event.type === "content.delta" && event.streamKind === "assistant_text") {
        entry.reply = (entry.reply + event.delta).slice(0, 16000);
        entry.input.update({ reply: entry.reply });
      } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
        entry.reply = event.text.slice(0, 16000);
        entry.input.update({ reply: entry.reply });
      } else if (event.type === "turn.completed") this.finish(entry, event.ok ? "completed" : "failed");
      else if (event.type === "session.exited") this.finish(entry, "uncertain");
      // runtime.error may precede an ordinary completion; it is not a second terminal event.
    }
  }
  sweep(): void {
    for (const entry of this.byBot.values()) this.current(entry.lease);
  }
  forget(lease: PeerLease): void {
    if (this.byBot.get(lease.botId)?.lease === lease) this.byBot.delete(lease.botId);
  }
}
