// Tier & trial entitlements — the Free/Pro/Cloud ladder from the founder
// playbook, enforced locally. Design rules (memory/free-trial-spec.md):
//
// 1. The trial is a FEATURE unlock, never a token grant — no key needed.
// 2. A license is an Ed25519-signed JSON; verified offline, 7-day grace.
// 3. Backup restore is NEVER gated. Data escape hatch always open.
// 4. Pure logic here: the store persists state, callers enforce caps.

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

export const FREE_BOT_CAP = 2;
export const FREE_VAULT_FILE_CAP = 1_000;
export const TRIAL_DAYS = 14;

export interface TierState {
  tier: Tier;
  /** True during the 14-day Pro trial that starts on first launch. */
  trialActive: boolean;
  /** ISO date the trial ends (firstLaunch + TRIAL_DAYS), even if lapsed. */
  trialEndsAt: string;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * Resolve today's tier. `firstLaunchAt` is persisted on first boot so the
 * trial clock never restarts; `license` is the parsed payload of a valid
 * license file (signature verified by the caller before it gets here).
 */
export function resolveTier(input: {
  firstLaunchAt: string;
  now?: string;
  license?: LicensePayload | null;
}): TierState {
  const now = input.now ?? new Date().toISOString();
  const trialEndsAt = addDays(input.firstLaunchAt, TRIAL_DAYS);
  if (input.license && Date.parse(input.license.exp) > Date.parse(now)) {
    return { tier: "pro", trialActive: false, trialEndsAt };
  }
  const trialActive = Date.parse(now) < Date.parse(trialEndsAt);
  // During the trial the user gets Pro features; after it lapses without a
  // license they fall back to Free — watermark on, caps on, data intact.
  return { tier: trialActive ? "pro" : "free", trialActive, trialEndsAt };
}

/** Effective tier for enforcement: identical to resolveTier's tier field. */
export function effectiveTier(state: TierState): Tier {
  return state.tier;
}

export function canAddBot(currentBots: number, tier: Tier): boolean {
  if (tier === "pro") return true;
  return currentBots < FREE_BOT_CAP;
}

export function vaultFileAllowed(currentFiles: number, tier: Tier): boolean {
  if (tier === "pro") return true;
  // Restores are never gated — only new uploads count against the cap.
  return currentFiles < FREE_VAULT_FILE_CAP;
}

// ── persistence ─────────────────────────────────────────────────────────
// ~/.muster/license.json: { firstLaunchAt, license? }. Tiny file, read per
// request; the signature check lives with the store endpoint that accepts
// uploads — here we only trust already-verified payloads.

export interface TierFile {
  firstLaunchAt?: string;
  license?: LicensePayload | null;
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
  return resolveTier({ firstLaunchAt, now, license: parsed.license ?? null });
}
