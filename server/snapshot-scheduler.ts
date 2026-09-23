// Nightly snapshot scheduler (B1, DESIGN §11: "automatic snapshots … when a
// Drive connection + trusted passphrase store exist"). Two halves:
//
//   1. evaluateNightlyDue — PURE due-logic over injected facts (policy,
//      clock, run history), so the decision matrix is testable without
//      timers, Drive or a Keychain. Order matters and is deliberate:
//        enabled → already-succeeded-today → per-local-day attempt budget →
//        local-hour window → retry gap.
//      The window is local 02:00 onward (NIGHTLY_LOCAL_HOUR): backups at a
//      quiet hour, in the OPERATOR's timezone, reusing the ladder's own
//      localDayKey so "today" means the same day everywhere in B1.
//      The budget (NIGHTLY_MAX_ATTEMPTS_PER_DAY attempts per local day,
//      60 minutes apart) bounds churn: an installation whose gate stays
//      closed tries three times, records each skip, and goes quiet until
//      tomorrow instead of writing state every 15 minutes forever.
//
//   2. createSnapshotScheduler / startSnapshotScheduler — injectable-timer
//      loop (the electron/updater-coordinator pattern): the first check lands
//      a minute after boot, then every SCHEDULER_TICK_MS, unref'd so the
//      timer never holds the process open, single-flight so a slow upload
//      cannot overlap itself. The production singleton refuses to arm under
//      tests and on self-hosted installs (the runner's gate says no either
//      way — not arming simply keeps hosted installs from ticking at all).
import { localDayKey } from "./snapshot-retention.ts";
import { readSnapshotState, type SnapshotHistoryEntry, type SnapshotState } from "./snapshot-state.ts";
import { runNightlySnapshot, SELF_HOSTED_MIRROR, type SnapshotRunResult } from "./snapshot-runner.ts";

export const NIGHTLY_LOCAL_HOUR = 2;
export const NIGHTLY_RETRY_GAP_MS = 60 * 60 * 1000;
export const NIGHTLY_MAX_ATTEMPTS_PER_DAY = 3;
export const SCHEDULER_TICK_MS = 15 * 60 * 1000;
export const FIRST_TICK_DELAY_MS = 60_000;

export type NightlySkipReason = "disabled" | "succeeded-today" | "budget-exhausted" | "before-window" | "retry-gap";
export type NightlyVerdict = NightlySkipReason | "due";

export interface NightlyDueInput {
  enabled: boolean;
  nowMs: number;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  /** Nightly attempts already recorded in the current local day. */
  attemptsToday: number;
}

export interface NightlyDue {
  due: boolean;
  verdict: NightlyVerdict;
}

export function evaluateNightlyDue(input: NightlyDueInput): NightlyDue {
  const verdict = verdictOf(input);
  return { due: verdict === "due", verdict };
}

function verdictOf(input: NightlyDueInput): NightlyVerdict {
  if (!input.enabled) return "disabled";
  if (input.lastSuccessAt !== null && localDayKey(input.lastSuccessAt) === localDayKey(input.nowMs)) {
    return "succeeded-today";
  }
  if (input.attemptsToday >= NIGHTLY_MAX_ATTEMPTS_PER_DAY) return "budget-exhausted";
  if (new Date(input.nowMs).getHours() < NIGHTLY_LOCAL_HOUR) return "before-window";
  if (input.lastAttemptAt !== null && input.nowMs - input.lastAttemptAt < NIGHTLY_RETRY_GAP_MS) {
    return "retry-gap";
  }
  return "due";
}

/** Attempts the NIGHTLY reason already made in `nowMs`'s local day — manual
 * runs and pre-migration captures do not consume the scheduler's budget. */
export function countNightlyAttemptsToday(history: readonly SnapshotHistoryEntry[], nowMs: number): number {
  const today = localDayKey(nowMs);
  let count = 0;
  for (const entry of history) {
    if (entry.reason === "nightly" && localDayKey(entry.at) === today) count += 1;
  }
  return count;
}

/** Next time the nightly WINDOW opens (local NIGHTLY_LOCAL_HOUR): today if
 * the hour has not struck yet, otherwise tomorrow. Settings shows this so
 * "nightly" is a concrete time, not a vibe. */
export function nextNightlyAtMs(nowMs: number): number {
  const now = new Date(nowMs);
  const todayWindow = new Date(now.getFullYear(), now.getMonth(), now.getDate(), NIGHTLY_LOCAL_HOUR, 0, 0, 0);
  if (nowMs < todayWindow.getTime()) return todayWindow.getTime();
  return new Date(todayWindow.getTime() + 24 * 60 * 60 * 1000).getTime();
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface SnapshotSchedulerDeps {
  now?: () => number;
  readState?: () => SnapshotState;
  runNightly?: () => Promise<SnapshotRunResult | void>;
  scheduleTimer?: (fn: () => void, ms: number) => TimerHandle;
  cancelTimer?: (handle: TimerHandle) => void;
}

export interface SnapshotScheduler {
  /** Cancel the pending tick; further manual ticks are inert. */
  stop(): void;
  /** Run one evaluation immediately (the test seam; joins an in-flight tick). */
  tick(): Promise<void>;
  nextNightlyAt(): number;
}

const defaultSchedule = (fn: () => void, ms: number): TimerHandle => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return handle;
};

export function createSnapshotScheduler(deps: SnapshotSchedulerDeps = {}): SnapshotScheduler {
  const now = deps.now ?? Date.now;
  const readState = deps.readState ?? readSnapshotState;
  const runNightly = deps.runNightly ?? runNightlySnapshot;
  const schedule = deps.scheduleTimer ?? defaultSchedule;
  const cancel = deps.cancelTimer ?? ((handle: TimerHandle) => clearTimeout(handle));

  let timer: TimerHandle | null = null;
  let stopped = false;
  let inflight: Promise<void> | null = null;

  const arm = (delayMs: number): void => {
    if (stopped) return;
    if (timer !== null) cancel(timer);
    timer = schedule(() => {
      timer = null;
      void tick().finally(() => {
        arm(SCHEDULER_TICK_MS);
      });
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inflight !== null) return inflight;
    inflight = (async () => {
      try {
        const state = readState();
        const nowMs = now();
        const due = evaluateNightlyDue({
          enabled: state.policy.nightlyEnabled,
          nowMs,
          lastSuccessAt: state.runs.lastSuccessAt,
          lastAttemptAt: state.runs.lastAttemptAt,
          attemptsToday: countNightlyAttemptsToday(state.history, nowMs),
        });
        if (!due.due) return;
        await runNightly();
      } catch (error) {
        // The runner classifies its own failures into the run log; anything
        // escaping it is a bug — warn (message only, never a passphrase) and
        // keep the loop alive rather than letting one tick kill the night.
        console.warn(`snapshot scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  arm(FIRST_TICK_DELAY_MS);

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
    tick,
    nextNightlyAt(): number {
      return nextNightlyAtMs(now());
    },
  };
}

let live: SnapshotScheduler | null = null;

/** Boot-path singleton, armed by startSyncEngine. Returns null under tests
 * (no real timers in vitest) and on self-hosted installs (route wall + the
 * runner's gate both say no — don't tick at all; SELF_HOSTED_MIRROR is the
 * runner's lockstep mirror of auth.ts). Idempotent. */
export function startSnapshotScheduler(): SnapshotScheduler | null {
  if (process.env.VITEST !== undefined || process.env.NODE_ENV === "test") return null;
  if (SELF_HOSTED_MIRROR) return null;
  if (live !== null) return live;
  live = createSnapshotScheduler();
  return live;
}

export function stopSnapshotScheduler(): void {
  if (live !== null) {
    live.stop();
    live = null;
  }
}
