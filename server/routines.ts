import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { evaluateSentryRun, sentryPromptSuffix, shouldSentryNotify } from "./sentry.ts";
import { whyPromptSuffix } from "./why-journal.ts";

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] };

/** `cloud` runs the agent itself inside the bot's Box VM. `agent` keeps
 * using the provider selected on the AGENT and only borrows its configured
 * computer tools, if any. */
export type RoutineRunOn = "agent" | "cloud" | "opensandbox";

export type RoutineRunTrigger = "schedule" | "manual" | "webhook";

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "missed";

/** One scorecard assertion: a deterministic check the harness evaluates
 * against the settled run's output (the ARC scorecard pattern — objective
 * pass/fail per run, so routines are comparable across runs and bots). */
export interface RoutineCheck {
  id: string;
  label: string;
  kind: "contains" | "not_contains" | "matches";
  /** contains/not_contains: a substring (case-insensitive); matches: a
   * JavaScript regex source (capped — ReDoS-prone patterns just fail). */
  value: string;
}

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  schedule: RoutineSchedule;
  durationMinutes: number;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Sentry mode: the bot re-watches on this cadence and only notifies
   * when the digest line changes (server/sentry.ts). */
  sentry?: boolean;
  /** Last digest the sentry saw — the baseline for the next diff. */
  lastDigest?: string | null;
  /** Overnight mode: total consecutive runs per firing (1 = normal single
   * run). Each iteration after the first chains through notesFile. */
  iterations?: number;
  /** Shared cross-iteration memory the bot reads and appends to — the
   * gnhf notes.md pattern: each run continues where the last stopped. */
  notesFile?: string;
  /** Scorecard assertions evaluated against the settled output. */
  checks?: RoutineCheck[];
  /** Dedicated results thread: when set, every run of this routine
   * dispatches into THIS task instead of spawning a fresh one, so the
   * transcript becomes one continuous log with dated runs. A thread that
   * was deleted (or that the bot never owned) falls back to a fresh task
   * for that run — the routine never stalls on a missing destination. */
  destination?: string;
}

/** One evaluated assertion on a settled run. */
export interface ScorecardResult {
  id: string;
  label: string;
  passed: boolean;
  /** Why it failed, when it did — shown on the run card. */
  reason?: string;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  /** Snapshot the work so an edited/deleted definition cannot rewrite history. */
  prompt?: string;
  durationMinutes?: number;
  botId: string;
  runOn: RoutineRunOn;
  scheduledFor: number;
  status: RoutineRunStatus;
  manual: boolean;
  /** Why this receipt exists. Kept optional so version-1 files migrate in place. */
  triggerSource?: RoutineRunTrigger;
  webhookId?: string;
  deliveryId?: string;
  threadId?: string;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  cost?: number | null;
  denials?: string[];
  /** Overnight chain position: 1..iterations when the routine fires a
   * multi-run chain. Absent on ordinary single runs. */
  iteration?: number;
  createdAt: number;
  seenAt?: number;
  /** Sentry runs only: true when this run's digest changed (or the watch
   * failed) — i.e. the run was worth interrupting the user for. */
  changeDetected?: boolean;
  /** Scorecard results evaluated at settle; absent when the routine
   * defines no checks (or the run never settled with output). */
  scorecard?: ScorecardResult[];
}

export interface RoutineInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  schedule: RoutineSchedule;
  durationMinutes?: number;
  /** Watcher mode: the run's SENTRY digest is diffed against the previous
   * one and the user is only notified on change (or run failure). */
  sentry?: boolean;
  /** Overnight mode (the gnhf pattern): the routine fires `iterations`
   * consecutive runs instead of one, chaining through a shared notes file
   * so each iteration continues where the last stopped. */
  iterations?: number;
  notesFile?: string;
  /** Scorecard assertions (1-3) evaluated against each run's output. */
  checks?: RoutineCheck[];
  /** Dedicated results thread id: reuse that task for every run. */
  destination?: string;
}

interface RoutineFile {
  version: 1;
  routines: Routine[];
  runs: RoutineRun[];
}

/** Frames the manager publishes on the server's keyed event bus: every
 * payload leads with `kind`, which is what lets the bus number and replay
 * them. */
export type RoutineEvent =
  | { kind: "routine"; routine: Routine }
  | { kind: "routine.run"; run: RoutineRun }
  | { kind: "routine.deleted"; routineId: string };

export interface RoutineManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: RoutineEvent) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  createTask: (botId: string, title: string, activate?: boolean) => { threadId: string } | null;
  /** Liveness probe for a dedicated destination thread: returns the thread
   * id when that bot owns this task right now, else null. Dispatch reuses
   * the destination only on a live answer — the stored id is never trusted
   * on its own. */
  taskThread?: (botId: string, threadId: string) => string | null | undefined;
  startTurn: (
    botId: string,
    threadId: string,
    prompt: string,
    runOn: RoutineRunOn,
    triggerSource: RoutineRunTrigger,
    onDispatchError: (message: string) => void,
  ) => Promise<void>;
  interruptTurn?: (botId: string, threadId: string, runOn: RoutineRunOn) => Promise<void>;
  /** Sentry mode delivery: called when a sentry run's digest CHANGED (or
   * the run failed) — the moments a watcher is worth interrupting for.
   * Returns the run's task thread so the caller can route a notification. */
  onSentryAlert?: (run: RoutineRun, verdict: { changed: boolean; digest: string | null }) => void;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const CATCH_UP_MS = 12 * 60 * 60_000;
const MAX_RUNS = 2_000;

function cleanDays(days: ReadonlyArray<unknown> | undefined): number[] {
  if (!Array.isArray(days)) return ALL_DAYS;
  const out = [...new Set(days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return out.length ? out : ALL_DAYS;
}

function cleanSchedule(schedule: RoutineSchedule): RoutineSchedule {
  if (schedule?.type === "once") {
    const at = Number(schedule.at);
    if (!Number.isFinite(at)) throw new Error("Choose a valid date and time");
    return { type: "once", at };
  }
  if (schedule?.type === "daily") {
    const time = String(schedule.time ?? "");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Time must use HH:MM");
    return { type: "daily", time, weekdays: cleanDays(schedule.weekdays) };
  }
  throw new Error("Choose a supported schedule");
}

/** Next wall-clock occurrence in this computer's timezone, strictly after `after`. */
export function nextOccurrence(schedule: RoutineSchedule, after: number): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  const [hour, minute] = schedule.time.split(":").map(Number);
  const weekdays = new Set(cleanDays(schedule.weekdays));
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(after);
    d.setDate(d.getDate() + offset);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() > after && weekdays.has(d.getDay())) return d.getTime();
  }
  return null;
}

function sanitizeInput(input: RoutineInput): Omit<Routine, "id" | "createdAt" | "updatedAt" | "nextRunAt"> {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
  const botId = String(input.botId ?? "").trim();
  if (!name) throw new Error("Give the routine a name");
  if (!prompt) throw new Error("Tell the bot what to do");
  if (!botId) throw new Error("Choose a bot");
  const runOn = input.runOn ?? "agent";
  if (runOn !== "agent" && runOn !== "cloud" && runOn !== "opensandbox") throw new Error("Choose where this routine runs");
  return {
    name,
    prompt,
    botId,
    runOn,
    enabled: input.enabled !== false,
    schedule: cleanSchedule(input.schedule),
    durationMinutes: Math.min(240, Math.max(15, Math.round(Number(input.durationMinutes) || 30))),
    sentry: input.sentry === true,
    // Overnight loop: 1 = ordinary single run; 2-12 chains consecutive
    // runs through the notes file when one fires.
    iterations: input.iterations === undefined ? undefined : Math.min(12, Math.max(1, Math.round(Number(input.iterations) || 1))),
    notesFile: input.notesFile?.trim().slice(0, 300) || undefined,
    checks: sanitizeChecks(input.checks),
    destination: input.destination?.trim().slice(0, 64) || undefined,
  };
}

const CHECK_KINDS = ["contains", "not_contains", "matches"] as const;
const MAX_CHECKS = 3;
const MAX_CHECK_LABEL = 120;
const MAX_CHECK_VALUE = 300;

const checkSchema = z.object({
  id: z.string().max(64).optional(),
  label: z.string().max(MAX_CHECK_LABEL),
  kind: z.enum(CHECK_KINDS),
  value: z.string().max(MAX_CHECK_VALUE),
});

const checksSchema = z.array(checkSchema).max(MAX_CHECKS);

/** Validate 0-3 scorecard assertions: label + kind + value. A regex that
 * fails to compile is rejected here, not at run time — a broken check
 * should fail at save, not silently every run. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the /api/routines I/O boundary: checksSchema.safeParse IS the schema run
function sanitizeChecks(raw: unknown): RoutineCheck[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw) && raw.length === 0) return undefined;
  const parsed = checksSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`checks: ${issue?.message ?? "invalid check"}`);
  }
  return parsed.data.map((check) => {
    if (check.kind === "matches") {
      try {
        new RegExp(check.value);
      } catch {
        throw new Error(`check "${check.label}": "${check.value}" is not a valid regular expression`);
      }
      if (check.value.length > 200) throw new Error(`check "${check.label}": regex too long`);
    } else if (!check.value.trim()) {
      throw new Error(`check "${check.label}": give it something to look for`);
    }
    return { id: check.id?.trim() || randomUUID(), label: check.label.trim(), kind: check.kind, value: check.value.trim() };
  });
}

/** Evaluate a routine's checks against the settled output. Deterministic,
 * harness-side — the bot never grades itself. A run with no output fails
 * every check (nothing to pass on). */
export function evaluateScorecard(checks: RoutineCheck[] | undefined, output: string | undefined): ScorecardResult[] | undefined {
  if (!checks || checks.length === 0) return undefined;
  return checks.map((check) => {
    const text = output ?? "";
    try {
      if (check.kind === "contains") {
        const hit = text.toLowerCase().includes(check.value.toLowerCase());
        return { id: check.id, label: check.label, passed: hit, reason: hit ? undefined : `output does not contain "${check.value}"` };
      }
      if (check.kind === "not_contains") {
        const clean = !text.toLowerCase().includes(check.value.toLowerCase());
        return {
          id: check.id,
          label: check.label,
          passed: clean,
          reason: clean ? undefined : `output contains "${check.value}"`,
        };
      }
      const re = new RegExp(check.value);
      const hit = re.test(text);
      return { id: check.id, label: check.label, passed: hit, reason: hit ? undefined : `output does not match /${check.value}/` };
    } catch {
      // an invalid regex that slipped through (hand-edited file) fails the
      // check loudly rather than pretending it passed
      return { id: check.id, label: check.label, passed: false, reason: "check is misconfigured" };
    }
  });
}

export class RoutineManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: RoutineManagerOptions;
  private routines: Routine[] = [];
  private runs: RoutineRun[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: RoutineManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "routines.json");
    this.now = options.now ?? Date.now;
    try {
      // SAFETY: save() writes exactly the RoutineFile shape; a corrupt or
      // foreign file throws below and resets to an empty schedule.
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RoutineFile>;
      this.routines = Array.isArray(disk.routines)
        ? disk.routines.map((routine) => ({ ...routine, runOn: routine.runOn ?? "agent" }))
        : [];
      this.runs = Array.isArray(disk.runs)
        ? disk.runs.map((run) => ({ ...run, runOn: run.runOn ?? "agent" }))
        : [];
    } catch {
      this.routines = [];
      this.runs = [];
    }
    // A local process cannot still own these turns after a full restart.
    let recovered = false;
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "waiting") {
        run.status = "failed";
        run.error = "Muster restarted while this routine was running";
        run.finishedAt = this.now();
        recovered = true;
      }
    }
    if (recovered) this.save();
  }

  listRoutines(): Routine[] {
    return this.routines.map((r) => ({ ...r, schedule: { ...r.schedule } }));
  }

  listRuns(from?: number, to?: number): RoutineRun[] {
    return this.runs
      .filter((r) => (from == null || r.scheduledFor >= from) && (to == null || r.scheduledFor <= to))
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map((r) => ({ ...r }));
  }

  activeRunForBot(botId: string): RoutineRun | null {
    const run = this.runs.find(
      (candidate) => candidate.botId === botId && ["running", "waiting"].includes(candidate.status),
    );
    return run ? { ...run } : null;
  }

  isActiveThread(threadId: string): boolean {
    return this.runs.some(
      (run) => run.threadId === threadId && ["running", "waiting"].includes(run.status),
    );
  }

  create(input: RoutineInput): Routine {
    const clean = sanitizeInput(input);
    if (this.options.botState(clean.botId) === "missing") throw new Error("That bot no longer exists");
    const at = this.now();
    const routine: Routine = {
      id: randomUUID(),
      ...clean,
      nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, at) : null,
      createdAt: at,
      updatedAt: at,
    };
    this.routines.unshift(routine);
    this.save();
    this.emitRoutine(routine);
    return { ...routine, schedule: { ...routine.schedule } };
  }

  update(id: string, patch: Partial<RoutineInput>): Routine | null {
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    const clean = sanitizeInput({
      name: patch.name ?? routine.name,
      prompt: patch.prompt ?? routine.prompt,
      botId: patch.botId ?? routine.botId,
      runOn: patch.runOn ?? routine.runOn,
      enabled: patch.enabled ?? routine.enabled,
      schedule: patch.schedule ?? routine.schedule,
      durationMinutes: patch.durationMinutes ?? routine.durationMinutes,
      sentry: patch.sentry ?? routine.sentry,
      iterations: patch.iterations ?? routine.iterations,
      notesFile: patch.notesFile ?? routine.notesFile,
      checks: patch.checks ?? routine.checks,
      destination: patch.destination ?? routine.destination,
    });
    if (this.options.botState(clean.botId) === "missing") throw new Error("That bot no longer exists");
    Object.assign(routine, clean, {
      nextRunAt: clean.enabled ? this.initialOccurrence(clean.schedule, this.now()) : null,
      updatedAt: this.now(),
    });
    if (patch.enabled === false) {
      for (const run of this.runs) {
        if (run.routineId !== routine.id || run.status !== "queued") continue;
        run.status = "cancelled";
        run.finishedAt = this.now();
        run.error = "The routine was paused before this run started";
        this.emitRun(run);
      }
    }
    this.save();
    this.emitRoutine(routine);
    return { ...routine, schedule: { ...routine.schedule } };
  }

  remove(id: string): boolean {
    const at = this.routines.findIndex((r) => r.id === id);
    if (at === -1) return false;
    this.routines.splice(at, 1);
    for (const run of this.runs) {
      if (run.routineId === id && run.status === "queued") {
        run.status = "cancelled";
        run.finishedAt = this.now();
        this.emitRun(run);
      }
    }
    this.save();
    this.options.emit?.({ kind: "routine.deleted", routineId: id });
    return true;
  }

  disableForBot(botId: string) {
    let changed = false;
    for (const routine of this.routines) {
      if (routine.botId !== botId || !routine.enabled) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = this.now();
      this.emitRoutine(routine);
      changed = true;
    }
    for (const run of this.runs) {
      if (run.botId !== botId || !["queued", "running", "waiting"].includes(run.status)) continue;
      run.status = "cancelled";
      run.finishedAt = this.now();
      run.error = "The assigned bot was deleted";
      this.emitRun(run);
      if (run.threadId) void this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "agent").catch(() => {});
      changed = true;
    }
    if (changed) this.save();
  }

  runNow(id: string): RoutineRun | null {
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) return null;
    const run = this.newRun(routine, this.now(), true);
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  /** Queue an event-driven job without inventing a calendar schedule. Webhook
   * definitions live in their own store; the execution receipt deliberately
   * reuses this manager so busy-bot ordering, task creation and VM routing stay
   * identical for every unattended job. */
  enqueueWebhook(input: {
    webhookId: string;
    webhookName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
  }): RoutineRun {
    if (this.options.botState(input.botId) === "missing") {
      throw Object.assign(new Error("The assigned AGENT no longer exists"), { status: 410 });
    }
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: input.webhookId,
      routineName: input.webhookName,
      prompt: input.prompt,
      botId: input.botId,
      runOn: input.runOn,
      scheduledFor: input.receivedAt,
      status: "queued",
      manual: false,
      triggerSource: "webhook",
      webhookId: input.webhookId,
      deliveryId: input.deliveryId,
      createdAt: this.now(),
    };
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  activeWebhookRunCount(webhookId: string): number {
    return this.runs.filter(
      (run) => run.webhookId === webhookId && ["queued", "running", "waiting"].includes(run.status),
    ).length;
  }

  cancelQueuedWebhook(webhookId: string, message: string): void {
    let changed = false;
    for (const run of this.runs) {
      if (run.webhookId !== webhookId || run.status !== "queued") continue;
      run.status = "cancelled";
      run.finishedAt = this.now();
      run.error = message.slice(0, 500);
      this.emitRun(run);
      changed = true;
    }
    if (changed) this.save();
  }

  async cancelRun(id: string): Promise<RoutineRun | null> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || !["queued", "running", "waiting"].includes(run.status)) return null;
    run.status = "cancelled";
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    if (run.threadId) await this.options.interruptTurn?.(run.botId, run.threadId, run.runOn ?? "agent").catch(() => {});
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  markSeen(id: string): RoutineRun | null {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return null;
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.save();
      this.emitRun(run);
    }
    return { ...run };
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      let changed = false;
      for (const routine of this.routines) {
        if (!routine.enabled || routine.nextRunAt == null || routine.nextRunAt > now) continue;
        const scheduledFor = routine.nextRunAt;
        const late = now - scheduledFor;
        if (late > CATCH_UP_MS) {
          const missed = this.newRun(routine, scheduledFor, false);
          missed.status = "missed";
          missed.finishedAt = now;
          missed.error = "This computer was offline for more than 12 hours after the scheduled time";
          this.emitRun(missed);
        } else {
          const run = this.newRun(routine, scheduledFor, false);
          this.emitRun(run);
        }
        routine.nextRunAt =
          routine.schedule.type === "once" ? null : nextOccurrence(routine.schedule, Math.max(now, scheduledFor));
        if (routine.schedule.type === "once") routine.enabled = false;
        routine.updatedAt = now;
        this.emitRoutine(routine);
        changed = true;
      }
      if (changed) this.save();

      for (const run of [...this.runs].reverse()) {
        if (run.status !== "queued") continue;
        const state = this.options.botState(run.botId);
        if (state === "busy") continue;
        if (state === "missing") {
          run.status = "failed";
          run.error = "The assigned bot no longer exists";
          run.finishedAt = this.now();
          this.save();
          this.emitRun(run);
          continue;
        }
        // A webhook is an incoming message, so make its task the bot's live
        // chat immediately. Scheduled work remains detached and unobtrusive.
        // Dedicated destination: a routine pointed at a specific task
        // dispatches every run into THAT thread instead of spawning a fresh
        // one, so its results accumulate in one continuous log. Liveness is
        // re-checked at dispatch — the task may have been deleted since the
        // routine was saved — and a dead or foreign thread falls back to a
        // fresh task for this run rather than stalling the routine.
        const routineDef = this.routines.find((r) => r.id === run.routineId);
        const destThread = routineDef?.destination
          ? this.options.taskThread?.(run.botId, routineDef.destination)
          : undefined;
        const task = destThread
          ? { threadId: destThread }
          : this.options.createTask(run.botId, run.routineName, run.triggerSource === "webhook");
        if (!task) {
          run.status = "failed";
          run.error = "Could not create a task for this run";
          run.finishedAt = this.now();
          this.save();
          this.emitRun(run);
          continue;
        }
        run.threadId = task.threadId;
        run.startedAt = this.now();
        run.status = "running";
        this.save();
        this.emitRun(run);
        try {
          const basePrompt = run.prompt ?? routineDef?.prompt;
          if (!basePrompt) {
            this.failThread(task.threadId, "The routine was deleted before it could start");
            continue;
          }
          // Overnight loop (the gnhf pattern): iteration 2..N of a firing
          // chains through the shared notes file — the prompt tells the bot
          // to read it first and continue where the last run stopped, and
          // to append its progress before finishing. Cross-iteration memory
          // is a plain file the human can also read and edit.
          let chainedPrompt = basePrompt;
          const routineIterations = routineDef?.iterations ?? 1;
          const notesPath = routineDef?.notesFile;
          if (routineIterations > 1 && notesPath) {
            const continuation =
              run.iteration && run.iteration > 1
                ? `\n\nThis is iteration ${run.iteration} of ${routineIterations} in an overnight chain. First read the file ${notesPath} — it carries the notes from previous iterations. Continue that work from where it stopped. Before finishing, append a short progress line to ${notesPath} describing what this iteration changed.`
                : `\n\nThis is iteration 1 of ${routineIterations} in an overnight chain. Work toward the objective, then append a short progress line to ${notesPath} describing what this iteration changed, so the next iteration can continue.`;
            chainedPrompt = `${basePrompt}${continuation}`;
          }
          // Sentry runs carry the watching suffix so the diff policy has a
          // stable digest line to read at completion. Every run also carries
          // the why-journal suffix: a routine is exactly the kind of work a
          // future audit asks WHY about, and the extractor is mechanical —
          // a bot that skips the block simply produces no journal entry.
          // Scorecard routines tell the bot what will be checked, so it can
          // self-verify before finishing (grading is still harness-side).
          const scorecardHint =
            routineDef?.checks && routineDef.checks.length > 0
              ? `\n\nBefore you finish, verify your reply satisfies each of these checks — they are evaluated on your reply text:\n${routineDef.checks
                  .map((c) => `- ${c.label} (${c.kind === "contains" ? `must contain "${c.value}"` : c.kind === "not_contains" ? `must not contain "${c.value}"` : `must match /${c.value}/`})`)
                  .join("\n")}`
              : "";
          const prompt = `${chainedPrompt}${routineDef?.sentry ? sentryPromptSuffix() : ""}${whyPromptSuffix()}${scorecardHint}`;
          const triggerSource = run.triggerSource ?? (run.manual ? "manual" : "schedule");
          await this.options.startTurn(
            run.botId,
            task.threadId,
            prompt,
            run.runOn ?? "agent",
            triggerSource,
            (message) => this.failThread(task.threadId, message),
          );
        } catch (error) {
          this.failThread(task.threadId, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  handleRuntimeEvent(event: RuntimeEvent) {
    const run = this.runs.find((r) => r.threadId === event.threadId && ["running", "waiting"].includes(r.status));
    if (!run) return;
    if (event.type === "request.opened") {
      run.status = "waiting";
    } else if (event.type === "request.resolved") {
      run.status = "running";
    } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
      run.output = event.text.trim().slice(0, 2_000);
    } else if (event.type === "runtime.error") {
      run.error = event.message.slice(0, 500);
    } else if (event.type === "turn.completed") {
      run.status = event.ok ? "completed" : "failed";
      run.finishedAt = this.now();
      run.error = event.ok ? undefined : (event.stopReason ?? run.error ?? "The bot did not complete this run");
      run.cost = event.cost;
      run.denials = event.denials;
      const routineDef = this.routines.find((r) => r.id === run.routineId);
      // Scorecard: evaluate the routine's assertions against the settled
      // output. Harness-side and deterministic — the bot never grades
      // itself. Results land on the run so the details view can show
      // pass/fail chips and runs stay comparable.
      const checks = routineDef?.checks;
      if (checks && checks.length > 0) {
        run.scorecard = evaluateScorecard(checks, run.output);
      }
      // Sentry diff: compare this run's digest against the routine's stored
      // memory. A changed digest (or a failed watch) alerts; the memory
      // only updates on a successful run with a well-formed digest.
      if (routineDef?.sentry) {
        const verdict = evaluateSentryRun(routineDef.lastDigest ?? null, run.output ?? null);
        run.changeDetected = shouldSentryNotify(verdict, event.ok);
        if (verdict.digest !== null) {
          routineDef.lastDigest = verdict.digest;
          this.emitRoutine(routineDef);
        }
        if (run.changeDetected) {
          this.save();
          this.emitRun(run);
          queueMicrotask(() =>
            this.options.onSentryAlert?.({ ...run }, verdict),
          );
          return; // tick still needed below for the next scheduling hop
        }
      }
      // Overnight chain: a successful iteration enqueues the next one
      // immediately (bypassing the calendar), so a firing runs its full
      // iteration count back-to-back. Any failure stops the chain — an
      // unattended loop must not keep grinding on a broken objective.
      if (
        routineDef?.iterations &&
        routineDef.iterations > 1 &&
        run.iteration &&
        run.iteration < routineDef.iterations
      ) {
        if (event.ok) {
          const next: RoutineRun = {
            id: randomUUID(),
            routineId: run.routineId,
            routineName: run.routineName,
            prompt: run.prompt,
            durationMinutes: run.durationMinutes,
            botId: run.botId,
            runOn: run.runOn,
            scheduledFor: this.now(),
            status: "queued",
            manual: run.manual,
            triggerSource: run.triggerSource ?? "schedule",
            iteration: run.iteration + 1,
            createdAt: this.now(),
          };
          this.runs.unshift(next);
          this.save();
          this.emitRun(next);
        } else {
          run.error = `${run.error ?? "This run failed"} — overnight chain stopped after iteration ${run.iteration} of ${routineDef.iterations}`;
        }
      }
    } else {
      return;
    }
    this.save();
    this.emitRun(run);
    if (event.type === "turn.completed") queueMicrotask(() => void this.tick());
  }

  failThread(threadId: string, message: string) {
    const run = this.runs.find((r) => r.threadId === threadId && ["running", "waiting"].includes(r.status));
    if (!run) return;
    run.status = "failed";
    run.error = message.slice(0, 500);
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
  }

  private initialOccurrence(schedule: RoutineSchedule, now: number): number | null {
    if (schedule.type === "once") return Math.max(schedule.at, now);
    return nextOccurrence(schedule, now);
  }

  private newRun(routine: Routine, scheduledFor: number, manual: boolean): RoutineRun {
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      routineName: routine.name,
      prompt: routine.prompt,
      durationMinutes: routine.durationMinutes,
      botId: routine.botId,
      runOn: routine.runOn ?? "agent",
      scheduledFor,
      status: "queued",
      manual,
      triggerSource: manual ? "manual" : "schedule",
      // Overnight chain: the calendar-fired run is always iteration 1;
      // iterations 2..N are enqueued by the completion handler.
      iteration: routine.iterations && routine.iterations > 1 ? 1 : undefined,
      createdAt: this.now(),
    };
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
    return run;
  }

  private emitRoutine(routine: Routine) {
    this.options.emit?.({ kind: "routine", routine: { ...routine, schedule: { ...routine.schedule } } });
  }

  private emitRun(run: RoutineRun) {
    this.options.emit?.({ kind: "routine.run", run: { ...run } });
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, routines: this.routines, runs: this.runs } satisfies RoutineFile, null, 2));
    renameSync(temp, this.file);
  }
}
