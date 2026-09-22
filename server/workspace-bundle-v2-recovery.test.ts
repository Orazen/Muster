// K1 recovery codes — the format half of the phase: a MEK sealed into key
// slots (one wrapped by the passphrase, one per recovery code), never stored
// unwrapped beside the ciphertext it opens (threat model #3).
//
// Every fixture is inline: the recovery contract only needs a payload the
// schema accepts, and an empty-manifest payload (digest = sha256 of the
// empty string) keeps this suite independent of any data-directory fixture.
// Nothing here starts a server or writes outside the process.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptBundleV2,
  encryptBundleV2,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  type BundlePayloadV2,
} from "./workspace-bundle-v2.ts";

const PASSPHRASE = "correct horse battery staple";
const EMPTY_MANIFEST_SHA = createHash("sha256").update("").digest("hex");
const RECOVERY_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/u;

function minimalPayload(): BundlePayloadV2 {
  return {
    schema: 2,
    appVersion: "1.12.0",
    counts: { files: 0, messages: 0, threads: 0, totalBytes: 0 },
    files: [],
    skipped: [],
    skippedTruncated: false,
    manifestSha256: EMPTY_MANIFEST_SHA,
    transcripts: { method: "unsupported:test-fixture", threads: [], counts: { threads: 0, messages: 0 } },
  };
}

function envelopeOf(sealed: Buffer): {
  keySlots?: Array<{ kind: string; slotIdB64?: string; wrappedKeyB64: string }>;
} {
  return JSON.parse(sealed.toString("utf8"));
}

describe("recovery code material", () => {
  it("generates ten unique codes in the grouped Crockford shape", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(RECOVERY_CODE_PATTERN);
    expect(new Set(codes).size).toBe(10);
  });

  it("generates a caller-sized set", () => {
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });

  it("normalizes whatever the user typed and refuses junk", () => {
    const [code] = generateRecoveryCodes(1);
    expect(code).not.toBeNull();
    const messy = ` ${code!.toLowerCase().replaceAll("-", " ")} `;
    expect(normalizeRecoveryCode(messy)).toBe(code);
    expect(normalizeRecoveryCode("not-a-real-recovery-code-at-all")).toBeNull();
    expect(normalizeRecoveryCode("")).toBeNull();
    // I, L, O and U are outside the Crockford alphabet
    expect(normalizeRecoveryCode("ABCD-EFGH-IJKL-MNOP")).toBeNull();
  });
});

describe("recovery-keyed bundles", () => {
  it("opens a recovery bundle with the passphrase", () => {
    const codes = generateRecoveryCodes(3);
    const sealed = encryptBundleV2(minimalPayload(), { passphrase: PASSPHRASE, recovery: { codes } });
    const opened = decryptBundleV2(sealed, { passphrase: PASSPHRASE });
    expect(opened.status).toBe("ok");
    expect(opened.payload?.counts.files).toBe(0);
  });

  it("opens with any of the recovery codes, however they are typed", () => {
    const codes = generateRecoveryCodes(3);
    const sealed = encryptBundleV2(minimalPayload(), { passphrase: PASSPHRASE, recovery: { codes } });
    for (const code of codes) {
      expect(decryptBundleV2(sealed, { recoveryCode: code }).status).toBe("ok");
    }
    const typed = codes[0]!.toLowerCase().replaceAll("-", "");
    expect(decryptBundleV2(sealed, { recoveryCode: typed }).status).toBe("ok");
  });

  it("rejects a wrong recovery code as bad-key, with no payload", () => {
    const sealed = encryptBundleV2(minimalPayload(), { passphrase: PASSPHRASE, recovery: { codes: generateRecoveryCodes(3) } });
    const [stranger] = generateRecoveryCodes(1);
    const opened = decryptBundleV2(sealed, { recoveryCode: stranger! });
    expect(opened.status).toBe("bad-key");
    expect(opened.payload).toBeUndefined();
  });

  it("rejects a wrong passphrase on a recovery bundle as bad-key", () => {
    const sealed = encryptBundleV2(minimalPayload(), { passphrase: PASSPHRASE, recovery: { codes: generateRecoveryCodes(3) } });
    expect(decryptBundleV2(sealed, { passphrase: "wrong horse battery staple" }).status).toBe("bad-key");
  });

  it("records one passphrase slot plus one slot per code, and no bare MEK", () => {
    const codes = generateRecoveryCodes(4);
    const sealed = encryptBundleV2(minimalPayload(), { passphrase: PASSPHRASE, recovery: { codes } });
    const envelope = envelopeOf(sealed);
    expect(envelope.keySlots).toHaveLength(5);
    expect(envelope.keySlots!.filter((slot) => slot.kind === "passphrase")).toHaveLength(1);
    expect(envelope.keySlots!.filter((slot) => slot.kind === "recovery")).toHaveLength(4);
    const text = sealed.toString("utf8");
    // the raw 32-byte MEK must never appear in the envelope: only wrapped
    // keys may be stored beside the ciphertext (threat model #3)
    expect(text).not.toMatch(/"mek"/u);
  });

  it("fails authentication when a key slot is edited", () => {
    const sealed = encryptBundleV2(minimalPayload(), { passphrase: PASSPHRASE, recovery: { codes: generateRecoveryCodes(3) } });
    // SAFETY: the bytes came from encryptBundleV2 two lines above, so the
    // parse yields a v2 envelope; the assertion narrows only the field this
    // tamper case edits, and a structurally wrong envelope fails the unwrap.
    const envelope = JSON.parse(sealed.toString("utf8")) as { keySlots: Array<{ wrappedKeyB64: string }> };
    const wrapped = envelope.keySlots[1]!.wrappedKeyB64;
    envelope.keySlots[1]!.wrappedKeyB64 = (wrapped[0] === "A" ? "B" : "A") + wrapped.slice(1);
    const tampered = Buffer.from(JSON.stringify(envelope), "utf8");
    expect(decryptBundleV2(tampered, { passphrase: PASSPHRASE }).status).toBe("bad-key");
  });

  it("keeps legacy bundles byte-compatible: no keySlots, passphrase-only", () => {
    const sealed = encryptBundleV2(minimalPayload(), { passphrase: PASSPHRASE });
    expect(envelopeOf(sealed).keySlots).toBeUndefined();
    expect(decryptBundleV2(sealed, { passphrase: PASSPHRASE }).status).toBe("ok");
    expect(decryptBundleV2(sealed, { passphrase: PASSPHRASE, recoveryCode: "ABCD-EFGH-JKMN-PQRS" }).status).toBe("bad-key");
  });

  it("refuses an empty or malformed recovery set at seal time", () => {
    expect(() => encryptBundleV2(minimalPayload(), { passphrase: PASSPHRASE, recovery: { codes: [] } })).toThrow(
      /at least one recovery code/u,
    );
    expect(() => encryptBundleV2(minimalPayload(), { passphrase: PASSPHRASE, recovery: { codes: ["short"] } })).toThrow(
      /recovery code/u,
    );
  });
});
