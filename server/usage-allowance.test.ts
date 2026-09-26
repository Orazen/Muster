import { describe, expect, it } from "vitest";

import {
  DEFAULT_TURN_RESERVE_USD,
  UsageAllowance,
  monthKeyOf,
} from "./usage-allowance.ts";

describe("usage allowance", () => {
  const cap = { monthlyUsd: 10 };

  it("is unmetered when no allowance is configured", () => {
    const ledger = new UsageAllowance(undefined);
    expect(ledger.enabled).toBe(false);
    const zero = new UsageAllowance({ monthlyUsd: 0 });
    expect(zero.enabled).toBe(false);
    const negative = new UsageAllowance({ monthlyUsd: -5 });
    expect(negative.enabled).toBe(false);
  });

  it("reserves before execution and reports committed spend", () => {
    const ledger = new UsageAllowance(cap);
    const first = ledger.reserve("acct-a", ledger.reservePerTurn);
    expect(first.ok).toBe(true);
    expect(first.state.committed).toBeGreaterThan(0);
    expect(first.state.remaining).toBeLessThan(cap.monthlyUsd);
    // a second concurrent dispatch also fits under a 10 USD cap
    const second = ledger.reserve("acct-a", ledger.reservePerTurn);
    expect(second.ok).toBe(true);
  });

  it("refuses a reservation that would cross the cap, atomically", () => {
    const ledger = new UsageAllowance({ monthlyUsd: 1, turnReserveUsd: 0.6 });
    expect(ledger.reserve("acct", 0.6).ok).toBe(true);
    const refused = ledger.reserve("acct", 0.6);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("cap-reached");
    // the refused attempt must not have moved the ledger
    expect(refused.state.reserved).toBe(0.6);
  });

  it("reconciles real cost against the reservation, returning the unused part", () => {
    const ledger = new UsageAllowance(cap);
    ledger.reserve("acct", 1);
    const state = ledger.reconcile("acct", 0.25, 1);
    expect(state.used).toBe(0.25);
    expect(state.reserved).toBe(0);
    expect(state.committed).toBe(0.25);
  });

  it("records real cost honestly even when it exceeds the reservation", () => {
    const ledger = new UsageAllowance(cap);
    ledger.reserve("acct", 0.5);
    const state = ledger.reconcile("acct", 0.9, 0.5);
    expect(state.used).toBe(0.9);
    expect(state.reserved).toBe(0);
  });

  it("releases the reservation when the turn never runs", () => {
    const ledger = new UsageAllowance(cap);
    ledger.reserve("acct", 1);
    const state = ledger.release("acct", 1);
    expect(state.committed).toBe(0);
    expect(state.remaining).toBe(cap.monthlyUsd);
  });

  it("keys accounts independently and months separately", () => {
    const ledger = new UsageAllowance({ monthlyUsd: 1, turnReserveUsd: 0.6 });
    expect(ledger.reserve("acct-a", 0.6).ok).toBe(true);
    // account b is untouched by account a's spend
    expect(ledger.reserve("acct-b", 0.6).ok).toBe(true);
    // and account a cannot reserve again this month
    expect(ledger.reserve("acct-a", 0.6).ok).toBe(false);
  });

  it("rolls over into a new month with a clean slate", () => {
    let now = Date.UTC(2026, 0, 31, 23, 59, 0);
    const ledger = new UsageAllowance({ monthlyUsd: 1, turnReserveUsd: 0.6 }, () => now);
    expect(ledger.reserve("acct", 0.6).ok).toBe(true);
    ledger.reconcile("acct", 0.6, 0.6);
    now = Date.UTC(2026, 1, 1, 0, 1, 0);
    const state = ledger.state("acct");
    expect(state.used).toBe(0);
    expect(state.remaining).toBe(1);
  });

  it("clamps the per-turn reservation into a sane band", () => {
    expect(new UsageAllowance({ monthlyUsd: 10, turnReserveUsd: 0 }).reservePerTurn).toBe(0.01);
    expect(new UsageAllowance({ monthlyUsd: 10, turnReserveUsd: 999 }).reservePerTurn).toBe(25);
    expect(new UsageAllowance({ monthlyUsd: 10 }).reservePerTurn).toBe(DEFAULT_TURN_RESERVE_USD);
  });

  it("derives stable UTC month keys", () => {
    expect(monthKeyOf(Date.UTC(2026, 8, 26)).key).toBe("2026-09");
    expect(monthKeyOf(Date.UTC(2026, 11, 31, 23)).key).toBe("2026-12");
  });
});
