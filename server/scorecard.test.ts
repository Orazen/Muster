import { describe, expect, it } from "vitest";

import { evaluateScorecard, type RoutineCheck } from "./routines.ts";

describe("evaluateScorecard", () => {
  const checks: RoutineCheck[] = [
    { id: "1", label: "mentions total", kind: "contains", value: "total" },
    { id: "2", label: "no placeholder text", kind: "not_contains", value: "TODO" },
    { id: "3", label: "has an amount", kind: "matches", value: "\\$?[0-9]+" },
  ];

  it("passes all checks on a good output", () => {
    const results = evaluateScorecard(checks, "The total is $42 and shipping is free.");
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("fails contains when the text lacks the substring", () => {
    const results = evaluateScorecard([checks[0]], "nothing relevant here");
    expect(results[0].passed).toBe(false);
    expect(results[0].reason).toContain("does not contain");
  });

  it("contains is case-insensitive", () => {
    const results = evaluateScorecard([checks[0]], "TOTAL SPEND: 12");
    expect(results[0].passed).toBe(true);
  });

  it("fails not_contains when the forbidden text appears", () => {
    const results = evaluateScorecard([checks[1]], "still has TODO items");
    expect(results[0].passed).toBe(false);
    expect(results[0].reason).toContain("contains");
  });

  it("fails a regex check on a non-matching output", () => {
    const results = evaluateScorecard([checks[2]], "no numbers at all");
    expect(results[0].passed).toBe(false);
  });

  it("fails every affirmative check when the output is missing", () => {
    const results = evaluateScorecard(checks, undefined);
    // "not_contains" trivially passes on an empty output; every check that
    // requires something to be present fails.
    expect(results.find((r) => r.id === "1")?.passed).toBe(false);
    expect(results.find((r) => r.id === "3")?.passed).toBe(false);
  });

  it("returns undefined for a routine with no checks", () => {
    expect(evaluateScorecard(undefined, "anything")).toBeUndefined();
    expect(evaluateScorecard([], "anything")).toBeUndefined();
  });

  it("a misconfigured regex fails the check instead of throwing", () => {
    // "[" alone is an invalid regex that sanitized input should have kept
    // out — but a hand-edited routines.json can still smuggle one in.
    const results = evaluateScorecard([{ id: "x", label: "broken", kind: "matches", value: "[" }], "text");
    expect(results[0].passed).toBe(false);
    expect(results[0].reason).toContain("misconfigured");
  });
});
