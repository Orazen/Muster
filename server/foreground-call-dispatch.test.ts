import { describe, expect, it } from "vitest";
import { ForegroundCallDispatchTracker } from "./foreground-call-dispatch.ts";
import type { CallDispatch, CallTurn } from "./foreground-call.ts";
import type { PeerLease } from "./peer-capabilities.ts";
import type { RuntimeEvent } from "./contracts.ts";

const lease: PeerLease = { id: "lease", botId: "bot", threadId: "thread", taskId: "task", ownerId: "owner", depth: 0, expiresAt: 999999 };
type Patch = Partial<Omit<CallTurn, "requestId">>;
function fixture() {
  let valid = true;
  const updates: Patch[] = [];
  const input: CallDispatch = { ownerId: "owner", botId: "bot", threadId: "thread", requestId: "request", text: "hello",
    isValid: () => valid, setCancel: () => {}, update: (patch) => updates.push(patch) };
  const tracker = new ForegroundCallDispatchTracker();
  tracker.attach(lease, input);
  tracker.activate(lease, "provider");
  return { tracker, input, updates, invalidate: () => { valid = false; } };
}
function event(patch: Partial<RuntimeEvent> & { type: RuntimeEvent["type"] }): RuntimeEvent {
  // SAFETY: Each owned fixture supplies its discriminant fields; the shared base supplies runtime identity.
  return { eventId: "event", provider: "codex", providerInstanceId: "provider", threadId: "thread", turnId: "turn", createdAt: new Date().toISOString(), ...patch } as RuntimeEvent;
}

describe("foreground call runtime correlation", () => {
  it("captures first matching turn and completes with authoritative bounded assistant reply", () => {
    const f = fixture();
    f.tracker.onEvent(event({ type: "turn.started" }));
    f.tracker.onEvent(event({ type: "content.delta", streamKind: "reasoning_text", delta: "private reasoning" }));
    f.tracker.onEvent(event({ type: "content.delta", streamKind: "assistant_text", delta: "partial" }));
    f.tracker.onEvent(event({ type: "item.completed", itemType: "assistant_text", text: "final" }));
    f.tracker.onEvent(event({ type: "turn.completed", ok: true }));
    expect(f.updates).toEqual([{ state: "working" }, { reply: "partial" }, { reply: "final" }, { state: "completed", reply: "final" }]);
    f.tracker.onEvent(event({ type: "turn.completed", ok: false }));
    f.tracker.fail(lease, true);
    expect(f.updates).toHaveLength(4);
  });
  it("ignores other provider/thread/turn identities and untagged events", () => {
    const f = fixture();
    f.tracker.onEvent(event({ type: "turn.started", providerInstanceId: "foreign" }));
    f.tracker.onEvent(event({ type: "turn.started", threadId: "foreign" }));
    f.tracker.onEvent(event({ type: "turn.completed", ok: true }));
    expect(f.updates).toEqual([]);
    f.tracker.bindTurn(lease, "provider", "turn");
    f.tracker.onEvent(event({ type: "turn.started", turnId: "old" }));
    for (const patch of [{ turnId: "old" }, { providerInstanceId: undefined }, { providerInstanceId: "foreign" }, { threadId: "foreign" }]) {
      f.tracker.onEvent(event({ type: "turn.completed", ok: true, ...patch }));
    }
    expect(f.updates).toEqual([{ state: "working" }]);
    f.tracker.onEvent(event({ type: "turn.completed", ok: true }));
    expect(f.updates.at(-1)?.state).toBe("completed");
  });
  it("does not terminate on provider error until exact completion and never leaks error detail", () => {
    const f = fixture(); f.tracker.bindTurn(lease, "provider", "turn");
    f.tracker.onEvent(event({ type: "runtime.error", message: "private provider credential" }));
    expect(f.updates).toHaveLength(1);
    f.tracker.onEvent(event({ type: "turn.completed", ok: false }));
    expect(f.updates.at(-1)?.state).toBe("failed");
    expect(JSON.stringify(f.updates)).not.toContain("credential");
  });
  it("session exit is uncertain only for captured turn", () => {
    const f = fixture(); f.tracker.bindTurn(lease, "provider", "turn");
    f.tracker.onEvent(event({ type: "session.exited", turnId: "other" }));
    expect(f.updates).toHaveLength(1);
    f.tracker.onEvent(event({ type: "session.exited", reason: "private reason" }));
    expect(f.updates.at(-1)?.state).toBe("uncertain");
    expect(JSON.stringify(f.updates)).not.toContain("private reason");
  });
  it("superseding attach settles prior uncertain and old lease cannot fail or forget replacement", () => {
    const f = fixture(); f.tracker.bindTurn(lease, "provider", "turn");
    const nextUpdates: Patch[] = [];
    const next = { ...lease, id: "replacement" };
    f.tracker.attach(next, { ...f.input, update: (patch) => nextUpdates.push(patch) });
    expect(f.updates.at(-1)?.state).toBe("uncertain");
    f.tracker.activate(next, "provider"); f.tracker.bindTurn(next, "provider", "next");
    f.tracker.forget(lease); f.tracker.fail(lease, false);
    f.tracker.onEvent(event({ type: "turn.completed", ok: true }));
    expect(nextUpdates).toEqual([{ state: "working" }]);
    f.tracker.onEvent(event({ type: "turn.completed", ok: true, turnId: "next" }));
    expect(nextUpdates.at(-1)?.state).toBe("completed");
  });
  it("ended call invalidates and drops late events without updates", () => {
    const f = fixture(); f.tracker.bindTurn(lease, "provider", "turn"); f.invalidate();
    f.tracker.onEvent(event({ type: "turn.completed", ok: true })); f.tracker.fail(lease, true);
    expect(f.updates).toEqual([{ state: "working" }]);
  });
  it.each([true, false])("setup failure receipt is uncertain=%s and terminal", (uncertain) => {
    const f = fixture(); f.tracker.fail(lease, uncertain); f.tracker.fail(lease, !uncertain);
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].state).toBe(uncertain ? "uncertain" : "failed");
  });
  it("bounds streamed and final answer independently", () => {
    const f = fixture(); f.tracker.bindTurn(lease, "provider", "turn");
    for (let i = 0; i < 2; i++) f.tracker.onEvent(event({ type: "content.delta", streamKind: "assistant_text", delta: "x".repeat(10000) }));
    expect(f.updates.at(-1)?.reply).toHaveLength(16000);
    f.tracker.onEvent(event({ type: "item.completed", itemType: "assistant_text", text: "y".repeat(17000) }));
    expect(f.updates.at(-1)?.reply).toBe("y".repeat(16000));
  });
  it("never binds mismatched leases or changes an activated provider", () => {
    const f = fixture();
    f.tracker.attach({ ...lease, botId: "foreign" }, f.input);
    f.tracker.activate(lease, "foreign");
    f.tracker.bindTurn(lease, "foreign", "turn");
    expect(f.updates).toEqual([]);
    f.tracker.bindTurn(lease, "provider", "turn");
    expect(f.updates).toEqual([{ state: "working" }]);
  });
});

it("untagged terminal event cannot claim completion and resolves conservatively uncertain", () => {
  const f = fixture(); f.tracker.bindTurn(lease, "provider", "turn");
  f.tracker.onEvent(event({ type: "turn.completed", turnId: undefined, ok: true }));
  expect(f.updates.at(-1)?.state).toBe("uncertain");
});
it("sweep removes invalid entries without awaiting another runtime event", () => {
  const f = fixture(); f.invalidate(); f.tracker.sweep();
  f.tracker.fail(lease, true);
  expect(f.updates).toEqual([]);
});

it("a newer normal lease cannot have its started event adopted by the old call", () => {
  let current = true;
  const f = fixture();
  const tracker = new ForegroundCallDispatchTracker(() => current);
  tracker.attach(lease, f.input); tracker.activate(lease, "provider");
  current = false;
  tracker.onEvent(event({ type: "turn.started", turnId: "new-normal-turn" }));
  tracker.onEvent(event({ type: "turn.completed", turnId: "new-normal-turn", ok: true }));
  expect(f.updates.map((patch) => patch.state)).toEqual(["uncertain"]);
});
it("sweep settles a superseded call even if the new normal turn emits no events", () => {
  let current = true;
  const f = fixture();
  const tracker = new ForegroundCallDispatchTracker(() => current);
  tracker.attach(lease, f.input); current = false; tracker.sweep(); tracker.sweep();
  expect(f.updates.map((patch) => patch.state)).toEqual(["uncertain"]);
});
