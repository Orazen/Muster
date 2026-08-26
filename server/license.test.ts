import { describe, expect, it } from "vitest";
import {
  canAddBot,
  effectiveTier,
  FREE_BOT_CAP,
  resolveTier,
  vaultFileAllowed,
  type LicensePayload,
} from "./license.js";

const LAUNCH = "2026-08-26T00:00:00.000Z";
const DAY = 86_400_000;

const proLicense: LicensePayload = { tier: "pro", exp: "2027-01-01T00:00:00.000Z", licensee: "ram" };

describe("resolveTier", () => {
  it("grants pro during the 14-day trial with no license", () => {
    const s = resolveTier({ firstLaunchAt: LAUNCH, now: new Date(Date.parse(LAUNCH) + 5 * DAY).toISOString() });
    expect(effectiveTier(s)).toBe("pro");
    expect(s.trialActive).toBe(true);
    expect(s.trialEndsAt).toBe("2026-09-09T00:00:00.000Z");
  });

  it("falls back to free after the trial lapses without a license", () => {
    const s = resolveTier({ firstLaunchAt: LAUNCH, now: new Date(Date.parse(LAUNCH) + 20 * DAY).toISOString() });
    expect(effectiveTier(s)).toBe("free");
    expect(s.trialActive).toBe(false);
  });

  it("a valid license is pro regardless of trial state", () => {
    const s = resolveTier({
      firstLaunchAt: LAUNCH,
      now: new Date(Date.parse(LAUNCH) + 60 * DAY).toISOString(),
      license: proLicense,
    });
    expect(effectiveTier(s)).toBe("pro");
    expect(s.trialActive).toBe(false);
  });

  it("an expired license does not grant pro", () => {
    const s = resolveTier({
      firstLaunchAt: LAUNCH,
      now: "2027-06-01T00:00:00.000Z",
      license: { tier: "pro", exp: "2026-12-31T00:00:00.000Z" },
    });
    expect(effectiveTier(s)).toBe("free");
  });
});

describe("caps", () => {
  it("free tier caps the roster at 2 bots; pro unlimited", () => {
    expect(canAddBot(1, "free")).toBe(true);
    expect(canAddBot(FREE_BOT_CAP, "free")).toBe(false);
    expect(canAddBot(500, "pro")).toBe(true);
  });

  it("vault upload cap applies on free; restore never gated by design", () => {
    expect(vaultFileAllowed(999, "free")).toBe(true);
    expect(vaultFileAllowed(1_000, "free")).toBe(false);
    expect(vaultFileAllowed(50_000, "pro")).toBe(true);
  });
});
