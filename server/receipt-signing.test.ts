// Signed job receipts — contracts for canonicalization, sign/verify
// round-trips, and tamper detection. The signature is the trust moat on
// shared /r/<token> pages, so the failure modes (edited field, edited
// signature, garbage input) are pinned explicitly.
import { describe, expect, it } from "vitest";

import { buildReceipt, type JobReceipt } from "./receipts.ts";
import { canonicalReceiptJson, signInto, signReceipt, verifyReceipt } from "./receipt-signing.ts";

const SECRET = "loop-test-signing-secret-not-real-0123456789";

/** One frozen receipt: every assertion in this file uses the same payload,
 * since a rebuilt one carries a fresh startedAt timestamp. */
const fixedReceipt = (): JobReceipt =>
  buildReceipt({
    botName: "Scout",
    taskTitle: "Audit the deploy logs",
    createdAt: 1_700_000_000_000,
    finishedAt: 1_700_000_090_000,
    usage: { input: 1200, output: 340, costUsd: 0.0042, turns: 3 },
    finalWord: "Build is green; two flaky tests re-run and passed.",
  });

describe("canonicalReceiptJson", () => {
  it("is key-order independent", () => {
    const r = fixedReceipt();
    const a = canonicalReceiptJson(r);
    // SAFETY: the object is a key-reordered copy of the same fixed receipt
    // the canonicalizer normalizes — the assertion only names the type.
    const manuallyReordered = {
      summary: r.summary,
      result: r.result,
      costUsd: r.costUsd,
      tokensOut: r.tokensOut,
      tokensIn: r.tokensIn,
      turns: r.turns,
      durationHuman: r.durationHuman,
      durationMs: r.durationMs,
      startedAt: r.startedAt,
      job: r.job,
      bot: r.bot,
      version: r.version,
    } as JobReceipt;
    expect(canonicalReceiptJson(manuallyReordered)).toBe(a);
  });

  it("has no structural whitespace (JSON.stringify, not pretty-print)", () => {
    expect(canonicalReceiptJson(fixedReceipt())).not.toMatch(/:\s|"[\w]+":\s/);
    expect(canonicalReceiptJson(fixedReceipt())).toBe(canonicalReceiptJson(fixedReceipt()));
  });
});

describe("sign/verify round-trip", () => {
  it("verifies a receipt signed by the same secret", () => {
    const { receipt: r, signature } = signInto(fixedReceipt(), SECRET);
    expect(verifyReceipt(r, signature, SECRET)).toEqual({ valid: true });
  });

  it("signReceipt is deterministic for the same payload", () => {
    expect(signReceipt(fixedReceipt(), SECRET)).toBe(signReceipt(fixedReceipt(), SECRET));
  });

  it("rejects an edited field (tamper detection)", () => {
    const { receipt: r, signature } = signInto(fixedReceipt(), SECRET);
    const forged: JobReceipt = { ...r, tokensOut: r.tokensOut + 1_000_000 };
    expect(verifyReceipt(forged, signature, SECRET)).toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("rejects a wrong secret and a corrupted signature", () => {
    const { receipt: r, signature } = signInto(fixedReceipt(), SECRET);
    expect(verifyReceipt(r, signature, "another-secret")).toEqual({ valid: false, reason: "signature-mismatch" });
    const corrupted = signature.slice(0, -4) + (signature.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(verifyReceipt(r, corrupted, SECRET)).toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("answers malformed for garbage signatures and empty inputs", () => {
    const r = fixedReceipt();
    expect(verifyReceipt(r, "not base64url !!!", SECRET).valid).toBe(false);
    expect(verifyReceipt(r, "", SECRET)).toEqual({ valid: false, reason: "malformed" });
  });

  it("signatures are url-safe (base64url alphabet only)", () => {
    const signature = signReceipt(fixedReceipt(), SECRET);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
