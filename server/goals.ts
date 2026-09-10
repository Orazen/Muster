import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { writeFileAtomic } from "./atomic.ts";

export type GoalStatus = "active" | "done" | "stopped" | "failed";

/** One bounded autonomy loop: a goal the bot keeps working across
 * consecutive turns until it reports completion or the round budget runs
 * out. The transcript stays the human's record — continuation prompts are
 * control-plane text only the model sees. */
export interface GoalRecord {
  id: string;
  botId: string;
  threadId: string;
  text: string;
  status: GoalStatus;
  /** Turns spent on this goal so far (round 1 is the initial dispatch). */
  rounds: number;
  maxRounds: number;
  createdAt: number;
  updatedAt: number;
  /** Why the goal ended, or what the loop is waiting on. */
  lastOutcome?: string;
}

export type GoalEvent = { kind: "goal"; goal: GoalRecord };

export interface GoalManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: GoalEvent) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  startTurn: (args: {
    botId: string;
    threadId: string;
    /** Round 1 only: the user's goal, appended to the transcript as their
     * own bubble. Continuations pass nothing visible. */
    userText: string;
    /** What the model actually receives — goal text plus the marker
     * protocol (and round framing on continuations). */
    engineText: string;
    first: boolean;
    onDispatchError: (message: string) => void;
  }) => Promise<void>;
}

export const DEFAULT_MAX_ROUNDS = 5;
export const MAX_ROUNDS_CAP = 20;

const MAX_GOALS = 200;

/** The marker protocol: the bot ends its reply with one of these lines and
 * the harness decides whether the loop continues. Parsed case-insensitively
 * from the settled reply text — the bot never grades itself on anything
 * more structured than that, and a missing marker means "keep going". */
export function parseGoalOutcome(text: string | undefined | null): "done" | "in_progress" | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("goal complete")) return "done";
  if (t.includes("goal in progress")) return "in_progress";
  return null;
}

const MARKER_INSTRUCTIONS =
  'When you finish this turn, end your reply with exactly "GOAL COMPLETE" if the goal is fully achieved, or "GOAL IN PROGRESS" if there is still meaningful work to do — the harness continues the loop from that marker.';

function firstTurnPrompt(goalText: string): string {
  return `${goalText}\n\nGoal mode: work toward this goal autonomously, making real progress every turn. ${MARKER_INSTRUCTIONS}`;
}

function continuePrompt(goalText: string, rounds: number, maxRounds: number): string {
  return `Continue the active goal: "${goalText}". This is round ${rounds} of ${maxRounds} — pick up where the last turn left off and keep making progress; do not restart from scratch or repeat work already done. ${MARKER_INSTRUCTIONS}`;
}

interface GoalFile {
  version: 1;
  goals: GoalRecord[];
}

/** Bounded autonomy loop, mirroring RoutineManager's shape: a JSON-persisted
 * record store, a recovery sweep on boot, a settle-driven continuation and
 * narrow injected options so tests can drive the whole loop without a
 * server. The budget is the safety property — a goal cannot spin past its
 * round cap, and any turn failure or restart stops it visibly. */
export class GoalManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: GoalManagerOptions;
  private goals: GoalRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Goal ids with a continuation ready to fire. In-memory only: the boot
   * sweep stops every active goal anyway, so persisting this would lie. */
  private readonly queued = new Set<string>();
  /** The reply text accumulated for the turn in flight on each active goal,
   * parsed for markers when the turn settles. */
  private readonly roundReplies = new Map<string, string>();
  /** Threads with a goal-dispatched turn in flight. Only these turns are
   * rounds — a plain user message sent on the goal thread between rounds
   * settles on the same threadId and must not consume budget or extend the
   * loop on the bot's unrelated reply. */
  private readonly inflight = new Set<string>();

  constructor(options: GoalManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "goals.json");
    this.now = options.now ?? Date.now;
    try {
      // SAFETY: save() writes exactly the GoalFile shape; a corrupt or
      // foreign file throws below and resets to an empty store.
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<GoalFile>;
      this.goals = Array.isArray(disk.goals) ? disk.goals : [];
    } catch {
      this.goals = [];
    }
    // A local process cannot still be mid-goal after a full restart.
    let recovered = false;
    for (const goal of this.goals) {
      if (goal.status === "active") {
        goal.status = "stopped";
        goal.lastOutcome = "interrupted by restart";
        goal.updatedAt = this.now();
        recovered = true;
      }
    }
    if (recovered) this.save();
  }

  listGoals(): GoalRecord[] {
    return this.goals.map((g) => ({ ...g }));
  }

  activeGoalForBot(botId: string): GoalRecord | null {
    const goal = this.goals.find((g) => g.botId === botId && g.status === "active");
    return goal ? { ...goal } : null;
  }

  create(input: { botId: string; threadId: string; text: string; maxRounds?: number }): GoalRecord {
    const botId = String(input.botId ?? "").trim();
    const threadId = String(input.threadId ?? "").trim();
    const text = String(input.text ?? "").trim().slice(0, 4_000);
    if (!botId || !threadId) throw new Error("Choose a bot");
    if (!text) throw new Error("Say what the goal is");
    if (this.goals.some((g) => g.botId === botId && g.status === "active")) {
      throw Object.assign(new Error("this bot already has an active goal — stop it first"), { status: 409 });
    }
    const state = this.options.botState(botId);
    if (state === "missing") throw Object.assign(new Error("no such bot"), { status: 404 });
    if (state === "busy") {
      throw Object.assign(new Error("the bot is working — stop it before starting a goal"), { status: 409 });
    }
    if (this.goals.filter((goal) => goal.status === "active").length >= MAX_GOALS) {
      throw Object.assign(new Error("The goal limit is reached — stop an active goal before starting another."), { status: 409 });
    }
    const at = this.now();
    const goal: GoalRecord = {
      id: randomUUID(),
      botId,
      threadId,
      text,
      status: "active",
      rounds: 1,
      maxRounds: clampRounds(input.maxRounds),
      createdAt: at,
      updatedAt: at,
    };
    const pruneCount = Math.max(0, this.goals.length + 1 - MAX_GOALS);
    const oldestTerminal = this.goals
      .filter((existing) => existing.status !== "active")
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, pruneCount);
    const prunedIds = new Set(oldestTerminal.map((existing) => existing.id));
    this.goals = [goal, ...this.goals.filter((existing) => !prunedIds.has(existing.id))];
    this.save();
    this.emitGoal(goal);
    queueMicrotask(() => void this.dispatch(goal.id, true));
    return { ...goal };
  }

  stopGoal(id: string, outcome = "stopped by the user"): GoalRecord | null {
    const goal = this.goals.find((g) => g.id === id);
    if (!goal) return null;
    this.finish(goal, "stopped", outcome);
    return { ...goal };
  }

  /** Turn the goal loop hears. Assistant text accumulates the round's reply
   * for marker parsing; a settled turn decides whether the loop continues. */
  handleRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === "item.completed" && event.itemType === "assistant_text") {
      if (!this.inflight.has(event.threadId)) return;
      const goal = this.goals.find((g) => g.status === "active" && g.threadId === event.threadId);
      if (goal) {
        const prior = this.roundReplies.get(goal.id) ?? "";
        this.roundReplies.set(goal.id, `${prior}${event.text}`.slice(0, 20_000));
      }
      return;
    }
    if (event.type !== "turn.completed") return;
    if (!this.inflight.delete(event.threadId)) return;
    const goal = this.goals.find((g) => g.status === "active" && g.threadId === event.threadId);
    if (!goal) return;
    const reply = this.roundReplies.get(goal.id);
    this.roundReplies.delete(goal.id);
    if (!event.ok) {
      this.finish(goal, "stopped", `turn failed — ${event.stopReason ?? "the turn did not complete"}`);
      return;
    }
    const verdict = parseGoalOutcome(reply);
    if (verdict === "done") {
      this.finish(goal, "done", "the bot reported the goal complete");
      return;
    }
    if (goal.rounds >= goal.maxRounds) {
      this.finish(goal, "stopped", `round limit reached (${goal.maxRounds})`);
      return;
    }
    goal.rounds += 1;
    goal.updatedAt = this.now();
    this.save();
    this.emitGoal(goal);
    this.queued.add(goal.id);
    queueMicrotask(() => void this.tick());
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 3_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fire queued continuations whose bot has settled idle. A busy bot keeps
   * its continuation queued — the interval retries, so a steer-queue send
   * that grabbed the slot first only delays the loop, never kills it. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // A dispatch can await while another goal settles and queues work.
      // Keep that new work for the next tick rather than extending this one.
      const queuedAtStart = [...this.queued];
      for (const id of queuedAtStart) {
        const goal = this.goals.find((g) => g.id === id && g.status === "active");
        if (!goal) {
          this.queued.delete(id);
          continue;
        }
        const state = this.options.botState(goal.botId);
        if (state === "busy") continue;
        this.queued.delete(id);
        if (state === "missing") {
          this.finish(goal, "failed", "the bot no longer exists");
          continue;
        }
        await this.dispatch(goal.id, false);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async dispatch(goalId: string, first: boolean): Promise<void> {
    const goal = this.goals.find((g) => g.id === goalId);
    if (!goal || goal.status !== "active") return;
    const engineText = first
      ? firstTurnPrompt(goal.text)
      : continuePrompt(goal.text, goal.rounds, goal.maxRounds);
    this.inflight.add(goal.threadId);
    try {
      await this.options.startTurn({
        botId: goal.botId,
        threadId: goal.threadId,
        userText: goal.text,
        engineText,
        first,
        onDispatchError: (message) => this.finishById(goalId, "failed", message),
      });
    } catch (error) {
      // The turn never started, so no turn.completed will clear the flag.
      this.inflight.delete(goal.threadId);
      this.finishById(goalId, "failed", error instanceof Error ? error.message : String(error));
    }
  }

  private finishById(id: string, status: GoalStatus, outcome: string): void {
    const goal = this.goals.find((g) => g.id === id);
    if (goal && goal.status === "active") this.finish(goal, status, outcome);
  }

  private finish(goal: GoalRecord, status: GoalStatus, outcome: string): void {
    goal.status = status;
    goal.lastOutcome = outcome.slice(0, 300);
    goal.updatedAt = this.now();
    this.queued.delete(goal.id);
    this.roundReplies.delete(goal.id);
    this.inflight.delete(goal.threadId);
    this.save();
    this.emitGoal(goal);
  }

  private emitGoal(goal: GoalRecord) {
    this.options.emit?.({ kind: "goal", goal: { ...goal } });
  }

  private save() {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, goals: this.goals } satisfies GoalFile, null, 2));
  }
}

function clampRounds(raw: number | undefined): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_ROUNDS;
  return Math.min(MAX_ROUNDS_CAP, n);
}
