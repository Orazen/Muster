import { describe, expect, it } from "vitest";
import * as license from "./license.js";
import {
  effectiveTier,
  resolveTier,
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

describe("unlimited — the app has no Free caps", () => {
  it("exports no roster cap, no vault-file cap, and no guard for either", () => {
    // FREE_BOT_CAP / FREE_VAULT_FILE_CAP and their guards (canAddBot,
    // vaultFileAllowed) were deleted: bots and vault files are unlimited on
    // every tier. This pins that contract at the module surface — the app is
    // free, so no tier can ever refuse a teammate or an upload.
    for (const name of ["FREE_BOT_CAP", "FREE_VAULT_FILE_CAP", "canAddBot", "vaultFileAllowed"]) {
      expect(license).not.toHaveProperty(name);
    }
  });

  it("tier state carries only trial fields, never a cap field", () => {
    const lapsed = resolveTier({
      firstLaunchAt: LAUNCH,
      now: new Date(Date.parse(LAUNCH) + 20 * DAY).toISOString(),
    });
    expect(Object.keys(lapsed).sort()).toEqual(["bonusDays", "tier", "trialActive", "trialEndsAt"]);
    // A lapsed trial still reports free — with nothing left for it to cap.
    expect(effectiveTier(lapsed)).toBe("free");
    const active = resolveTier({ firstLaunchAt: LAUNCH, now: new Date(Date.parse(LAUNCH) + DAY).toISOString() });
    expect(Object.keys(active).sort()).toEqual(["bonusDays", "tier", "trialActive", "trialEndsAt"]);
  });
});
