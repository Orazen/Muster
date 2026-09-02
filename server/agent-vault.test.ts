// Muster Vault (lite) — budget checks are the whole module: unlimited
// passes, spent-below-cap passes, at-cap and over-cap refuse with the
// raise-the-cap hint, and garbage budgets behave as unlimited.
import { describe, expect, it } from "vitest";

import { checkBudget, tokenBudgetSchema } from "./agent-vault.ts";

describe("checkBudget", () => {
  it("passes when no budget is set (null/undefined/0)", () => {
    const usage = { lifetimeTokens: 5_000_000, inFlightTokens: 0 };
    expect(checkBudget(null, usage)).toEqual({ ok: true });
    expect(checkBudget(undefined, usage)).toEqual({ ok: true });
    expect(checkBudget(0, usage)).toEqual({ ok: true });
  });

  it("passes while spent stays under the cap", () => {
    expect(checkBudget(1_000_000, { lifetimeTokens: 999_999, inFlightTokens: 0 })).toEqual({ ok: true });
  });

  it("counts in-flight spend against the cap", () => {
    expect(checkBudget(1_000_000, { lifetimeTokens: 999_000, inFlightTokens: 1_000 })).toEqual({
      ok: false,
      reason: expect.stringContaining("Token budget reached"),
    });
  });

  it("refuses at exactly the cap (no overage clause when not over)", () => {
    const verdict = checkBudget(1_000_000, { lifetimeTokens: 900_000, inFlightTokens: 100_000 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).not.toContain("over)");
  });

  it("the refusal names the cap and how to fix it", () => {
    const verdict = checkBudget(100_000, { lifetimeTokens: 150_000, inFlightTokens: 0 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("150,000");
      expect(verdict.reason).toContain("100,000");
      expect(verdict.reason).toContain("Raise or clear the cap");
    }
  });

  it("negative/garbage usage never makes things worse than reality", () => {
    expect(checkBudget(1_000_000, { lifetimeTokens: -50, inFlightTokens: -1_000 })).toEqual({ ok: true });
  });
});

describe("tokenBudgetSchema", () => {
  it("bounds the number and allows null for clearing", () => {
    expect(tokenBudgetSchema.safeParse(10_000).success).toBe(true);
    expect(tokenBudgetSchema.safeParse(null).success).toBe(true);
    expect(tokenBudgetSchema.safeParse(undefined).success).toBe(true);
    expect(tokenBudgetSchema.safeParse(9_999).success).toBe(false);
    expect(tokenBudgetSchema.safeParse(2_000_000_001).success).toBe(false);
    expect(tokenBudgetSchema.safeParse(1.5).success).toBe(false);
    expect(tokenBudgetSchema.safeParse("100000").success).toBe(false);
  });
});
