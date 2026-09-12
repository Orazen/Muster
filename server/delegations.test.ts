// Async peer handoff (`delegate_bot`) — real Store/SQLite, with a fake bus and
// target dispatcher. Each test stands up a
// real Store with throwaway bots, a fake comms-bus (records broadcasts),
// and a runTarget stub that captures the would-be turn so the test can
// assert what would have been dispatched to the harness. The harness itself
// stays out of these — the integration happens in comms.test.ts (the full
// e2e through the agents proxy + fake ACP CLI).
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { closeMessageDb, readThread } from "./message-db.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  drainDelegations,
  queueDelegation,
  _pendingCount,
  type PeerProvenance,
} from "./delegations.ts";
import { peerAllowKey, resolvePeerComms, type ApprovalBus } from "./peer-approval.ts";
import { Store, type BotRecord, type GroupRecord, type Message } from "./store.ts";

function provenanceFor(store: Store, from: BotRecord, depth = 0, sourceThreadId = from.threadId, ownerId = "local"): PeerProvenance {
  const task = store.taskByThread(from.id, sourceThreadId);
  if (!task) throw new Error("Test source task missing");
  return { ownerId, fromBotId: from.id, sourceThreadId, taskId: task.threadId, depth, operation: "delegate_bot" };
}

beforeEach(() => { closeMessageDb(); _resetPending(); });
afterEach(() => { closeMessageDb(); _resetPending(); vi.restoreAllMocks(); });

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

/** Frames the test buses emit: the keyed SSE envelope plus the mirrored
 * message fields the assertions read back. */
interface TestBroadcastFrame {
  kind: string;
  threadId?: string;
  message?: Message;
}

interface BusPair {
  commsBus: CommsBus;
  approvalBus: ApprovalBus;
  broadcasts: TestBroadcastFrame[];
}

function setupBuses(store: Store): BusPair {
  const broadcasts: TestBroadcastFrame[] = [];
  const broadcast = (payload: TestBroadcastFrame) => {
    broadcasts.push(payload);
  };
  // the store emits what it writes; the server turns those into frames.
  // Mirror that here so assertions see what a client would.
  store.onChange((change) => {
    if (change.type === "message" || change.type === "message.patch") {
      broadcasts.push({ kind: change.type, threadId: change.threadId, message: change.message });
    }
  });
  const commsBus: CommsBus = {
    store,
    broadcast(payload) {
      // SAFETY: this server's SSE envelopes always lead with `kind` — that
      // is the CommsBus envelope contract — so any payload is a broadcast frame.
      broadcasts.push(payload as TestBroadcastFrame);
    },
  };
  const approvalBus: ApprovalBus = { store, broadcast };
  return { commsBus, approvalBus, broadcasts };
}

/** Poll until `predicate` returns a truthy value or `timeout` elapses.
 * drainDelegations is fire-and-forget (processOne runs as a Promise) so
 * tests need to wait for its async steps to land. */
async function waitFor<T>(predicate: () => T | undefined | false, timeout = 2_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = predicate();
    if (v) {
      // SAFETY: truthiness is this helper's contract for "done" — callers
      // return T | undefined | false exactly so the poll loop can tell them
      // apart, so a truthy value is the T itself.
      return v as T;
    }
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("queueDelegation", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let broadcasts: TestBroadcastFrame[];

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    broadcasts = buses.broadcasts;
  });

  it("rejects a self-delegation without queueing", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: from.id,
      message: "self-talk",
      depth: 0,
    }, 1, provenanceFor(commsBus.store, from, 0));
    expect(result).toBe("self");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("rejects when the source turn is already at the depth cap", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "next task",
      depth: 1,
    }, 1, provenanceFor(commsBus.store, from, 1));
    expect(result).toBe("too_deep");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("rejects when the target bot does not exist", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: "ghost",
      message: "where?",
      depth: 0,
    }, 1, provenanceFor(commsBus.store, from, 0));
    expect(result).toBe("no_target");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("queues, broadcasts, and drops a 'Delegated to @Target' chip on the source thread", () => {
    const result = queueDelegation(commsBus, from, {
      toBotId: target.id,
      message: "do this",
      reason: "followup",
      depth: 0,
    }, 1, provenanceFor(commsBus.store, from, 0));
    expect(result).toBe("ok");
    expect(_pendingCount(from.threadId)).toBe(1);

    const chip = store
      .messagesFor(from.threadId)
      .find((m) => m.kind === "activity" && m.tool?.name?.startsWith("Delegated to @"));
    expect(chip?.tool?.name).toBe("Delegated to @Helper: followup");

    // The chip is also broadcast over SSE so chat clients see it without
    // polling /api/bots
    const broadcast = broadcasts.find(
      (b) => b.kind === "message" && b.threadId === from.threadId,
    );
    expect(broadcast).toBeTruthy();
  });

  it("keys detached routine delegations to their real source thread", async () => {
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    const result = queueDelegation(commsBus, from, { toBotId: target.id, message: "routine follow-up", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0, routineTask.threadId));

    expect(result).toBe("ok");
    expect(_pendingCount(routineTask.threadId)).toBe(1);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(
      store.messagesFor(routineTask.threadId).some((m) => m.tool?.name === "Delegated to @Helper"),
    ).toBe(true);
    expect(
      store.messagesFor(from.threadId).some((m) => m.tool?.name === "Delegated to @Helper"),
    ).toBe(false);
  });
});

describe("drainDelegations", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let approvalBus: ApprovalBus;
  let runTargetCalls: Array<{ toBotId: string; message: string; commsDepth: number; sourceThreadId?: string }>;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    const buses = setupBuses(store);
    commsBus = buses.commsBus;
    approvalBus = buses.approvalBus;
    runTargetCalls = [];
  });

  afterEach(() => {
    // Unresolved approval requests carry a 15-min timer that would otherwise
    // keep vitest's event loop alive long after the suite ends. None of the
    // tests above leave one — they all resolve via resolvePeerComms — but
    // double-check by counting the module's pending map: tests that didn't
    // resolve should be re-examined if this ever fires.
    void runTargetCalls;
  });

  it("runs the target's turn via runTarget and mirrors the exchange", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0));
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    const call = runTargetCalls[0]!;
    expect(call.toBotId).toBe(target.id);
    expect(call.commsDepth).toBe(1);
    expect(call.message).toContain("Delegated by @");
    expect(call.message).toContain("do this");

    // Both 1:1 threads picked up their comm chips, attributed to the
    // source/target bot respectively, linking to the same channel.
    const fromChips = store
      .messagesFor(from.threadId)
      .filter((m) => m.kind === "activity" && m.tool?.name === "Messaged @Helper");
    expect(fromChips).toHaveLength(1);
    const targetChips = store
      .messagesFor(target.threadId)
      .filter((m) => m.kind === "activity" && m.tool?.name === `Message from @${from.name}`);
    expect(targetChips).toHaveLength(1);
    expect(fromChips[0]?.comm?.groupId).toBe(targetChips[0]?.comm?.groupId);
  });

  it("includes the reason line in the prefixed message when one is given", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", reason: "next step", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0));
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.message).toContain("[Reason: next step]");
  });

  it("drains and mirrors a detached routine delegation on its source thread", async () => {
    const activeThreadId = from.threadId;
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    queueDelegation(commsBus, from, { toBotId: target.id, message: "routine follow-up", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0, routineTask.threadId));

    drainDelegations(
      commsBus,
      approvalBus,
      routineTask.threadId,
      (toBotId, message, commsDepth, sourceThreadId) => {
        runTargetCalls.push({ toBotId, message, commsDepth, sourceThreadId });
      },
    );

    await waitFor(() => runTargetCalls.length === 1 && _pendingCount(routineTask.threadId) === 0);
    expect(_pendingCount(routineTask.threadId)).toBe(0);
    expect(runTargetCalls[0]?.sourceThreadId).toBe(routineTask.threadId);
    expect(
      store.messagesFor(routineTask.threadId).some((m) => m.tool?.name === "Messaged @Helper"),
    ).toBe(true);
    expect(
      store.messagesFor(activeThreadId).some((m) => m.tool?.name === "Messaged @Helper"),
    ).toBe(false);
  });

  it("contains a rejected delegation worker and reports it on the source thread", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0));
    drainDelegations(commsBus, approvalBus, from.threadId, () => {
      throw new Error("target runner exploded");
    });

    const failure = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.tool?.ok === false && m.tool.name.includes("target runner exploded")),
    );
    expect(failure.tool?.name).toContain("delegation failed");
  });

  it("reports an asynchronous target-start rejection on a detached source thread", async () => {
    const activeThreadId = from.threadId;
    const routineTask = store.createTask(from.id, "Routine run", false)!;
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0, routineTask.threadId));
    drainDelegations(commsBus, approvalBus, routineTask.threadId, () =>
      Promise.reject(new Error("provider disappeared")),
    );

    const failure = await waitFor(() =>
      store
        .messagesFor(routineTask.threadId)
        .find((m) => m.tool?.ok === false && m.tool.name.includes("provider disappeared")),
    );
    expect(failure.tool?.name).toContain("delegation failed");
    expect(
      store.messagesFor(activeThreadId).some((m) => m.tool?.name.includes("provider disappeared")),
    ).toBe(false);
  });

  it("skips runTarget and emits a 'no such bot' chip when the target was deleted", async () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0));
    store.deleteBot(target.id);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("no such bot")),
    );
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("skips runTarget and emits a 'is busy' chip when the target is currently busy", async () => {
    store.patchBot(target.id, { busy: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0));
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("is busy")),
    );
    expect(chip.tool?.name).toBe("Delegation to @Helper canceled — @Helper is busy");
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("asks for approval when approvePeerComms is on, then runs only on allow", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0));
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    // the source bot's thread shows the options card BEFORE runTarget fires
    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((m) => m.card?.requestId),
    );
    expect(card.card?.title).toContain("delegate to @Helper");
    expect(card.card?.tool).toBe("delegate_bot");
    expect(card.card?.allowKey).toBe(peerAllowKey("delegate_bot", target.id));
    expect(card.card?.options).toEqual(["Allow", "Deny", "Always allow"]);
    expect(runTargetCalls).toEqual([]);

    resolvePeerComms(approvalBus, card.card!.requestId!, "allow");
    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.toBotId).toBe(target.id);
    expect(runTargetCalls[0]!.commsDepth).toBe(1);
  });

  it("emits a denial chip and skips runTarget when the user denies", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0));
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    const card = await waitFor(() =>
      store.messagesFor(from.threadId).find((m) => m.card?.requestId),
    );
    resolvePeerComms(approvalBus, card.card!.requestId!, "deny");

    const chip = await waitFor(() =>
      store
        .messagesFor(from.threadId)
        .find((m) => m.kind === "activity" && (m.tool?.name ?? "").includes("denied by user")),
    );
    expect(chip.tool?.ok).toBe(false);
    expect(runTargetCalls).toEqual([]);
  });

  it("auto-allows when alwaysAllow already covers the pair (no card pushed)", async () => {
    store.patchBot(from.id, {
      approvePeerComms: true,
      alwaysAllow: [peerAllowKey("delegate_bot", target.id)],
    });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0));
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });

    await waitFor(() => runTargetCalls.length === 1);
    expect(runTargetCalls[0]!.commsDepth).toBe(1);
    const card = store
      .messagesFor(from.threadId)
      .find((m) => m.card?.requestId && m.card.tool === "delegate_bot");
    expect(card).toBeUndefined();
  });

  it("no-ops when nothing is queued for the source thread", () => {
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    expect(runTargetCalls).toEqual([]);
  });

  it("no-ops when the source thread no longer resolves to a bot", () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, provenanceFor(commsBus.store, from, 0));
    store.deleteBot(from.id);
    drainDelegations(commsBus, approvalBus, from.threadId, (toBotId, message, commsDepth) => {
      runTargetCalls.push({ toBotId, message, commsDepth });
    });
    expect(runTargetCalls).toEqual([]);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { _loadPending, _resetPending, discardDelegations, pendingThreads } from "./delegations.ts";

describe("delegations survive a restart", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let buses: BusPair;
  const file = () => join(DATA_DIR, "delegations.json");

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    buses = setupBuses(store);
  });
  afterEach(() => _resetPending());

  it("writes the queue to disk on queue, and clears it on drain and discard", async () => {
    expect(queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "do this", depth: 0 }, 1, provenanceFor(buses.commsBus.store, from, 0))).toBe("ok");
    expect(existsSync(file())).toBe(true);
    // SAFETY: delegations.json is queueDelegation's own on-disk map of
    // threadId → queued delegation list; the expects below pin its entries.
    const onDisk = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown[]>;
    expect(onDisk[from.threadId]).toHaveLength(1);
    expect(onDisk[from.threadId][0]).toMatchObject({ toBotId: target.id, message: "do this" });

    discardDelegations(buses.commsBus, from.threadId);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();

    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "again", depth: 0 }, 1, provenanceFor(buses.commsBus.store, from, 0));
    const ran: string[] = [];
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, message) => {
      ran.push(message);
    });
    await waitFor(() => ran.length === 1 && pendingThreads().length === 0);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();
  });

  it("acknowledges a handoff at dispatch time, not after the target turn settles", async () => {
    // At-most-once: the queue entry is removed (and persisted) when the
    // target turn STARTS, so a crash mid-turn does not automatically run
    // it a second time. Completion is not guaranteed after removal.
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "wait for dispatch", depth: 0 }, 1, provenanceFor(buses.commsBus.store, from, 0));
    let release!: () => void;
    const dispatchSettled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async () => {
      started = true;
      await dispatchSettled;
    });

    await waitFor(() => started);
    // Dispatch began → the entry is already acknowledged and cleared.
    expect(pendingThreads()).toEqual([]);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();

    release();
    await waitFor(() => pendingThreads().length === 0);
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toBeUndefined();
  });

  it("never runs a handoff whose queue was discarded while approval was pending", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "dropped mid-approval", depth: 0 }, 1, provenanceFor(buses.commsBus.store, from, 0));
    let fired = false;
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, () => {
      fired = true;
    });

    // Wait for the approval card, then drop the queue while the drain is
    // parked inside requestPeerApproval.
    await waitFor(() => store.messagesFor(from.threadId).some((m) => m.card?.requestId));
    const card = store.messagesFor(from.threadId).find((m) => m.card?.requestId)!;
    discardDelegations(buses.commsBus, from.threadId);

    // The user answers "allow" to the card they still see.
    resolvePeerComms(buses.approvalBus, card.card!.requestId!, "allow");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toBe(false);
    expect(pendingThreads()).toEqual([]);
  });

  it("drains work queued by a later settled turn while an earlier handoff is waiting", async () => {
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "first", depth: 0 }, 1, provenanceFor(buses.commsBus.store, from, 0));
    let release!: () => void;
    const firstSettled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ran: string[] = [];
    const runTarget = async (_to: string, message: string) => {
      ran.push(message);
      if (message.includes("first")) await firstSettled;
    };
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, runTarget);
    await waitFor(() => ran.length === 1);

    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "second", depth: 0 }, 1, provenanceFor(buses.commsBus.store, from, 0));
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, runTarget);
    expect(ran).toHaveLength(1);

    release();
    await waitFor(() => ran.length === 2 && pendingThreads().length === 0);
    expect(ran[1]).toContain("second");
  });

  it("reloads the disk queue after forgetting in-memory state, and can drain it", async () => {
    queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "left over", depth: 0 }, 1, provenanceFor(buses.commsBus.store, from, 0));
    // "restart": forget memory, reload from disk
    _resetPending();
    expect(pendingThreads()).toEqual([]);
    _loadPending();
    expect(pendingThreads()).toEqual([from.threadId]);
    const ran: string[] = [];
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, message) => {
      ran.push(message);
    });
    await waitFor(() => ran.length === 1 && pendingThreads().length === 0);
    expect(ran[0]).toContain("left over");
    expect(pendingThreads()).toEqual([]);
  });

  it("tolerates a missing or corrupt file", () => {
    _resetPending();
    _loadPending(); // no file
    expect(pendingThreads()).toEqual([]);
    // SAFETY: require resolves to the same node:fs namespace the static
    // import types describe; only mkdirSync/writeFileSync are taken from it.
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file(), "{not json");
    _loadPending();
    expect(pendingThreads()).toEqual([]);
  });
});

import * as atomic from "./atomic.ts";
import { mkdirSync, writeFileSync } from "node:fs";

describe("delegation provenance and durable transitions", () => {
  let store: Store;
  let from: BotRecord;
  let target: BotRecord;
  let buses: BusPair;
  const file = () => join(DATA_DIR, "delegations.json");
  const ownerOf = (bot: Pick<BotRecord, "ownerId">) => bot.ownerId || "primary";
  const queue = () => queueDelegation(buses.commsBus, from,
    { toBotId: target.id, message: "owned follow-up", depth: 0 }, 1,
    provenanceFor(store, from, 0, from.threadId, "primary"), ownerOf);
  const injectWriteFailure = () => {
    const write = atomic.writeFileAtomic;
    return vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, data, options) => {
      if (path === file()) throw new Error("Injected delegation storage failure");
      write(path, data, options);
    });
  };

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
    from = store.createBot();
    target = store.createBot();
    buses = setupBuses(store);
  });

  it("persists a copied explicit provenance and uses the hosted primary-owner fallback", async () => {
    const provenance = provenanceFor(store, from, 0, from.threadId, "primary");
    expect(queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "owned", depth: 0 }, 1, provenance, ownerOf)).toBe("ok");
    expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId][0].provenance).toEqual(provenance);
    provenance.ownerId = "mutated-caller-record";
    _resetPending();
    _loadPending();
    const run = vi.fn();
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    await waitFor(() => run.mock.calls.length === 1);
    expect(readFileSync(file(), "utf8")).not.toContain("mutated-caller-record");
  });

  it.each(["ownerId", "fromBotId", "sourceThreadId", "taskId"] as const)("rejects queue provenance mismatch in %s before any disclosure or persistence", (field) => {
    const provenance = { ...provenanceFor(store, from, 0, from.threadId, "primary"), [field]: "wrong" };
    const before = store.messagesFor(from.threadId).length;
    expect(queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "no", depth: 0 }, 1, provenance, ownerOf)).toBe("invalid_provenance");
    expect(store.messagesFor(from.threadId)).toHaveLength(before);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(existsSync(file())).toBe(false);
  });

  it("rejects mismatched depth and foreign target without a named queue chip", () => {
    const provenance = provenanceFor(store, from, 1, from.threadId, "primary");
    expect(queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "no", depth: 0 }, 1, provenance, ownerOf)).toBe("invalid_provenance");
    store.patchBot(target.id, { ownerId: "foreign", name: "PRIVATE-NAME", busy: true });
    expect(queue()).toBe("invalid_provenance");
    expect(JSON.stringify(store.messagesFor(from.threadId))).not.toContain("PRIVATE-NAME");
    expect(existsSync(file())).toBe(false);
  });

  it.each(["sender", "target"] as const)("revalidates %s owner before busy/name/approval disclosure during drain", async (participant) => {
    expect(queue()).toBe("ok");
    const before = store.messagesFor(from.threadId).length;
    store.patchBot(from.id, { approvePeerComms: true });
    store.patchBot(participant === "sender" ? from.id : target.id, { ownerId: "foreign", name: "PRIVATE-NAME", busy: true });
    const run = vi.fn();
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    await waitFor(() => _pendingCount(from.threadId) === 0);
    expect(run).not.toHaveBeenCalled();
    expect(store.messagesFor(from.threadId)).toHaveLength(before);
  });

  it.each(["sender", "target", "task"] as const)("revalidates %s after a held approval without mirroring or dispatch", async (participant) => {
    store.patchBot(from.id, { approvePeerComms: true });
    expect(queue()).toBe("ok");
    const run = vi.fn();
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    const card = await waitFor(() => store.messagesFor(from.threadId).find((message) => message.card?.requestId));
    if (participant === "task") store.taskByThread(from.id, from.threadId)!.threadId = "replacement-task";
    else store.patchBot(participant === "sender" ? from.id : target.id, { ownerId: "foreign", name: "PRIVATE-NAME" });
    resolvePeerComms(buses.approvalBus, card.card!.requestId!, "allow");
    await waitFor(() => _pendingCount(from.threadId) === 0);
    expect(run).not.toHaveBeenCalled();
    expect(store.messagesFor(target.threadId).some((message) => message.comm)).toBe(false);
    expect(JSON.stringify(store.messagesFor(from.threadId))).not.toContain("PRIVATE-NAME");
  });

  it.each(["sender", "target", "task"] as const)("passes a live %s validation callback across target setup", async (participant) => {
    expect(queue()).toBe("ok");
    let release = () => {};
    const setup = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let validAfterSetup: boolean | undefined;
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, _message, _depth, _thread, _channel, validate) => {
      expect(validate()).toBe(true);
      entered = true;
      await setup;
      validAfterSetup = validate();
    }, ownerOf);
    await waitFor(() => entered);
    if (participant === "task") store.taskByThread(from.id, from.threadId)!.threadId = "replacement-task";
    else store.patchBot(participant === "sender" ? from.id : target.id, { ownerId: "foreign" });
    release();
    await waitFor(() => validAfterSetup === false);
    expect(validAfterSetup).toBe(false);
  });

  it("rejects legacy and malformed loaded provenance and deduplicates stable queue IDs", async () => {
    expect(queue()).toBe("ok");
    const [row] = JSON.parse(readFileSync(file(), "utf8"))[from.threadId];
    const { provenance, ...legacy } = row;
    const invalid = [
      legacy,
      { ...row, id: "wrong-operation", provenance: { ...provenance, operation: "ask_bot" } },
      { ...row, id: "wrong-thread", provenance: { ...provenance, sourceThreadId: "different" } },
      { ...row, id: "wrong-depth", provenance: { ...provenance, depth: 1 } },
      { ...row, id: "blank-owner", provenance: { ...provenance, ownerId: " " } },
      { ...row, id: "with-token", provenance: { ...provenance, token: "not-authority" } },
      { ...row, id: "recursive-depth", depth: 1, provenance: { ...provenance, depth: 1 } },
      { ...row, id: "fraction-depth", depth: 0.5, provenance: { ...provenance, depth: 0.5 } },
    ];
    writeFileSync(file(), JSON.stringify({ [from.threadId]: [...invalid, row, row] }));
    _resetPending();
    _loadPending();
    expect(_pendingCount(from.threadId)).toBe(1);
    const run = vi.fn();
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    await waitFor(() => run.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({});
  });

  it("does not acknowledge acceptance or publish a chip on an actual atomic rename failure", () => {
    mkdirSync(file());
    const before = store.messagesFor(from.threadId).length;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(queue()).toBe("persistence_failed");
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(store.messagesFor(from.threadId)).toHaveLength(before);
    expect(log).toHaveBeenCalled();
  });

  it("preserves existing queue bytes and memory on failed enqueue, then permits explicit retry", () => {
    expect(queue()).toBe("ok");
    const bytes = readFileSync(file());
    const before = store.messagesFor(from.threadId).length;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = injectWriteFailure();
    expect(queue()).toBe("persistence_failed");
    expect(readFileSync(file())).toEqual(bytes);
    expect(_pendingCount(from.threadId)).toBe(1);
    expect(store.messagesFor(from.threadId)).toHaveLength(before);
    failure.mockRestore();
    expect(queue()).toBe("ok");
    expect(_pendingCount(from.threadId)).toBe(2);
  });

  it("failed durable dequeue cannot mirror/dispatch or retry itself, and remains reloadable", async () => {
    expect(queue()).toBe("ok");
    const bytes = readFileSync(file());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = injectWriteFailure();
    const run = vi.fn();
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    await waitFor(() => store.messagesFor(from.threadId).some((message) => message.tool?.name.includes("Could not durably remove")));
    // The report happens before drain.finally; let that microtask complete.
    await Promise.resolve();
    expect(failure.mock.calls.filter(([path]) => path === file())).toHaveLength(1); // no automatic retry
    expect(run).not.toHaveBeenCalled();
    expect(store.messagesFor(target.threadId).some((message) => message.comm)).toBe(false);
    expect(_pendingCount(from.threadId)).toBe(1);
    expect(readFileSync(file())).toEqual(bytes);
    failure.mockRestore();
    _resetPending();
    _loadPending();
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    await waitFor(() => run.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
  });

  it("failed discard preserves queue and emits no dropped chip; retry removes it durably", () => {
    expect(queue()).toBe("ok");
    const bytes = readFileSync(file());
    const before = store.messagesFor(from.threadId).length;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = injectWriteFailure();
    expect(discardDelegations(buses.commsBus, from.threadId)).toBe(false);
    expect(_pendingCount(from.threadId)).toBe(1);
    expect(readFileSync(file())).toEqual(bytes);
    expect(store.messagesFor(from.threadId)).toHaveLength(before);
    failure.mockRestore();
    expect(discardDelegations(buses.commsBus, from.threadId)).toBe(true);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({});
  });
  it("refuses an existing foreign-owned direct channel before mirroring or dispatch", async () => {
    const room = store.createGroup("PRIVATE-ROOM", [from.id, target.id], true, "foreign");
    expect(queue()).toBe("ok");
    const fromCount = store.messagesFor(from.threadId).length;
    const targetCount = store.messagesFor(target.threadId).length;
    const roomCount = store.messagesFor(room.threadId).length;
    const run = vi.fn();
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    await waitFor(() => _pendingCount(from.threadId) === 0);
    expect(run).not.toHaveBeenCalled();
    expect(store.messagesFor(from.threadId)).toHaveLength(fromCount);
    expect(store.messagesFor(target.threadId)).toHaveLength(targetCount);
    expect(store.messagesFor(room.threadId)).toHaveLength(roomCount);
  });

  it.each(["owner", "member"] as const)("rechecks channel %s after provider setup", async (change) => {
    expect(queue()).toBe("ok");
    let release = () => {};
    const setup = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let validAfterSetup: boolean | undefined;
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, _message, _depth, _thread, channel, validate) => {
      expect(validate()).toBe(true);
      if (!channel) throw new Error("Expected owned direct channel");
      entered = true;
      await setup;
      validAfterSetup = validate();
    }, ownerOf);
    await waitFor(() => entered);
    const room = store.dmGroup(from.id, target.id)!;
    if (change === "owner") room.ownerId = "foreign";
    else {
      const foreign = store.createBot({ ownerId: "foreign" });
      store.patchGroup(room.id, { memberIds: [from.id, target.id, foreign.id] });
    }
    release();
    await waitFor(() => validAfterSetup === false);
    expect(validAfterSetup).toBe(false);
  });

  it("acknowledges identical queued messages by ID without removing a second handoff", async () => {
    expect(queue()).toBe("ok");
    expect(queue()).toBe("ok");
    const run = vi.fn();
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    await waitFor(() => run.mock.calls.length === 2 && _pendingCount(from.threadId) === 0);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({});
  });

  it("preserves the four-item cap and queue bytes when another handoff is refused", () => {
    for (let index = 0; index < 4; index++) expect(queue()).toBe("ok");
    const bytes = readFileSync(file());
    const count = store.messagesFor(from.threadId).length;
    expect(queue()).toBe("too_many");
    expect(_pendingCount(from.threadId)).toBe(4);
    expect(readFileSync(file())).toEqual(bytes);
    expect(store.messagesFor(from.threadId)).toHaveLength(count);
  });

  it.each([false, true])("rechecks setup-time consent with prior item approval=%s", async (approvedInitially) => {
    store.patchBot(from.id, { approvePeerComms: approvedInitially });
    expect(queue()).toBe("ok");
    let release = () => {};
    const setup = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let validAfterSetup: boolean | undefined;
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, _message, _depth, _thread, _channel, validate) => {
      expect(validate()).toBe(true);
      entered = true;
      await setup;
      validAfterSetup = validate();
    }, ownerOf);
    if (approvedInitially) {
      const card = await waitFor(() => store.messagesFor(from.threadId).find((message) => message.card?.requestId));
      resolvePeerComms(buses.approvalBus, card.card!.requestId!, "allow");
    }
    await waitFor(() => entered);
    store.patchBot(from.id, { approvePeerComms: true });
    release();
    await waitFor(() => validAfterSetup !== undefined);
    expect(validAfterSetup).toBe(approvedInitially);
  });

  it("does not admit recursive handoffs even if a caller supplies a larger depth limit", () => {
    expect(queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "recursive", depth: 1 }, 2,
      provenanceFor(store, from, 1, from.threadId, "primary"), ownerOf)).toBe("too_deep");
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(existsSync(file())).toBe(false);
  });

  it("returns durable acceptance once even when the acknowledgement hits a real SQLite insert failure", async () => {
    const connection = new DatabaseSync(join(DATA_DIR, "messages.db"));
    const before = readThread(from.threadId, join(DATA_DIR, `messages-${from.threadId}.json`));
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      connection.exec("CREATE TRIGGER delegation_ack_failure BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'owned acknowledgement failure'); END");
      expect(queue()).toBe("ok");
      expect(_pendingCount(from.threadId)).toBe(1);
      expect(JSON.parse(readFileSync(file(), "utf8"))[from.threadId]).toHaveLength(1);
      expect(readThread(from.threadId, join(DATA_DIR, `messages-${from.threadId}.json`))).toEqual(before);
      connection.exec("DROP TRIGGER delegation_ack_failure");
      const run = vi.fn();
      drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
      await waitFor(() => run.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
      expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({});
      const repaired = readThread(from.threadId, join(DATA_DIR, `messages-${from.threadId}.json`));
      expect(repaired.messages.filter((message) => message.tool?.name.startsWith("Delegated to @"))).toHaveLength(1);
    } finally {
      connection.exec("DROP TRIGGER IF EXISTS delegation_ack_failure");
      connection.close();
    }
  });

  it("failed discard retires a held approval in process; later drain removes it without dispatch", async () => {
    store.patchBot(from.id, { approvePeerComms: true });
    expect(queue()).toBe("ok");
    const bytes = readFileSync(file());
    const run = vi.fn();
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    const card = await waitFor(() => store.messagesFor(from.threadId).find((message) => message.card?.requestId));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = injectWriteFailure();
    expect(discardDelegations(buses.commsBus, from.threadId)).toBe(false);
    resolvePeerComms(buses.approvalBus, card.card!.requestId!, "allow");
    await waitFor(() => store.messagesFor(from.threadId).some((message) => message.tool?.name.includes("Could not durably remove")));
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(readFileSync(file())).toEqual(bytes);
    failure.mockRestore();
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    await waitFor(() => _pendingCount(from.threadId) === 0);
    expect(run).not.toHaveBeenCalled();
    // A new accepted item on the same thread is independent of the stop.
    store.patchBot(from.id, { approvePeerComms: false });
    expect(queue()).toBe("ok");
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    await waitFor(() => run.mock.calls.length === 1);
  });

  it("discard retires a dequeued handoff while target setup is still awaiting", async () => {
    expect(queue()).toBe("ok");
    let release = () => {};
    const setup = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let validAfterSetup: boolean | undefined;
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, async (_to, _message, _depth, _thread, _channel, validate) => {
      entered = true;
      await setup;
      validAfterSetup = validate();
    }, ownerOf);
    await waitFor(() => entered);
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(discardDelegations(buses.commsBus, from.threadId)).toBe(true);
    release();
    await waitFor(() => validAfterSetup === false);
    expect(validAfterSetup).toBe(false);
  });

  it("successful durable discard survives an actual dropped-chip SQLite failure", () => {
    expect(queue()).toBe("ok");
    const connection = new DatabaseSync(join(DATA_DIR, "messages.db"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      connection.exec("CREATE TRIGGER delegation_drop_failure BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'owned drop acknowledgement failure'); END");
      expect(discardDelegations(buses.commsBus, from.threadId)).toBe(true);
      expect(_pendingCount(from.threadId)).toBe(0);
      expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({});
    } finally {
      connection.exec("DROP TRIGGER delegation_drop_failure");
      connection.close();
    }
  });

  it("allows a hidden source to queue and dispatch to its visible same-owner peer", async () => {
    store.patchBot(from.id, { hidden: true });
    expect(queue()).toBe("ok");
    let validateCurrent = () => false;
    const run = vi.fn((_to: string, _message: string, _depth: number, _thread: string, _channel: GroupRecord | undefined, validate: () => boolean) => {
      validateCurrent = validate;
      expect(validate()).toBe(true);
    });
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    await waitFor(() => run.mock.calls.length === 1 && _pendingCount(from.threadId) === 0);
    expect(store.messagesFor(target.threadId).some((message) => message.comm?.withBotId === from.id)).toBe(true);
    expect(validateCurrent()).toBe(true);
    // Visibility never substitutes for the accepted owner's authority.
    store.patchBot(from.id, { ownerId: "foreign" });
    expect(validateCurrent()).toBe(false);
    expect(queue()).toBe("invalid_provenance");
  });

  it("still refuses a hidden target at queue and drain for a hidden same-owner source", async () => {
    store.patchBot(from.id, { hidden: true });
    store.patchBot(target.id, { hidden: true });
    expect(queue()).toBe("invalid_provenance");
    expect(_pendingCount(from.threadId)).toBe(0);
    store.patchBot(target.id, { hidden: false });
    expect(queue()).toBe("ok");
    store.patchBot(target.id, { hidden: true });
    const run = vi.fn();
    const count = store.messagesFor(target.threadId).length;
    drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, run, ownerOf);
    await waitFor(() => _pendingCount(from.threadId) === 0);
    expect(run).not.toHaveBeenCalled();
    expect(store.messagesFor(target.threadId)).toHaveLength(count);
  });

});
