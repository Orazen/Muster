import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ForegroundCallRegistry, type CallDispatch, type CallScope } from "./foreground-call.ts";

const scope: CallScope = { ownerId: "owner", botId: "bot", token: "a".repeat(64) };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fixture(options: { maxCalls?: number; dispatch?: (input: CallDispatch) => void | Promise<void> } = {}) {
  let now = 1000;
  const dispatched: CallDispatch[] = [];
  const registry = new ForegroundCallRegistry({ now: () => now, leaseMs: 45_000, retentionMs: 300_000, maxCalls: options.maxCalls,
    dispatch: (input) => { dispatched.push(input); return options.dispatch?.(input); } });
  const id = randomUUID();
  const ring = () => registry.ring(scope, { requestId: id, threadId: "thread" });
  const connect = () => { ring(); return registry.accept(scope, id); };
  const message = (requestId = randomUUID(), text = "hello") => registry.message(scope, id, { requestId, text });
  return { registry, dispatched, id, ring, connect, message, advance: (ms: number) => { now += ms; } };
}

describe("foreground call capability and consent", () => {
  it("rings and accepts without dispatch, duplicates are idempotent", () => {
    const f = fixture();
    const first = f.ring();
    expect(f.ring()).toEqual(first);
    const connected = f.registry.accept(scope, f.id);
    expect(f.registry.accept(scope, f.id)).toEqual(connected);
    expect(f.dispatched).toEqual([]);
    expect(JSON.stringify(connected)).not.toContain(scope.token);
    expect(() => f.registry.ring(scope, { requestId: f.id, threadId: "other" })).toThrow("another thread");
  });
  it.each([
    { ...scope, ownerId: "other" }, { ...scope, botId: "other" }, { ...scope, token: "b".repeat(64) },
  ])("rejects a foreign scope without exposing its receipt", (foreign) => {
    const f = fixture(); f.ring();
    expect(() => f.registry.get(foreign, f.id)).toThrow("Call not found");
    expect(() => f.registry.accept(foreign, f.id)).toThrow("Call not found");
  });
  it("rejects malformed capability, ids and messages", () => {
    const f = fixture();
    expect(() => f.registry.ring({ ...scope, token: "A".repeat(64) }, { requestId: f.id, threadId: "thread" })).toThrow();
    expect(() => f.registry.ring(scope, { requestId: "not-uuid", threadId: "thread" })).toThrow();
    f.connect();
    expect(() => f.message(randomUUID(), " ")).toThrow();
    expect(() => f.message(randomUUID(), "x".repeat(8001))).toThrow();
  });
  it("requires explicit accept and does not dispatch after ending before the queued start", async () => {
    const f = fixture(); f.ring();
    expect(() => f.message()).toThrow("Accept");
    f.registry.accept(scope, f.id); f.message();
    const ended = await f.registry.end(scope, f.id);
    await tick();
    expect(ended.turn?.state).toBe("cancelled");
    expect(f.dispatched).toEqual([]);
  });
});

describe("foreground call dispatch receipts", () => {
  it("deduplicates a lost acknowledgement, rejects changed text and never overlaps work", async () => {
    const f = fixture(); f.connect();
    const requestId = randomUUID();
    const first = f.message(requestId);
    expect(f.message(requestId)).toEqual(first);
    expect(() => f.message(requestId, "changed")).toThrow("another message");
    expect(() => f.message()).toThrow("still working");
    await tick();
    expect(f.dispatched).toHaveLength(1);
    f.dispatched[0].update({ state: "working", messageId: "message" });
    f.dispatched[0].update({ state: "completed", reply: "x".repeat(17000) });
    expect(f.message(requestId).turn?.reply).toHaveLength(16000);
    f.message(); await tick();
    expect(f.dispatched).toHaveLength(2);
    expect(f.message(requestId).turn?.requestId).toBe(requestId);
    expect(f.dispatched).toHaveLength(2);
  });
  it("unknown dispatch failure is sanitized and cannot be replayed or followed by new work", async () => {
    const f = fixture({ dispatch: () => { throw new Error("private-key-provider-error"); } }); f.connect();
    const requestId = randomUUID(); f.message(requestId); await tick();
    const receipt = f.message(requestId);
    expect(receipt.turn?.state).toBe("uncertain");
    expect(JSON.stringify(receipt)).not.toContain("private-key");
    expect(() => f.message()).toThrow("unknown");
    expect(f.dispatched).toHaveLength(1);
  });
  it("an explicit pre-dispatch failure permits a new explicit message without replaying the failed one", async () => {
    const f = fixture({ dispatch: (input) => input.update({ state: "failed", error: "private detail" }) }); f.connect();
    const id = randomUUID(); f.message(id); await tick();
    expect(f.message(id).turn?.state).toBe("failed");
    f.message(); await tick();
    expect(f.dispatched).toHaveLength(2);
  });
});

describe("foreground call cancellation and expiry", () => {
  it("invalidates before exact cancellation and ignores late provider events", async () => {
    let release: () => void = () => {};
    let cancels = 0;
    const f = fixture({ dispatch: (input) => input.setCancel(async () => {
      cancels++; expect(input.isValid()).toBe(false);
      await new Promise<void>((resolve) => { release = resolve; });
    }) }); f.connect(); f.message(); await tick();
    const ending = f.registry.end(scope, f.id); await tick();
    f.dispatched[0].update({ state: "completed", reply: "late" });
    expect(f.registry.get(scope, f.id).turn?.state).toBe("uncertain");
    release(); const ended = await ending;
    expect(ended.turn?.state).toBe("cancelled");
    expect(ended.turn?.reply).toBeUndefined();
    await f.registry.end(scope, f.id);
    expect(cancels).toBe(1);
  });
  it("late cancellation registration stops only the captured turn and never resurrects call", async () => {
    const f = fixture(); f.connect(); f.message(); await tick();
    await f.registry.end(scope, f.id);
    let oldTurnStops = 0;
    let newerTurnStops = 0;
    f.dispatched[0].setCancel(() => { oldTurnStops++; });
    f.dispatched[0].setCancel(() => { newerTurnStops++; });
    await tick();
    expect(oldTurnStops).toBe(1);
    expect(newerTurnStops).toBe(0);
    expect(f.registry.get(scope, f.id).state).toBe("ended");
  });
  it("cancellation failure stays uncertain and reports only a generic error", async () => {
    const f = fixture({ dispatch: (input) => input.setCancel(() => { throw new Error("private transport"); }) });
    f.connect(); f.message(); await tick();
    await expect(f.registry.end(scope, f.id)).rejects.toThrow("could not be confirmed");
    expect(f.registry.get(scope, f.id).turn?.state).toBe("uncertain");
    await expect(f.registry.end(scope, f.id)).rejects.toThrow("could not be confirmed");
  });
  it("reads renew live lease; expired calls end and cancel without being revived", async () => {
    let cancels = 0;
    const f = fixture({ dispatch: (input) => input.setCancel(() => { cancels++; }) }); f.connect(); f.message(); await tick();
    f.advance(44_000); const read = f.registry.get(scope, f.id);
    expect(read.expiresAt).toBe(90_000);
    f.advance(44_000); await f.registry.sweep();
    expect(cancels).toBe(0);
    f.advance(1001); await f.registry.sweep(); await tick();
    const ended = f.registry.get(scope, f.id);
    expect(ended.state).toBe("ended");
    expect(ended.endReason).toContain("expired");
    expect(cancels).toBe(1);
    expect(() => f.registry.accept(scope, f.id)).toThrow("ended");
  });
  it("guard expires dispatch setup at the lease boundary", async () => {
    const f = fixture(); f.connect(); f.message(); await tick(); f.advance(45_000);
    expect(f.dispatched[0].isValid()).toBe(false);
    f.dispatched[0].update({ state: "working" });
    expect(f.registry.get(scope, f.id).state).toBe("ended");
  });
  it("bounds tombstones and refuses eviction of active calls", async () => {
    const f = fixture({ maxCalls: 1 }); f.ring();
    const second = randomUUID();
    expect(() => f.registry.ring(scope, { requestId: second, threadId: "thread" })).toThrow("Too many active");
    await f.registry.end(scope, f.id);
    f.registry.ring(scope, { requestId: second, threadId: "thread" });
    expect(() => f.registry.get(scope, f.id)).toThrow("not found");
    await f.registry.end(scope, second);
    f.advance(300_000); await f.registry.sweep();
    expect(() => f.registry.get(scope, second)).toThrow("not found");
  });
});

it("internal peek checks scope and expiry without renewing the foreground lease", () => {
  const f = fixture();
  const initial = f.connect();
  f.advance(44_000);
  expect(f.registry.peek(scope, f.id).expiresAt).toBe(initial.expiresAt);
  expect(f.registry.peek(scope, f.id).revision).toBe(initial.revision);
  expect(() => f.registry.peek({ ...scope, token: "b".repeat(64) }, f.id)).toThrow("Call not found");
  f.advance(1000);
  expect(f.registry.peek(scope, f.id).state).toBe("ended");
  expect(f.registry.get(scope, f.id).expiresAt).toBe(initial.expiresAt);
});
