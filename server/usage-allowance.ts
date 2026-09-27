// Usage allowance (device-first strategy, missing-logic #6): the deployment
// can declare a monthly USD allowance that task dispatch RESERVES before a
// turn starts, reconciles from the turn's real cost when it completes, and
// releases when the turn fails or cancels. A reservation is optimistic but
// honest: it is checked and recorded BEFORE the model is invoked, so one
// account can never silently overspend a cap by racing concurrent turns.
// NO default allowance exists — unset means unmetered, exactly as today.
// BYOK fallback is a per-bot modelSelection decision the user already
// owns; this ledger surfaces, it does not choose.
//
// Durability: reservations land before dispatch, and settlement replaces
// them with reported or estimated spend. After a crash an outstanding hold
// is uncertain spend, not proof that the provider did no work. Invalid or
// unwritable state blocks further reservations until the ledger is repaired;
// it must never silently reset a configured cap.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

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
  /** Cost the provider actually reported. */
  used: number;
  /** Spend the provider never itemized (null cost): kept, never zeroed. */
  usedUnknown: number;
  /** used + usedUnknown + reserved, the number the UI shows as committed spend. */
  committed: number;
  remaining: number;
}

export interface ReserveOutcome {
  ok: boolean;
  /** Why the reservation was refused (present only when ok is false). */
  reason?: "cap-reached" | "ledger-unavailable";
  state: AllowanceState;
}

/** One account's month: the reservation held against running turns, the
 * spend the provider reported, and the spend it did not. */
interface AllowanceBucket {
  reserved: number;
  used: number;
  usedUnknown?: number;
}

/** The current month's settled costs and pending holds. Older version-1
 * files without reserved remain readable; missing reserved means zero. */
interface UsageAllowanceLedgerFile {
  version: 1;
  months: Record<string, Record<string, { used: number; usedUnknown?: number; reserved?: number }>>;
}

const ledgerFileSchema = z.object({
  version: z.literal(1),
  months: z.record(z.string(), z.record(z.string(), z.object({
    used: z.number().nonnegative(),
    usedUnknown: z.number().nonnegative().optional(),
    reserved: z.number().nonnegative().optional(),
  }))),
});

/** The ledger itself. Keyed by account, scoped to a UTC month, persisted
 * when the caller supplies a path. Without a path it remains an in-memory
 * ledger for callers and tests that do not request durability. */
export class UsageAllowance {
  /** monthKey -> accountId -> { reserved, used, usedUnknown } */
  private readonly months = new Map<string, Map<string, AllowanceBucket>>();
  private readonly config: AllowanceConfig | undefined;
  private readonly now: () => number;
  private readonly persistPath?: string;
  private ledgerUnavailable = false;

  // SAFETY: no TS parameter properties — the server runs under Node's
  // strip-only type mode, which rejects that syntax at load time.
  constructor(config: AllowanceConfig | undefined, now: () => number = Date.now, persistPath?: string) {
    this.config = config;
    this.now = now;
    this.persistPath = persistPath;
    this.restoreUsed();
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

  /** Restore this UTC month. Only ENOENT means a new ledger. A pending hold
   * becomes unknown spend because a restart cannot prove the provider never
   * acted. This conversion is not added repeatedly: every boot starts from
   * the disk record, and the next write saves unknown with reserved zero. */
  private restoreUsed(): void {
    if (!this.persistPath) return;
    try {
      const disk = ledgerFileSchema.parse(JSON.parse(readFileSync(this.persistPath, "utf8")));
      const current = monthKeyOf(this.now()).key;
      for (const [monthKey, accounts] of Object.entries(disk.months ?? {})) {
        if (monthKey !== current) continue;
        const month = new Map<string, AllowanceBucket>();
        for (const [accountId, record] of Object.entries(accounts)) {
          month.set(accountId, { reserved: 0, used: record.used, usedUnknown: round((record.usedUnknown ?? 0) + (record.reserved ?? 0)) });
        }
        if (month.size > 0) this.months.set(monthKey, month);
      }
    } catch (error) {
      this.ledgerUnavailable = !z.object({ code: z.literal("ENOENT") }).safeParse(error).success;
    }
  }

  /** A failed write latches the ledger closed. The last successful record
   * still contains the pre-dispatch hold if settlement could not land. */
  private persist(): boolean {
    if (!this.persistPath) return true;
    if (this.ledgerUnavailable) return false;
    const current = monthKeyOf(this.now()).key;
    const months: UsageAllowanceLedgerFile["months"] = {};
    const live = this.months.get(current);
    if (live) {
      months[current] = {};
      for (const [accountId, bucket] of live) {
        months[current]![accountId] = { used: bucket.used, usedUnknown: bucket.usedUnknown, reserved: bucket.reserved };
      }
    }
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
      writeFileAtomic(
        this.persistPath,
        JSON.stringify({ version: 1, months } satisfies UsageAllowanceLedgerFile, null, 2),
        { mode: 0o600 },
      );
      return true;
    } catch {
      this.ledgerUnavailable = true;
      return false;
    }
  }

  private month(): Map<string, AllowanceBucket> {
    const { key } = monthKeyOf(this.now());
    let month = this.months.get(key);
    if (!month) {
      month = new Map();
      this.months.set(key, month);
    }
    return month;
  }

  private bucket(accountId: string): AllowanceBucket {
    const month = this.month();
    let bucket = month.get(accountId);
    if (!bucket) {
      bucket = { reserved: 0, used: 0 };
      month.set(accountId, bucket);
    }
    return bucket;
  }

  /** The committed spend for one account this month (used + unknown + reserved). */
  state(accountId: string): AllowanceState {
    const cap = this.config?.monthlyUsd ?? 0;
    const bucket = this.bucket(accountId);
    const used = round(bucket.used);
    const usedUnknown = round(bucket.usedUnknown ?? 0);
    const reserved = round(bucket.reserved);
    return {
      monthlyUsd: round(cap),
      reserved,
      used,
      usedUnknown,
      committed: round(used + usedUnknown + reserved),
      remaining: round(Math.max(0, cap - used - usedUnknown - reserved)),
    };
  }

  /** Try to hold `amount` against the cap. Atomic per account: concurrent
   * dispatches either each get their reservation or the last one sees
   * nothing left. */
  reserve(accountId: string, amount: number): ReserveOutcome {
    if (this.ledgerUnavailable) return { ok: false, reason: "ledger-unavailable", state: this.state(accountId) };
    const bucket = this.bucket(accountId);
    const cap = this.config?.monthlyUsd ?? 0;
    const requested = round(Math.max(0, amount));
    if (bucket.used + (bucket.usedUnknown ?? 0) + bucket.reserved + requested > cap) {
      return { ok: false, reason: "cap-reached", state: this.state(accountId) };
    }
    const previous = bucket.reserved;
    bucket.reserved = round(bucket.reserved + requested);
    if (!this.persist()) {
      bucket.reserved = previous;
      return { ok: false, reason: "ledger-unavailable", state: this.state(accountId) };
    }
    return { ok: true, state: this.state(accountId) };
  }

  /** A turn finished: trade its reservation for the real cost. Extra spend
   * beyond the reservation is still recorded (honest reporting) even when
   * it dips the account past the cap — the cap gates DISPATCH. A turn whose
   * provider reported no cost keeps its reservation amount as UNKNOWN
   * spend instead of collapsing it to zero: the reservation was the best
   * estimate available, and forgetting it would re-open the cap. */
  reconcile(accountId: string, actualUsd: number | null, reservedAmount: number): AllowanceState {
    const bucket = this.bucket(accountId);
    const held = Math.max(0, reservedAmount);
    bucket.reserved = round(Math.max(0, bucket.reserved - held));
    if (actualUsd === null || !Number.isFinite(actualUsd)) {
      bucket.usedUnknown = round((bucket.usedUnknown ?? 0) + held);
    } else {
      bucket.used = round(bucket.used + Math.max(0, actualUsd));
    }
    this.persist();
    return this.state(accountId);
  }

  /** The turn never ran (dispatch failed, cancelled): hand the reservation
   * straight back. */
  release(accountId: string, reservedAmount: number): AllowanceState {
    const bucket = this.bucket(accountId);
    bucket.reserved = round(Math.max(0, bucket.reserved - Math.max(0, reservedAmount)));
    this.persist();
    return this.state(accountId);
  }
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;
