// Nightly scheduler (B1): the PURE due matrix first (order of checks is the
// contract), then the injectable-timer loop — no real timers, no Drive, no
// Keychain anywhere in this file.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIRST_TICK_DELAY_MS,
  NIGHTLY_MAX_ATTEMPTS_PER_DAY,
  NIGHTLY_RETRY_GAP_MS,
  SCHEDULER_TICK_MS,
  countNightlyAttemptsToday,
  createSnapshotScheduler,
  evaluateNightlyDue,
  nextNightlyAtMs,
  startSnapshotScheduler,
  type NightlyDueInput,
  type SnapshotScheduler,
} from "./snapshot-scheduler.ts";
import { defaultSnapshotState, type SnapshotHistoryEntry } from "./snapshot-state.ts";

/** Local wall-clock time — the ladder and the window are both local-time
 * concepts, so every fixture here builds local Dates, never UTC. */
function local(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute, 0, 0).getTime();
}

const base = (overrides: Partial<NightlyDueInput> = {}): NightlyDueInput => ({
  enabled: true,
  nowMs: local(2026, 5, 17, 3, 0), // 03:00, inside the window
  lastSuccessAt: local(2026, 5, 16, 2, 5), // yesterday's nightly
  lastAttemptAt: null,
  attemptsToday: 0,
  ...overrides,
});

describe("evaluateNightlyDue — decision matrix in documented order", () => {
  it("runs when enabled, inside the window, with budget and no attempt in the retry gap", () => {
    expect(evaluateNightlyDue(base())).toEqual({ due: true, verdict: "due" });
    // gap boundary: an attempt exactly 60 minutes ago is no longer in the gap
    const nowMs = local(2026, 5, 17, 3, 0);
    expect(evaluateNightlyDue(base({ nowMs, lastAttemptAt: nowMs - NIGHTLY_RETRY_GAP_MS })).verdict).toBe("due");
    expect(evaluateNightlyDue(base({ nowMs, lastAttemptAt: nowMs - NIGHTLY_RETRY_GAP_MS + 1 })).verdict).toBe("retry-gap");
  });

  it("disabled wins over everything — a turned-off toggle is never due", () => {
    expect(
      evaluateNightlyDue(
        base({
          enabled: false,
          attemptsToday: NIGHTLY_MAX_ATTEMPTS_PER_DAY,
          nowMs: local(2026, 5, 17, 1, 0),
          lastSuccessAt: local(2026, 5, 17, 3, 0),
        }),
      ).verdict,
    ).toBe("disabled");
  });

  it("already-succeeded-today beats budget and window (any success today satisfies the nightly)", () => {
    expect(evaluateNightlyDue(base({ lastSuccessAt: local(2026, 5, 17, 0, 30), attemptsToday: 3 })).verdict).toBe("succeeded-today");
    // last night's success does not bleed into today
    expect(evaluateNightlyDue(base({ lastSuccessAt: local(2026, 5, 16, 23, 59) })).verdict).toBe("due");
  });

  it("the per-local-day attempt budget beats the window (order pin)", () => {
    expect(
      evaluateNightlyDue(base({ attemptsToday: NIGHTLY_MAX_ATTEMPTS_PER_DAY, nowMs: local(2026, 5, 17, 1, 0) })).verdict,
    ).toBe("budget-exhausted");
    expect(evaluateNightlyDue(base({ attemptsToday: NIGHTLY_MAX_ATTEMPTS_PER_DAY - 1 })).verdict).toBe("due");
  });

  it("holds the local 02:00 window", () => {
    expect(evaluateNightlyDue(base({ nowMs: local(2026, 5, 17, 1, 59) })).verdict).toBe("before-window");
    expect(evaluateNightlyDue(base({ nowMs: local(2026, 5, 17, 0, 30) })).verdict).toBe("before-window");
    expect(evaluateNightlyDue(base({ nowMs: local(2026, 5, 17, 2, 0) })).verdict).toBe("due");
    // The window OPENS at 02:00 and stays open through end of day — a late
    // gate opening at 23:59 still runs tonight rather than waiting a day.
    expect(
      evaluateNightlyDue(base({ nowMs: local(2026, 5, 16, 23, 59), lastSuccessAt: local(2026, 5, 15, 2, 5) })).verdict,
    ).toBe("due");
  });

  it("the retry gap delays a fresh failure, not an old one", () => {
    const nowMs = local(2026, 5, 17, 3, 0);
    expect(evaluateNightlyDue(base({ nowMs, lastAttemptAt: nowMs - 30 * 60_000 })).verdict).toBe("retry-gap");
    expect(evaluateNightlyDue(base({ nowMs, lastAttemptAt: nowMs - 120 * 60_000 })).verdict).toBe("due");
  });
});

describe("countNightlyAttemptsToday", () => {
  it("counts only the nightly reason inside the current local day — gate skips included, manual runs and yesterday excluded", () => {
    const history: SnapshotHistoryEntry[] = [
      { at: local(2026, 5, 17, 2, 5), reason: "nightly", outcome: "skipped", detail: "drive-not-connected" },
      { at: local(2026, 5, 17, 3, 5), reason: "nightly", outcome: "failed", detail: "upload rejected" },
      { at: local(2026, 5, 17, 4, 5), reason: "manual", outcome: "success", detail: "round trip verified" },
      { at: local(2026, 5, 16, 2, 5), reason: "nightly", outcome: "success", detail: "round trip verified" },
    ];
    const nowMs = local(2026, 5, 17, 5, 0);
    expect(countNightlyAttemptsToday(history, nowMs)).toBe(2);
    // 23:30 yesterday is a different local day than 00:30 today
    const acrossMidnight: SnapshotHistoryEntry[] = [{ at: local(2026, 5, 16, 23, 30), reason: "nightly", outcome: "failed", detail: "x" }];
    expect(countNightlyAttemptsToday(acrossMidnight, local(2026, 5, 17, 0, 30))).toBe(0);
    expect(countNightlyAttemptsToday([], nowMs)).toBe(0);
  });
});

describe("nextNightlyAtMs", () => {
  it("points at today's 02:00 before the window and tomorrow's 02:00 from the window onward", () => {
    expect(nextNightlyAtMs(local(2026, 5, 17, 1, 59))).toBe(local(2026, 5, 17, 2, 0));
    expect(nextNightlyAtMs(local(2026, 5, 17, 2, 0))).toBe(local(2026, 5, 18, 2, 0));
    expect(nextNightlyAtMs(local(2026, 5, 17, 23, 59))).toBe(local(2026, 5, 18, 2, 0));
  });
});

// ── the injectable-timer loop ──────────────────────────────────────────────
function captureTimers() {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const scheduleTimer = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    scheduled.push({ fn, ms });
    // a benign placeholder handle so cancel/stop semantics are exercised for
    // real; the scheduler's OWN fn is fired manually by the tests
    const handle = setTimeout(() => {}, 0x7fffffff);
    handle.unref?.();
    return handle;
  };
  const cancelled: Array<ReturnType<typeof setTimeout>> = [];
  const cancelTimer = (handle: ReturnType<typeof setTimeout>): void => {
    cancelled.push(handle);
    clearTimeout(handle);
  };
  return { scheduled, cancelled, scheduleTimer, cancelTimer };
}

function dueState() {
  const state = defaultSnapshotState();
  state.policy.nightlyEnabled = true;
  return state;
}

const NOW = local(2026, 5, 17, 3, 0);

describe("createSnapshotScheduler", () => {
  const open: SnapshotScheduler[] = [];
  afterEach(() => {
    while (open.length > 0) open.pop()?.stop();
    vi.restoreAllMocks();
  });

  it("arms a first check after a minute without running anything, then re-arms on the 15-minute cadence", async () => {
    const timers = captureTimers();
    const runNightly = vi.fn(async () => {});
    const scheduler = createSnapshotScheduler({
      now: () => NOW,
      readState: dueState,
      runNightly,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    });
    open.push(scheduler);

    expect(timers.scheduled).toHaveLength(1);
    expect(timers.scheduled[0]?.ms).toBe(FIRST_TICK_DELAY_MS);
    expect(runNightly).not.toHaveBeenCalled(); // creating the scheduler runs nothing

    timers.scheduled[0]?.fn(); // the boot-delayed check fires
    await vi.waitFor(() => expect(runNightly).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(timers.scheduled).toHaveLength(2)); // re-armed
    expect(timers.scheduled[1]?.ms).toBe(SCHEDULER_TICK_MS);
  });

  it("does not run when the policy is off — the tick re-arms silently", async () => {
    const timers = captureTimers();
    const runNightly = vi.fn(async () => {});
    const state = dueState();
    state.policy.nightlyEnabled = false;
    const scheduler = createSnapshotScheduler({
      now: () => NOW,
      readState: () => state,
      runNightly,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    });
    open.push(scheduler);

    timers.scheduled[0]?.fn();
    await vi.waitFor(() => expect(timers.scheduled).toHaveLength(2));
    expect(runNightly).not.toHaveBeenCalled();
  });

  it("single-flight: a fired timer and two manual ticks all join one run", async () => {
    const timers = captureTimers();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runNightly = vi.fn(async () => {
      await gate;
    });
    const scheduler = createSnapshotScheduler({
      now: () => NOW,
      readState: dueState,
      runNightly,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    });
    open.push(scheduler);

    timers.scheduled[0]?.fn();
    const t1 = scheduler.tick();
    const t2 = scheduler.tick();
    release();
    await Promise.all([t1, t2]);
    expect(runNightly).toHaveBeenCalledTimes(1);
  });

  it("a run that throws is warned (message only) and the loop survives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timers = captureTimers();
    const runNightly = vi.fn(async () => {
      throw new Error("runner bug — but no passphrase here");
    });
    const scheduler = createSnapshotScheduler({
      now: () => NOW,
      readState: dueState,
      runNightly,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    });
    open.push(scheduler);

    timers.scheduled[0]?.fn();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0]?.[0])).toContain("runner bug");
    await vi.waitFor(() => expect(timers.scheduled).toHaveLength(2)); // still ticking
  });

  it("stop cancels the pending timer and makes further ticks inert", async () => {
    const timers = captureTimers();
    const runNightly = vi.fn(async () => {});
    const scheduler = createSnapshotScheduler({
      now: () => NOW,
      readState: dueState,
      runNightly,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    });
    open.push(scheduler);

    scheduler.stop();
    expect(timers.cancelled).toHaveLength(1);
    await scheduler.tick();
    expect(runNightly).not.toHaveBeenCalled();
    timers.scheduled[0]?.fn(); // a stale timer callback is inert too
    await scheduler.tick();
    expect(runNightly).not.toHaveBeenCalled();
    expect(timers.scheduled).toHaveLength(1); // no re-arm after stop
  });

  it("nextNightlyAt reflects the injected clock", () => {
    const timers = captureTimers();
    const scheduler = createSnapshotScheduler({
      now: () => local(2026, 5, 17, 1, 0),
      readState: dueState,
      runNightly: async () => {},
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    });
    open.push(scheduler);
    expect(scheduler.nextNightlyAt()).toBe(local(2026, 5, 17, 2, 0));
  });

  it("the production singleton refuses to arm under vitest (no real timers in the suite)", () => {
    expect(process.env.VITEST).toBeDefined();
    expect(startSnapshotScheduler()).toBeNull();
  });
});
