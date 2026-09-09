// Stall watchdog for dispatched turns.
//
// ask_bot has a 4-minute ceiling and room turns a 5-minute one, but the
// main 1:1 path had none: a wedged CLI (hung network call, dead MCP child,
// a provider that stops streaming without exiting) left its bot busy
// forever — composer locked, screen poller running — until an interrupt or
// an app restart. This watchdog watches ACTIVITY, not duration: a turn may
// legitimately run for an hour while events keep flowing, but a turn whose
// thread has emitted nothing at all for `stallMs` is wedged. Turns parked
// on a human approval are exempt — waiting on a person is not a stall.
export interface WatchedTurn {
  threadId: string;
  botId: string;
  startedAt: number;
  lastEventAt: number;
  waitingOnHuman: boolean;
  /** The engine process this turn was dispatched into, when the harness can
   * see it — lets the liveness reaper attribute a journalled process death
   * to the exact turn instead of guessing by spawn time. */
  pid?: number;
  /** The in-flight generation's provider turnId, bound from its turn.started
   * event. A turn.completed carrying a different id is a prior generation's
   * late wind-down — an interrupted-but-alive provider finishing after its
   * turn was already lost — and must not settle this one. */
  turnId?: string;
}

export interface TurnWatchdogOptions {
  stallMs: number;
  checkMs: number;
  /** Absolute ceiling for a turn even while waiting on a human. A
   * permission request with no deadline and no resolving event (dead MCP
   * child, adapter bug) would otherwise hold the busy flag forever — the
   * exact wedged state this watchdog exists to clear. */
  hardCapMs: number;
  /** Called once per stalled turn, after the entry is removed. */
  onStall: (turn: WatchedTurn) => void;
  now?: () => number;
}

export class TurnWatchdog {
  private turns = new Map<string, WatchedTurn>();
  /** Threads whose turn was recently lost: until the window lapses, a
   * turn.completed that cannot prove it belongs to the current generation
   * (by turnId) is presumed to be the lost turn's wind-down and is ignored
   * by settleIfCurrent. Covers the gap between a replacement turn's watch()
   * and its turn.started, before ids can disambiguate. */
  private staleSettleUntil = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: TurnWatchdogOptions;

  // a plain field assignment, not a parameter property — the server runs
  // under Node's type-stripping, which cannot transform the latter
  constructor(opts: TurnWatchdogOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.opts.checkMs);
    // never hold the process open just to watch for stalls
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.turns.clear();
    this.staleSettleUntil.clear();
  }

  /** A turn was dispatched on this thread. `pid` binds the engine process
   * when the harness can see it (reaper attribution). */
  watch(threadId: string, botId: string, pid?: number): void {
    const at = this.now();
    this.turns.set(threadId, {
      threadId,
      botId,
      startedAt: at,
      lastEventAt: at,
      waitingOnHuman: false,
      ...(pid !== undefined ? { pid } : {}),
    });
  }

  /** Any provider event for the thread proves the turn is alive. */
  touch(threadId: string): void {
    const turn = this.turns.get(threadId);
    if (turn) turn.lastEventAt = this.now();
  }

  /** request.opened → true (a human is deciding; not a stall however long
   * they take); request.resolved → false (the clock restarts). */
  setWaitingOnHuman(threadId: string, waiting: boolean): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    turn.waitingOnHuman = waiting;
    turn.lastEventAt = this.now();
  }

  /** The turn settled normally — stop watching it. */
  settle(threadId: string): void {
    this.turns.delete(threadId);
  }

  /** Bind the in-flight generation's provider turnId from its turn.started
   * event, so later completions can be matched against it. */
  noteTurnStarted(threadId: string, turnId?: string): void {
    const turn = this.turns.get(threadId);
    if (turn && turnId) turn.turnId = turnId;
  }

  /** Bind the turn's engine process pid (from a turn.engine-pid event) so
   * the liveness reaper can attribute a process death exactly. */
  noteEnginePid(threadId: string, pid: number): void {
    const turn = this.turns.get(threadId);
    if (turn) turn.pid = pid;
  }

  /** Arm the stale-completion guard for a thread whose turn was just lost:
   * for the next `ms`, a completion that cannot prove it belongs to the
   * current generation is presumed to be the lost turn's wind-down. */
  suppressStaleSettles(threadId: string, ms: number): void {
    this.staleSettleUntil.set(threadId, this.now() + ms);
  }

  /** The guarded settle for provider terminal events read off the event
   * bus; settle() above stays for the harness's OWN completion paths, which
   * always mean the current turn. A turn.completed may belong to a lost
   * turn: when the watchdog interrupts a stalled provider, that provider
   * usually survives the interrupt and emits its real completion seconds
   * later. If a replacement turn is in flight by then, that stale
   * completion — matched by threadId alone — would unwatch the NEW turn
   * and leave it unprotected against the exact wedge this watchdog exists
   * to catch. */
  settleIfCurrent(threadId: string, turnId?: string): void {
    const turn = this.turns.get(threadId);
    if (!turn) return;
    const bothKnown = turnId !== undefined && turn.turnId !== undefined;
    // Matching ids prove the current generation; differing ids prove a
    // prior one. When ids cannot decide, the guard window does.
    if (bothKnown && turnId !== turn.turnId) return;
    if (!bothKnown) {
      const until = this.staleSettleUntil.get(threadId);
      if (until !== undefined) {
        if (this.now() < until) return;
        this.staleSettleUntil.delete(threadId);
      }
    }
    this.turns.delete(threadId);
    this.staleSettleUntil.delete(threadId);
  }

  watching(threadId: string): boolean {
    return this.turns.has(threadId);
  }

  /** Current in-flight turns, for the liveness reaper's sweep. Copies, so
   * callers cannot mutate the watchdog's bookkeeping. */
  snapshot(): WatchedTurn[] {
    return [...this.turns.values()].map((t) => ({ ...t }));
  }

  /** Visible for tests; the interval calls this. */
  sweep(): void {
    const at = this.now();
    for (const turn of this.turns.values()) {
      if (turn.waitingOnHuman) {
        // Waiting on a person is not a stall, but it is not a license to
        // hold the turn forever either: past the hard cap the request is
        // treated as wedged (no resolving event ever arrived).
        if (at - turn.startedAt < this.opts.hardCapMs) continue;
      } else if (at - turn.lastEventAt < this.opts.stallMs) {
        continue;
      }
      this.turns.delete(turn.threadId);
      this.opts.onStall(turn);
    }
    // windows for threads that never saw a follow-up completion are pure
    // bookkeeping once lapsed — drop them so the map stays bounded
    for (const [threadId, until] of this.staleSettleUntil) {
      if (at >= until) this.staleSettleUntil.delete(threadId);
    }
  }
}
