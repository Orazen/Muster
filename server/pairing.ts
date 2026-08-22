// Cloud↔desktop identity pairing — the bridge that gives the desktop app
// Google sign-in without shipping OAuth credentials to desktop installs.
//
// Flow: a signed-in cloud user generates a short-lived code on
// muster.orazen.online (/pair), types it into their desktop app, and the
// local server redeems it against the cloud's verify endpoint. The code IS
// the credential (same trust model as OAuth device activation): high
// entropy, single-use, five-minute TTL, and redeem attempts are rate-
// limited per IP so guessing is hopeless long before the code expires.

import { randomBytes } from "node:crypto";

const CODE_TTL_MS = 5 * 60_000;
const CODE_LENGTH = 8;
// No 0/O/1/I/L — codes get typed by hand off another screen.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Redeem attempts allowed per IP inside one window. A human mistypes a
 * couple of characters; a guesser never gets near 2^40 space at this rate. */
const VERIFY_WINDOW_MS = 5 * 60_000;
const MAX_VERIFIES_PER_WINDOW = 20;

interface PendingCode {
  userId: string;
  expiresAt: number;
}

const pending = new Map<string, PendingCode>();
const verifyAttempts = new Map<string, { count: number; windowStart: number }>();

function sweepExpired(now = Date.now()): void {
  for (const [code, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(code);
  }
  for (const [ip, window] of verifyAttempts) {
    if (window.windowStart + VERIFY_WINDOW_MS <= now) verifyAttempts.delete(ip);
  }
}

/** Cryptographically random code from the unambiguous alphabet. Rejection
 * sampling keeps every character uniformly distributed. */
export function createCode(userId: string, now = Date.now()) {
  if (!userId) throw Object.assign(new Error("a session is required to create a pairing code"), { status: 401 });
  sweepExpired(now);
  // One live code per user: generating again invalidates the old one, so a
  // lost phone screen can't accumulate an army of still-valid codes.
  for (const [code, entry] of pending) {
    if (entry.userId === userId) pending.delete(code);
  }
  let raw = randomBytes(CODE_LENGTH);
  for (let i = 0; i < raw.length; i++) {
    // 256 % 31 ≈ 19 — redraw the rare biased byte rather than modulo it
    while (raw[i] >= 256 - (256 % ALPHABET.length)) raw[i] = randomBytes(1)[0];
  }
  const code = Array.from(raw, (b) => ALPHABET[b % ALPHABET.length]).join("");
  const expiresAt = now + CODE_TTL_MS;
  pending.set(code, { userId, expiresAt });
  return { code, expiresAt };
}

export class VerifyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Redeem a code: single-use, expiry-checked, IP-throttled. Returns the
 * owning user id — the caller resolves identity from its own auth store. */
export function consumeCode(code: string, ip = "unknown", now = Date.now()): string {
  const normalized = String(code ?? "").trim().toUpperCase();
  if (!normalized) throw new VerifyError("enter the code shown on muster.orazen.online/pair");
  const window = verifyAttempts.get(ip);
  if (!window || window.windowStart + VERIFY_WINDOW_MS <= now) {
    verifyAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    window.count++;
    if (window.count > MAX_VERIFIES_PER_WINDOW) {
      throw new VerifyError("too many attempts — wait a few minutes and try again", 429);
    }
  }
  sweepExpired(now);
  const entry = pending.get(normalized);
  if (!entry || entry.expiresAt <= now) {
    pending.delete(normalized);
    throw new VerifyError("that code isn't valid — generate a fresh one on muster.orazen.online/pair");
  }
  pending.delete(normalized);
  return entry.userId;
}

export function _pendingCount(): number {
  return pending.size;
}
