// Durable task plans: a checkpointed status machine for work a bot drives
// on a human's behalf, with pause/resume/cancel/retry, typed input
// requests and human approvals that all survive a restart.
//
// The engine is the ledger, not the dispatcher — nothing here runs a turn.
// A caller (a worker, a route, a future harness seam) moves a plan through
// `queued → running → waiting_* → …` and the engine guarantees every move
// is legal, ordered, leased and flushed to disk before anyone is told
// about it. Keeping dispatch out of this file is what lets the tests drive
// the whole machine without a server, and what keeps the seam additive.
//
// Two invariants hold everything together:
//   1. Legal moves come from one table, so an illegal control verb is a
//      409 instead of a silent no-op or a corrupted record.
//   2. Every mutation runs inside a transaction frame: the record set is
//      snapshotted, mutated, written atomically and only then published.
//      A failed write rolls memory back to what is actually on disk.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import { writeFileAtomic } from "./atomic.ts";
import { isText } from "./http-helpers.ts";
import type { JsonPrimitive } from "./schema.ts";
import type {
  TaskApprovalBody,
  TaskControlAction,
  TaskControlBody,
  TaskInputBody,
  TaskPlanAnswer,
  TaskPlanCreateInput,
  TaskPlanFieldEntry,
  TaskPlanInputField,
  TaskPlanRecord,
  TaskPlanStatus,
  TaskPlanStep,
  TaskPlanStepEntry,
  TaskStepKind,
  TaskTransitionEvent,
} from "./contracts.ts";

/** Frames the engine publishes on every change, stamped with the owning
 * bot so the multi-tenant stream filter can drop foreign plans. */
export type TaskPlanEvent =
  | { kind: "taskPlan"; botId: string; plan: TaskPlanRecord }
  | { kind: "taskTransition"; botId: string; transition: TaskTransitionEvent };

/** A plan is at most this many ordered steps: the approval card has to
 * stay readable and the machine has to stay bounded. */
export const MAX_PLAN_STEPS = 12;
export const MAX_PLAN_FIELDS = 8;
/** How long a worker's lease survives without a heartbeat. */
export const DEFAULT_LEASE_MS = 5 * 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** What the file keeps before the oldest resting plan / transition goes. */
export const MAX_PLANS = 200;
export const MAX_TRANSITIONS = 200;

const MAX_TITLE = 200;
const MAX_STEP_TITLE = 200;
const MAX_PROMPT = 2_000;
const MAX_ERROR = 300;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const RESTING: readonly TaskPlanStatus[] = ["succeeded", "failed", "cancelled"];
const DEFAULT_HOLDER = "harness";

/** Legal moves out of each status. Terminal states have none, and a plan
 * that is waiting keeps its wait: only an answered input, an approval
 * decision or an explicit control verb can carry it elsewhere. */
const NEXT = {
  queued: ["running", "cancelled"],
  running: ["paused", "waiting_input", "waiting_approval", "succeeded", "failed", "cancelled"],
  waiting_input: ["running", "paused", "cancelled"],
  waiting_approval: ["running", "paused", "cancelled"],
  // resume restores `pausedFrom`, which is why the waiting states are legal
  // targets here as well as the plain running one.
  paused: ["running", "waiting_input", "waiting_approval", "cancelled"],
  failed: ["running", "cancelled"],
  succeeded: [],
  cancelled: [],
} satisfies Record<TaskPlanStatus, readonly TaskPlanStatus[]>;

export interface TaskPlanEngineOptions {
  /** Persisted record file. Defaults to `<DATA_DIR>/task-plans.json`. */
  file?: string;
  now?: () => number;
  /** How long a worker's lease survives without a heartbeat. */
  leaseMs?: number;
  /** Failures a plan may record before it refuses another retry. */
  maxAttempts?: number;
  maxPlans?: number;
  emit?: (payload: TaskPlanEvent) => void;
}

interface TaskPlanFile {
  version: 1;
  plans: TaskPlanRecord[];
  transitions: TaskTransitionEvent[];
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/** Only real strings count: anything else becomes an empty string,
 * which the callers then reject as missing. */
const text = (value: JsonPrimitive | undefined, max: number): string =>
  isText(value) ? value.trim().slice(0, max) : "";

// SAFETY: JSON.stringify can only emit JSON-compatible values, and every
// clone here is a TaskPlanRecord / TaskTransitionEvent / TaskPlanFile.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isStepKind = (value: string): value is TaskStepKind =>
  value === "checkpoint" || value === "input" || value === "approval";

const isInputType = (value: string): value is TaskPlanInputField["type"] =>
  value === "text" || value === "number" || value === "boolean" || value === "select";

const isControlAction = (value: string): value is TaskControlAction =>
  value === "start" || value === "pause" || value === "resume" || value === "cancel" || value === "retry";

/** Answers are primitives on the wire — one declared field, one value —
 * so a stray object, array or other malformed body is refused before any
 * individual field is even looked at. */
const answersSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

function clampAttempts(raw: number | undefined, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(10, Math.max(1, n));
}

/** Turn the client's loose entries into ordered, bounded steps. Steps are
 * numbered here and never renumber, so every later reference (answers,
 * checkpoints, approvals) can name a stable `n`. */
function normalizeSteps(raw: TaskPlanStepEntry[] | undefined): TaskPlanStep[] {
  if (!Array.isArray(raw)) fail(400, "the plan needs an ordered list of steps");
  if (raw.length < 1) fail(400, "the plan needs at least one step");
  if (raw.length > MAX_PLAN_STEPS) fail(400, `a plan can have at most ${MAX_PLAN_STEPS} steps`);
  return raw.map((entry, index) => {
    const title = text(isText(entry) ? entry : entry?.title, MAX_STEP_TITLE);
    if (!title) fail(400, `step ${index + 1} needs a title`);
    const kind = isText(entry) ? undefined : entry?.kind;
    if (kind !== undefined && !isStepKind(kind)) fail(400, `step ${index + 1} has an unknown kind`);
    return {
      n: index + 1,
      title,
      kind: kind !== undefined && isStepKind(kind) ? kind : "checkpoint",
      status: "pending",
    };
  });
}

function normalizeFields(raw: TaskPlanFieldEntry[] | undefined): TaskPlanInputField[] {
  if (!Array.isArray(raw) || raw.length < 1) fail(400, "the request needs at least one field");
  if (raw.length > MAX_PLAN_FIELDS) fail(400, `a request can ask at most ${MAX_PLAN_FIELDS} fields`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const name = text(entry?.name, 40);
    if (!FIELD_NAME.test(name)) fail(400, `field ${index + 1} needs a name like "deadline"`);
    if (seen.has(name)) fail(400, `duplicate field name "${name}"`);
    seen.add(name);
    const rawType = entry?.type ?? "text";
    if (!isInputType(rawType)) fail(400, `field "${name}" has an unknown type`);
    const declared = entry?.options;
    const options =
      rawType === "select"
        ? Array.isArray(declared)
          ? declared.map((option) => text(option, 80)).filter(Boolean)
          : []
        : undefined;
    if (rawType === "select" && !options?.length) fail(400, `field "${name}" needs at least one option`);
    const field: TaskPlanInputField = {
      name,
      label: text(entry?.label, 120) || name,
      type: rawType,
      required: entry?.required !== false,
    };
    if (options) field.options = options;
    return field;
  });
}

/** Validate and coerce one answer against its declared field. Throws
 * before anything is stored, so a half-filled form never half-applies. */
function coerceAnswer(field: TaskPlanInputField, raw: JsonPrimitive | undefined): string | number | boolean {
  const missing = raw === undefined || raw === null || (isText(raw) && !raw.trim());
  if (missing && field.required) fail(400, `field "${field.name}" is required`);
  if (missing) return "";
  if (field.type === "text") {
    // A non-string (a stray object or number) coerces to nothing, which a
    // required field must not accept as an answer.
    const value = text(raw, 4_000);
    if (!value) fail(400, `field "${field.name}" needs a value`);
    return value;
  }
  if (field.type === "number") {
    // Booleans are not numbers: Number(true) would silently answer 1.
    if (raw === true || raw === false) fail(400, `field "${field.name}" needs a number`);
    const value = isText(raw) ? Number(raw.trim()) : Number(raw);
    if (!Number.isFinite(value)) fail(400, `field "${field.name}" needs a number`);
    return value;
  }
  if (field.type === "boolean") {
    if (raw === true || raw === false) return raw;
    const value = String(raw).trim().toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
    return fail(400, `field "${field.name}" needs true or false`);
  }
  const value = text(raw, 200);
  if (!field.options?.includes(value)) {
    fail(400, `field "${field.name}" must be one of ${field.options?.join(", ") ?? ""}`);
  }
  return value;
}

/** The plan's step in flight: the one active step, else the last one that
 * was ever started (where a cancelled or failed plan stopped). */
function stepInFlight(steps: TaskPlanStep[]): TaskPlanStep | undefined {
  const active = steps.find((step) => step.status === "active");
  if (active) return active;
  let started: TaskPlanStep | undefined;
  for (const step of steps) if (step.startedAt != null) started = step;
  return started;
}

/** Durable checkpointed plans: ordered steps, legal control transitions,
 * a lease per running plan, typed input and approval waits, and a boot
 * recovery sweep — all in one atomically written JSON file so every state
 * on this list means the same thing before and after a restart. */
export class TaskPlanEngine {
  private readonly file: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly maxPlans: number;
  private readonly emit?: (payload: TaskPlanEvent) => void;
  private plans: TaskPlanRecord[] = [];
  private transitions: TaskTransitionEvent[] = [];
  /** Reentrancy depth for the transaction frame: only the outermost call
   * snapshots and restores, so nested helpers join their caller's frame. */
  private depth = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TaskPlanEngineOptions = {}) {
    this.file = options.file ?? join(DATA_DIR, "task-plans.json");
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxPlans = options.maxPlans ?? MAX_PLANS;
    this.emit = options.emit;
    try {
      // SAFETY: save() writes exactly the TaskPlanFile shape; a corrupt or
      // foreign file throws below and resets to an empty store.
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<TaskPlanFile>;
      this.plans = Array.isArray(disk.plans) ? disk.plans : [];
      this.transitions = Array.isArray(disk.transitions) ? disk.transitions : [];
    } catch {
      this.plans = [];
      this.transitions = [];
    }
    // A lease belongs to a worker that died with the process, so boot is
    // the one sweep that must run before anyone can touch the store. It is
    // deliberately not published — there are no clients yet — but it is
    // persisted, so what the file says and what memory says never diverge.
    if (this.recover()) this.persist();
  }

  /** Fire the lease sweep on an interval so a worker that dies mid-run
   * parks its plan without waiting for a restart. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        // A transient write failure. The lease is still expired next tick.
      }
    }, 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  listPlans(filter?: { botId?: string }): TaskPlanRecord[] {
    const source = filter?.botId ? this.plans.filter((plan) => plan.botId === filter.botId) : this.plans;
    return source.map((plan) => clone(plan));
  }

  plan(id: string): TaskPlanRecord | null {
    const found = this.plans.find((plan) => plan.id === id);
    return found ? clone(found) : null;
  }

  /** Audit trail for one plan (or every plan), oldest first. */
  transitionsFor(planId?: string): TaskTransitionEvent[] {
    const source = planId ? this.transitions.filter((event) => event.planId === planId) : this.transitions;
    return source.map((event) => clone(event));
  }

  create(input: TaskPlanCreateInput): TaskPlanRecord {
    return this.tx(() => {
      const botId = text(input?.botId, 120);
      if (!botId) fail(400, "Choose a bot");
      const title = text(input?.title, MAX_TITLE) || "Task plan";
      const steps = normalizeSteps(input?.steps);
      const events: TaskTransitionEvent[] = [];
      const at = this.now();
      const plan: TaskPlanRecord = {
        id: randomUUID(),
        botId,
        ownerId: text(input?.ownerId, 120) || undefined,
        threadId: text(input?.threadId, 120) || undefined,
        title,
        status: "queued",
        steps,
        currentStep: null,
        attempts: 0,
        maxAttempts: clampAttempts(input?.maxAttempts, this.maxAttempts),
        inputAnswers: [],
        createdAt: at,
        updatedAt: at,
      };
      this.plans.unshift(plan);
      this.prune();
      // A plan nobody starts would be dead on arrival: the API has no
      // scheduler waiting to pick up queued work. `start: false` is how a
      // caller opts out and holds the plan queued until it says go.
      if (input?.start !== false) this.startPlan(plan, input?.actorId, events);
      this.persist();
      this.publish(events, [plan]);
      return clone(plan);
    });
  }

  /** One control verb from the client. Unknown verbs are a 400; a legal
   * verb aimed at a status that cannot take it is a 409. */
  control(id: string, body: TaskControlBody): TaskPlanRecord {
    const action = text(body == null ? undefined : body.action, 40);
    if (!isControlAction(action)) {
      fail(400, `unknown control action "${action || "?"}" — use start, pause, resume, cancel or retry`);
    }
    const actorId = text(body?.actorId, 120);
    const reason = text(body?.reason, MAX_ERROR);
    return this.tx(() => {
      const plan = this.requirePlan(id);
      const events: TaskTransitionEvent[] = [];
      switch (action) {
        case "start":
          this.startPlan(plan, actorId, events);
          break;
        case "pause":
          this.pausePlan(plan, actorId, reason, events);
          break;
        case "resume":
          this.resumePlan(plan, actorId, events);
          break;
        case "cancel":
          this.cancelPlan(plan, actorId, reason, events);
          break;
        default:
          this.retryPlan(plan, actorId, events);
          break;
      }
      this.persist();
      this.publish(events, [plan]);
      return clone(plan);
    });
  }

  /** Block an input step until the human answers. The question itself is
   * part of the record, so it outlives a restart like everything else. */
  requestInput(
    id: string,
    input: { prompt?: string; fields?: TaskPlanFieldEntry[]; actorId?: string },
  ): TaskPlanRecord {
    const prompt = text(input?.prompt, MAX_PROMPT);
    if (!prompt) fail(400, "Say what you need from the human");
    const fields = normalizeFields(input?.fields);
    const actorId = text(input?.actorId, 120);
    return this.tx(() => {
      const plan = this.requirePlan(id);
      this.requireStatus(plan, "request input on", ["running"]);
      const active = this.requireActive(plan, "ask for input");
      if (active.kind !== "input") {
        fail(409, `step ${active.n} is a ${active.kind} step — only an input step can ask for typed answers`);
      }
      const events: TaskTransitionEvent[] = [];
      const event = this.move(plan, "waiting_input", "request-input", events, { step: active.n, actorId });
      plan.inputRequest = { prompt, fields, step: event.step ?? active.n, askedAt: this.now() };
      this.persist();
      this.publish(events, [plan]);
      return clone(plan);
    });
  }

  /** Answer a waiting input request. Every required field is validated
   * before anything is stored, then the plan returns to running. */
  submitInput(id: string, body: TaskInputBody): TaskPlanRecord {
    const actorId = text(body?.actorId, 120);
    const parsed = answersSchema.safeParse(body == null ? undefined : body.answers);
    if (!parsed.success) fail(400, "answers must be an object of field values");
    const answers = parsed.data;
    return this.tx(() => {
      const plan = this.requirePlan(id);
      const request = plan.inputRequest;
      if (!request) fail(409, "nothing on this plan is waiting for input");
      const recorded: TaskPlanAnswer[] = [];
      for (const field of request.fields) {
        const answer = coerceAnswer(field, answers[field.name]);
        if (answer === "" && !field.required) continue;
        recorded.push({ name: field.name, value: answer, at: this.now() });
      }
      const events: TaskTransitionEvent[] = [];
      this.move(plan, "running", "submit-input", events, { step: request.step, actorId });
      plan.inputRequest = undefined;
      plan.inputAnswers.push(...recorded);
      if (plan.inputAnswers.length > 200) plan.inputAnswers.splice(0, plan.inputAnswers.length - 200);
      plan.lastError = undefined;
      this.persist();
      this.publish(events, [plan]);
      return clone(plan);
    });
  }

  /** Stop an approval step for a human decision. */
  requestApproval(id: string, input: { title?: string; actorId?: string } = {}): TaskPlanRecord {
    const actorId = text(input?.actorId, 120);
    return this.tx(() => {
      const plan = this.requirePlan(id);
      this.requireStatus(plan, "request approval on", ["running"]);
      const active = this.requireActive(plan, "ask for approval");
      if (active.kind !== "approval") {
        fail(409, `step ${active.n} is a ${active.kind} step — only an approval step can stop for a human`);
      }
      const events: TaskTransitionEvent[] = [];
      const event = this.move(plan, "waiting_approval", "request-approval", events, {
        step: active.n,
        actorId,
      });
      plan.approvalRequest = {
        title: text(input?.title, MAX_TITLE) || active.title,
        step: event.step ?? active.n,
        askedAt: this.now(),
        by: actorId || undefined,
      };
      this.persist();
      this.publish(events, [plan]);
      return clone(plan);
    });
  }

  /** The human's decision: approve sends the plan back to running, reject
   * closes it out with the reason recorded as the plan's last error. */
  decideApproval(id: string, body: TaskApprovalBody): TaskPlanRecord {
    const decision = text(body?.decision, 20);
    if (decision !== "approve" && decision !== "reject") {
      fail(400, `decision must be "approve" or "reject"`);
    }
    const actorId = text(body?.actorId, 120);
    const reason = text(body?.reason, MAX_ERROR);
    return this.tx(() => {
      const plan = this.requirePlan(id);
      const request = plan.approvalRequest;
      if (!request) fail(409, "nothing on this plan is waiting for approval");
      const events: TaskTransitionEvent[] = [];
      if (decision === "approve") {
        this.move(plan, "running", "approve", events, { step: request.step, actorId, reason });
        plan.approvalRequest = undefined;
        plan.lastError = undefined;
      } else {
        this.move(plan, "cancelled", "reject", events, { step: request.step, actorId, reason });
        plan.approvalRequest = undefined;
        this.markUnfinishedSkipped(plan);
        plan.lastError = reason || "the human rejected this plan";
      }
      this.persist();
      this.publish(events, [plan]);
      return clone(plan);
    });
  }

  /** Report the active checkpoint done. Steps only ever complete in
   * order: naming any other step is refused rather than silently
   * accepted, which is what keeps the card's progress honest. */
  completeStep(id: string, n: number, actorId?: string): TaskPlanRecord {
    return this.tx(() => {
      const plan = this.requirePlan(id);
      if (plan.status !== "running") fail(409, `cannot complete a step while the plan is ${plan.status}`);
      const active = this.requireActive(plan, "complete a step");
      this.requireActiveN(active, n, "complete");
      const events: TaskTransitionEvent[] = [];
      active.status = "done";
      active.finishedAt = this.now();
      const next = plan.steps.find((step) => step.status === "pending");
      if (next) {
        next.status = "active";
        next.startedAt = this.now();
        this.jump(plan, "running", "complete", events, { step: n, actorId });
      } else {
        this.move(plan, "succeeded", "complete", events, { step: n, actorId });
        plan.lastError = undefined;
      }
      this.persist();
      this.publish(events, [plan]);
      return clone(plan);
    });
  }

  /** Report the active checkpoint failed. The failure counts against the
   * plan's attempt budget, which is what bounds a retry loop. */
  failStep(id: string, n: number, input: { error?: string; actorId?: string } = {}): TaskPlanRecord {
    const error = text(input?.error, MAX_ERROR);
    const actorId = text(input?.actorId, 120);
    return this.tx(() => {
      const plan = this.requirePlan(id);
      if (plan.status !== "running") fail(409, `cannot fail a step while the plan is ${plan.status}`);
      const active = this.requireActive(plan, "fail a step");
      this.requireActiveN(active, n, "fail");
      const events: TaskTransitionEvent[] = [];
      active.status = "failed";
      active.finishedAt = this.now();
      plan.attempts += 1;
      this.move(plan, "failed", "fail", events, { step: n, actorId, reason: error });
      plan.lastError = error || `step ${n} failed`;
      this.persist();
      this.publish(events, [plan]);
      return clone(plan);
    });
  }

  /** Claim the running plan for a worker. This is the compare-and-set:
   * a live lease held by someone else is refused instead of stolen, and
   * an expired one is handed over, because its holder is gone. */
  acquire(id: string, holder: string, ttlMs?: number): TaskPlanRecord {
    const name = text(holder, 120);
    if (!name) fail(400, "Name the worker taking the lease");
    const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : this.leaseMs;
    return this.tx(() => {
      const plan = this.requirePlan(id);
      if (plan.status !== "running") {
        fail(409, `only a running plan can be leased — this one is ${plan.status}`);
      }
      if (this.leaseValid(plan) && plan.lease?.holder !== name) {
        fail(409, `this plan is leased to ${plan.lease?.holder ?? "another worker"}`);
      }
      plan.lease = { holder: name, expiresAt: this.now() + ttl };
      plan.updatedAt = this.now();
      this.persist();
      this.publish([], [plan]);
      return clone(plan);
    });
  }

  /** Extend a lease the caller already holds. A holder that stops beating
   * loses the plan to the sweep — that is the whole point of the lease. */
  heartbeat(id: string, holder: string): TaskPlanRecord {
    const name = text(holder, 120);
    return this.tx(() => {
      const plan = this.requirePlan(id);
      if (plan.status !== "running") fail(409, `this plan is ${plan.status} — nothing to heartbeat`);
      if (!name || plan.lease?.holder !== name) fail(409, "you do not hold this plan's lease");
      plan.lease = { holder: name, expiresAt: this.now() + this.leaseMs };
      plan.updatedAt = this.now();
      this.persist();
      this.publish([], [plan]);
      return clone(plan);
    });
  }

  /** Park every running plan whose lease ran out. Returns how many moved. */
  sweep(): number {
    return this.tx(() => {
      const events: TaskTransitionEvent[] = [];
      const parked: TaskPlanRecord[] = [];
      let changed = false;
      for (const plan of this.plans) {
        if (plan.status === "running" && !this.leaseValid(plan)) {
          parked.push(this.park(plan, "worker lease expired", events));
          changed = true;
        } else if (plan.lease && plan.status !== "running") {
          plan.lease = undefined;
          changed = true;
        }
      }
      if (!changed) return 0;
      this.persist();
      this.publish(events, parked);
      return events.length;
    });
  }

  // ── transitions ────────────────────────────────────────────────────

  /** Each verb has its own source states: the target-side table cannot
   * tell `retry` from `resume`, since both land on running, and retrying
   * something that never failed would skip the attempt budget. */
  private requireStatus(plan: TaskPlanRecord, verb: string, allowed: readonly TaskPlanStatus[]): void {
    if (!allowed.includes(plan.status)) fail(409, `cannot ${verb} a plan in state ${plan.status}`);
  }

  private startPlan(plan: TaskPlanRecord, actorId: string | undefined, events: TaskTransitionEvent[]): void {
    this.requireStatus(plan, "start", ["queued"]);
    this.move(plan, "running", "start", events, { actorId });
    const first = plan.steps.find((step) => step.status === "pending");
    if (first) {
      first.status = "active";
      first.startedAt = this.now();
    }
    plan.lastError = undefined;
  }

  private pausePlan(
    plan: TaskPlanRecord,
    actorId: string | undefined,
    reason: string,
    events: TaskTransitionEvent[],
  ): void {
    this.requireStatus(plan, "pause", ["running", "waiting_input", "waiting_approval"]);
    const event = this.move(plan, "paused", "pause", events, { actorId, reason });
    // Remember the wait, so resuming puts the plan back where it was
    // instead of dropping the question the human had not answered yet.
    plan.pausedFrom = event.from;
    plan.lastError = reason || undefined;
  }

  private resumePlan(plan: TaskPlanRecord, actorId: string | undefined, events: TaskTransitionEvent[]): void {
    this.requireStatus(plan, "resume", ["paused"]);
    let target: TaskPlanStatus = plan.pausedFrom ?? "running";
    // A wait whose request is gone (a hand-edited file) cannot be restored;
    // fall back to running rather than parking the plan forever.
    if (target === "waiting_input" && !plan.inputRequest) target = "running";
    if (target === "waiting_approval" && !plan.approvalRequest) target = "running";
    this.move(plan, target, "resume", events, { actorId });
    plan.pausedFrom = undefined;
    plan.lastError = undefined;
  }

  private cancelPlan(
    plan: TaskPlanRecord,
    actorId: string | undefined,
    reason: string,
    events: TaskTransitionEvent[],
  ): void {
    this.requireStatus(plan, "cancel", ["queued", "running", "waiting_input", "waiting_approval", "paused", "failed"]);
    this.move(plan, "cancelled", "cancel", events, { actorId, reason });
    this.markUnfinishedSkipped(plan);
    plan.inputRequest = undefined;
    plan.approvalRequest = undefined;
    plan.pausedFrom = undefined;
    plan.lastError = reason || "cancelled";
  }

  private retryPlan(plan: TaskPlanRecord, actorId: string | undefined, events: TaskTransitionEvent[]): void {
    this.requireStatus(plan, "retry", ["failed"]);
    if (plan.attempts >= plan.maxAttempts) {
      fail(409, `this plan has already failed ${plan.attempts} time(s) — start a new plan instead`);
    }
    this.move(plan, "running", "retry", events, { actorId });
    const failed = plan.steps.find((step) => step.status === "failed");
    if (failed) {
      failed.status = "active";
      failed.finishedAt = undefined;
      failed.startedAt = failed.startedAt ?? this.now();
    } else {
      const first = plan.steps.find((step) => step.status === "pending");
      if (first) {
        first.status = "active";
        first.startedAt = this.now();
      }
    }
    plan.lastError = undefined;
  }

  /** A plan stopped mid-flight keeps no half-work: everything past the
   * step it was on is marked skipped, while `currentStep` still points at
   * the last step that ran (it was started, so the projection finds it). */
  private markUnfinishedSkipped(plan: TaskPlanRecord): void {
    for (const step of plan.steps) {
      if (step.status === "pending" || step.status === "active") step.status = "skipped";
    }
  }

  /** Boot / sweep: park interrupted work for an explicit resume instead of
   * auto-continuing something nobody asked to restart. */
  private park(plan: TaskPlanRecord, reason: string, events: TaskTransitionEvent[]): TaskPlanRecord {
    const event = this.move(plan, "paused", "recover", events, { reason });
    plan.pausedFrom = event.from;
    plan.lastError = reason;
    return plan;
  }

  /** Validate a move against the legality table, then apply it. */
  private move(
    plan: TaskPlanRecord,
    to: TaskPlanStatus,
    action: string,
    events: TaskTransitionEvent[],
    detail: { step?: number; actorId?: string; reason?: string } = {},
  ): TaskTransitionEvent {
    const legalMoves: readonly TaskPlanStatus[] = NEXT[plan.status];
    if (!legalMoves.includes(to)) {
      fail(409, `cannot ${action} a plan in state ${plan.status}`);
    }
    return this.jump(plan, to, action, events, detail);
  }

  /** Apply an already-validated move. The lease invariant lives here:
   * entering `running` always leases the plan to whoever caused it (a
   * fresh claim, never a stolen one), and leaving `running` always drops
   * the lease, so no status can carry a dead worker's claim. */
  private jump(
    plan: TaskPlanRecord,
    to: TaskPlanStatus,
    action: string,
    events: TaskTransitionEvent[],
    detail: { step?: number; actorId?: string; reason?: string },
  ): TaskTransitionEvent {
    const from = plan.status;
    plan.status = to;
    plan.updatedAt = this.now();
    // `pausedFrom` only means anything while the plan is paused; clearing
    // it on every other landing keeps a stale wait off the wire.
    if (to !== "paused") plan.pausedFrom = undefined;
    if (to === "running") {
      if (!this.leaseValid(plan)) {
        plan.lease = { holder: detail.actorId || DEFAULT_HOLDER, expiresAt: this.now() + this.leaseMs };
      }
    } else {
      plan.lease = undefined;
    }
    const event: TaskTransitionEvent = { planId: plan.id, botId: plan.botId, from, to, at: plan.updatedAt, action };
    if (detail.step !== undefined) event.step = detail.step;
    if (detail.actorId) event.actorId = detail.actorId;
    if (detail.reason) event.reason = detail.reason;
    events.push(event);
    this.transitions.push(event);
    if (this.transitions.length > MAX_TRANSITIONS) {
      this.transitions.splice(0, this.transitions.length - MAX_TRANSITIONS);
    }
    return event;
  }

  // ── store plumbing ─────────────────────────────────────────────────

  private requirePlan(id: string): TaskPlanRecord {
    const plan = this.plans.find((candidate) => candidate.id === text(id, 120));
    if (!plan) fail(404, "no such plan");
    return plan;
  }

  private requireActive(plan: TaskPlanRecord, verb: string): TaskPlanStep {
    const active = plan.steps.find((step) => step.status === "active");
    if (!active) fail(409, `no step is active — nothing to ${verb}`);
    return active;
  }

  private requireActiveN(active: TaskPlanStep, n: number, verb: string): void {
    if (active.n !== n) {
      fail(409, `step ${n} is not the active checkpoint — the plan is on step ${active.n} (${verb} ${active.n})`);
    }
  }

  private leaseValid(plan: TaskPlanRecord): boolean {
    return Boolean(plan.lease && plan.lease.expiresAt > this.now());
  }

  private prune(): void {
    const overflow = Math.max(0, this.plans.length - this.maxPlans);
    if (!overflow) return;
    // Resting plans only: never drop work that could still move.
    const doomed = this.plans
      .filter((plan) => RESTING.includes(plan.status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, overflow);
    const ids = new Set(doomed.map((plan) => plan.id));
    this.plans = this.plans.filter((plan) => !ids.has(plan.id));
  }

  /** Boot sweep: a lease cannot outlive the process that held it, and a
   * running plan was interrupted rather than finished. Waiting plans and
   * their requests are left exactly as they were written. */
  private recover(): boolean {
    const events: TaskTransitionEvent[] = [];
    let changed = false;
    for (const plan of this.plans) {
      if (plan.status === "running") {
        this.park(plan, "interrupted by restart", events);
        changed = true;
      } else if (plan.lease) {
        plan.lease = undefined;
        changed = true;
      }
    }
    return changed;
  }

  /** Run `fn` inside the transaction frame: snapshot, mutate, persist. If
   * anything throws — including the write itself — memory is restored to
   * what is on disk, so a caller never sees a state that did not land. */
  private tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    const before: TaskPlanFile = clone({ version: 1, plans: this.plans, transitions: this.transitions });
    this.depth = 1;
    try {
      const out = fn();
      this.depth = 0;
      return out;
    } catch (error) {
      this.depth = 0;
      this.plans = before.plans;
      this.transitions = before.transitions;
      throw error;
    }
  }

  private persist(): void {
    // `currentStep` is a projection of the steps; recomputing it here is
    // the one place it can be kept honest, for memory and disk alike.
    for (const plan of this.plans) plan.currentStep = stepInFlight(plan.steps)?.n ?? null;
    const file: TaskPlanFile = { version: 1, plans: this.plans, transitions: this.transitions };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(file, null, 2));
  }

  /** Publish only after the write lands, so a client that reacts to a
   * frame is reacting to state that is already durable. */
  private publish(events: TaskTransitionEvent[], plans: TaskPlanRecord[]): void {
    if (!this.emit) return;
    for (const event of events) this.emit({ kind: "taskTransition", botId: event.botId, transition: event });
    for (const plan of plans) this.emit({ kind: "taskPlan", botId: plan.botId, plan: clone(plan) });
  }
}
