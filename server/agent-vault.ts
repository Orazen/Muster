// Muster Vault (lite) — per-agent spend guardrails, inspired by NanoClaw's
// Agent Vault (per-request key injection with per-agent rate limits).
// This slice: an optional lifetime TOKEN BUDGET per bot. When a bot's
// cumulative usage crosses its budget, its turns are refused with a clear
// chip until a human raises or clears the cap. The metered unit the
// business bills for is the cloud computer; the budget protects against a
// runaway agent burning the account's provider quota regardless of where
// it runs.
//
// Deliberately minimal: the number lives on the bot record (patchable via
// the existing per-bot PATCH route), the ledger is the task tally the
// store already maintains plus the in-flight turn's running figure. No
// second source of truth, no background jobs.
import { z } from "zod";

/** Budget is in tokens (input+output combined), lifetime per bot.
 * 0/null = unlimited; min is small enough to be a real tripwire. */
export const TOKEN_BUDGET_MIN = 10_000;
export const TOKEN_BUDGET_MAX = 2_000_000_000;

export const tokenBudgetSchema = z
  .number()
  .int()
  .min(TOKEN_BUDGET_MIN)
  .max(TOKEN_BUDGET_MAX)
  .nullable()
  .optional();

export interface BudgetUsageSource {
  /** Lifetime tokens this bot's settled tasks consumed. */
  lifetimeTokens: number;
  /** Tokens spent by the turn currently in flight, if any. */
  inFlightTokens: number;
}

export type BudgetCheck = { ok: true } | { ok: false; reason: string };

/** Would starting one more turn on this bot cross its budget? Uses the
 * projected end-of-turn figure (spent + in-flight + a full new turn's
 * allowance is unknowable pre-run, so enforcement is: the bot must still
 * have budget HEADROOM — strictly below the cap counting in-flight spend). */
export function checkBudget(
  budget: number | null | undefined,
  usage: BudgetUsageSource,
): BudgetCheck {
  if (!budget || budget <= 0) return { ok: true };
  const spent = Math.max(0, Math.trunc(usage.lifetimeTokens)) + Math.max(0, Math.trunc(usage.inFlightTokens));
  if (spent >= budget) {
    const over = spent - budget;
    return {
      ok: false,
      reason:
        `Token budget reached — this bot has spent ${spent.toLocaleString()} of its ${budget.toLocaleString()}-token cap` +
        (over > 0 ? ` (${over.toLocaleString()} over)` : "") +
        ". Raise or clear the cap in the bot's settings to continue.",
    };
  }
  return { ok: true };
}
