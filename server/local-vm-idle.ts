/** Renewable idle deadline for the shared Local VM.
 *
 * Activity resets the full window. The caller decides how to suspend or
 * recycle the disposable VM, and an active turn or lifecycle operation defers
 * that work for another full window instead of racing current work.
 */
export class LocalVmIdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleMs: number;
  private readonly isBusy: () => boolean;
  private readonly suspend: () => Promise<void>;

  constructor(idleMs: number, isBusy: () => boolean, suspend: () => Promise<void>) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("Local VM idle timeout must be positive");
    this.idleMs = idleMs;
    this.isBusy = isBusy;
    this.suspend = suspend;
  }

  touch(): void {
    this.cancel();
    this.timer = setTimeout(() => void this.expire(), this.idleMs);
    this.timer.unref?.();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async expire(): Promise<void> {
    this.timer = null;
    if (this.isBusy()) {
      this.touch();
      return;
    }
    try {
      await this.suspend();
    } catch {
      // A transient runtime failure must not disable the cost/resource
      // backstop forever. Retry after a fresh full idle window.
      this.touch();
    }
  }
}

/** One recycle deadline per desktop target. Shared mode holds a single
 * entry and behaves exactly like the bare timer; per-bot mode gives every
 * desktop its own countdown so an unused bot's container is recycled
 * without touching anyone else's. */
export class LocalVmIdleTimerPool {
  private readonly timers = new Map<string, LocalVmIdleTimer>();
  private readonly idleMs: number;
  private readonly isBusy: (targetKey: string) => boolean;
  private readonly suspend: (targetKey: string) => Promise<void>;

  constructor(
    idleMs: number,
    isBusy: (targetKey: string) => boolean,
    suspend: (targetKey: string) => Promise<void>,
  ) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("Local VM idle timeout must be positive");
    this.idleMs = idleMs;
    this.isBusy = isBusy;
    this.suspend = suspend;
  }

  forTarget(targetKey: string): LocalVmIdleTimer {
    let timer = this.timers.get(targetKey);
    if (!timer) {
      timer = new LocalVmIdleTimer(this.idleMs, () => this.isBusy(targetKey), () => this.suspend(targetKey));
      this.timers.set(targetKey, timer);
    }
    return timer;
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
  }
}
