import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GoalManager, parseGoalOutcome, type GoalEvent, type GoalManagerOptions, type GoalRecord } from "./goals.ts";
import type { RuntimeEventBase } from "./contracts.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-goals-"));
  dirs.push(dir);
  return join(dir, "goals.json");
}

function harness(start = new Date(2026, 8, 8, 9, 0, 0).getTime(), file = tempFile()) {
  let now = start;
  let bot: "ready" | "busy" | "missing" = "ready";
  const started: Array<Parameters<GoalManagerOptions["startTurn"]>[0]> = [];
  const emitted: GoalEvent[] = [];
  const options = {
    file,
    now: () => now,
    emit: (payload) => emitted.push(payload),
    botState: () => bot,
    startTurn: async (args) => {
      started.push(args);
    },
  } satisfies GoalManagerOptions;
  const manager = new GoalManager(options);
  return {
    manager,
    options,
    emitted,
    started,
    lastGoal: () => {
      const last = emitted.at(-1);
      if (!last) throw new Error("Expected a goal event from the fixture");
      return last.goal;
    },
    setNow: (value: number) => (now = value),
    setBot: (value: typeof bot) => (bot = value),
  };
}

let eventSequence = 0;
function eventBase(threadId: string): RuntimeEventBase {
  return {
    eventId: `goal-fixture-${++eventSequence}`,
    provider: "codex",
    threadId,
    createdAt: "2026-09-08T07:00:00.000Z",
  };
}

/** Drive one full round: the initial dispatch (or a continuation) plus the
 * turn.completed that settles it with the given reply text. */
function settle(h: ReturnType<typeof harness>, goalId: string, threadId: string, reply: string, ok = true) {
  h.manager.handleRuntimeEvent({
    ...eventBase(threadId),
    type: "item.completed",
    itemType: "assistant_text",
    text: reply,
  });
  h.manager.handleRuntimeEvent({
    ...eventBase(threadId),
    type: "turn.completed",
    ok,
  });
  void goalId;
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseGoalOutcome", () => {
  it("recognizes the markers case-insensitively", () => {
    expect(parseGoalOutcome("All done. GOAL COMPLETE")).toBe("done");
    expect(parseGoalOutcome("still working… goal in progress")).toBe("in_progress");
    expect(parseGoalOutcome("no marker here")).toBeNull();
    expect(parseGoalOutcome(undefined)).toBeNull();
  });

  it("treats done as the stronger marker when both appear", () => {
    expect(parseGoalOutcome("goal in progress… actually GOAL COMPLETE")).toBe("done");
  });
});

describe("GoalManager.create", () => {
  it("round 1 dispatches immediately with the marker protocol on the engine text", async () => {
    const h = harness();
    const goal = h.manager.create({ botId: "b1", threadId: "t1", text: "Ship the release notes", maxRounds: 3 });
    expect(goal.status).toBe("active");
    expect(goal.rounds).toBe(1);
    expect(goal.maxRounds).toBe(3);
    await flush();
    expect(h.started).toHaveLength(1);
    expect(h.started[0].first).toBe(true);
    expect(h.started[0].userText).toBe("Ship the release notes");
    expect(h.started[0].engineText).toContain("Ship the release notes");
    expect(h.started[0].engineText).toContain("GOAL COMPLETE");
  });

  it("rejects a second active goal, a missing bot, and a busy bot", () => {
    const h = harness();
    h.manager.create({ botId: "b1", threadId: "t1", text: "one" });
    expect(() => h.manager.create({ botId: "b1", threadId: "t1", text: "two" })).toThrow(/active goal/);
    h.setBot("missing");
    expect(() => h.manager.create({ botId: "b2", threadId: "t2", text: "x" })).toThrow(/no such bot/);
    h.setBot("busy");
    expect(() => h.manager.create({ botId: "b3", threadId: "t3", text: "x" })).toThrow(/working/);
  });

  it("clamps the round budget to the cap", () => {
    const h = harness();
    const goal = h.manager.create({ botId: "b1", threadId: "t1", text: "x", maxRounds: 999 });
    expect(goal.maxRounds).toBe(20);
    const fallback = h.manager.create({ botId: "b2", threadId: "t2", text: "y" });
    expect(fallback.maxRounds).toBe(5);
  });

  it("persists goals and reloads them with active ones stopped as interrupted", () => {
    const h = harness();
    const file = h.options.file;
    h.manager.create({ botId: "b1", threadId: "t1", text: "durable" });
    const disk = JSON.parse(readFileSync(file, "utf8"));
    expect(disk.goals).toHaveLength(1);
    const h2 = new GoalManager({ ...h.options, now: () => Date.now() });
    const reloaded = h2.listGoals().find((g) => g.text === "durable")!;
    expect(reloaded.status).toBe("stopped");
    expect(reloaded.lastOutcome).toMatch(/interrupted by restart/);
  });

  it("at capacity preserves active goals and dispatches the new goal while pruning only oldest terminal history", async () => {
    const file = tempFile();
    const history = Array.from({ length: 199 }, (_, index): GoalRecord => ({
      id: `terminal-${index}`, botId: `old-bot-${index}`, threadId: `old-thread-${index}`,
      text: `Historical goal ${index}`, status: "stopped", rounds: 1, maxRounds: 5,
      createdAt: 10 + index, updatedAt: 500 + index,
    }));
    // Deliberately nonchronological storage proves eviction uses age, not
    // an incidental first/last array position.
    writeFileSync(file, JSON.stringify({ version: 1, goals: history }));
    const h = harness(1, file);
    const active = h.manager.create({ botId: "active", threadId: "active-thread", text: "Keep this active goal" });
    h.setNow(1_000);
    const created = h.manager.create({ botId: "new", threadId: "new-thread", text: "Dispatch this new goal" });
    await flush();
    const records = h.manager.listGoals();
    expect(records).toHaveLength(200);
    expect(records.some((record) => record.id === active.id && record.status === "active")).toBe(true);
    expect(records.some((record) => record.id === created.id && record.status === "active")).toBe(true);
    expect(records.some((record) => record.id === "terminal-0")).toBe(false);
    expect(records.some((record) => record.id === "terminal-198")).toBe(true);
    expect(h.started.map((turn) => turn.botId)).toEqual(["active", "new"]);
    const persisted = new GoalManager({ ...h.options, emit: () => {} });
    expect(persisted.listGoals().some((record) => record.id === created.id)).toBe(true);
    expect(persisted.listGoals().some((record) => record.id === "terminal-0")).toBe(false);
  });

  it("rejects an all-active capacity before disk/events/dispatch change and accepts a new goal after one stops", async () => {
    const h = harness();
    const existing = Array.from({ length: 200 }, (_, index) => h.manager.create({
      botId: `bot-${index}`, threadId: `thread-${index}`, text: `Active goal ${index}`,
    }));
    await flush();
    const before = readFileSync(h.options.file), emittedCount = h.emitted.length;
    expect(h.started).toHaveLength(200);
    const input = { botId: "one-too-many", threadId: "overflow", text: "New work" };
    expect(() => h.manager.create(input)).toThrow(/goal limit.*stop an active goal/);
    expect(readFileSync(h.options.file)).toEqual(before);
    expect(h.emitted).toHaveLength(emittedCount);
    await flush();
    expect(h.started).toHaveLength(200);
    expect(h.manager.listGoals()).toHaveLength(200);
    const stopped = existing[0];
    h.manager.stopGoal(stopped.id);
    const created = h.manager.create(input);
    await flush();
    expect(h.started).toHaveLength(201);
    expect(h.started.at(-1)?.botId).toBe("one-too-many");
    const records = h.manager.listGoals();
    expect(records).toHaveLength(200);
    expect(records.some((record) => record.id === created.id)).toBe(true);
    expect(records.some((record) => record.id === stopped.id)).toBe(false);
    expect(records.filter((record) => record.status === "active")).toHaveLength(200);
  });
});

describe("GoalManager loop", () => {
  it("continues on an in-progress marker and stops on the round budget", async () => {
    const h = harness();
    const goal = h.manager.create({ botId: "b1", threadId: "t1", text: "grind", maxRounds: 2 });
    await flush();
    expect(h.started).toHaveLength(1);

    settle(h, goal.id, "t1", "partial work — GOAL IN PROGRESS");
    expect(h.lastGoal().rounds).toBe(2);
    await flush();
    expect(h.started).toHaveLength(2);
    expect(h.started[1].first).toBe(false);
    expect(h.started[1].engineText).toContain("round 2 of 2");

    settle(h, goal.id, "t1", "still not done — GOAL IN PROGRESS");
    const done = h.lastGoal();
    expect(done.status).toBe("stopped");
    expect(done.lastOutcome).toMatch(/round limit reached/);
    await flush();
    expect(h.started).toHaveLength(2); // no dispatch past the budget
  });

  it("finishes done when the marker says complete", async () => {
    const h = harness();
    const goal = h.manager.create({ botId: "b1", threadId: "t1", text: "tidy" });
    await flush();
    settle(h, goal.id, "t1", "everything shipped. GOAL COMPLETE");
    expect(h.lastGoal().status).toBe("done");
    await flush();
    expect(h.started).toHaveLength(1);
  });

  it("stops visibly when a turn fails", async () => {
    const h = harness();
    const goal = h.manager.create({ botId: "b1", threadId: "t1", text: "watch" });
    await flush();
    settle(h, goal.id, "t1", "", false);
    expect(h.lastGoal().status).toBe("stopped");
    expect(h.lastGoal().lastOutcome).toMatch(/turn failed/);
  });

  it("stopGoal ends the loop and no further rounds dispatch", async () => {
    const h = harness();
    const goal = h.manager.create({ botId: "b1", threadId: "t1", text: "cancel-me" });
    await flush();
    const stopped = h.manager.stopGoal(goal.id);
    expect(stopped?.status).toBe("stopped");
    settle(h, goal.id, "t1", "GOAL IN PROGRESS");
    await flush();
    expect(h.started).toHaveLength(1);
  });

  it("defers a continuation while the bot is busy and never mislabels a user turn", async () => {
    const h = harness();
    vi.useFakeTimers();
    h.manager.start();
    try {
      const goal = h.manager.create({ botId: "b1", threadId: "t1", text: "polite" });
      await vi.advanceTimersByTimeAsync(0);
      // the goal's own turn settles with a continue marker, but the user's
      // queued message has already claimed the bot
      h.setBot("busy");
      settle(h, goal.id, "t1", "GOAL IN PROGRESS");
      expect(h.lastGoal().rounds).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.started).toHaveLength(1); // continuation queued, not dispatched

      // an unrelated user turn on the same thread must not consume a round
      h.manager.handleRuntimeEvent({ ...eventBase("t1"), type: "item.completed", itemType: "assistant_text", text: "chatting" });
      h.manager.handleRuntimeEvent({ ...eventBase("t1"), type: "turn.completed", ok: true });
      expect(h.lastGoal().rounds).toBe(2);

      h.setBot("ready");
      await vi.advanceTimersByTimeAsync(3_000);
      expect(h.started).toHaveLength(2);
      expect(h.started[1].engineText).toContain("round 2 of");
    } finally {
      h.manager.stop();
      vi.useRealTimers();
    }
  });

  it("keeps goal B queued for the next tick when B settles while goal A's continuation dispatch awaits", async () => {
    const h = harness();
    let releaseDispatch = () => {};
    const heldDispatch = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    h.options.startTurn = async (args) => {
      h.started.push(args);
      if (args.botId === "a" && !args.first) await heldDispatch;
    };
    vi.useFakeTimers();
    h.manager.start();
    try {
      const a = h.manager.create({ botId: "a", threadId: "ta", text: "Goal A" });
      const b = h.manager.create({ botId: "b", threadId: "tb", text: "Goal B" });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.started.map((turn) => turn.botId)).toEqual(["a", "b"]);
      settle(h, a.id, "ta", "GOAL IN PROGRESS");
      await vi.advanceTimersByTimeAsync(0);
      expect(h.started.map((turn) => turn.botId)).toEqual(["a", "b", "a"]);
      settle(h, b.id, "tb", "GOAL IN PROGRESS");
      await vi.advanceTimersByTimeAsync(0);
      releaseDispatch();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.started.map((turn) => turn.botId)).toEqual(["a", "b", "a"]);
      expect(h.manager.activeGoalForBot("b")?.rounds).toBe(2);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(h.started).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.started.map((turn) => turn.botId)).toEqual(["a", "b", "a", "b"]);
      expect(h.started[3].first).toBe(false);
    } finally {
      releaseDispatch();
      h.manager.stop();
      vi.useRealTimers();
    }
  });

  it("does not treat a failed dispatch as an endless loop: goal fails once", async () => {
    const h = harness();
    let failFirst = true;
    h.options.startTurn = async (args) => {
      if (failFirst && args.first) {
        failFirst = false;
        args.onDispatchError("provider offline");
        return;
      }
    };
    const goal = h.manager.create({ botId: "b1", threadId: "t1", text: "doomed" });
    // create() returns before the async dispatch runs; the snapshot it gave
    // back still says active — the manager's own event carries the truth
    expect(goal.status).toBe("active");
    await flush();
    expect(h.lastGoal().status).toBe("failed");
    expect(h.lastGoal().lastOutcome).toMatch(/provider offline/);
  });
});
