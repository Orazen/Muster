// Signed job receipts — the trust moat.
//
// A shared receipt (/r/<token>) currently says "trust me": the payload is
// whatever the server holds, with no way for an outsider to tell tampering
// from truth. Signing changes that. At share time the harness computes an
// HMAC-SHA256 over the canonical receipt JSON with the deployment's auth
// secret and appends a detached signature. The public share page embeds
// the signature; GET /api/receipts/verify checks any pasted receipt and
// answers valid/tampered. Anyone — another agent, a hiring manager, an
// auditor — can prove a receipt came from a real Muster deployment and
// was not edited after the fact.
//
// Canonicalization: deterministic JSON with sorted keys, so the same
// logical receipt always hashes to the same bytes across servers.
import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { JsonObject } from "./schema.ts";
import type { JobReceipt } from "./receipts.ts";

/** A value is a string exactly when String() of it returns it unchanged —
 * the receipts composer's own primitive test. */
const isText = <T>(value: T): value is T & string => String(value) === value;

/** Deterministic key sort + no-whitespace serialization over the receipt's
 * own fields. Field list pinned to the JobReceipt contract (see
 * receipts.ts); built as a plain record so every key/value is typed —
 * no casts, no `unknown` leakage. */
export function canonicalReceiptJson(receipt: JobReceipt): string {
  // Sorted-key plain object: JSON.stringify emits insertion order for
  // string keys, so building the record alphabetically IS canonical.
  const canonical: JsonObject = {
    bot: receipt.bot,
    costUsd: receipt.costUsd,
    durationHuman: receipt.durationHuman,
    durationMs: receipt.durationMs,
    job: receipt.job,
    result: receipt.result,
    startedAt: receipt.startedAt,
    summary: receipt.summary,
    tokensIn: receipt.tokensIn,
    tokensOut: receipt.tokensOut,
    turns: receipt.turns,
    version: receipt.version,
  };
  return JSON.stringify(canonical);
}

/** HMAC-SHA256 over the canonical JSON. Base64url, no padding — URL-safe
 * everywhere a receipt travels (query params, chat text, QR codes). */
export function signReceipt(receipt: JobReceipt, secret: string): string {
  return createHmac("sha256", secret).update(canonicalReceiptJson(receipt)).digest("base64url");
}

export type ReceiptVerdict =
  | { valid: true }
  | { valid: false; reason: "malformed" | "signature-mismatch" };

/** Verify a receipt + signature pair against the deployment secret.
 * Signature comparison is timing-safe — a forger must not learn how many
 * leading bytes they got right. Both sides compare as UTF-8 bytes of the
 * base64url text (the signature travels as text everywhere). */
export function verifyReceipt(receipt: JobReceipt, signature: string, secret: string): ReceiptVerdict {
  if (!receipt || !isText(signature) || signature.length === 0) {
    return { valid: false, reason: "malformed" };
  }
  const expected = Buffer.from(signReceipt(receipt, secret), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { valid: false, reason: "signature-mismatch" };
  }
  return { valid: true };
}

/** A receipt as it travels: payload + detached signature. */
export interface SignedReceipt {
  receipt: JobReceipt;
  signature: string;
}

export function signInto(receipt: JobReceipt, secret: string): SignedReceipt {
  return { receipt, signature: signReceipt(receipt, secret) };
}

/** The public verify endpoint's wire shape: every signed field, parsed and
 * typed at the unauthenticated boundary. Unknown fields pass through but
 * are excluded from the hash — extra data cannot fake a valid signature. */
export const verifyableReceiptSchema = z
  .object({
    version: z.literal(1),
    bot: z.string(),
    job: z.string(),
    startedAt: z.string(),
    durationMs: z.number(),
    durationHuman: z.string(),
    turns: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    costUsd: z.number().nullable(),
    result: z.enum(["done", "no-reply"]),
    summary: z.string(),
  })
  .passthrough();
