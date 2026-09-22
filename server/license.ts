// Tier & trial entitlements — the Free/Pro/Cloud ladder from the founder
// playbook, enforced locally. Design rules (memory/free-trial-spec.md):
//
// 1. The trial is a FEATURE unlock, never a token grant — no key needed.
// 2. A license is an Ed25519-signed JSON; verified offline, 7-day grace.
// 3. Backup restore is NEVER gated. Data escape hatch always open.
// 4. Pure logic here: the store persists state; callers act on it. There is
//    no Free-tier cap left to enforce — bots and vault files are unlimited.

import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

export type Tier = "free" | "pro";

/** What a paid license file contains (signed by the Orazen store key). */
export interface LicensePayload {
  tier: "pro";
  /** ISO date after which the license expires. */
  exp: string;
  licensee?: string;
}

export const TRIAL_DAYS = 14;

export interface TierState {
  tier: Tier;
  /** True during the 14-day Pro trial that starts on first launch. */
  trialActive: boolean;
  /** ISO date the trial ends (firstLaunch + TRIAL_DAYS + bonusDays), even
   * if lapsed. Referral rewards extend this, they never shorten it. */
  trialEndsAt: string;
  /** Pro days granted on top of the 14-day trial (referral rewards). */
  bonusDays: number;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * Resolve today's tier. `firstLaunchAt` is persisted on first boot so the
 * trial clock never restarts; `license` is the parsed payload of a valid
 * license file (signature verified by the caller before it gets here);
 * `bonusProDays` are referral rewards persisted in the tier file.
 */
export function resolveTier(input: {
  firstLaunchAt: string;
  now?: string;
  license?: LicensePayload | null;
  bonusProDays?: number;
}): TierState {
  const now = input.now ?? new Date().toISOString();
  const bonus = Math.max(0, Math.floor(input.bonusProDays ?? 0));
  const trialEndsAt = addDays(input.firstLaunchAt, TRIAL_DAYS + bonus);
  if (input.license && Date.parse(input.license.exp) > Date.parse(now)) {
    return { tier: "pro", trialActive: false, trialEndsAt, bonusDays: bonus };
  }
  const trialActive = Date.parse(now) < Date.parse(trialEndsAt);
  // During the trial the user gets Pro features; after it lapses without a
  // license they fall back to Free — data intact, and no part of the app is
  // capped: the roster and the vault stay unlimited either way.
  return { tier: trialActive ? "pro" : "free", trialActive, trialEndsAt, bonusDays: bonus };
}

/** Effective tier for enforcement: identical to resolveTier's tier field. */
export function effectiveTier(state: TierState): Tier {
  return state.tier;
}

// ── persistence ─────────────────────────────────────────────────────────
// ~/.muster/license.json: { firstLaunchAt, license? }. Tiny file, read per
// request; the signature check lives with the store endpoint that accepts
// uploads — here we only trust already-verified payloads.

export interface TierFile {
  firstLaunchAt?: string;
  license?: LicensePayload | null;
  /** Referral rewards: Pro days banked on this install (granted when this
   * user's invite code is redeemed by someone else, or when they redeem
   * someone else's code). Extends the trial; never shortens it. */
  bonusProDays?: number;
}

export function loadTierFile(dataDir: string, now?: string): TierState {
  const file = join(dataDir, "license.json");
  let parsed: TierFile = {};
  try {
    // SAFETY: local config owned by the same user as the server process.
    parsed = JSON.parse(readFileSync(file, "utf8")) as TierFile;
  } catch {
    parsed = {};
  }
  const firstLaunchAt = parsed.firstLaunchAt ?? new Date().toISOString();
  if (!parsed.firstLaunchAt) {
    try {
      writeFileSync(file, JSON.stringify({ firstLaunchAt, license: null }, null, 2));
    } catch {
      /* read-only data dir: treat trial as not started rather than crash */
    }
  }
  return resolveTier({
    firstLaunchAt,
    now,
    license: parsed.license ?? null,
    bonusProDays: parsed.bonusProDays,
  });
}

/** Grant referral Pro days on this install: persists into the tier file so
 * the bonus survives restarts and stacks across referrals. Returns the new
 * TierState. */
export function grantBonusProDays(dataDir: string, days: number, now?: string): TierState {
  const file = join(dataDir, "license.json");
  let parsed: TierFile = {};
  try {
    // SAFETY: local config owned by the same user as the server process.
    parsed = JSON.parse(readFileSync(file, "utf8")) as TierFile;
  } catch {
    parsed = {};
  }
  const firstLaunchAt = parsed.firstLaunchAt ?? new Date().toISOString();
  parsed.firstLaunchAt = firstLaunchAt;
  parsed.bonusProDays = clamp(parsed.bonusProDays ?? 0, days);
  try {
    writeFileSync(file, JSON.stringify(parsed, null, 2));
  } catch {
    /* read-only dir: grant applies to this boot only rather than crash */
  }
  return resolveTier({
    firstLaunchAt,
    now,
    license: parsed.license ?? null,
    bonusProDays: parsed.bonusProDays,
  });
}

function clamp(current: number, add: number): number {
  return Math.min(365, Math.max(0, Math.floor(current)) + Math.max(0, Math.floor(add)));
}
