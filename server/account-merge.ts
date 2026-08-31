// Account merge — one human, several sign-in identities, one dataset.
//
// Why. Cloud sign-in fragments naturally: the same person ends up with a
// Google identity per email (work, old signup, typo account), each holding
// its own vault keys and bots. Rather than asking support to shuffle rows,
// any signed-in account can mint a short-lived merge token; the OTHER
// account spends it and its data migrates into the token's account.
// What. Token registry here; the actual migration (vault keys, bot
// ownership, auth-row deletion) lives in index.ts where the store and
// registry handles already exist.

import { randomBytes } from "node:crypto";

interface PendingMerge {
  targetUserId: string;
  expiresAt: number;
}

const TTL_MS = 15 * 60_000;
const pending = new Map<string, PendingMerge>();

function sweep(now = Date.now()): void {
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
}

/** Mint a single-use merge token whose target is the CURRENT account. */
export function startAccountMerge(targetUserId: string): string {
  sweep();
  const token = randomBytes(24).toString("base64url");
  pending.set(token, { targetUserId, expiresAt: Date.now() + TTL_MS });
  return token;
}

export interface MergeIntent {
  targetUserId: string;
}

/** Spend a token on behalf of the SOURCE account. Returns the merge target,
 * or null when the token is unknown/expired. Single-use by construction —
 * a valid spend removes the token before the caller mutates anything. */
export function spendAccountMergeToken(token: string, sourceUserId: string): MergeIntent | null {
  sweep();
  const entry = pending.get(token);
  if (!entry || entry.expiresAt <= Date.now()) {
    pending.delete(token);
    return null;
  }
  if (entry.targetUserId === sourceUserId) return null; // merging with yourself is a no-op, not an error path
  pending.delete(token);
  return { targetUserId: entry.targetUserId };
}
