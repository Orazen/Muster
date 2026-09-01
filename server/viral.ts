// Viral growth primitives: referral codes and share tokens.
//
// Two loops, both built on things Muster already has:
//
// 1. Referrals — every signed-in user gets a code; whoever redeems it on a
//    NEW install banks Pro days on BOTH sides (the inviter on the cloud
//    record, the invitee on their local tier file). Pro days extend the
//    trial window via license.ts's bonusProDays — never shorten anything,
//    never gate data.
//
// 2. Wrapped shares — /api/wrapped already computes the card; a share
//    token turns it into a public, unguessable URL that renders a
//    standalone page. Tokens encode NOTHING but an id: card data is
//    stored server-side, the URL carries no personal info.
//
// Pure logic here (pinned by tests); persistence and routes live in the
// callers (server/index.ts cloud store for referrals, share-tokens.json
// for Wrapped cards).

import { randomBytes, timingSafeEqual } from "node:crypto";

/** Pro days granted per successful referral. */
export const REFERRAL_INVITER_DAYS = 7;
export const REFERRAL_INVITEE_DAYS = 7;
/** A new install may redeem at most this many invite codes (anti self-farm). */
export const MAX_REDEEM_PER_INVITEE = 3;
/** Upper bound on banked bonus days so the trial window can't be pushed
 * past a sane horizon by referral farming. */
export const MAX_BONUS_DAYS = 365;

export interface ReferralCodeCheck {
  valid: boolean;
  reason?: "malformed" | "unknown";
}

/** Referral codes are 10 chars of base58-ish unambiguous alphabet — same
 * character discipline as pairing codes. Uppercase, no 0/O/1/I/L. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newReferralCode(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function isPlausibleReferralCode(code: string): boolean {
  // The regex alone is the contract: a malformed input simply fails the
  // character-class/length match, so no representation check is needed.
  return /^[2-9A-HJ-NP-Z]{10}$/.test(code ?? "");
}

/** Constant-time code comparison for store lookups that hold raw codes. */
export function referralCodeMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Cap the banked bonus days. Called before persisting an increment.
 * Corrupted values (negative, NaN) collapse to 0 before adding. */
export function clampBonusDays(current: number, add: number): number {
  const base = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0;
  const gain = Number.isFinite(add) ? Math.max(0, Math.floor(add)) : 0;
  return Math.min(MAX_BONUS_DAYS, base + gain);
}

// ── share tokens ────────────────────────────────────────────────────────

export interface ShareToken {
  token: string;
  kind: "wrapped";
  createdAt: number;
}

/** Unlinked, unguessable token for a public share URL. 128 bits is plenty
 * for URLs that are shared by hand; nothing about the owner is encoded. */
export function newShareToken(): string {
  return randomBytes(16).toString("base64url");
}

/** Cap the share-token map so an authenticated loop can't grow it
 * unboundedly. Oldest tokens fall off; shared URLs older than a month
 * expiring is acceptable for a weekly card. */
export const MAX_SHARE_TOKENS = 500;

export function pruneShareTokens(tokens: Map<string, ShareToken>): void {
  if (tokens.size <= MAX_SHARE_TOKENS) return;
  const entries = [...tokens.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (const [key] of entries.slice(0, tokens.size - MAX_SHARE_TOKENS)) tokens.delete(key);
}
