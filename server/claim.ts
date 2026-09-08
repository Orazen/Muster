// Self-host front door — "scan the QR, land in the console".
//
// `muster up` boots the server on the LAN, asks (over loopback) for a claim
// code, and prints it as a QR code encoding http://<lan-ip>:<port>/claim#CODE.
// The phone that scans it POSTs the code to /api/pair/claim and receives an
// owner session — no password, no email, no signup form on a 390px screen.
//
// The code IS the credential (same trust model as OAuth device activation,
// same mechanics as pairing.ts): 8 chars of the unambiguous alphabet,
// single-use, five-minute TTL, and redemption is throttled per IP — five
// failed attempts lock that IP out for ten minutes, so guessing a live code
// is hopeless long before expiry.
// This module deliberately does NOT share a namespace with pairing.ts — a
// pairing code must never redeem as a claim code and vice versa, so the two
// flows keep separate maps, separate stores, and this module never mixes
// code strings with the pairing store's.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import { VerifyError } from "./pairing.ts";

const CODE_TTL_MS = 5 * 60_000;
const CODE_LENGTH = 8;
// Same alphabet as pairing codes: no 0/O/1/I/L, because these get read off
// a laptop screen by a phone camera at arm's length.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Failed redemptions an IP gets before a ten-minute lockout — the
 * self-host front door's brute-force posture. The code's entropy (2^40)
 * does the real work; this makes even a lucky guessing run hopeless, and
 * unlike burning the code on bad guesses it can't be weaponized against
 * the operator (a drive-by scanner can lock OUT an IP, never kill the QR). */
const CLAIM_WINDOW_MS = 10 * 60_000;
const MAX_CLAIMS_PER_WINDOW = 5;

interface PendingClaim {
  expiresAt: number;
}

const pending = new Map<string, PendingClaim>();
const claimAttempts = new Map<string, { count: number; windowStart: number }>();

// ── persistence ────────────────────────────────────────────────────────────
// Mirrors pairing.ts 1:1: the envelope mirrors the in-memory maps, is
// rewritten atomically on every mutation, and a malformed file falls back to
// clean memory state instead of throwing into route handlers.
interface StoreFile {
  version: 1;
  pending: Record<string, PendingClaim>;
  attempts: Record<string, { count: number; windowStart: number }>;
}

const storeFileSchema = z.object({
  version: z.literal(1),
  pending: z.record(z.string(), z.object({ expiresAt: z.number() })).default({}),
  attempts: z
    .record(z.string(), z.object({ count: z.number(), windowStart: z.number() }))
    .default({}),
}) satisfies z.ZodType<StoreFile>;

function storePath(): string {
  return join(DATA_DIR, "claim-codes.json");
}

function persistStore(): void {
  try {
    if (!existsSync(DATA_DIR)) return; // read-only or unusual FS — memory-only fallback
    const file: StoreFile = {
      version: 1,
      pending: Object.fromEntries(pending),
      attempts: Object.fromEntries(claimAttempts),
    };
    const tmp = storePath() + ".tmp";
    // SAFETY: the only bytes ever written here are this module's own JSON
    // envelope (same trust level as the in-memory maps it mirrors).
    writeFileSync(tmp, JSON.stringify(file));
    renameSync(tmp, storePath());
  } catch {
    // Persistence is best-effort: in-memory behavior remains correct for
    // the current process even if the disk write fails.
  }
}

function loadStore(): void {
  try {
    const p = storePath();
    if (!existsSync(p)) return;
    const decoded = storeFileSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
    if (!decoded.success) return;
    for (const [code, entry] of Object.entries(decoded.data.pending)) {
      pending.set(code, entry);
    }
    for (const [ip, win] of Object.entries(decoded.data.attempts)) {
      claimAttempts.set(ip, win);
    }
  } catch {
    // Corrupt file → start from clean memory state.
  }
}
loadStore();

function sweepExpired(now = Date.now()): void {
  let dirty = false;
  for (const [code, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(code);
      dirty = true;
    }
  }
  for (const [ip, window] of claimAttempts) {
    if (window.windowStart + CLAIM_WINDOW_MS <= now) {
      claimAttempts.delete(ip);
      dirty = true;
    }
  }
  if (dirty) persistStore();
}

/** Mint a claim code. Exactly ONE live code exists at a time — the QR on
 * the operator's screen is the deployment's only door, so re-running
 * `muster up` (or re-requesting) invalidates the previous code rather than
 * accumulating still-valid ones. Loopback-only enforcement lives in the
 * route handler (it owns the socket), not here. */
export function createClaimCode(now = Date.now()) {
  sweepExpired(now);
  pending.clear();
  let raw = randomBytes(CODE_LENGTH);
  for (let i = 0; i < raw.length; i++) {
    // 256 % 31 ≈ 19 — redraw the rare biased byte rather than modulo it
    while (raw[i] >= 256 - (256 % ALPHABET.length)) raw[i] = randomBytes(1)[0];
  }
  const code = Array.from(raw, (b) => ALPHABET[b % ALPHABET.length]).join("");
  const expiresAt = now + CODE_TTL_MS;
  pending.set(code, { expiresAt });
  persistStore();
  console.log(`[claim] created ${code.slice(0, 2)}*** (one live code, ${Math.round(CODE_TTL_MS / 60_000)}min)`);
  return { code, expiresAt };
}

/** Redeem a claim code: single-use, expiry-checked, brute-force-throttled.
 * Throws VerifyError on every failure shape (empty, unknown, expired,
 * locked out). Only FAILED attempts count toward the lockout — a wrong
 * guess is evidence of attack, a right one isn't — and a successful
 * redemption clears the IP's slate. The caller resolves the owner account —
 * this module deliberately knows nothing about users, keeping the code
 * namespace and the identity store decoupled. */
export function consumeClaimCode(code: string, ip = "unknown", now = Date.now()): void {
  const normalized = String(code ?? "").trim().toUpperCase();
  if (!normalized) throw new VerifyError("this link is missing its claim code — run `muster up` and scan the fresh QR");
  // Lockout check comes FIRST: a throttled IP gets 429 even holding the
  // right code, or the throttle wouldn't throttle.
  const window = claimAttempts.get(ip);
  if (window && window.windowStart + CLAIM_WINDOW_MS > now && window.count >= MAX_CLAIMS_PER_WINDOW) {
    throw new VerifyError("too many failed attempts — locked out for a few minutes; run `muster up` again for a fresh QR if yours expired", 429);
  }
  sweepExpired(now);
  const entry = pending.get(normalized);
  if (!entry || entry.expiresAt <= now) {
    pending.delete(normalized);
    if (!window || window.windowStart + CLAIM_WINDOW_MS <= now) {
      claimAttempts.set(ip, { count: 1, windowStart: now });
    } else {
      window.count++;
    }
    persistStore();
    // Enough to tell a typo from a restart race from a stale QR, never a
    // full redeemable code.
    console.log(
      `[claim] rejected ${normalized.slice(0, 2)}*** len=${normalized.length} ip=${ip} pending=${pending.size}`,
    );
    throw new VerifyError(
      pending.size > 0
        ? "that code isn't valid — a fresh QR was printed; use the latest one"
        : "that code isn't valid — run `muster up` again for a fresh QR",
    );
  }
  pending.delete(normalized);
  claimAttempts.delete(ip);
  persistStore();
  console.log(`[claim] consumed ${normalized.slice(0, 2)}*** from ip ${ip}`);
}

export function _pendingClaimCount(): number {
  return pending.size;
}
