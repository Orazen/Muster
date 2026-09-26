// Usage allowance (device-first strategy, missing-logic #6): the deployment
// can declare a monthly USD allowance that task dispatch RESERVES before a
// turn starts, reconciles from the turn's real cost when it completes, and
// releases when the turn fails or cancels. A reservation is optimistic but
// honest: it is checked and recorded BEFORE the model is invoked, so one
// account can never silently overspend a cap by racing concurrent turns.
// NO default allowance exists — unset means unmetered, exactly as today.
// BYOK fallback is a per-bot modelSelection decision the user already
// owns; this ledger surfaces, it does not choose.

/** One turn reserves at most this much against the cap. Generous on
 * purpose: the reconcile step returns the unused difference the moment
 * the turn's real cost lands. */
export const DEFAULT_TURN_RESERVE_USD = 1;

/** Guards against fat-fingered config; the owner can still raise it via
 * env for a genuinely expensive deployment. */
export const MAX_ALLOWANCE_USD = 100_000;

export interface AllowanceConfig {
  /** Monthly USD allowance per account. Absent = unmetered. */
  monthlyUsd?: number;
  /** USD reserved per running turn before dispatch. Default 1. */
  turnReserveUsd?: number;
}

export interface MonthKey {
  key: string;
}

/** The usage month a timestamp belongs to, UTC. Keys sort lexically. */
export function monthKeyOf(at: number): MonthKey {
  const date = new Date(at);
  return { key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}` };
}

export interface AllowanceState {
  monthlyUsd: number;
  reserved: number;
  used: number;
  /** used + reserved, the number the UI shows as committed spend. */
  committed: number;
  remaining: number;
}

export interface ReserveOutcome {
  ok: boolean;
  /** Why the reservation was refused (present only when ok is false). */
  reason?: "cap-reached";
  state: AllowanceState;
}

/** The ledger itself. Keyed by account, scoped to a UTC month, persisted
 * by the caller (this module is pure so tests need no disk). */
export class UsageAllowance {
  /** monthKey -> accountId -> { reserved, used } */
  private readonly months = new Map<string, Map<string, { reserved: number; used: number }>>();
  private readonly config: AllowanceConfig | undefined;
  private readonly now: () => number;

  // SAFETY: no TS parameter properties — the server runs under Node's
  // strip-only type mode, which rejects that syntax at load time.
  constructor(config: AllowanceConfig | undefined, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
  }

  get enabled(): boolean {
    // config.json is the untyped input boundary. Number.isFinite rejects
    // strings/NaN/undefined, so only a real positive number meters anything.
    const cap = Number(this.config?.monthlyUsd);
    return Number.isFinite(cap) && cap > 0;
  }

  get reservePerTurn(): number {
    // Same boundary treatment: Number() coerces, Number.isFinite accepts
    // only the finite results, and everything else gets the default.
    const value = Number(this.config?.turnReserveUsd);
    const clamped = Number.isFinite(value) ? value : DEFAULT_TURN_RESERVE_USD;
    return Math.min(Math.max(clamped, 0.01), 25);
  }

  private month(): Map<string, { reserved: number; used: number }> {
    const { key } = monthKeyOf(this.now());
    let month = this.months.get(key);
    if (!month) {
      month = new Map();
      this.months.set(key, month);
    }
    return month;
  }

  private bucket(accountId: string): { reserved: number; used: number } {
    const month = this.month();
    let bucket = month.get(accountId);
    if (!bucket) {
      bucket = { reserved: 0, used: 0 };
      month.set(accountId, bucket);
    }
    return bucket;
  }

  /** The committed spend for one account this month (used + reserved). */
  state(accountId: string): AllowanceState {
    const cap = this.config?.monthlyUsd ?? 0;
    const bucket = this.bucket(accountId);
    const used = round(bucket.used);
    const reserved = round(bucket.reserved);
    return {
      monthlyUsd: round(cap),
      reserved,
      used,
      committed: round(used + reserved),
      remaining: round(Math.max(0, cap - used - reserved)),
    };
  }

  /** Try to hold `amount` against the cap. Atomic per account: concurrent
   * dispatches either each get their reservation or the last one sees
   * nothing left. */
  reserve(accountId: string, amount: number): ReserveOutcome {
    const bucket = this.bucket(accountId);
    const cap = this.config?.monthlyUsd ?? 0;
    const requested = round(Math.max(0, amount));
    if (bucket.used + bucket.reserved + requested > cap) {
      return { ok: false, reason: "cap-reached", state: this.state(accountId) };
    }
    bucket.reserved = round(bucket.reserved + requested);
    return { ok: true, state: this.state(accountId) };
  }

  /** A turn finished: trade its reservation for the real cost. Extra spend
   * beyond the reservation is still recorded (honest reporting) even when
   * it dips the account past the cap — the cap gates DISPATCH. */
  reconcile(accountId: string, actualUsd: number, reservedAmount: number): AllowanceState {
    const bucket = this.bucket(accountId);
    const actual = Math.max(0, Number.isFinite(actualUsd) ? actualUsd : 0);
    const held = Math.max(0, reservedAmount);
    bucket.reserved = round(Math.max(0, bucket.reserved - held));
    bucket.used = round(bucket.used + actual);
    return this.state(accountId);
  }

  /** The turn never ran (dispatch failed, cancelled): hand the reservation
   * straight back. */
  release(accountId: string, reservedAmount: number): AllowanceState {
    const bucket = this.bucket(accountId);
    bucket.reserved = round(Math.max(0, bucket.reserved - Math.max(0, reservedAmount)));
    return this.state(accountId);
  }
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;
