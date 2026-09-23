import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nextOccurrence, RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { whyPromptSuffix } from "./why-journal.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omb-routines-"));
  dirs.push(dir);
  return join(dir, "routines.json");
}

function harness(start = new Date(2026, 7, 17, 8, 0, 0).getTime()) {
  let now = start;
  let bot: "ready" | "busy" | "missing" = "ready";
  let task = 0;
  const started: Array<{ botId: string; threadId: string; prompt: string }> = [];
  const runOns: string[] = [];
  const triggerSources: string[] = [];
  const taskActivations: boolean[] = [];
  const emitted: any[] = [];
  const options: RoutineManagerOptions = {
    file: tempFile(),
    now: () => now,
    emit: (payload) => emitted.push(payload),
    botState: () => bot,
    createTask: (_botId, _title, activate = false) => {
      taskActivations.push(activate);
      return { threadId: `thread-${++task}` };
    },
    startTurn: async (botId, threadId, prompt, runOn, triggerSource) => {
      started.push({ botId, threadId, prompt });
      runOns.push(runOn);
      triggerSources.push(triggerSource);
    },
  };
  const manager = new RoutineManager(options);
  return {
    manager,
    options,
    emitted,
    started,
    runOns,
    triggerSources,
    taskActivations,
    setNow: (value: number) => (now = value),
    setBot: (value: typeof bot) => (bot = value),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("nextOccurrence", () => {
  it("finds the next selected weekday in local wall-clock time", () => {
    const monday = new Date(2026, 7, 17, 10, 0, 0).getTime();
    const next = nextOccurrence({ type: "daily", time: "09:30", weekdays: [1, 3] }, monday)!;
    const d = new Date(next);
    expect(d.getDay()).toBe(3);
    expect([d.getHours(), d.getMinutes()]).toEqual([9, 30]);
  });

  it("returns a one-off only while it is still in the future", () => {
    expect(nextOccurrence({ type: "once", at: 200 }, 100)).toBe(200);
    expect(nextOccurrence({ type: "once", at: 100 }, 100)).toBeNull();
  });
});

describe("RoutineManager", () => {
  it("persists definitions separately from permanent run receipts", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Morning brief",
      prompt: "Summarize what changed",
      botId: "agent-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 5).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()).toHaveLength(1);
    expect(reloaded.listRuns()).toMatchObject([
      { routineId: routine.id, routineName: "Morning brief", status: "failed", threadId: "thread-1" },
    ]);
    // Reload recovery truthfully marks an in-process run as interrupted.
    expect(reloaded.listRuns()[0]!.error).toContain("restarted");
  });

  it("queues behind a busy bot, then dispatches into a detached task", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Review queue",
      prompt: "Review the queue",
      botId: "agent-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
      durationMinutes: 45,
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]!.status).toBe("queued");
    expect(h.started).toHaveLength(0);

    h.setBot("ready");
    await h.manager.tick();
    // Every run carries the why-journal suffix on top of its base prompt.
    expect(h.started).toEqual([{ botId: "agent-2", threadId: "thread-1", prompt: `Review the queue${whyPromptSuffix()}` }]);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", threadId: "thread-1" });
    expect(h.manager.activeRunForBot("agent-2")?.threadId).toBe("thread-1");
    expect(h.manager.isActiveThread("thread-1")).toBe(true);
    expect(h.taskActivations).toEqual([false]);
  });

  it("reuses a dedicated destination thread across runs and falls back when it dies", async () => {
    let liveThread: string | null = "fixed-thread";
    const h = harness();
    (h.options as RoutineManagerOptions).taskThread = (_botId, threadId) =>
      liveThread === threadId ? threadId : null;
    const routine = h.manager.create({
      name: "Standing log",
      prompt: "Log the state",
      botId: "agent-2",
      schedule: { type: "daily", time: "08:01", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      destination: "fixed-thread",
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.started).toEqual([{ botId: "agent-2", threadId: "fixed-thread", prompt: `Log the state${whyPromptSuffix()}` }]);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", threadId: "fixed-thread" });
    // No fresh task was spawned for a live destination.
    expect(h.taskActivations).toEqual([]);

    // Run 2: destination still alive → same thread again.
    h.setBot("busy");
    h.setNow(new Date(2026, 7, 18, 8, 1).getTime());
    await h.manager.tick();
    h.setBot("ready");
    await h.manager.tick();
    expect(h.started[1]!.threadId).toBe("fixed-thread");

    // Run 3: destination deleted → fresh detached task, run still dispatches.
    liveThread = null;
    h.setBot("busy");
    h.setNow(new Date(2026, 7, 19, 8, 1).getTime());
    await h.manager.tick();
    h.setBot("ready");
    await h.manager.tick();
    expect(h.started[2]!.threadId).toBe("thread-1");
    // listRuns is newest-first.
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", threadId: "thread-1" });
  });

  it("keeps the destination in the persisted definition", () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Dated digest",
      prompt: "Digest the day",
      botId: "agent-2",
      schedule: { type: "daily", time: "08:01", weekdays: [1] },
      destination: "thread-abc",
    });
    const reloaded = new RoutineManager(h.options);
    expect(reloaded.listRoutines()[0]).toMatchObject({ id: routine.id, destination: "thread-abc" });
  });

  it("cancels queued work when a routine is paused", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Pauseable check",
      prompt: "Check later",
      botId: "agent-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    h.manager.update(routine.id, { enabled: false });
    h.setBot("ready");
    await h.manager.tick();

    expect(h.manager.listRuns()[0]).toMatchObject({ status: "cancelled" });
    expect(h.started).toHaveLength(0);
  });

  it("snapshots queued instructions so later edits do not rewrite a receipt", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "Original brief",
      prompt: "Use the original instructions",
      botId: "agent-2",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.update(routine.id, { name: "Edited brief", prompt: "Use the new instructions" });

    h.setBot("ready");
    await h.manager.tick();

    expect(h.started[0]?.prompt).toBe(`Use the original instructions${whyPromptSuffix()}`);
    expect(h.manager.listRuns()[0]).toMatchObject({
      routineName: "Original brief",
      prompt: "Use the original instructions",
    });
  });

  it("snapshots and dispatches the selected execution machine", async () => {
    const h = harness();
    h.setBot("busy");
    const routine = h.manager.create({
      name: "VM review",
      prompt: "Review the project on the virtual machine",
      botId: "agent-cloud",
      runOn: "cloud",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.update(routine.id, { runOn: "agent" });

    h.setBot("ready");
    await h.manager.tick();

    expect(h.runOns).toEqual(["cloud"]);
    expect(h.manager.listRuns()[0]).toMatchObject({ runOn: "cloud" });
    expect(h.manager.listRoutines()[0]).toMatchObject({ runOn: "agent" });
  });

  it("opens webhook jobs in the assigned bot's live chat", async () => {
    const h = harness();
    const receivedAt = new Date(2026, 7, 17, 8, 2).getTime();
    const queued = h.manager.enqueueWebhook({
      webhookId: "hook-1",
      webhookName: "New ticket",
      prompt: "Handle ticket 42",
      botId: "agent-webhook",
      runOn: "cloud",
      deliveryId: "delivery-42",
      receivedAt,
    });
    await h.manager.tick();

    expect(queued).toMatchObject({
      routineId: "hook-1",
      webhookId: "hook-1",
      deliveryId: "delivery-42",
      triggerSource: "webhook",
      scheduledFor: receivedAt,
    });
    expect(queued).not.toHaveProperty("durationMinutes");
    expect(h.started).toEqual([{ botId: "agent-webhook", threadId: "thread-1", prompt: `Handle ticket 42${whyPromptSuffix()}` }]);
    expect(h.runOns).toEqual(["cloud"]);
    expect(h.triggerSources).toEqual(["webhook"]);
    expect(h.taskActivations).toEqual([true]);
  });

  it("folds provider lifecycle events into the calendar receipt", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Ship report",
      prompt: "Write the report",
      botId: "agent-3",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    const base = {
      eventId: "event-1",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date(h.manager.listRuns()[0]!.startedAt!).toISOString(),
    };
    h.manager.handleRuntimeEvent({ ...base, type: "request.opened", requestType: "question", tool: "ask", summary: "Need a date" });
    expect(h.manager.listRuns()[0]!.status).toBe("waiting");
    h.manager.handleRuntimeEvent({ ...base, type: "request.resolved", behavior: "answer", source: "user" });
    h.manager.handleRuntimeEvent({ ...base, type: "item.completed", itemType: "assistant_text", text: "Report shipped." });
    h.manager.handleRuntimeEvent({ ...base, type: "turn.completed", ok: true, cost: 0.02 });

    expect(h.manager.listRuns()[0]).toMatchObject({
      status: "completed",
      output: "Report shipped.",
      cost: 0.02,
    });
  });

  it("keeps recurring history while advancing the definition", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Daily check",
      prompt: "Check it",
      botId: "agent-4",
      schedule: { type: "daily", time: "08:05", weekdays: [1, 2, 3, 4, 5] },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      eventId: "done",
      provider: "fake",
      threadId: "thread-1",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: true,
    });

    expect(h.manager.listRuns()).toHaveLength(1);
    expect(h.manager.listRoutines()[0]!.nextRunAt).toBeGreaterThan(routine.nextRunAt!);
  });

  it("records a missed receipt instead of launching very stale work", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Old check",
      prompt: "Do the old thing",
      botId: "agent-5",
      schedule: { type: "once", at: new Date(2026, 7, 17, 8, 1).getTime() },
    });
    h.setNow(routine.nextRunAt! + 13 * 60 * 60_000);
    await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "missed" });
    expect(h.started).toHaveLength(0);
  });
});

describe("overnight chain (iterations)", () => {
  const eventBase = (threadId: string, startedAt: number) => ({
    eventId: "event-x",
    provider: "fake",
    threadId,
    createdAt: new Date(startedAt).toISOString(),
  });

  it("a successful iteration enqueues the next with an incremented counter and chained prompt", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Nightly refactor",
      prompt: "Refactor the parser",
      botId: "agent-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 23, 0).getTime() },
      iterations: 3,
      notesFile: "~/project/NOTES.md",
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();

    // Iteration 1 dispatched with the chain preamble.
    expect(h.started[0]!.prompt).toContain("iteration 1 of 3");
    expect(h.started[0]!.prompt).toContain("~/project/NOTES.md");
    expect(h.manager.listRuns()[0]!.iteration).toBe(1);

    // Turn 1 succeeds → iteration 2 enqueues immediately (no calendar hop).
    h.manager.handleRuntimeEvent({
      ...eventBase("thread-1", h.manager.listRuns()[0]!.startedAt!),
      type: "turn.completed",
      ok: true,
    });
    await h.manager.tick();
    expect(h.started[1]!.prompt).toContain("iteration 2 of 3");
    expect(h.started[1]!.prompt).toContain("Continue that work from where it stopped");
    expect(h.manager.listRuns()[0]!.iteration).toBe(2);

    // Iteration 2 succeeds → iteration 3 enqueues and dispatches; after
    // the FINAL iteration nothing further enqueues (the chain is done).
    h.manager.handleRuntimeEvent({
      ...eventBase("thread-2", h.manager.listRuns()[0]!.startedAt!),
      type: "turn.completed",
      ok: true,
    });
    await h.manager.tick();
    expect(h.started).toHaveLength(3);
    expect(h.started[2]!.prompt).toContain("iteration 3 of 3");
    expect(h.manager.listRuns()[0]!.iteration).toBe(3);
    // Completing iteration 3 must not enqueue an iteration 4.
    h.manager.handleRuntimeEvent({
      ...eventBase("thread-3", h.manager.listRuns()[0]!.startedAt!),
      type: "turn.completed",
      ok: true,
    });
    await h.manager.tick();
    expect(h.started).toHaveLength(3);
    expect(h.manager.listRuns()[0]!.status).toBe("completed");
  });

  it("a failed iteration stops the chain with an explanatory error", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Nightly refactor",
      prompt: "Refactor the parser",
      botId: "agent-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 23, 0).getTime() },
      iterations: 3,
      notesFile: "~/project/NOTES.md",
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    h.manager.handleRuntimeEvent({
      ...eventBase("thread-1", h.manager.listRuns()[0]!.startedAt!),
      type: "turn.completed",
      ok: false,
      stopReason: "engine crashed",
    });
    await h.manager.tick();
    const run = h.manager.listRuns()[0]!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("overnight chain stopped after iteration 1 of 3");
    expect(h.started).toHaveLength(1); // no iteration 2
  });

  it("single-iteration routines are untouched (no iteration stamp)", async () => {
    const h = harness();
    const routine = h.manager.create({
      name: "Plain daily",
      prompt: "Do the thing",
      botId: "agent-1",
      schedule: { type: "once", at: new Date(2026, 7, 17, 9, 0).getTime() },
    });
    h.setNow(routine.nextRunAt!);
    await h.manager.tick();
    expect(h.started[0]!.prompt).not.toContain("iteration");
    expect(h.manager.listRuns()[0]!.iteration).toBeUndefined();
  });

  it("sanitizeInput clamps iterations to 1..12", async () => {
    const h = harness();
    const high = h.manager.create({
      name: "Too many",
      prompt: "Go",
      botId: "agent-1",
      schedule: { type: "daily", time: "02:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      iterations: 999,
      notesFile: "~/n.md",
    });
    expect(high.iterations).toBe(12);
    const updated = h.manager.update(high.id, { iterations: 0 });
    expect(updated!.iterations).toBe(1);
  });
});
