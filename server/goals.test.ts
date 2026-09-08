import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GoalManager, parseGoalOutcome, type GoalManagerOptions } from "./goals.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-goals-"));
  dirs.push(dir);
  return join(dir, "goals.json");
}

function harness(start = new Date(2026, 8, 8, 9, 0, 0).getTime()) {
  let now = start;
  let bot: "ready" | "busy" | "missing" = "ready";
  const started: Array<{ botId: string; threadId: string; userText: string; engineText: string; first: boolean }> = [];
  const emitted: any[] = [];
  const options: GoalManagerOptions = {
    file: tempFile(),
    now: () => now,
    emit: (payload) => emitted.push(payload),
    botState: () => bot,
    startTurn: async (args) => {
      started.push(args);
    },
  };
  const manager = new GoalManager(options);
  return {
    manager,
    options,
    emitted,
    started,
    setNow: (value: number) => (now = value),
    setBot: (value: typeof bot) => (bot = value),
  };
}

/** Drive one full round: the initial dispatch (or a continuation) plus the
 * turn.completed that settles it with the given reply text. */
function settle(h: ReturnType<typeof harness>, goalId: string, threadId: string, reply: string, ok = true) {
  h.manager.handleRuntimeEvent({
    type: "item.completed",
    itemType: "assistant_text",
    threadId,
    text: reply,
  } as any);
  h.manager.handleRuntimeEvent({
    type: "turn.completed",
    threadId,
    ok,
  } as any);
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
    const file = (h.options as { file: string }).file;
    h.manager.create({ botId: "b1", threadId: "t1", text: "durable" });
    const disk = JSON.parse(readFileSync(file, "utf8"));
    expect(disk.goals).toHaveLength(1);
    const h2 = new GoalManager({ ...h.options, now: () => Date.now() });
    const reloaded = h2.listGoals().find((g) => g.text === "durable")!;
    expect(reloaded.status).toBe("stopped");
    expect(reloaded.lastOutcome).toMatch(/interrupted by restart/);
  });
});

describe("GoalManager loop", () => {
  it("continues on an in-progress marker and stops on the round budget", async () => {
    const h = harness();
    const goal = h.manager.create({ botId: "b1", threadId: "t1", text: "grind", maxRounds: 2 });
    await flush();
    expect(h.started).toHaveLength(1);

    settle(h, goal.id, "t1", "partial work — GOAL IN PROGRESS");
    expect(h.emitted.at(-1).goal.rounds).toBe(2);
    await flush();
    expect(h.started).toHaveLength(2);
    expect(h.started[1].first).toBe(false);
    expect(h.started[1].engineText).toContain("round 2 of 2");

    settle(h, goal.id, "t1", "still not done — GOAL IN PROGRESS");
    const done = h.emitted.at(-1).goal;
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
    expect(h.emitted.at(-1).goal.status).toBe("done");
    await flush();
    expect(h.started).toHaveLength(1);
  });

  it("stops visibly when a turn fails", async () => {
    const h = harness();
    const goal = h.manager.create({ botId: "b1", threadId: "t1", text: "watch" });
    await flush();
    settle(h, goal.id, "t1", "", false);
    expect(h.emitted.at(-1).goal.status).toBe("stopped");
    expect(h.emitted.at(-1).goal.lastOutcome).toMatch(/turn failed/);
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
    const goal = h.manager.create({ botId: "b1", threadId: "t1", text: "polite" });
    await flush();
    // the goal's own turn settles with a continue marker, but the user's
    // queued message has already claimed the bot
    h.setBot("busy");
    settle(h, goal.id, "t1", "GOAL IN PROGRESS");
    expect(h.emitted.at(-1).goal.rounds).toBe(2);
    await flush();
    expect(h.started).toHaveLength(1); // continuation queued, not dispatched

    // an unrelated user turn on the same thread must not consume a round
    h.manager.handleRuntimeEvent({ type: "item.completed", itemType: "assistant_text", threadId: "t1", text: "chatting" } as any);
    h.manager.handleRuntimeEvent({ type: "turn.completed", threadId: "t1", ok: true } as any);
    expect(h.emitted.at(-1).goal.rounds).toBe(2);

    h.setBot("ready");
    await (h.manager as any).tick();
    expect(h.started).toHaveLength(2);
    expect(h.started[1].engineText).toContain("round 2 of");
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
    expect(h.emitted.at(-1).goal.status).toBe("failed");
    expect(h.emitted.at(-1).goal.lastOutcome).toMatch(/provider offline/);
  });
});
