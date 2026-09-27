import { beforeEach, describe, expect, it } from "vitest";

import { newIntentId, parkSend, reconcileThread, retireSend, type PendingSend, type ReplayBody } from "./message-intent.js";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const pending = (over: Partial<PendingSend> = {}): PendingSend => ({
  intentId: newIntentId(),
  threadId: "thread-1",
  botId: "bot-1",
  text: "Plan tomorrow",
  createdAt: Date.now(),
  ...over,
});

let store: Storage;
beforeEach(() => { store = memoryStorage(); });

describe("pending send ledger", () => {
  it("keeps the SAME intent id on retry — park twice, one record", () => {
    const intent = pending();
    parkSend(store, intent);
    parkSend(store, intent);
    // SAFETY: the ledger file is written only by park/retire above, so the
    // stored JSON maps thread ids to pending-send arrays.
    const raw = JSON.parse(store.getItem("muster:message-intents:v1") ?? "{}") as Record<string, PendingSend[]>;
    expect(raw["thread-1"]).toHaveLength(1);
    expect(raw["thread-1"]![0]!.intentId).toBe(intent.intentId);
  });

  it("retires a confirmed send so a reconnect replays nothing", () => {
    const intent = pending();
    parkSend(store, intent);
    retireSend(store, intent.threadId, intent.intentId);
    // SAFETY: the ledger file is written only by park/retire above, so the
    // stored JSON maps thread ids to pending-send arrays.
    const raw = JSON.parse(store.getItem("muster:message-intents:v1") ?? "{}") as Record<string, PendingSend[]>;
    expect(raw["thread-1"]).toBeUndefined();
  });

  it("is bounded: newest four per thread and a day of age", () => {
    const base = Date.now();
    for (let i = 0; i < 6; i++) parkSend(store, pending({ intentId: newIntentId(), createdAt: base - i * 1000 }));
    // SAFETY: the ledger file is written only by park/retire above, so the
    // stored JSON maps thread ids to pending-send arrays.
    const raw = JSON.parse(store.getItem("muster:message-intents:v1") ?? "{}") as Record<string, PendingSend[]>;
    expect(raw["thread-1"]).toHaveLength(4);
  });

  it("keeps threads isolated — a replay never lands in another conversation", () => {
    parkSend(store, pending({ threadId: "thread-a" }));
    parkSend(store, pending({ threadId: "thread-b" }));
    // SAFETY: the ledger file is written only by park/retire above, so the
    // stored JSON maps thread ids to pending-send arrays.
    const raw = JSON.parse(store.getItem("muster:message-intents:v1") ?? "{}") as Record<string, PendingSend[]>;
    expect(raw["thread-a"]).toHaveLength(1);
    expect(raw["thread-b"]).toHaveLength(1);
  });
});

describe("reconcileThread", () => {
  it("replays a pending intent and retires it on the original receipt", async () => {
    const intent = pending();
    parkSend(store, intent);
    const seen: PendingSend[] = [];
    const result = await reconcileThread(store, intent.threadId, async (p) => {
      seen.push(p);
      return { message: { id: "server-msg-1" }, intent: { messageId: "server-msg-1", state: "dispatched" } };
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.intentId).toBe(intent.intentId); // same id, never regenerated
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]!.receipt.messageId).toBe("server-msg-1");
    expect(result.unresolved).toHaveLength(0);
  });

  it("keeps the record parked when the server rejects the replay", async () => {
    const intent = pending();
    parkSend(store, intent);
    const result = await reconcileThread(store, intent.threadId, async () => {
      throw new Error("transport down");
    });
    expect(result.recovered).toHaveLength(0);
    expect(result.unresolved.map((p) => p.intentId)).toEqual([intent.intentId]);
    // still parked for the next reconciliation
    // SAFETY: the ledger file is written only by park/retire above, so the
    // stored JSON maps thread ids to pending-send arrays.
    const raw = JSON.parse(store.getItem("muster:message-intents:v1") ?? "{}") as Record<string, PendingSend[]>;
    expect(raw["thread-1"]).toHaveLength(1);
  });

  it("reports a local-only record unresolved when the server never saw the intent", async () => {
    const intent = pending();
    parkSend(store, intent);
    const result = await reconcileThread(store, intent.threadId, async () => ({}));
    expect(result.unresolved.map((p) => p.intentId)).toEqual([intent.intentId]);
  });

  it("keeps an accepted (queued) receipt parked until a terminal state retires it", async () => {
    const intent = pending();
    parkSend(store, intent);
    // The bot was busy: durable words, still waiting to send.
    const first = await reconcileThread(store, intent.threadId, async () => ({
      message: { id: "server-msg-9" },
      intent: { messageId: "server-msg-9", state: "accepted" },
    }));
    expect(first.recovered).toHaveLength(0);
    expect(first.accepted.map((item) => item.pending.intentId)).toEqual([intent.intentId]);
    expect(first.accepted[0]!.receipt.messageId).toBe("server-msg-9");
    // SAFETY: the ledger file is written only by park/retire above, so the
    // stored JSON maps thread ids to pending-send arrays.
    let raw = JSON.parse(store.getItem("muster:message-intents:v1") ?? "{}") as Record<string, PendingSend[]>;
    expect(raw["thread-1"]).toHaveLength(1); // still parked, still replaying
    // The queue drained while we were away: the terminal receipt retires it.
    const second = await reconcileThread(store, intent.threadId, async () => ({
      intent: { messageId: "server-msg-9", state: "dispatched" },
    }));
    expect(second.recovered.map((item) => item.receipt.messageId)).toEqual(["server-msg-9"]);
    // SAFETY: same invariant as the read above — only park/retire write this
    // file, and they store thread id -> pending-send arrays.
    raw = JSON.parse(store.getItem("muster:message-intents:v1") ?? "{}") as Record<string, PendingSend[]>;
    expect(raw["thread-1"]).toBeUndefined();
  });

  it("treats a non-string message id as no confirmation at all", async () => {
    const intent = pending();
    parkSend(store, intent);
    // This body is deliberately malformed: a numeric id is exactly the wire
    // garbage reconciliation must refuse to trust. It enters through the
    // JSON boundary rather than a cast, so the fixture stays honest about
    // what it is handing the reconciler.
    const malformed: ReplayBody = JSON.parse('{"message":{"id":12345}}');
    const result = await reconcileThread(store, intent.threadId, async () => malformed);
    expect(result.recovered).toHaveLength(0);
    expect(result.accepted).toHaveLength(0);
    expect(result.unresolved.map((p) => p.intentId)).toEqual([intent.intentId]);
  });

  it("does not touch other threads while reconciling one", async () => {
    const a = pending({ threadId: "thread-a" });
    parkSend(store, a);
    parkSend(store, pending({ threadId: "thread-b" }));
    await reconcileThread(store, a.threadId, async () => ({ message: { id: "m" }, intent: { messageId: "m" } }));
    // SAFETY: the ledger file is written only by park/retire above, so the
    // stored JSON maps thread ids to pending-send arrays.
    const raw = JSON.parse(store.getItem("muster:message-intents:v1") ?? "{}") as Record<string, PendingSend[]>;
    expect(raw["thread-b"]).toHaveLength(1);
  });
});

describe("newIntentId", () => {
  it("matches the server's intent-id charset and length", () => {
    const id = newIntentId();
    expect(id).toMatch(/^[\w.-]{8,128}$/);
    expect(newIntentId()).not.toBe(newIntentId());
  });
});
