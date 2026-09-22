// S2a (DESIGN §10): the per-object sync envelope and the encrypted manifest —
// the two bytes-level halves of incremental sync, before any transport.
//
// The architectural pin in §10: "Incremental uploads only after the v2 bundle
// format's envelope checks (authenticate-then-parse) gate every object." So a
// sync object does NOT get its own encryption scheme: it rides the exact
// BundlePayloadV2/encryptBundleV2/verifyBundleV2 machinery the portable
// bundle already uses, as a single-file payload. Every object therefore gets
// GCM header binding, scrypt, K1 recovery slots and the eleven named verify
// checks for free — test 2 asserts that inheritance explicitly.
//
// The reconcile tests pin the rev-compare decision table §10's sequence
// diagram leaves implicit: newer rev uploads, newer remote rev downloads,
// equal rev + equal checksum is in sync, equal rev + different checksum is a
// conflict nothing auto-resolves, and tombstones travel as ordinary newer
// revs whose payload is the empty string.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  VERIFY_CHECKS,
  encryptBundleV2,
  generateRecoveryCodes,
  manifestDigest,
  verifyBundleV2,
  type BundleFileEntry,
  type BundlePayloadV2,
} from "./workspace-bundle-v2.ts";
import {
  SYNC_OBJECT_PATH,
  packSyncManifest,
  packSyncObject,
  reconcileSyncObjects,
  syncObjectFileName,
  unpackSyncManifest,
  unpackSyncObject,
  type SyncManifestDoc,
  type SyncManifestEntry,
  type SyncObject,
} from "./sync-objects.ts";

const PASSPHRASE = "correct horse battery staple";
const EMPTY_SHA = createHash("sha256").update("", "utf8").digest("hex");
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const anObject = (over: Partial<SyncObject> = {}): SyncObject => ({
  objectId: "memory:bot_alpha",
  objectType: "memory",
  ownerId: "user_1",
  rev: 3,
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_100_000,
  deviceId: "device-a",
  checksum: sha256("the memory content"),
  tombstone: false,
  schemaVersion: 1,
  payload: "the memory content",
  ...over,
});

const anEntry = (over: Partial<SyncManifestEntry> = {}): SyncManifestEntry => {
  const base: SyncManifestEntry = {
    objectId: "memory:bot_alpha",
    objectType: "memory",
    rev: 3,
    checksum: sha256("the memory content"),
    fileName: syncObjectFileName("memory:bot_alpha", 3),
    updatedAt: 1_760_000_100_000,
    tombstone: false,
  };
  const merged = { ...base, ...over };
  if (over.fileName === undefined) merged.fileName = syncObjectFileName(merged.objectId, merged.rev);
  return merged;
};

/** Build a single-file payload that is structurally honest except where a
 * test deliberately lies — the envelope around it is always authentic. */
const singleFilePayload = (
  file: BundleFileEntry,
  over: Partial<BundlePayloadV2> = {},
): BundlePayloadV2 => ({
  schema: 2,
  appVersion: "0.0.0-test",
  counts: { files: 1, messages: 0, threads: 0, totalBytes: file.size },
  files: [file],
  skipped: [],
  skippedTruncated: false,
  manifestSha256: manifestDigest([file]),
  transcripts: { method: "none", threads: [], counts: { threads: 0, messages: 0 } },
  ...over,
});

describe("packSyncObject / unpackSyncObject", () => {
  it("round-trips every field of the §10 object envelope", () => {
    const source = anObject();
    const bytes = packSyncObject(source, { passphrase: PASSPHRASE, appVersion: "0.0.0-test" });
    const opened = unpackSyncObject(bytes, { passphrase: PASSPHRASE });
    expect(opened.status).toBe("ok");
    expect(opened.object).toEqual(source);
  });

  it("rides the v2 envelope: every one of the named verify checks passes on a packed object", () => {
    const bytes = packSyncObject(anObject(), { passphrase: PASSPHRASE, appVersion: "0.0.0-test" });
    const verified = verifyBundleV2(bytes, { passphrase: PASSPHRASE });
    expect(verified.status).toBe("ok");
    expect(verified.checks.map((check) => check.check)).toEqual([...VERIFY_CHECKS]);
    expect(verified.checks.every((check) => check.ok)).toBe(true);
  });

  it("reports a wrong passphrase as bad-key without leaking the object", () => {
    const bytes = packSyncObject(anObject(), { passphrase: PASSPHRASE, appVersion: "0.0.0-test" });
    const opened = unpackSyncObject(bytes, { passphrase: "not the passphrase" });
    expect(opened.status).toBe("bad-key");
    expect(opened.object).toBeUndefined();
  });

  it("opens with a K1 recovery code instead of the passphrase", () => {
    const [code] = generateRecoveryCodes(1);
    const bytes = packSyncObject(anObject(), {
      passphrase: PASSPHRASE,
      appVersion: "0.0.0-test",
      recovery: { codes: [code!] },
    });
    const opened = unpackSyncObject(bytes, { recoveryCode: code! });
    expect(opened.status).toBe("ok");
    expect(opened.object).toEqual(anObject());
  });

  it("refuses to pack an object whose checksum disagrees with its payload", () => {
    expect(() =>
      packSyncObject(anObject({ checksum: sha256("something else") }), {
        passphrase: PASSPHRASE,
        appVersion: "0.0.0-test",
      }),
    ).toThrow(/checksum/);
  });

  it("tombstones carry the empty payload and its canonical checksum", () => {
    const tombstone = anObject({ tombstone: true, payload: "", checksum: EMPTY_SHA });
    const bytes = packSyncObject(tombstone, { passphrase: PASSPHRASE, appVersion: "0.0.0-test" });
    const opened = unpackSyncObject(bytes, { passphrase: PASSPHRASE });
    expect(opened.status).toBe("ok");
    expect(opened.object).toEqual(tombstone);
    expect(() =>
      packSyncObject(anObject({ tombstone: true, checksum: sha256("leftover") }), {
        passphrase: PASSPHRASE,
        appVersion: "0.0.0-test",
      }),
    ).toThrow(/tombstone/);
  });

  it("rejects a flipped ciphertext — GCM gives one verdict and no object escapes", () => {
    const bytes = packSyncObject(anObject(), { passphrase: PASSPHRASE, appVersion: "0.0.0-test" });
    // pack's own output: validate the field we flip, keep every other
    // envelope key intact so the envelope still parses up to the tag check.
    const envelope = JSON.parse(bytes.toString("utf8"));
    const cipher: string = z.string().min(1).parse(envelope.ciphertextB64);
    const flipped = cipher.split("");
    flipped[10] = flipped[10] === "A" ? "B" : "A";
    envelope.ciphertextB64 = flipped.join("");
    const opened = unpackSyncObject(Buffer.from(JSON.stringify(envelope), "utf8"), {
      passphrase: PASSPHRASE,
    });
    // A failed tag cannot say whether the key or the body is wrong — the
    // envelope layer reports its auth-failure form, never a parseable object.
    expect(opened.status).toBe("bad-key");
    expect(opened.object).toBeUndefined();
  });

  it("reports an authenticated payload whose file hash lies about its body as tampered", () => {
    // The manifest digest binds the DECLARED hash, so this envelope is
    // internally consistent enough to authenticate — only the post-auth
    // body check can name the lie. That is §10's gate doing its job.
    const body = Buffer.from("real body", "utf8");
    const file: BundleFileEntry = {
      path: SYNC_OBJECT_PATH,
      sha256: sha256("some other body"),
      size: body.byteLength,
      bodyB64: body.toString("base64"),
    };
    const bytes = encryptBundleV2(singleFilePayload(file), { passphrase: PASSPHRASE });
    const opened = unpackSyncObject(bytes, { passphrase: PASSPHRASE });
    expect(opened.status).toBe("tampered");
    expect(opened.object).toBeUndefined();
  });

  it("rejects an authentic envelope whose payload is not exactly one object file", () => {
    const file: BundleFileEntry = {
      path: "somewhere-else.json",
      sha256: sha256("body"),
      size: 4,
      bodyB64: Buffer.from("body").toString("base64"),
    };
    const bytes = encryptBundleV2(singleFilePayload(file), { passphrase: PASSPHRASE });
    const opened = unpackSyncObject(bytes, { passphrase: PASSPHRASE });
    expect(opened.status).toBe("check-failed");
    expect(opened.error).toContain(SYNC_OBJECT_PATH);
  });

  it("verifies the declared checksum against the payload after decryption", () => {
    const lying = anObject({ checksum: sha256("not what this is") });
    const file: BundleFileEntry = {
      path: SYNC_OBJECT_PATH,
      sha256: sha256(JSON.stringify(lying)),
      size: JSON.stringify(lying).length,
      bodyB64: Buffer.from(JSON.stringify(lying), "utf8").toString("base64"),
    };
    const bytes = encryptBundleV2(singleFilePayload(file), { passphrase: PASSPHRASE });
    const opened = unpackSyncObject(bytes, { passphrase: PASSPHRASE });
    expect(opened.status).toBe("check-failed");
    expect(opened.error).toMatch(/checksum/);
  });

  it("names a payload body that is not JSON", () => {
    const body = "{not json";
    const file: BundleFileEntry = {
      path: SYNC_OBJECT_PATH,
      sha256: sha256(body),
      size: body.length,
      bodyB64: Buffer.from(body, "utf8").toString("base64"),
    };
    const bytes = encryptBundleV2(singleFilePayload(file), { passphrase: PASSPHRASE });
    const opened = unpackSyncObject(bytes, { passphrase: PASSPHRASE });
    expect(opened.status).toBe("check-failed");
    expect(opened.error).toMatch(/JSON/);
  });
});

describe("packSyncManifest / unpackSyncManifest", () => {
  const doc = (entries: SyncManifestEntry[]): SyncManifestDoc => ({
    schema: 1,
    updatedAt: 1_760_000_200_000,
    entries,
  });

  it("round-trips the object index", () => {
    const source = doc([
      anEntry(),
      anEntry({ objectId: "memory:bot_beta", rev: 1, checksum: sha256("beta"), updatedAt: 1_760_000_150_000 }),
    ]);
    const bytes = packSyncManifest(source, { passphrase: PASSPHRASE, appVersion: "0.0.0-test" });
    const opened = unpackSyncManifest(bytes, { passphrase: PASSPHRASE });
    expect(opened.status).toBe("ok");
    expect(opened.doc).toEqual(source);
  });

  it("is itself gated by the v2 envelope checks", () => {
    const bytes = packSyncManifest(doc([anEntry()]), {
      passphrase: PASSPHRASE,
      appVersion: "0.0.0-test",
    });
    const verified = verifyBundleV2(bytes, { passphrase: PASSPHRASE });
    expect(verified.status).toBe("ok");
    expect(verified.checks.every((check) => check.ok)).toBe(true);
  });

  it("reports a wrong passphrase without leaking the index", () => {
    const bytes = packSyncManifest(doc([anEntry()]), {
      passphrase: PASSPHRASE,
      appVersion: "0.0.0-test",
    });
    const opened = unpackSyncManifest(bytes, { passphrase: "wrong" });
    expect(opened.status).toBe("bad-key");
    expect(opened.doc).toBeUndefined();
  });

  it("rejects a manifest whose fileName does not follow the canonical derivation", () => {
    const tampered = doc([anEntry({ fileName: "muster-anything-1.enc" })]);
    expect(() =>
      packSyncManifest(tampered, { passphrase: PASSPHRASE, appVersion: "0.0.0-test" }),
    ).toThrow(/fileName/);
  });

  it("rejects duplicate entries for one objectId — the index must have one row per object", () => {
    const duplicated = doc([anEntry(), anEntry({ rev: 4, checksum: sha256("newer") })]);
    expect(() =>
      packSyncManifest(duplicated, { passphrase: PASSPHRASE, appVersion: "0.0.0-test" }),
    ).toThrow(/unique/);
  });
});

describe("syncObjectFileName", () => {
  it("is deterministic and separates ids that sanitize alike", () => {
    const colon = syncObjectFileName("memory:bot_alpha", 2);
    const underscore = syncObjectFileName("memory_bot_alpha", 2);
    expect(colon).toContain("-2.enc");
    expect(colon).not.toBe(underscore);
    expect(syncObjectFileName("memory:bot_alpha", 2)).toBe(colon);
  });
});

describe("reconcileSyncObjects", () => {
  it("uploads local-er, downloads remote-er, and calls equal rev+checksum in sync", () => {
    const local = [anEntry({ rev: 4, checksum: sha256("newer local") }), anEntry({ objectId: "settings:app", objectType: "settings", rev: 1, checksum: sha256("a") })];
    const remote = [
      anEntry({ rev: 3, checksum: sha256("older") }),
      anEntry({ objectId: "settings:app", objectType: "settings", rev: 2, checksum: sha256("b") }),
      anEntry({ objectId: "bot:atlas", objectType: "bots", rev: 7, checksum: sha256("same") }),
    ];
    const localSync = anEntry({ objectId: "bot:atlas", objectType: "bots", rev: 7, checksum: sha256("same") });
    const plan = reconcileSyncObjects([...local, localSync], remote);
    expect(plan.upload.map((entry) => entry.objectId)).toEqual(["memory:bot_alpha"]);
    expect(plan.download.map((entry) => entry.objectId)).toEqual(["settings:app"]);
    expect(plan.inSync).toEqual(["bot:atlas"]);
    expect(plan.conflict).toHaveLength(0);
  });

  it("reports an equal-rev checksum disagreement as a conflict and picks no side", () => {
    const local = [anEntry({ checksum: sha256("mine") })];
    const remote = [anEntry({ checksum: sha256("theirs") })];
    const plan = reconcileSyncObjects(local, remote);
    expect(plan.upload).toHaveLength(0);
    expect(plan.download).toHaveLength(0);
    expect(plan.inSync).toHaveLength(0);
    expect(plan.conflict).toHaveLength(1);
    expect(plan.conflict[0]!.objectId).toBe("memory:bot_alpha");
  });

  it("moves tombstones with the same rev rules as live objects", () => {
    const localGone = anEntry({ rev: 5, checksum: EMPTY_SHA, tombstone: true });
    const remoteGone = anEntry({
      objectId: "bot:retired",
      objectType: "bots",
      rev: 2,
      checksum: EMPTY_SHA,
      tombstone: true,
    });
    const plan = reconcileSyncObjects(
      [localGone, anEntry({ objectId: "bot:retired", objectType: "bots", rev: 1, checksum: sha256("alive") })],
      [anEntry({ rev: 4, checksum: sha256("stale") }), remoteGone],
    );
    expect(plan.upload).toHaveLength(1);
    expect(plan.upload[0]!.tombstone).toBe(true);
    expect(plan.download).toHaveLength(1);
    expect(plan.download[0]!.objectId).toBe("bot:retired");
    expect(plan.download[0]!.tombstone).toBe(true);
  });

  it("treats a side that has never seen an object as pure distance", () => {
    const only = anEntry();
    expect(reconcileSyncObjects([], [only]).download).toHaveLength(1);
    expect(reconcileSyncObjects([only], []).upload).toHaveLength(1);
    expect(reconcileSyncObjects([], [])).toEqual({
      upload: [],
      download: [],
      conflict: [],
      inSync: [],
    });
  });
});
