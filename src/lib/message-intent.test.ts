import { beforeEach, describe, expect, it } from "vitest";

import { allPendingSends, newIntentId, parkSend, receiptThreadId, reconcileThread, retireSend, type PendingSend, type ReplayBody } from "./message-intent.js";

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
  it("replays a pending intent, reports the RECEIPT's destination, and retires it", async () => {
    const intent = pending();
    parkSend(store, intent);
    const seen: Array<[PendingSend, boolean]> = [];
    const receipts: Array<{ messageId: string; threadId: string; state: string }> = [];
    const parked = await reconcileThread(
      store,
      intent.threadId,
      async (p, lookup) => {
        seen.push([p, lookup]);
        // The record was parked under a thread that has since moved on:
        // the receipt answers where the words ACTUALLY went.
        return { message: { id: "server-msg-1" }, intent: { messageId: "server-msg-1", threadId: "thread-moved", state: "dispatched" } };
      },
      (item) => receipts.push(item.receipt),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]!.intentId).toBe(intent.intentId); // same id, never regenerated
    expect(seen[0]![1]).toBe(true); // the replay is a LOOKUP, never a send
    expect(parked).toHaveLength(0); // terminal receipt retires the record
    expect(receipts).toEqual([{ messageId: "server-msg-1", threadId: "thread-moved", state: "dispatched" }]);
  });

  it("keeps the record parked when the server rejects the replay", async () => {
    const intent = pending();
    parkSend(store, intent);
    const parked = await reconcileThread(store, intent.threadId, async () => {
      throw new Error("transport down");
    });
    expect(parked.map((p) => p.intentId)).toEqual([intent.intentId]);
    // still parked for the next reconciliation
    // SAFETY: the ledger file is written only by park/retire above, so the
    // stored JSON maps thread ids to pending-send arrays.
    const raw = JSON.parse(store.getItem("muster:message-intents:v1") ?? "{}") as Record<string, PendingSend[]>;
    expect(raw["thread-1"]).toHaveLength(1);
  });

  it("reports a local-only record unresolved when the server never saw the intent", async () => {
    const intent = pending();
    parkSend(store, intent);
    const parked = await reconcileThread(store, intent.threadId, async () => ({}));
    expect(parked.map((p) => p.intentId)).toEqual([intent.intentId]);
  });

  it("keeps an accepted (queued) receipt parked until a terminal state retires it", async () => {
    const intent = pending();
    parkSend(store, intent);
    // The bot was busy: durable words, still waiting to send.
    const accepted: Array<{ pending: PendingSend; receipt: { messageId: string; threadId: string; state: string } }> = [];
    await reconcileThread(store, intent.threadId, async () => ({
      message: { id: "server-msg-9" },
      intent: { messageId: "server-msg-9", state: "accepted" },
    }), (item) => accepted.push(item));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.receipt.messageId).toBe("server-msg-9");
    // SAFETY: the ledger file is written only by park/retire above, so the
    // stored JSON maps thread ids to pending-send arrays.
    let raw = JSON.parse(store.getItem("muster:message-intents:v1") ?? "{}") as Record<string, PendingSend[]>;
    expect(raw["thread-1"]).toHaveLength(1); // still parked, still replaying
    // The queue drained while we were away: the terminal receipt retires it.
    const secondReceipts: Array<{ messageId: string; threadId: string; state: string }> = [];
    const second = await reconcileThread(store, intent.threadId, async () => ({
      intent: { messageId: "server-msg-9", state: "dispatched" },
    }), (item) => secondReceipts.push(item.receipt));
    expect(second).toHaveLength(0); // retired
    // No receipt destination means the record's own thread — the fallback.
    expect(secondReceipts).toEqual([{ messageId: "server-msg-9", threadId: "thread-1", state: "dispatched" }]);
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
    const parked = await reconcileThread(store, intent.threadId, async () => malformed);
    expect(parked.map((p) => p.intentId)).toEqual([intent.intentId]);
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

describe("account-scoped pending sweep (W0)", () => {
  it("replays only the current account's records across a shared storage", () => {
    const mine = pending({ intentId: newIntentId(), threadId: "thread-a", accountId: "acct-me" });
    const theirs = pending({ intentId: newIntentId(), threadId: "thread-b", accountId: "acct-other" });
    const legacy = pending({ intentId: newIntentId(), threadId: "thread-c" });
    delete legacy.accountId; // the pre-W0 record shape: no account stamp at all
    parkSend(store, mine);
    parkSend(store, theirs);
    parkSend(store, legacy);
    const sweep = allPendingSends(store, "acct-me");
    expect(sweep.map((entry) => entry.intentId)).toEqual([mine.intentId]);
    // The other account's record is untouched — still parked, still there.
    // SAFETY: the ledger file is written only by park/retire above, so the
    // stored JSON maps thread ids to pending-send arrays.
    const raw = JSON.parse(store.getItem("muster:message-intents:v1") ?? "{}") as Record<string, PendingSend[]>;
    expect(raw["thread-b"]).toHaveLength(1);
    // Without an account filter (single-user desktop) everything sweeps.
    expect(allPendingSends(store)).toHaveLength(3);
  });
});

describe("newIntentId", () => {
  it("matches the server's intent-id charset and length", () => {
    const id = newIntentId();
    expect(id).toMatch(/^[\w.-]{8,128}$/);
    expect(newIntentId()).not.toBe(newIntentId());
  });
});

describe("reconciliation eligibility at the request boundary", () => {
  it("queries an accepted row without querying or retiring an active send in the same thread", async () => {
    const older = pending({ intentId: "accepted-A", accountId: "owner" });
    const active = pending({ intentId: "active-B", accountId: "owner" });
    parkSend(store, older);
    parkSend(store, active);
    const inFlight = new Set([active.intentId]);
    const lookedUp: string[] = [];
    const folded: string[] = [];
    const unresolved = await reconcileThread(store, older.threadId, async (record, lookup) => {
      expect(lookup).toBe(true);
      lookedUp.push(record.intentId);
      return { intent: { messageId: "older-message", threadId: older.threadId, state: "accepted" } };
    }, item => folded.push(item.pending.intentId), record => !inFlight.has(record.intentId));
    expect(lookedUp).toEqual([older.intentId]);
    expect(folded).toEqual([older.intentId]);
    expect(unresolved).toEqual([]);
    expect(allPendingSends(store)).toEqual([older, active]);
  });

  it("keeps foreign and unstamped rows untouched even when the thread has an eligible account row", async () => {
    const mine = pending({ intentId: "mine", accountId: "owner" });
    const foreign = pending({ intentId: "foreign", accountId: "another-owner" });
    const legacy = pending({ intentId: "legacy" });
    for (const record of [mine, foreign, legacy]) parkSend(store, record);
    const lookedUp: string[] = [];
    await reconcileThread(store, mine.threadId, async record => {
      lookedUp.push(record.intentId);
      return { intent: { messageId: "owned-message", threadId: mine.threadId, state: "dispatched" } };
    }, undefined, record => record.accountId === "owner");
    expect(lookedUp).toEqual([mine.intentId]);
    expect(allPendingSends(store)).toEqual([foreign, legacy]);
  });

  it("rechecks eligibility after a preceding asynchronous lookup instead of capturing a stale set", async () => {
    const first = pending({ intentId: "first", accountId: "owner" });
    const second = pending({ intentId: "second", accountId: "owner" });
    parkSend(store, first);
    parkSend(store, second);
    const inFlight = new Set<string>();
    let releaseFirst: (response: ReplayBody) => void = () => { throw new Error("Deferred response was not initialized"); };
    const firstResponse = new Promise<ReplayBody>(resolve => { releaseFirst = resolve; });
    const lookedUp: string[] = [];
    const sweep = reconcileThread(store, first.threadId, async record => {
      lookedUp.push(record.intentId);
      return firstResponse;
    }, undefined, record => !inFlight.has(record.intentId));
    expect(lookedUp).toEqual([first.intentId]);
    inFlight.add(second.intentId);
    releaseFirst({ intent: { messageId: "first-message", state: "dispatched" } });
    await sweep;
    expect(lookedUp).toEqual([first.intentId]);
    expect(allPendingSends(store)).toEqual([second]);
  });

  it("can reconcile a previously skipped record on the next sweep with its original id and receipt destination", async () => {
    const record = pending({ accountId: "owner" });
    parkSend(store, record);
    let eligible = false;
    const seen: Array<[string, boolean]> = [];
    const destinations: string[] = [];
    const send = async (current: PendingSend, lookup: boolean): Promise<ReplayBody> => {
      seen.push([current.intentId, lookup]);
      return { intent: { messageId: "original-message", threadId: "original-destination", state: "dispatched" } };
    };
    await reconcileThread(store, record.threadId, send, item => destinations.push(item.receipt.threadId), () => eligible);
    expect(seen).toEqual([]);
    expect(allPendingSends(store)).toEqual([record]);
    eligible = true;
    await reconcileThread(store, record.threadId, send, item => destinations.push(item.receipt.threadId), () => eligible);
    expect(seen).toEqual([[record.intentId, true]]);
    expect(destinations).toEqual(["original-destination"]);
    expect(allPendingSends(store)).toEqual([]);
  });
});

describe("receipt destination", () => {
  it("uses the admitted destination even when the current conversation changes", () => {
    expect(receiptThreadId({ intent: { threadId: "admitted-thread" } }, "captured-thread"))
      .toBe("admitted-thread");
  });

  it.each([
    "{}",
    '{"intent":{}}',
    '{"intent":{"threadId":""}}',
    '{"intent":{"threadId":"  "}}',
    '{"intent":{"threadId":42}}',
    '{"intent":{"threadId":null}}',
    '{"intent":{"threadId":{"id":"another-thread"}}}',
    '{"intent":{"threadId":{"toString":"not-a-function"}}}',
  ])("keeps the captured destination for an older or malformed reply: %s", encoded => {
    expect(receiptThreadId(JSON.parse(encoded), "captured-thread")).toBe("captured-thread");
  });
});
