import { describe, expect, it } from "vitest";

import {
  clampBonusDays,
  isPlausibleReferralCode,
  MAX_BONUS_DAYS,
  MAX_SHARE_TOKENS,
  newReferralCode,
  newShareToken,
  pruneShareTokens,
  referralCodeMatches,
  type ShareToken,
} from "./viral.ts";

describe("referral codes", () => {
  it("generates plausible codes", () => {
    for (let i = 0; i < 50; i++) {
      expect(newReferralCode()).toMatch(/^[2-9A-HJ-NP-Z]{10}$/);
    }
  });
  it("generates unique codes", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newReferralCode()));
    expect(seen.size).toBe(500);
  });

  it("accepts only well-formed codes", () => {
    expect(isPlausibleReferralCode("ABCD2345YZ")).toBe(true);
    expect(isPlausibleReferralCode("abcd2345yz")).toBe(false); // lowercase
    expect(isPlausibleReferralCode("O0I1L2345X")).toBe(false); // ambiguous chars
    expect(isPlausibleReferralCode("SHORT")).toBe(false);
    expect(isPlausibleReferralCode("")).toBe(false);
    expect(isPlausibleReferralCode("ABCD2345YZEXTRA")).toBe(false);
  });

  it("compares codes in constant time", () => {
    expect(referralCodeMatches("ABCD2345YZ", "ABCD2345YZ")).toBe(true);
    expect(referralCodeMatches("ABCD2345YZ", "ABCD2345YX")).toBe(false);
    expect(referralCodeMatches("ABCD", "ABCD2345YZ")).toBe(false);
  });
});

describe("bonus days", () => {
  it("accumulates without exceeding the ceiling", () => {
    expect(clampBonusDays(0, 7)).toBe(7);
    expect(clampBonusDays(7, 7)).toBe(14);
    expect(clampBonusDays(MAX_BONUS_DAYS, 7)).toBe(MAX_BONUS_DAYS);
  });

  it("rejects garbage", () => {
    // a corrupted negative balance is treated as zero, not subtracted from
    expect(clampBonusDays(-5, 7)).toBe(7);
    expect(clampBonusDays(10, -100)).toBe(10);
    expect(clampBonusDays(Number.NaN, 7)).toBe(7);
  });
});

describe("share tokens", () => {
  it("generates url-safe unguessable tokens", () => {
    const t = newShareToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{21,22}$/);
    expect(newShareToken()).not.toBe(t);
  });

  it("prunes oldest tokens beyond the cap", () => {
    const tokens = new Map<string, ShareToken>();
    for (let i = 0; i < MAX_SHARE_TOKENS + 10; i++) {
      tokens.set(`t${i}`, { token: `t${i}`, kind: "wrapped", createdAt: i });
    }
    pruneShareTokens(tokens);
    expect(tokens.size).toBe(MAX_SHARE_TOKENS);
    expect(tokens.has("t0")).toBe(false);
    expect(tokens.has("t9")).toBe(false);
    expect(tokens.has(`t${MAX_SHARE_TOKENS + 9}`)).toBe(true);
  });

  it("leaves small maps alone", () => {
    const tokens = new Map<string, ShareToken>([
      ["a", { token: "a", kind: "wrapped", createdAt: 1 }],
    ]);
    pruneShareTokens(tokens);
    expect(tokens.size).toBe(1);
  });
});
