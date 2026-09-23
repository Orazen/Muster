import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_PLAN_STEPS,
  MAX_TRANSITIONS,
  TaskPlanEngine,
  type TaskPlanEvent,
} from "./task-engine.ts";
import type { TaskControlAction, TaskPlanRecord, TaskTransitionEvent } from "./contracts.ts";

const dirs: string[] = [];

function tempFile(name = "task-plans.json") {
  const dir = mkdtempSync(join(tmpdir(), "omb-task-plans-"));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface HarnessOptions {
  file?: string;
  leaseMs?: number;
  maxAttempts?: number;
  maxPlans?: number;
}

interface DiskFile {
  version: number;
  plans: TaskPlanRecord[];
  transitions: TaskTransitionEvent[];
}

interface Harness {
  file: string;
  emitted: TaskPlanEvent[];
  /** Always the current instance: a restart swaps it out from under you. */
  readonly engine: TaskPlanEngine;
  /** What a process restart looks like — same file, fresh memory. */
  restart(): TaskPlanEngine;
  now(): number;
  advance(ms: number): void;
  disk(): DiskFile;
}

function harness(options: HarnessOptions = {}): Harness {
  let now = new Date(2026, 8, 8, 9, 0, 0).getTime();
  const emitted: TaskPlanEvent[] = [];
  const file = options.file ?? tempFile();
  const make = () =>
    new TaskPlanEngine({
      file,
      now: () => now,
      emit: (payload) => void emitted.push(payload),
      leaseMs: options.leaseMs ?? 60_000,
      maxAttempts: options.maxAttempts ?? 3,
      maxPlans: options.maxPlans,
    });
  let engine = make();
  /** The store file exactly as a restart would read it back. */
  // SAFETY: the engine wrote this file itself (persist() serializes a
  // TaskPlanFile), so the parsed JSON has exactly the DiskFile shape.
  const readDisk = (): DiskFile => JSON.parse(readFileSync(file, "utf8")) as DiskFile;
  const api: Harness = {
    file,
    emitted,
    get engine() {
      return engine;
    },
    restart() {
      engine = make();
      emitted.length = 0;
      return engine;
    },
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    disk: readDisk,
  };
  return api;
}

/** The HTTP status an engine error would carry through index.ts's catch. */
function statusOf(run: () => TaskPlanRecord): number | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    // SAFETY: engine failures are always Object.assign(new Error, { status }).
    return (error as { status?: number }).status;
  }
}

describe("TaskPlanEngine — creation and checkpoint ordering", () => {
  it("starts a plan immediately with ordered steps and a live lease", () => {
    const h = harness();
    const plan = h.engine.create({
      botId: "bot-1",
      title: "Ship the release",
      steps: ["draft", { title: "legal sign-off", kind: "approval" }, "publish"],
      actorId: "worker-a",
    });
    expect(plan.status).toBe("running");
    expect(plan.title).toBe("Ship the release");
    expect(plan.currentStep).toBe(1);
    expect(plan.lease?.holder).toBe("worker-a");
    expect(plan.steps.map((step) => [step.n, step.status, step.kind])).toEqual([
      [1, "active", "checkpoint"],
      [2, "pending", "approval"],
      [3, "pending", "checkpoint"],
    ]);
    const disk = h.disk();
    expect(disk.version).toBe(1);
    expect(disk.plans).toHaveLength(1);
    expect(disk.plans[0]?.currentStep).toBe(1);
    expect(h.emitted.at(-1)).toMatchObject({ kind: "taskPlan", botId: "bot-1" });
    expect(h.emitted.filter((frame) => frame.kind === "taskTransition").map((f) => f.transition.action)).toEqual([
      "start",
    ]);
  });

  it("holds a plan queued when the caller opts out of starting it", () => {
    const h = harness();
    const plan = h.engine.create({ botId: "bot-1", steps: ["one"], start: false });
    expect(plan.status).toBe("queued");
    expect(plan.currentStep).toBeNull();
    expect(plan.lease).toBeUndefined();
    expect(statusOf(() => h.engine.control(plan.id, { action: "pause" }))).toBe(409);
    expect(h.engine.control(plan.id, { action: "start" }).status).toBe("running");
    expect(h.engine.plan(plan.id)?.currentStep).toBe(1);
  });

  it("refuses malformed step lists without touching the store", () => {
    const h = harness();
    const kept = h.engine.create({ botId: "bot-1", steps: ["keep"] });
    const before = h.disk();
    expect(statusOf(() => h.engine.create({ botId: "bot-1", steps: [] }))).toBe(400);
    expect(() =>
      h.engine.create({ botId: "bot-1", steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => `s${i}`) }),
    ).toThrow(new RegExp(`at most ${MAX_PLAN_STEPS} steps`));
    expect(() => h.engine.create({ botId: "bot-1", steps: ["   "] })).toThrow(/needs a title/);
    expect(() => h.engine.create({ botId: "bot-1", steps: [{ title: "x", kind: "nonsense" }] })).toThrow(/unknown kind/);
    expect(() => h.engine.create({ botId: "", steps: ["x"] })).toThrow(/Choose a bot/);
    expect(h.disk()).toEqual(before);
    expect(h.engine.listPlans()).toHaveLength(1);
    expect(h.engine.plan(kept.id)?.status).toBe("running");
  });

  it("completes checkpoints only in order and ends succeeded", () => {
    const h = harness();
    const plan = h.engine.create({ botId: "bot-1", steps: ["draft", "review", "publish"] });
    expect(statusOf(() => h.engine.completeStep(plan.id, 2))).toBe(409);
    expect(() => h.engine.completeStep(plan.id, 2)).toThrow(/step 2 is not the active checkpoint/);
    expect(h.engine.plan(plan.id)?.status).toBe("running");

    h.engine.completeStep(plan.id, 1);
    expect(h.engine.plan(plan.id)?.currentStep).toBe(2);
    // Going backwards is refused too: a completed checkpoint stays done.
    expect(() => h.engine.completeStep(plan.id, 1)).toThrow(/not the active checkpoint/);

    expect(h.engine.completeStep(plan.id, 2).steps[1]?.status).toBe("done");
    const done = h.engine.completeStep(plan.id, 3);
    expect(done.status).toBe("succeeded");
    expect(done.steps.every((step) => step.status === "done")).toBe(true);
    expect(h.engine.plan(plan.id)?.currentStep).toBe(3);
    expect(h.engine.transitionsFor(plan.id).map((event) => event.action)).toEqual([
      "start",
      "complete",
      "complete",
      "complete",
    ]);
    expect(h.disk().transitions).toHaveLength(4);
  });

  it("recovers an interrupted plan at the same checkpoint and keeps the order", () => {
    const h = harness();
    const plan = h.engine.create({ botId: "bot-1", steps: ["draft", "review", "publish"], actorId: "worker-a" });
    h.engine.completeStep(plan.id, 1);

    const boot = h.restart();
    const recovered = boot.plan(plan.id)!;
    expect(recovered.status).toBe("paused");
    expect(recovered.pausedFrom).toBe("running");
    expect(recovered.lastError).toBe("interrupted by restart");
    expect(recovered.currentStep).toBe(2);
    expect(recovered.steps[0]?.status).toBe("done");
    expect(recovered.lease).toBeUndefined();

    const resumed = boot.control(plan.id, { action: "resume", actorId: "worker-b" });
    expect(resumed.status).toBe("running");
    expect(resumed.pausedFrom).toBeUndefined();
    expect(resumed.lastError).toBeUndefined();
    expect(resumed.currentStep).toBe(2);
    expect(resumed.lease?.holder).toBe("worker-b");
    expect(() => boot.completeStep(plan.id, 1)).toThrow(/not the active checkpoint/);
    boot.completeStep(plan.id, 2);
    expect(boot.completeStep(plan.id, 3).status).toBe("succeeded");
  });
});

describe("TaskPlanEngine — client control", () => {
  it("runs the legal control matrix and refuses the illegal moves", () => {
    const h = harness();
    const plan = h.engine.create({ botId: "bot-1", steps: ["one"], start: false });
    const verb = (action: TaskControlAction) => () => h.engine.control(plan.id, { action });

    // queued: only start and cancel
    expect(statusOf(verb("pause"))).toBe(409);
    expect(statusOf(verb("resume"))).toBe(409);
    expect(statusOf(verb("retry"))).toBe(409);
    expect(h.engine.control(plan.id, { action: "start" }).status).toBe("running");

    // running: start/resume/retry are all illegal
    expect(statusOf(verb("start"))).toBe(409);
    expect(statusOf(verb("resume"))).toBe(409);
    expect(() => verb("retry")()).toThrow(/cannot retry a plan in state running/);

    const paused = h.engine.control(plan.id, { action: "pause", reason: "waiting on the human" });
    expect(paused.status).toBe("paused");
    expect(paused.lease).toBeUndefined();
    expect(paused.lastError).toBe("waiting on the human");
    expect(statusOf(verb("retry"))).toBe(409);

    expect(h.engine.control(plan.id, { action: "cancel", reason: "changed our minds" }).status).toBe("cancelled");

    // terminal: nothing moves it again
    for (const action of ["start", "pause", "resume", "retry", "cancel"] as const) {
      expect(statusOf(() => h.engine.control(plan.id, { action }))).toBe(409);
    }
    // SAFETY: this deliberately malformed verb is what proves the 400 —
    // the engine's control-action check must reject it at runtime.
    const badAction = "yeet" as TaskControlAction;
    expect(statusOf(() => h.engine.control(plan.id, { action: badAction }))).toBe(400);
    expect(() => h.engine.control(plan.id, { action: badAction })).toThrow(/unknown control action/);
    expect(statusOf(() => h.engine.control("not-a-plan", { action: "pause" }))).toBe(404);
  });

  it("pauses a waiting plan, survives a restart, and restores the wait", () => {
    const h = harness();
    const plan = h.engine.create({
      botId: "bot-1",
      steps: ["prep", { title: "collect the budget", kind: "input" }, "ship"],
      actorId: "worker-a",
    });
    h.engine.completeStep(plan.id, 1);
    const waiting = h.engine.requestInput(plan.id, {
      prompt: "What is the budget?",
      fields: [{ name: "budget", type: "number" }],
    });
    expect(waiting.status).toBe("waiting_input");
    expect(waiting.lease).toBeUndefined();
    expect(waiting.currentStep).toBe(2);

    const paused = h.engine.control(plan.id, { action: "pause", reason: "asked offline" });
    expect(paused.status).toBe("paused");
    expect(paused.pausedFrom).toBe("waiting_input");
    expect(paused.inputRequest?.prompt).toBe("What is the budget?");

    // The restart keeps both halves: the pause and the question itself.
    const boot = h.restart();
    const back = boot.plan(plan.id)!;
    expect(back.status).toBe("paused");
    expect(back.pausedFrom).toBe("waiting_input");
    expect(back.inputRequest).toEqual(paused.inputRequest);

    const resumed = boot.control(plan.id, { action: "resume" });
    expect(resumed.status).toBe("waiting_input");
    expect(resumed.pausedFrom).toBeUndefined();
    expect(resumed.inputRequest?.step).toBe(2);

    const answered = boot.submitInput(plan.id, { answers: { budget: 1200 }, actorId: "human" });
    expect(answered.status).toBe("running");
    expect(answered.inputRequest).toBeUndefined();
    expect(answered.inputAnswers).toEqual([{ name: "budget", value: 1200, at: expect.any(Number) }]);
    expect(answered.currentStep).toBe(2);
    expect(answered.lease?.holder).toBe("human");
    expect(h.disk().plans[0]?.inputAnswers).toHaveLength(1);
  });
});

describe("TaskPlanEngine — typed input", () => {
  function withInputStep(h: ReturnType<typeof harness>) {
    const plan = h.engine.create({
      botId: "bot-1",
      steps: ["prep", { title: "pick a tier", kind: "input" }, "ship"],
      actorId: "worker-a",
    });
    h.engine.completeStep(plan.id, 1);
    h.engine.requestInput(plan.id, {
      prompt: "Which tier should we buy?",
      fields: [
        { name: "deadline", label: "Deadline", type: "text" },
        { name: "seats", label: "Seats", type: "number" },
        { name: "urgent", label: "Urgent", type: "boolean", required: false },
        { name: "tier", label: "Tier", type: "select", options: ["basic", "pro"] },
      ],
    });
    return plan;
  }

  it("validates typed answers before storing any of them", () => {
    const h = harness();
    const plan = withInputStep(h);
    const ask = (answers: Record<string, string | number | boolean | null>) => () =>
      h.engine.submitInput(plan.id, { answers });

    expect(statusOf(ask({ seats: 3, tier: "pro" }))).toBe(400);
    expect(ask({ seats: 3, tier: "pro" })).toThrow(/field "deadline" is required/);
    expect(ask({ deadline: "friday", seats: "many", tier: "pro" })).toThrow(/needs a number/);
    expect(ask({ deadline: "friday", seats: 3, tier: "enterprise" })).toThrow(/must be one of basic, pro/);
    // Nothing landed: a rejected answer leaves the plan waiting.
    expect(h.engine.plan(plan.id)?.status).toBe("waiting_input");
    expect(h.engine.plan(plan.id)?.inputAnswers).toEqual([]);

    const answered = h.engine.submitInput(plan.id, {
      answers: { deadline: " friday ", seats: "42", urgent: false, tier: "pro", ignored: "extra" },
    });
    expect(answered.status).toBe("running");
    expect(answered.inputAnswers).toEqual([
      { name: "deadline", value: "friday", at: expect.any(Number) },
      { name: "seats", value: 42, at: expect.any(Number) },
      { name: "urgent", value: false, at: expect.any(Number) },
      { name: "tier", value: "pro", at: expect.any(Number) },
    ]);
    expect(answered.lease?.holder).toBe("harness");
    expect(h.disk().plans[0]?.inputAnswers).toHaveLength(4);
    // The same answer twice is refused: the request is gone.
    expect(statusOf(() => h.engine.submitInput(plan.id, { answers: { deadline: "x", seats: 1, tier: "pro" } }))).toBe(
      409,
    );
  });

  it("survives a restart while still waiting for the answer", () => {
    const h = harness();
    const plan = withInputStep(h);
    const before = h.engine.plan(plan.id)!;

    const boot = h.restart();
    const after = boot.plan(plan.id)!;
    expect(after.status).toBe("waiting_input");
    expect(after.inputRequest).toEqual(before.inputRequest);
    expect(after.currentStep).toBe(2);

    const answered = boot.submitInput(plan.id, { answers: { deadline: "friday", seats: 2, tier: "basic" } });
    expect(answered.status).toBe("running");
    expect(answered.inputAnswers).toHaveLength(3);

    // And a second restart keeps the answers that already landed — the
    // plan itself parks, because nothing can still be mid-run after a boot.
    const again = h.restart();
    expect(again.plan(plan.id)?.status).toBe("paused");
    expect(again.plan(plan.id)?.pausedFrom).toBe("running");
    expect(again.plan(plan.id)?.inputAnswers).toHaveLength(3);
  });

  it("only lets the right kind of step ask, and only while running", () => {
    const h = harness();
    const checkpoint = h.engine.create({ botId: "bot-1", steps: ["draft", "review"] });
    expect(statusOf(() => h.engine.requestInput(checkpoint.id, { prompt: "?", fields: [{ name: "a" }] }))).toBe(409);
    expect(() => h.engine.requestInput(checkpoint.id, { prompt: "?", fields: [{ name: "a" }] })).toThrow(
      /only an input step/,
    );
    expect(statusOf(() => h.engine.requestApproval(checkpoint.id))).toBe(409);
    expect(() => h.engine.requestApproval(checkpoint.id)).toThrow(/only an approval step/);
    expect(statusOf(() => h.engine.requestInput(checkpoint.id, { fields: [{ name: "a" }] }))).toBe(400);
    expect(statusOf(() => h.engine.requestInput(checkpoint.id, { prompt: "?", fields: [] }))).toBe(400);

    const plan = h.engine.create({ botId: "bot-1", steps: [{ title: "ask", kind: "input" }] });
    h.engine.control(plan.id, { action: "pause" });
    expect(statusOf(() => h.engine.requestInput(plan.id, { prompt: "?", fields: [{ name: "a" }] }))).toBe(409);
    expect(() => h.engine.requestInput(plan.id, { prompt: "?", fields: [{ name: "a" }] })).toThrow(
      /cannot request input on a plan in state paused/,
    );
  });
});

describe("TaskPlanEngine — approvals", () => {
  function withApprovalStep(h: ReturnType<typeof harness>) {
    const plan = h.engine.create({
      botId: "bot-1",
      steps: ["prep", { title: "legal sign-off", kind: "approval" }, "publish"],
      actorId: "worker-a",
    });
    h.engine.completeStep(plan.id, 1);
    return plan;
  }

  it("stops for a human, resumes on approve, and closes on reject", () => {
    const h = harness();
    const plan = withApprovalStep(h);

    const waiting = h.engine.requestApproval(plan.id, { actorId: "worker-a" });
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.approvalRequest).toEqual({
      title: "legal sign-off",
      step: 2,
      askedAt: expect.any(Number),
      by: "worker-a",
    });
    expect(waiting.lease).toBeUndefined();

    const approved = h.engine.decideApproval(plan.id, { decision: "approve", actorId: "human" });
    expect(approved.status).toBe("running");
    expect(approved.approvalRequest).toBeUndefined();
    expect(approved.lease?.holder).toBe("human");
    expect(approved.currentStep).toBe(2);

    // Ask again on the same step, then reject: the plan closes out and
    // everything it had not finished is visibly skipped.
    h.engine.requestApproval(plan.id, { actorId: "worker-a" });
    const rejected = h.engine.decideApproval(plan.id, { decision: "reject", actorId: "human", reason: "too risky" });
    expect(rejected.status).toBe("cancelled");
    expect(rejected.lastError).toBe("too risky");
    expect(rejected.steps.map((step) => step.status)).toEqual(["done", "skipped", "skipped"]);
    expect(rejected.currentStep).toBe(2);
    expect(rejected.lease).toBeUndefined();
    expect(h.disk().plans[0]?.status).toBe("cancelled");
  });

  it("refuses decisions that are not on the table", () => {
    const h = harness();
    const plan = withApprovalStep(h);
    expect(statusOf(() => h.engine.decideApproval(plan.id, { decision: "approve" }))).toBe(409);
    expect(() => h.engine.decideApproval(plan.id, { decision: "approve" })).toThrow(
      /nothing on this plan is waiting for approval/,
    );
    h.engine.requestApproval(plan.id);
    // SAFETY: an invalid decision string is what proves the 400 guard —
    // decideApproval must reject it at runtime.
    const badDecision = "maybe" as "approve";
    expect(statusOf(() => h.engine.decideApproval(plan.id, { decision: badDecision }))).toBe(400);
    expect(h.engine.plan(plan.id)?.status).toBe("waiting_approval");
    expect(statusOf(() => h.engine.completeStep(plan.id, 2))).toBe(409);
  });
});

describe("TaskPlanEngine — leases, retries and recovery", () => {
  it("refuses a second worker while the lease is live and hands over after expiry", () => {
    const h = harness({ leaseMs: 60_000 });
    const plan = h.engine.create({ botId: "bot-1", steps: ["one"], actorId: "worker-a" });
    expect(statusOf(() => h.engine.acquire(plan.id, "worker-b"))).toBe(409);
    expect(() => h.engine.acquire(plan.id, "worker-b")).toThrow(/leased to worker-a/);
    expect(statusOf(() => h.engine.heartbeat(plan.id, "worker-b"))).toBe(409);
    expect(statusOf(() => h.engine.acquire(plan.id, "  "))).toBe(400);
    // The holder may re-claim its own lease.
    expect(h.engine.acquire(plan.id, "worker-a").lease?.holder).toBe("worker-a");

    // Once the lease is stale its holder is gone, so the claim is handed
    // over instead of wedged until a restart.
    h.advance(60_001);
    expect(h.engine.acquire(plan.id, "worker-b").lease?.holder).toBe("worker-b");
    expect(h.engine.plan(plan.id)?.status).toBe("running");

    h.engine.control(plan.id, { action: "pause" });
    h.advance(1);
    expect(statusOf(() => h.engine.acquire(plan.id, "worker-c"))).toBe(409);
    expect(() => h.engine.acquire(plan.id, "worker-c")).toThrow(/only a running plan can be leased/);
  });

  it("parks a running plan whose lease runs out, and resumes it on demand", () => {
    const h = harness({ leaseMs: 60_000 });
    const plan = h.engine.create({ botId: "bot-1", steps: ["one"], actorId: "worker-a" });

    h.advance(30_000);
    // A heartbeat pushes the deadline out from now, not from the claim.
    expect(h.engine.heartbeat(plan.id, "worker-a").lease?.expiresAt).toBe(h.now() + 60_000);
    h.advance(55_000);
    expect(h.engine.sweep()).toBe(0);
    expect(h.engine.plan(plan.id)?.status).toBe("running");

    h.advance(10_000);
    expect(h.engine.sweep()).toBe(1);
    expect(h.engine.sweep()).toBe(0);
    const parked = h.engine.plan(plan.id)!;
    expect(parked.status).toBe("paused");
    expect(parked.pausedFrom).toBe("running");
    expect(parked.lastError).toBe("worker lease expired");
    expect(parked.lease).toBeUndefined();
    expect(statusOf(() => h.engine.heartbeat(plan.id, "worker-a"))).toBe(409);
    expect(statusOf(() => h.engine.completeStep(plan.id, 1))).toBe(409);

    const resumed = h.engine.control(plan.id, { action: "resume", actorId: "worker-a" });
    expect(resumed.status).toBe("running");
    expect(resumed.lastError).toBeUndefined();
    expect(resumed.lease?.expiresAt).toBe(h.now() + 60_000);
    expect(h.disk().plans[0]?.status).toBe("running");
  });

  it("counts failures against the attempt budget across a restart", () => {
    const h = harness({ maxAttempts: 2 });
    const plan = h.engine.create({ botId: "bot-1", steps: ["one"] });
    h.engine.failStep(plan.id, 1, { error: "the API said no" });
    const failed = h.engine.plan(plan.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe("the API said no");
    expect(failed.steps[0]?.status).toBe("failed");
    expect(statusOf(() => h.engine.completeStep(plan.id, 1))).toBe(409);

    const boot = h.restart();
    expect(boot.plan(plan.id)?.attempts).toBe(1);
    const retried = boot.control(plan.id, { action: "retry", actorId: "worker-a" });
    expect(retried.status).toBe("running");
    expect(retried.steps[0]?.status).toBe("active");
    expect(retried.lastError).toBeUndefined();
    expect(retried.lease?.holder).toBe("worker-a");

    boot.failStep(plan.id, 1, { error: "still no" });
    expect(boot.plan(plan.id)?.attempts).toBe(2);
    expect(statusOf(() => boot.control(plan.id, { action: "retry" }))).toBe(409);
    expect(() => boot.control(plan.id, { action: "retry" })).toThrow(/start a new plan instead/);
    // A spent plan can still be closed out.
    expect(boot.control(plan.id, { action: "cancel" }).status).toBe("cancelled");
  });

  it("parks nothing that is not running and leaves waiting plans alone", () => {
    const h = harness();
    const waiting = h.engine.create({ botId: "bot-1", steps: [{ title: "ask", kind: "input" }] });
    h.engine.requestInput(waiting.id, { prompt: "Need input", fields: [{ name: "a" }] });
    const queued = h.engine.create({ botId: "bot-1", steps: ["one"], start: false });
    const done = h.engine.create({ botId: "bot-1", steps: ["one"] });
    h.engine.completeStep(done.id, 1);

    expect(h.engine.sweep()).toBe(0);
    const boot = h.restart();
    expect(boot.plan(waiting.id)?.status).toBe("waiting_input");
    expect(boot.plan(waiting.id)?.inputRequest?.prompt).toBe("Need input");
    expect(boot.plan(queued.id)?.status).toBe("queued");
    expect(boot.plan(done.id)?.status).toBe("succeeded");
    expect(boot.sweep()).toBe(0);
  });
});

describe("TaskPlanEngine — persistence", () => {
  it("rolls back memory and publishes nothing when the write fails", () => {
    // A path that is a directory: the atomic rename cannot land on it.
    const blocked = tempFile();
    mkdirSync(blocked);
    const h = harness({ file: blocked });
    expect(() => h.engine.create({ botId: "bot-1", steps: ["one"] })).toThrow();
    expect(h.engine.listPlans()).toEqual([]);
    expect(h.emitted).toHaveLength(0);

    // Now a healthy store, then break the file underneath it mid-flight.
    const healthy = harness();
    const plan = healthy.engine.create({ botId: "bot-1", steps: ["one"] });
    const before = healthy.disk();
    rmSync(healthy.file);
    mkdirSync(healthy.file);
    expect(() => healthy.engine.control(plan.id, { action: "pause" })).toThrow();
    expect(healthy.engine.plan(plan.id)?.status).toBe("running");
    expect(() => healthy.engine.failStep(plan.id, 1)).toThrow();
    expect(healthy.engine.plan(plan.id)?.attempts).toBe(0);
    expect(healthy.emitted.filter((frame) => frame.kind === "taskPlan")).toHaveLength(1);
    expect(before.plans[0]?.status).toBe("running");
    expect(before.version).toBe(1);
  });

  it("never prunes live work, and keeps the transition ring bounded", () => {
    const h = harness({ maxPlans: 2 });
    const first = h.engine.create({ botId: "bot-1", steps: ["a"] });
    const second = h.engine.create({ botId: "bot-1", steps: ["b"] });
    const third = h.engine.create({ botId: "bot-1", steps: ["c"] });
    // Three live plans over a cap of two: none of them can be dropped.
    expect(h.engine.listPlans().map((plan) => plan.id)).toEqual([third.id, second.id, first.id]);

    h.engine.control(first.id, { action: "cancel" });
    const fourth = h.engine.create({ botId: "bot-1", steps: ["d"] });
    const ids = h.engine.listPlans().map((plan) => plan.id);
    expect(ids).not.toContain(first.id);
    expect(ids).toEqual(expect.arrayContaining([fourth.id, second.id, third.id]));

    const busy = h.engine.create({ botId: "bot-1", steps: ["work"] });
    for (let i = 0; i < 110; i += 1) {
      h.engine.control(busy.id, { action: "pause" });
      h.engine.control(busy.id, { action: "resume" });
    }
    const trail = h.engine.transitionsFor(busy.id);
    expect(trail.length).toBe(MAX_TRANSITIONS);
    expect(trail.at(-1)?.action).toBe("resume");
    expect(h.disk().transitions).toHaveLength(MAX_TRANSITIONS);
    expect(h.disk().transitions.at(-1)?.action).toBe("resume");
  });

  it("isolates plans by bot in listings", () => {
    const h = harness();
    h.engine.create({ botId: "bot-1", steps: ["a"] });
    h.engine.create({ botId: "bot-2", steps: ["b"], start: false });
    expect(h.engine.listPlans({ botId: "bot-1" })).toHaveLength(1);
    expect(h.engine.listPlans({ botId: "bot-1" })[0]?.botId).toBe("bot-1");
    expect(h.engine.listPlans({ botId: "bot-3" })).toHaveLength(0);
    expect(h.engine.listPlans()).toHaveLength(2);
    expect(h.engine.plan("nope")).toBeNull();
    expect(statusOf(() => h.engine.control("nope", { action: "pause" }))).toBe(404);
  });
});
