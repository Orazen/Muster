// S2a (DESIGN §10) — the per-object sync envelope and the encrypted manifest.
//
// Architecture, straight from §10: "Incremental uploads only after the v2
// bundle format's envelope checks (authenticate-then-parse) gate every
// object." A sync object is therefore NOT a new crypto scheme — it is the
// portable bundle's exact machinery (encryptBundleV2 / decryptBundleV2 /
// verifyBundleV2) carrying a single-file payload. GCM header binding, scrypt,
// K1 recovery slots and the inspect gates (authentication, payload schema,
// payload hash, manifest digest, inflate bounds) all apply unchanged, and
// this module adds the structural gates that make "one object and nothing
// else" true: exactly one file at the reserved path, counts that describe
// only it, no skips, no transcripts, a body that matches its recorded hash,
// and an object checksum that matches its payload.
//
// The manifest (§9 `muster-manifest.json`) is the same envelope with the
// object index as its body — versions, checksums and Drive file names in one
// authenticated document. `reconcileSyncObjects` is the pure rev-compare
// from §10's sequence diagram: local-er uploads, remote-er downloads, equal
// rev+checksum is in sync, equal rev with different checksums is a conflict
// nothing auto-resolves. Transport (Drive upload/download of
// `muster-<object>-<rev>.enc`) and journal-drain wiring are S2b; nothing
// here performs I/O.

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  BUNDLE_SCHEMA,
  LIMITS,
  decryptBundleV2,
  encryptBundleV2,
  manifestDigest,
  type BundleFileEntry,
  type BundlePayloadV2,
  type BundleStatus,
  type DecryptBundleV2Options,
  type EncryptBundleV2Options,
} from "./workspace-bundle-v2.ts";

/** Reserved path of the single file inside a packed object / manifest. */
export const SYNC_OBJECT_PATH = "object.json";
export const SYNC_MANIFEST_PATH = "manifest.json";

const HEX64 = /^[a-f0-9]{64}$/u;
const printable = (value: string): boolean =>
  [...value].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 && code !== 127;
  });

const objectIdSchema = z.string().min(1).max(256).refine(printable);
const objectTypeSchema = z.string().min(1).max(64).refine(printable);
const checksumSchema = z.string().regex(HEX64);
const timeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** §10's syncable-object envelope. `payload` is the object's serialized
 * content — JSON text or base64 for binaries — and `checksum` is its
 * sha256, recomputed on both pack and unpack so the value is verified, not
 * trusted. A tombstone's payload is the empty string and its checksum the
 * canonical hash of that. */
const syncObjectSchema = z
  .object({
    objectId: objectIdSchema,
    objectType: objectTypeSchema,
    ownerId: z.string().min(1).max(256).refine(printable),
    rev: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: timeSchema,
    updatedAt: timeSchema,
    /** The install that produced this rev (S2b defines the producer's
     * install identity; the field exists so the envelope is complete). */
    deviceId: z.string().min(1).max(128).refine(printable),
    checksum: checksumSchema,
    tombstone: z.boolean(),
    schemaVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    payload: z.string().max(LIMITS.maxFileBytes),
  })
  .strict();

export type SyncObject = z.infer<typeof syncObjectSchema>;

/** The Drive file name for one object rev: percent-encoding keeps the
 * derivation injective (`a:b` and `a_b` cannot collide) while leaving the id
 * readable in the Drive UI. The manifest records this exact string and pack
 * refuses anything else, so one name can never drift from its entry. */
export function syncObjectFileName(objectId: string, rev: number): string {
  return `muster-${encodeURIComponent(objectId)}-${rev}.enc`;
}

const manifestEntrySchema = z
  .object({
    objectId: objectIdSchema,
    objectType: objectTypeSchema,
    rev: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    checksum: checksumSchema,
    fileName: z.string().min(1).max(512),
    updatedAt: timeSchema,
    tombstone: z.boolean(),
  })
  .strict()
  .refine(
    (entry) => entry.fileName === syncObjectFileName(entry.objectId, entry.rev),
    { message: "fileName must follow the canonical syncObjectFileName derivation" },
  );

export type SyncManifestEntry = z.infer<typeof manifestEntrySchema>;

const manifestDocSchema = z
  .object({
    schema: z.literal(1),
    updatedAt: timeSchema,
    entries: z.array(manifestEntrySchema).max(LIMITS.maxManifestEntries),
  })
  .strict()
  .refine(
    (doc) => new Set(doc.entries.map((entry) => entry.objectId)).size === doc.entries.length,
    { message: "entries must be unique per objectId" },
  );

export type SyncManifestDoc = z.infer<typeof manifestDocSchema>;

export interface PackSyncOptions {
  passphrase: string;
  appVersion: string;
  /** K1: wrap the MEK under recovery codes exactly as the portable bundle
   * does — an object opens with a recovery code the same way a bundle does. */
  recovery?: { codes: string[] };
}

export interface UnpackObjectResult {
  status: BundleStatus;
  object?: SyncObject;
  error?: string;
}

export interface UnpackManifestResult {
  status: BundleStatus;
  doc?: SyncManifestDoc;
  error?: string;
}

const sha256Hex = (input: Buffer | string): string =>
  createHash("sha256").update(input).digest("hex");

/** One shared single-file payload shape for both packers — counts that
 * describe only the file, no skips, no transcripts. */
const singleFilePayload = (file: BundleFileEntry, appVersion: string): BundlePayloadV2 => ({
  schema: BUNDLE_SCHEMA,
  appVersion,
  counts: { files: 1, messages: 0, threads: 0, totalBytes: file.size },
  files: [file],
  skipped: [],
  skippedTruncated: false,
  manifestSha256: manifestDigest([file]),
  transcripts: { method: "none", threads: [], counts: { threads: 0, messages: 0 } },
});

const fileOf = (path: string, body: Buffer): BundleFileEntry => ({
  path,
  sha256: sha256Hex(body),
  size: body.byteLength,
  bodyB64: body.toString("base64"),
});

const seal = (file: BundleFileEntry, appVersion: string, options: PackSyncOptions): Buffer => {
  const encryptOptions: EncryptBundleV2Options = { passphrase: options.passphrase };
  if (options.recovery !== undefined) encryptOptions.recovery = options.recovery;
  return encryptBundleV2(singleFilePayload(file, appVersion), encryptOptions);
};

/** The structural honesty of a single-file payload: exactly one file at the
 * reserved path, counts that describe only it, no skips, no transcripts, and
 * a body matching its recorded hash and size. The manifest digest itself is
 * already gated inside decrypt's inspect pass; this covers everything that
 * pass deliberately leaves to verify. Returns a named problem or null. */
function structureProblem(payload: BundlePayloadV2, expectedPath: string): string | null {
  if (payload.files.length !== 1) {
    return `expected exactly one file, found ${payload.files.length}`;
  }
  const file = payload.files[0]!;
  if (file.path !== expectedPath) {
    return `expected the payload at ${expectedPath}, found ${file.path}`;
  }
  const counts = payload.counts;
  if (counts.files !== 1 || counts.totalBytes !== file.size || counts.messages !== 0 || counts.threads !== 0) {
    return "declared counts do not describe a single file payload";
  }
  if (payload.skipped.length !== 0 || payload.skippedTruncated) {
    return "a single-file payload may not skip entries";
  }
  if (
    payload.transcripts.threads.length !== 0 ||
    payload.transcripts.counts.threads !== 0 ||
    payload.transcripts.counts.messages !== 0
  ) {
    return "a single-file payload must carry no transcripts";
  }
  const body = Buffer.from(file.bodyB64, "base64");
  if (body.byteLength !== file.size || sha256Hex(body) !== file.sha256) {
    return "the file body does not match the hash recorded for it";
  }
  return null;
}

/** Parsed JSON on success, or the named parse problem — never a throw. */
type BodyJsonResult = { json?: unknown; problem?: string };

function bodyJson(body: Buffer): BodyJsonResult {
  const text = body.toString("utf8");
  try {
    return { json: JSON.parse(text) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { problem: `the payload body is not JSON: ${message}` };
  }
}

/** Seal one sync object into its `<id>-<rev>.enc` bytes, riding the v2
 * envelope. The declared checksum must already match the payload — a
 * producer that disagrees with its own content is a bug, not a rotation. */
export function packSyncObject(object: SyncObject, options: PackSyncOptions): Buffer {
  const parsed = syncObjectSchema.parse(object);
  if (parsed.tombstone && parsed.payload !== "") {
    throw new Error(`sync object: the tombstone for ${parsed.objectId} must carry the empty payload`);
  }
  const actual = sha256Hex(parsed.payload);
  if (actual !== parsed.checksum) {
    throw new Error(`sync object: checksum for ${parsed.objectId} does not match its payload`);
  }
  const body = Buffer.from(JSON.stringify(parsed), "utf8");
  return seal(fileOf(SYNC_OBJECT_PATH, body), options.appVersion, options);
}

/** Open object bytes: decrypt's authenticate-then-parse gates first, then
 * the structural gates, then the object's own checksum. Never throws — every
 * failure is a status plus a named reason. */
export function unpackSyncObject(bytes: Buffer, options: DecryptBundleV2Options): UnpackObjectResult {
  const opened = decryptBundleV2(bytes, options);
  if (opened.status !== "ok" || opened.payload === undefined) {
    return opened.error !== undefined ? { status: opened.status, error: opened.error } : { status: opened.status };
  }
  const structural = structureProblem(opened.payload, SYNC_OBJECT_PATH);
  if (structural !== null) return { status: "check-failed", error: structural };
  const file = opened.payload.files[0]!;
  const { json, problem } = bodyJson(Buffer.from(file.bodyB64, "base64"));
  if (problem !== undefined) return { status: "check-failed", error: problem };
  const parsed = syncObjectSchema.safeParse(json);
  if (!parsed.success) {
    return { status: "check-failed", error: `the object body does not match the sync schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  const object = parsed.data;
  if (sha256Hex(object.payload) !== object.checksum) {
    return { status: "check-failed", error: `checksum for ${object.objectId} does not match its payload` };
  }
  if (object.tombstone && object.payload !== "") {
    return { status: "check-failed", error: `the tombstone for ${object.objectId} must carry the empty payload` };
  }
  return { status: "ok", object };
}

/** Seal the object index into `muster-manifest.json` — same envelope, the
 * index as body. Entry fileNames are enforced by the schema's canonical
 * derivation, so the manifest can never name a file pack didn't produce. */
export function packSyncManifest(doc: SyncManifestDoc, options: PackSyncOptions): Buffer {
  const parsed = manifestDocSchema.parse(doc);
  const body = Buffer.from(JSON.stringify(parsed), "utf8");
  return seal(fileOf(SYNC_MANIFEST_PATH, body), options.appVersion, options);
}

/** Open the manifest with the same gates as an object, plus the schema's
 * uniqueness and canonical-fileName refinements. */
export function unpackSyncManifest(bytes: Buffer, options: DecryptBundleV2Options): UnpackManifestResult {
  const opened = decryptBundleV2(bytes, options);
  if (opened.status !== "ok" || opened.payload === undefined) {
    return opened.error !== undefined ? { status: opened.status, error: opened.error } : { status: opened.status };
  }
  const structural = structureProblem(opened.payload, SYNC_MANIFEST_PATH);
  if (structural !== null) return { status: "check-failed", error: structural };
  const file = opened.payload.files[0]!;
  const { json, problem } = bodyJson(Buffer.from(file.bodyB64, "base64"));
  if (problem !== undefined) return { status: "check-failed", error: problem };
  const parsed = manifestDocSchema.safeParse(json);
  if (!parsed.success) {
    return { status: "check-failed", error: `the manifest body does not match its schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  return { status: "ok", doc: parsed.data };
}

export interface SyncReconcilePlan {
  /** Local is newer — including local tombstones (propagate the delete). */
  upload: SyncManifestEntry[];
  /** Remote is newer — including remote tombstones (accept the delete). */
  download: SyncManifestEntry[];
  /** Same rev, different checksum: reported, never auto-resolved. */
  conflict: Array<{ objectId: string; local: SyncManifestEntry; remote: SyncManifestEntry }>;
  /** objectIds whose rev and checksum already agree. */
  inSync: string[];
}

/** §10's rev-compare, pure: local-er uploads, remote-er downloads, equal
 * rev+checksum is in sync, equal rev with different checksums is a conflict
 * both sides keep. An unseen object is pure distance in either direction. */
export function reconcileSyncObjects(
  local: readonly SyncManifestEntry[],
  remote: readonly SyncManifestEntry[],
): SyncReconcilePlan {
  const plan: SyncReconcilePlan = { upload: [], download: [], conflict: [], inSync: [] };
  const remoteById = new Map(remote.map((entry) => [entry.objectId, entry]));
  for (const entry of local) {
    const other = remoteById.get(entry.objectId);
    if (other === undefined) {
      plan.upload.push(entry);
      continue;
    }
    remoteById.delete(entry.objectId);
    if (entry.rev > other.rev) plan.upload.push(entry);
    else if (entry.rev < other.rev) plan.download.push(other);
    else if (entry.checksum === other.checksum) plan.inSync.push(entry.objectId);
    else plan.conflict.push({ objectId: entry.objectId, local: entry, remote: other });
  }
  for (const remaining of remoteById.values()) plan.download.push(remaining);
  return plan;
}
