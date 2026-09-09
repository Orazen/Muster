// Liveness reaper: fast crash detection for in-flight turns.
//
// The stall watchdog (turn-watchdog.ts) catches the slow case — a turn that
// goes silent for stallMs. This reaper catches the FAST case: the driver's
// process itself died and no terminal event ever reached the harness (a
// detached grandchild can hold the stdio pipes open forever, so `close`
// never fires and a driver awaiting it hangs). procs.ts journals every
// spawn/exit; each tick this attributes new deaths to watched turns.
//
// Attribution rule: a death belongs to a turn only if the process was
// spawned no earlier than that turn's dispatch, minus a small skew for the
// watch()-after-spawn ordering race. A long-lived engine (ACP sessions
// persist across turns) dying while NO turn is in flight touches nobody
// here — the next dispatch fails loudly on its own. One death settles at
// most one turn, so a burst of helper-CLI exits cannot cascade into
// stopping several bots.
import type { ProcessDeath } from "./procs.ts";
import type { WatchedTurn } from "./turn-watchdog.ts";

export interface LivenessReaperOptions {
  checkMs: number;
  /** Deaths are attributed to turns dispatched after the process spawned,
   * with this much slack (ms) for event-ordering races at dispatch time. */
  skewMs?: number;
  /** Injected sources — tests pass fakes; production passes procs.deathsSince
   * and the stall watchdog's snapshot(). */
  deathsSince(mark: number): ProcessDeath[];
  snapshotTurns(): WatchedTurn[];
  onLost(turn: WatchedTurn, death: ProcessDeath): void;
}

export class LivenessReaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Journal cursor: exits with a sequence at or below this are consumed. */
  private mark = 0;
  private suspended = false;
  private readonly opts: LivenessReaperOptions;

  // plain field assignment, not a parameter property — Node type-stripping
  constructor(opts: LivenessReaperOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.timer) return;
    // consume everything already journalled: exits recorded before the
    // reaper existed belong to no in-flight turn.
    const all = this.opts.deathsSince(0);
    this.mark = all.length > 0 ? all[all.length - 1]!.exitedAtSeq : 0;
    this.timer = setInterval(() => this.sweep(), this.opts.checkMs);
    // never hold the process open just to watch for crashes
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Silence crash attribution while processes are being killed ON PURPOSE
   * (fleet disposal on provider reload). Without this the reaper's tick can
   * beat the disposal path's own settle loop and stamp an honest-looking
   * "crashed mid-turn" note over a deliberate interruption. The journal is
   * drained on resume so exits recorded during the window are never
   * attributed afterwards. */
  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
    this.mark = this.opts.deathsSince(0).at(-1)?.exitedAtSeq ?? this.mark;
  }

  /** Visible for tests; the interval calls this. */
  sweep(): void {
    if (this.suspended) return;
    const deaths = this.opts.deathsSince(this.mark);
    if (deaths.length === 0) return;
    this.mark = deaths[deaths.length - 1]!.exitedAtSeq;
    const skew = this.opts.skewMs ?? 2_000;
    // local copy: a settled turn must not absorb a second death in the
    // same sweep, and onLost's own settle path may not have run yet.
    const open = this.opts.snapshotTurns();
    for (const death of deaths) {
      // Exact pid match first: a turn that knows its engine's pid cannot be
      // confused with any other process's exit, and a turn bound to a
      // DIFFERENT (still-alive) process must never be blamed for one.
      let index = open.findIndex((t) => t.pid !== undefined && t.pid === death.pid);
      if (index === -1) {
        // No bound pid anywhere: fall back to the spawn-time window, where
        // newest matching turn wins. A delegating parent's turn started long
        // before the child's engine process spawned, so both match the
        // lower-bound rule; the death belongs to the child, whose start sits
        // right at the spawn — an oldest-first rule would steal it for the
        // ancestor and kill the delegation mid-flight. A pid-bound turn is
        // excluded here: its own engine is another process, still running.
        for (let i = 0; i < open.length; i++) {
          if (open[i]!.pid !== undefined) continue;
          if (death.spawnedAt >= open[i]!.startedAt - skew) index = i;
        }
      }
      if (index === -1) continue;
      const [turn] = open.splice(index, 1);
      this.opts.onLost(turn!, death);
    }
  }
}
