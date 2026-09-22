// Workspace bundle v2 — the portable half of the backup contract, prototype.
//
// v1 (server/workspace-bundle.ts) still owns the live backup routes and is
// unchanged. It has two properties the contract refuses to keep: the record
// schemas it restores from are loosely validated (`memory` keys accept
// traversal-shaped names, bot records are re-inserted as-is), and its key is
// derived from `passphrase + installation signing secret`, so a bundle is
// unreadable on any machine that does not carry the original
// `DATA_DIR/auth.secret`. That is a same-installation backup wearing a
// portable filename.
//
// v2 is a format, not a route. It fixes exactly those two things:
//   * the passphrase is the ONLY recovery material. The KDF parameters ride
//     in the envelope (`kdf`), and this module never reads the installation
//     secret at all — `buildPayloadV2` records it as a skipped file like any
//     other entry outside the subset. Recovery from a destroyed installation
//     therefore needs nothing but the bundle bytes and the passphrase.
//   * every boundary is parsed with zod — envelope, manifest, transcript rows
//     — and paths are checked against a single relative-path rule before
//     anything could act on them.
//
// Format: header + `gzip+json` payload sealed with AES-256-GCM. The
// canonicalised header (sorted keys, minus `ciphertextB64` and minus
// `cipher.tagB64` — the tag does not exist until final(), so it cannot be its
// own associated data) is the AEAD associated data. An edited `schema`,
// `kdf`, `counts`, `payloadSha256` or IV therefore fails authentication even
// though only the ciphertext would otherwise have been covered.
//
// The transcript is read from a `VACUUM INTO` snapshot in a private temp
// directory, never from the live database: a server folding turns writes to
// `messages.db` while an export reads it, and a torn read would silently
// produce a transcript that never existed. If the snapshot cannot be taken
// the payload records `unsupported:<reason>` and carries an empty transcript
// instead of a torn one. A `messages.db` outside the given data directory is
// never opened.
//
// The restore half is split in two so that only one of them can touch a live
// installation. `stageRestoreV2` validates the whole payload and then writes a
// complete, hashed copy of it into a staging directory the caller names; it
// never reads or writes the installation. `commitRestoreV2` is the only
// function here that may write into a live tree, and it overlays: the current
// version of exactly the paths the staging manifest covers is moved into a
// backup directory, the staged files are written in their place, and anything
// the bundle does not cover — `config.json`, `auth.secret`, attachments — is
// left exactly as it was. Any failure rolls the covered paths back and the
// directory is byte-identical to what it was before the call.
//
// `planRestoreV2` is still the dry run, and still writes nothing: it will not
// even open the target database, because opening a WAL database can create
// `-shm`/`-wal` sidecars. Nothing in this module is wired into a route — there
// is no endpoint, no UI and no automatic sync, so a restore only happens when
// a caller explicitly asks for one. See
// docs/plans/portable-backup-contract-2026-09-12.md.

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

/** Bounded everything. A bundle that declares more than this is refused
 * before a buffer is allocated for it. */
export const LIMITS = {
  maxFiles: 4096,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxManifestEntries: 4096,
  maxMessages: 200_000,
  maxBundleBytes: 512 * 1024 * 1024,
  maxInflatedBytes: 512 * 1024 * 1024,
} as const;

const BUNDLE_MAGIC = "muster-workspace-bundle";
/** The payload schema literal — exported so the S2 per-object packer stamps
 * the same version the envelope's own literal gate requires (DESIGN §10). */
export const BUNDLE_SCHEMA = 2;
const BUNDLE_PRODUCER = "muster-workspace-bundle-v2";
const MIN_PASSPHRASE_LENGTH = 8;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** 128 MiB of scrypt working memory at the default parameters. */
const DEFAULT_KDF = { name: "scrypt", N: 131072, r: 8, p: 1, keyLen: 32 } as const;
/** A hostile envelope must not be able to ask for an unbounded scrypt run. */
const MAX_KDF_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_SKIPPED_ENTRIES = LIMITS.maxManifestEntries;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

// ---------------------------------------------------------------------------
// Recovery codes (K1) — the user-held half of "the passphrase is the only
// recovery material", without weakening it: codes wrap the MEK, and nothing
// ever stores the MEK unwrapped beside the ciphertext it opens.
// ---------------------------------------------------------------------------

/** Crockford base32 — no I, L, O or U, so a code survives being read off
 *  paper or typed from memory. Four groups of four = 80 bits: a wrong guess
 *  costs a full scrypt run, so the space stays out of reach. */
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_SIZE = 4;
const RECOVERY_DEFAULT_COUNT = 10;
const RECOVERY_MAX_CODES = 16;

/** Canonical form: four dash-separated uppercase groups, or null when what
 *  the user typed is not a recovery code (length, alphabet, junk). */
export function normalizeRecoveryCode(input: string): string | null {
  const size = RECOVERY_GROUPS * RECOVERY_GROUP_SIZE;
  const compact = input.trim().toUpperCase().replace(/[^0-9A-Z]+/gu, "");
  if (compact.length !== size) return null;
  for (const char of compact) if (!RECOVERY_ALPHABET.includes(char)) return null;
  const groups: string[] = [];
  for (let i = 0; i < size; i += RECOVERY_GROUP_SIZE) groups.push(compact.slice(i, i + RECOVERY_GROUP_SIZE));
  return groups.join("-");
}

/** `count` independent codes, shown once by the caller. Byte-and-31 over a
 * 32-symbol alphabet is uniform, so each symbol is a clean five bits. */
export function generateRecoveryCodes(count = RECOVERY_DEFAULT_COUNT): string[] {
  const size = RECOVERY_GROUPS * RECOVERY_GROUP_SIZE;
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(size);
    let compact = "";
    for (const byte of bytes) compact += RECOVERY_ALPHABET[byte & 31];
    const groups: string[] = [];
    for (let i = 0; i < size; i += RECOVERY_GROUP_SIZE) groups.push(compact.slice(i, i + RECOVERY_GROUP_SIZE));
    return groups.join("-");
  });
}

// ---------------------------------------------------------------------------
// Path safety — the one rule every stored path must satisfy
// ---------------------------------------------------------------------------

/** A stored path must be relative, slash-separated, and free of `.`/`..`
 * segments. This is the only acceptance rule for a path that a future writer
 * would join onto a data directory, so it is deliberately strict: a Windows
 * separator or a drive letter is refused rather than normalised, because
 * "close enough" is how traversal gets through. */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (isAbsolute(path)) return false;
  if (path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** Resolve a stored path under a data directory, or null when the result
 * escapes it. Belt and braces on top of `isSafeRelativePath`: a symlinked
 * intermediate component is the caller's problem, but escaping the root by
 * string arithmetic never should be. */
function confinedTarget(dataDir: string, path: string): string | null {
  if (!isSafeRelativePath(path)) return null;
  const root = resolve(dataDir);
  const target = resolve(root, path);
  return target.startsWith(root + sep) ? target : null;
}

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const bundleCountsSchema = z.object({
  files: z.number().int().min(0),
  messages: z.number().int().min(0),
  threads: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
});

const bundleKdfSchema = z.object({
  name: z.literal("scrypt"),
  N: z.number().int(),
  r: z.number().int(),
  p: z.number().int(),
  keyLen: z.number().int(),
  saltB64: z.string().min(1).max(512),
});

const bundleCipherSchema = z.object({
  name: z.literal("aes-256-gcm"),
  ivB64: z.string().min(1).max(512),
  tagB64: z.string().min(1).max(512),
});

/** One way to unwrap the bundle's MEK: a passphrase slot plus one slot per
 *  recovery code. Everything here is public — `slotId` is the code's SHA-256
 *  (a lookup, not a secret) and the wrapped key is only meaningful to
 *  whoever holds the code or passphrase that derives its KEK. */
const keySlotSchema = z.object({
  kind: z.enum(["passphrase", "recovery"]),
  slotId: z.string().min(1).max(128).optional(),
  kdf: bundleKdfSchema,
  ivB64: z.string().min(1).max(512),
  wrappedKeyB64: z.string().min(1).max(256),
  tagB64: z.string().min(1).max(512),
});

const bundleEnvelopeSchema = z.object({
  magic: z.literal(BUNDLE_MAGIC),
  // deliberately not a literal: an envelope from a newer producer must be
  // readable enough to report its version, not least because reporting it
  // requires no key at all
  schema: z.number().int(),
  createdAt: z.number().int(),
  producer: z.string().min(1).max(128),
  kdf: bundleKdfSchema,
  /** K1: MEK-wrapping slots (one under the passphrase, one per recovery
   *  code). Absent on legacy bundles, which derive the payload key
   *  directly from passphrase + top-level kdf. */
  keySlots: z.array(keySlotSchema).max(RECOVERY_MAX_CODES + 1).optional(),
  cipher: bundleCipherSchema,
  encoding: z.literal("gzip+json"),
  counts: bundleCountsSchema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  ciphertextB64: z.string().min(1).max(Math.ceil(LIMITS.maxBundleBytes / 3) * 4 + 4),
});

const bundleFileSchema = z.object({
  path: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().min(0).max(LIMITS.maxFileBytes),
  bodyB64: z.string().max(Math.ceil(LIMITS.maxFileBytes / 3) * 4 + 4),
});

const skippedEntrySchema = z.object({
  path: z.string().min(1).max(512),
  reason: z.string().min(1).max(64),
});

const bundleMessageSchema = z.object({
  seq: z.number().int().min(0),
  id: z.string().min(1).max(512),
  at: z.number(),
  role: z.string().min(1).max(32),
  kind: z.string().min(1).max(64),
  text: z.string().max(LIMITS.maxInflatedBytes).nullable(),
  /** the serialized Message exactly as the `messages.json` cell held it, so a
   * future restore writes back the same row rather than a re-serialization */
  json: z.string().min(2).max(LIMITS.maxInflatedBytes),
});

const bundleThreadSchema = z.object({
  threadId: z.string().min(1).max(512),
  activeLeafId: z.string().max(512).nullable(),
  messages: z.array(bundleMessageSchema).max(LIMITS.maxMessages),
});

const bundleTranscriptSchema = z.object({
  /** "vacuum-into", or "unsupported:<reason>" with an empty thread list */
  method: z.string().min(1).max(128),
  threads: z.array(bundleThreadSchema).max(LIMITS.maxManifestEntries),
  counts: z.object({
    threads: z.number().int().min(0).max(LIMITS.maxManifestEntries),
    messages: z.number().int().min(0).max(LIMITS.maxMessages),
  }),
});

const bundlePayloadSchema = z.object({
  schema: z.literal(BUNDLE_SCHEMA),
  appVersion: z.string().min(1).max(128),
  counts: bundleCountsSchema,
  files: z.array(bundleFileSchema).max(LIMITS.maxManifestEntries),
  skipped: z.array(skippedEntrySchema).max(MAX_SKIPPED_ENTRIES),
  skippedTruncated: z.boolean(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  transcripts: bundleTranscriptSchema,
});

export type BundleCounts = z.infer<typeof bundleCountsSchema>;
export type BundleEnvelope = z.infer<typeof bundleEnvelopeSchema>;
export type BundleFileEntry = z.infer<typeof bundleFileSchema>;
export type BundleKdf = z.infer<typeof bundleKdfSchema>;
export type BundleKeySlot = z.infer<typeof keySlotSchema>;
export type BundleMessage = z.infer<typeof bundleMessageSchema>;
export type BundlePayloadV2 = z.infer<typeof bundlePayloadSchema>;
export type BundleSkipEntry = z.infer<typeof skippedEntrySchema>;
export type BundleThread = z.infer<typeof bundleThreadSchema>;
export type BundleTranscript = z.infer<typeof bundleTranscriptSchema>;

/** Why a file the scan walked past is not in the manifest. A file is never
 * dropped without one of these. */
export type SkippedReason =
  | "symlink"
  | "outside-subset"
  | "unsupported-file"
  | "unsupported-entry"
  | "unreadable"
  | "unsafe-path";

// ---------------------------------------------------------------------------
// Hashing, sealing, canonical header
// ---------------------------------------------------------------------------

const sha256Hex = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function encodeBase64(bytes: Buffer): string {
  return bytes.toString("base64");
}

/** Decode base64, or null when the text is not exactly the encoding of the
 * bytes it decodes to. A round trip is the only check that catches both an
 * illegal alphabet and a truncated body. */
function decodeBase64(text: string): Buffer | null {
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64.test(text)) return null;
  const decoded = Buffer.from(text, "base64");
  return encodeBase64(decoded) === text ? decoded : null;
}

/** One digest over the manifest, in path order so array order is not part of
 * the contract. Recorded in the payload and re-derived on every read: a
 * manifest edited without its digest — a swapped hash, a moved entry — is
 * detectable without trusting the producer. */
/** The canonical digest over a file index: sorted paths, each bound to its
 * size and hash. Exported for the S2 per-object packer (DESIGN §10) — a
 * single-file payload must record the same digest this function defines or
 * the envelope's own inspect gate rejects it. */
export function manifestDigest(files: readonly BundleFileEntry[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\u0000${file.size}\u0000${file.sha256}`)
    .join("\u0001");
  return sha256Hex(canonical);
}

/** The authenticated part of the header, in sorted order. `ciphertextB64` is
 * the body itself; `cipher.tagB64` cannot exist when the AAD is set. Both are
 * covered by the GCM tag regardless. */
function canonicalHeader(envelope: BundleEnvelope): string {
  return JSON.stringify({
    cipher: { ivB64: envelope.cipher.ivB64, name: envelope.cipher.name },
    counts: {
      files: envelope.counts.files,
      messages: envelope.counts.messages,
      threads: envelope.counts.threads,
      totalBytes: envelope.counts.totalBytes,
    },
    createdAt: envelope.createdAt,
    encoding: envelope.encoding,
    kdf: {
      N: envelope.kdf.N,
      keyLen: envelope.kdf.keyLen,
      name: envelope.kdf.name,
      p: envelope.kdf.p,
      r: envelope.kdf.r,
      saltB64: envelope.kdf.saltB64,
    },
    // `undefined` is dropped by JSON.stringify, so a legacy envelope's AAD is
    // byte-identical to today's; when present, every slot rides the AAD and
    // editing one fails the payload's authentication.
    keySlots: envelope.keySlots,
    magic: envelope.magic,
    payloadSha256: envelope.payloadSha256,
    producer: envelope.producer,
    schema: envelope.schema,
  });
}

/** scrypt's working set is 128 * N * r bytes plus a little for the parallel
 * lanes; maxmem must clear it or Node refuses the parameters. Sized with
 * headroom rather than to the byte, because the failure mode of a tight fit
 * is "the bundle you can still read today stops opening on another build". */
function kdfMaxmem(N: number, r: number, p: number): number {
  return Math.min(128 * N * r * 2 + 128 * r * p + 1_048_576, MAX_KDF_MEMORY_BYTES + 1_048_576);
}

function deriveKey(passphrase: string, kdf: BundleKdf, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, kdf.keyLen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: kdfMaxmem(kdf.N, kdf.r, kdf.p) });
}

/** Reject KDF parameters a hostile envelope could use to burn memory before
 * any key is derived. Returns null when the parameters are acceptable. */
function kdfProblem(kdf: BundleKdf): string | null {
  if (kdf.keyLen !== 32) return `keyLen ${kdf.keyLen} is not a 256-bit key`;
  if (!Number.isInteger(kdf.N) || kdf.N < 16_384 || kdf.N > 262_144 || (kdf.N & (kdf.N - 1)) !== 0) {
    return `N ${kdf.N} is outside the accepted scrypt range`;
  }
  if (!Number.isInteger(kdf.r) || kdf.r < 1 || kdf.r > 16) return `r ${kdf.r} is outside the accepted scrypt range`;
  if (!Number.isInteger(kdf.p) || kdf.p < 1 || kdf.p > 4) return `p ${kdf.p} is outside the accepted scrypt range`;
  if (128 * kdf.N * kdf.r > MAX_KDF_MEMORY_BYTES) return `scrypt parameters request more than ${MAX_KDF_MEMORY_BYTES} bytes`;
  return null;
}

/** The identity a wrapped MEK is bound to: moving a wrapped blob between
 *  slots (or editing a slot's KDF) breaks its own tag, independent of the
 *  payload AAD that also covers the whole envelope. */
function slotAad(identity: { kind: string; slotId?: string; kdf: BundleKdf }): string {
  return JSON.stringify({
    kind: identity.kind,
    kdf: {
      N: identity.kdf.N,
      keyLen: identity.kdf.keyLen,
      name: identity.kdf.name,
      p: identity.kdf.p,
      r: identity.kdf.r,
      saltB64: identity.kdf.saltB64,
    },
    slotId: identity.slotId ?? "",
  });
}

/** One slot's contribution to the envelope: the ciphertext of the MEK under
 *  a KEK — never the MEK itself. */
interface MekWrap {
  ivB64: string;
  wrappedKeyB64: string;
  tagB64: string;
}

/** AES-256-GCM wrap of the 32-byte MEK under a slot's KEK. */
function wrapMek(kek: Buffer, mek: Buffer, identity: { kind: string; slotId?: string; kdf: BundleKdf }): MekWrap {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(Buffer.from(slotAad(identity), "utf8"));
  const wrapped = Buffer.concat([cipher.update(mek), cipher.final()]);
  return { ivB64: encodeBase64(iv), wrappedKeyB64: encodeBase64(wrapped), tagB64: encodeBase64(cipher.getAuthTag()) };
}

/** Unwrap a slot's MEK. Null for a wrong KEK or a malformed slot — the read
 *  path reports failures as statuses, so this never throws either. */
function unwrapMek(kek: Buffer, slot: BundleKeySlot): Buffer | null {
  const iv = decodeBase64(slot.ivB64);
  const wrapped = decodeBase64(slot.wrappedKeyB64);
  const tag = decodeBase64(slot.tagB64);
  if (iv === null || iv.byteLength !== IV_BYTES || wrapped === null || wrapped.byteLength !== 32 || tag === null || tag.byteLength !== TAG_BYTES) {
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", kek, iv);
    decipher.setAAD(Buffer.from(slotAad(slot), "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  } catch {
    return null;
  }
}

/** The key to open the payload with: legacy envelopes derive it directly
 *  from the passphrase; slot'd envelopes unwrap the MEK from the matching
 *  slot. A recovery code, when present, is the ONLY way in — no passphrase
 *  fallback, so a wrong code cannot be masked by a correct passphrase.
 *  Null = no acceptable secret for this envelope (report as bad-key). */
function payloadKeyFor(envelope: BundleEnvelope, options: DecryptBundleV2Options, salt: Buffer): Buffer | null {
  if (options.recoveryCode !== undefined) {
    if (envelope.keySlots === undefined) return null;
    const code = normalizeRecoveryCode(options.recoveryCode);
    if (code === null) return null;
    const slotId = sha256Hex(code);
    const slot = envelope.keySlots.find((candidate) => candidate.kind === "recovery" && candidate.slotId === slotId);
    if (slot === undefined) return null;
    if (kdfProblem(slot.kdf) !== null) return null;
    const slotSalt = decodeBase64(slot.kdf.saltB64);
    if (slotSalt === null || slotSalt.byteLength !== SALT_BYTES) return null;
    return unwrapMek(deriveKey(code, slot.kdf, slotSalt), slot);
  }
  const passphrase = options.passphrase;
  if (passphrase === undefined) return null;
  if (envelope.keySlots === undefined) return deriveKey(passphrase, envelope.kdf, salt);
  const slot = envelope.keySlots.find((candidate) => candidate.kind === "passphrase");
  if (slot === undefined) return null;
  return unwrapMek(deriveKey(passphrase, envelope.kdf, salt), slot);
}

// ---------------------------------------------------------------------------
// Export — build the payload
// ---------------------------------------------------------------------------

const SUBSET_ROOT_FILES = new Set([
  "bots.json",
  "groups.json",
  "MEMORY.md",
  // the automation and history layer — a restore that lost routines, goals,
  // approval history or the social graph was only half a restore. Routines
  // and goals are de-weaponized by the boot apply (server/restore-apply.ts);
  // keys, connections and the installation secret stay outside the subset.
  "routines.json",
  "goals.json",
  "decisions.json",
  "social.json",
]);

export interface BuildPayloadV2Options {
  dataDir: string;
  appVersion: string;
}

export interface ScanState {
  files: BundleFileEntry[];
  skipped: BundleSkipEntry[];
  skippedTruncated: boolean;
  totalBytes: number;
}

/** Sorted, so a bundle over unchanged bytes is byte-identical run to run. */
function sortedEntries(dir: string): string[] {
  try {
    return readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function recordSkip(state: ScanState, path: string, reason: SkippedReason): void {
  // the skipped list is part of the manifest contract, so its own bound is
  // reported explicitly rather than silently dropping the tail
  if (state.skipped.length >= MAX_SKIPPED_ENTRIES) {
    state.skippedTruncated = true;
    return;
  }
  state.skipped.push({ path, reason });
}

/** Read one candidate file into the manifest. Symlinks are reported, never
 * followed — a link out of the data directory is exactly the shape that turns
 * a backup into an exfiltration or a restore into a write outside the tree. */
function addFile(state: ScanState, absolute: string, relative: string): void {
  if (!isSafeRelativePath(relative)) {
    recordSkip(state, relative, "unsafe-path");
    return;
  }
  const info = lstatOrNull(absolute);
  if (info === null) {
    recordSkip(state, relative, "unreadable");
    return;
  }
  if (info.isSymbolicLink()) {
    recordSkip(state, relative, "symlink");
    return;
  }
  if (!info.isFile()) {
    recordSkip(state, relative, "unsupported-entry");
    return;
  }
  if (info.size > LIMITS.maxFileBytes) {
    throw new Error(
      `workspace bundle v2: ${relative} is ${info.size} bytes, above the ${LIMITS.maxFileBytes}-byte per-file limit`,
    );
  }
  if (state.files.length >= LIMITS.maxFiles) {
    throw new Error(`workspace bundle v2: more than ${LIMITS.maxFiles} files — refusing a partial manifest`);
  }
  if (state.totalBytes + info.size > LIMITS.maxTotalBytes) {
    throw new Error(
      `workspace bundle v2: the included files exceed the ${LIMITS.maxTotalBytes}-byte total limit`,
    );
  }
  let body: Buffer;
  try {
    body = readFileSync(absolute);
  } catch {
    recordSkip(state, relative, "unreadable");
    return;
  }
  state.files.push({ path: relative, sha256: sha256Hex(body), size: body.byteLength, bodyB64: encodeBase64(body) });
  state.totalBytes += body.byteLength;
}

/** Walk the v2 subset. The scan surface is bounded on purpose: the data
 * directory, `memory/`, `workspaces/`, and each `workspaces/<botId>/` at their
 * top level only. A bot's desk subdirectory is one skipped entry, not a
 * 50,000-entry walk of its node_modules. */
function scanSubset(dataDir: string): ScanState {
  const state: ScanState = { files: [], skipped: [], skippedTruncated: false, totalBytes: 0 };
  for (const entry of sortedEntries(dataDir)) {
    if (SUBSET_ROOT_FILES.has(entry)) {
      addFile(state, join(dataDir, entry), entry);
      continue;
    }
    if (entry === "memory" || entry === "workspaces") continue;
    recordSkip(state, entry, "outside-subset");
  }
  const memoryDir = join(dataDir, "memory");
  for (const entry of sortedEntries(memoryDir)) {
    const relative = `memory/${entry}`;
    if (entry.endsWith(".md")) addFile(state, join(memoryDir, entry), relative);
    else recordSkip(state, relative, "unsupported-file");
  }
  const workspacesDir = join(dataDir, "workspaces");
  for (const botId of sortedEntries(workspacesDir)) {
    const botDir = join(workspacesDir, botId);
    const botInfo = lstatOrNull(botDir);
    if (botInfo === null) {
      recordSkip(state, `workspaces/${botId}`, "unreadable");
      continue;
    }
    if (botInfo.isSymbolicLink()) {
      recordSkip(state, `workspaces/${botId}`, "symlink");
      continue;
    }
    if (!botInfo.isDirectory()) {
      recordSkip(state, `workspaces/${botId}`, "unsupported-entry");
      continue;
    }
    for (const entry of sortedEntries(botDir)) {
      const relative = `workspaces/${botId}/${entry}`;
      if (entry === "MEMORY.md") {
        addFile(state, join(botDir, entry), relative);
        continue;
      }
      if (entry === "memory") {
        for (const topic of sortedEntries(join(botDir, "memory"))) {
          const relativeTopic = `${relative}/${topic}`;
          if (topic.endsWith(".md")) addFile(state, join(botDir, "memory", topic), relativeTopic);
          else recordSkip(state, relativeTopic, "unsupported-file");
        }
        continue;
      }
      recordSkip(state, relative, "outside-subset");
    }
  }
  state.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  state.skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return state;
}

// ---------------------------------------------------------------------------
// Transcript snapshot
// ---------------------------------------------------------------------------

interface TranscriptRow {
  thread_id: string;
  id: string;
  at: number;
  role: string;
  kind: string;
  text: string | null;
  json: string;
  seq: number;
}

interface ThreadStateRow {
  thread_id: string;
  active_leaf_id: string | null;
}

/** The rows exactly as `messages`/`thread_state` declare them. A snapshot is
 * the one place a database we did not write is read, so its rows are parsed,
 * not trusted. */
const transcriptRowSchema = z.object({
  thread_id: z.string(),
  id: z.string(),
  at: z.number(),
  role: z.string(),
  kind: z.string(),
  text: z.string().nullable(),
  json: z.string(),
  seq: z.number(),
});

const threadStateRowSchema = z.object({
  thread_id: z.string(),
  active_leaf_id: z.string().nullable(),
});

interface TranscriptSnapshot {
  threads: BundleThread[];
  messages: number;
}

function readSnapshot(copyPath: string): TranscriptSnapshot {
  const db = new DatabaseSync(copyPath, { readOnly: true });
  try {
    const rows: TranscriptRow[] = transcriptRowSchema.array().parse(
      db
        .prepare("SELECT thread_id, id, at, role, kind, text, json, rowid AS seq FROM messages ORDER BY thread_id, rowid")
        .all(),
    );
    const states: ThreadStateRow[] = threadStateRowSchema.array().parse(
      db.prepare("SELECT thread_id, active_leaf_id FROM thread_state").all(),
    );
    if (rows.length > LIMITS.maxMessages) {
      throw new Error(`workspace bundle v2: transcript holds ${rows.length} messages, above the ${LIMITS.maxMessages} limit`);
    }
    const order: string[] = [];
    const byThread = new Map<string, BundleThread>();
    const thread = (threadId: string): BundleThread => {
      const existing = byThread.get(threadId);
      if (existing) return existing;
      const created: BundleThread = { threadId, activeLeafId: null, messages: [] };
      byThread.set(threadId, created);
      order.push(threadId);
      return created;
    };
    for (const row of rows) {
      thread(row.thread_id).messages.push({
        seq: row.seq,
        id: row.id,
        at: row.at,
        role: row.role,
        kind: row.kind,
        text: row.text,
        json: row.json,
      });
    }
    for (const state of states) {
      const target = thread(state.thread_id);
      target.activeLeafId = state.active_leaf_id ?? null;
    }
    return { threads: order.map((threadId) => thread(threadId)), messages: rows.length };
  } finally {
    db.close();
  }
}

/** A consistent snapshot of the transcript, or an explicit reason why there is
 * none. The copy is what gets read: the live file is only ever the source of
 * a `VACUUM INTO`, and a database outside the data directory is refused
 * outright rather than read. */
function snapshotTranscript(dataDir: string): BundleTranscript {
  const empty: BundleTranscript = { method: "unsupported:none", threads: [], counts: { threads: 0, messages: 0 } };
  const dbPath = confinedTarget(dataDir, "messages.db");
  if (dbPath === null) return { ...empty, method: "unsupported:outside-data-directory" };
  if (!existsSync(dbPath)) return { ...empty, method: "unsupported:no-database" };
  const scratch = mkdtempSync(join(tmpdir(), "muster-bundle-v2-"));
  try {
    const copyPath = join(scratch, "messages.db");
    const source = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // VACUUM INTO writes a fresh database containing a consistent
      // transaction's view; the live file is not modified by it.
      source.prepare("VACUUM INTO ?").run(copyPath);
    } finally {
      source.close();
    }
    const snapshot = readSnapshot(copyPath);
    return {
      method: "vacuum-into",
      threads: snapshot.threads,
      counts: { threads: snapshot.threads.length, messages: snapshot.messages },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...empty, method: `unsupported:${reason.slice(0, 100)}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Export — build, then seal
// ---------------------------------------------------------------------------

/** Collect the v2 subset. Reads only: the one write in here is the VACUUM INTO
 * snapshot, which lands in a private temp directory and is removed before this
 * returns. The data directory is never written to. */
export function buildPayloadV2(options: BuildPayloadV2Options): BundlePayloadV2 {
  const dataDir = options.dataDir;
  const info = lstatOrNull(dataDir);
  if (info === null) throw new Error(`workspace bundle v2: the data directory ${dataDir} does not exist`);
  if (!info.isDirectory()) throw new Error(`workspace bundle v2: ${dataDir} is not a directory`);
  const state = scanSubset(dataDir);
  const transcripts = snapshotTranscript(dataDir);
  const payload: BundlePayloadV2 = {
    schema: BUNDLE_SCHEMA,
    appVersion: options.appVersion,
    counts: {
      files: state.files.length,
      messages: transcripts.counts.messages,
      threads: transcripts.counts.threads,
      totalBytes: state.totalBytes,
    },
    files: state.files,
    skipped: state.skipped,
    skippedTruncated: state.skippedTruncated,
    manifestSha256: manifestDigest(state.files),
    transcripts,
  };
  return payload;
}

export interface EncryptBundleV2Options {
  passphrase: string;
  /** scrypt parameters to record in the envelope. Defaults to 131072/8/1/32. */
  kdf?: BundleKdf;
  /** K1: additionally wrap the MEK under these recovery codes (one slot
   *  each). The codes are shown once by the caller — this module never
   *  persists them, and never stores the MEK unwrapped. */
  recovery?: { codes: string[] };
}

/** Seal a payload into the portable bundle bytes. The KDF parameters are
 * written into the envelope, so the default can move later without making
 * today's bundles unreadable. */
export function encryptBundleV2(payload: BundlePayloadV2, options: EncryptBundleV2Options): Buffer {
  const passphrase = options.passphrase;
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`workspace bundle v2: the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const parsed = bundlePayloadSchema.parse(payload);
  const plaintext = Buffer.from(JSON.stringify(parsed), "utf8");
  const compressed = gzipSync(plaintext);
  const kdf: BundleKdf = options.kdf ?? { ...DEFAULT_KDF, saltB64: "" };
  const kdfProblemText = kdfProblem(kdf);
  if (kdfProblemText !== null) throw new Error(`workspace bundle v2: ${kdfProblemText}`);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const recoveryCodes = options.recovery?.codes;
  let key: Buffer;
  let keySlots: BundleKeySlot[] | undefined;
  if (recoveryCodes !== undefined) {
    const normalized = recoveryCodes.map((raw) => {
      const code = normalizeRecoveryCode(raw);
      if (code === null) throw new Error(`workspace bundle v2: ${JSON.stringify(raw)} is not a recovery code`);
      return code;
    });
    if (normalized.length < 1) throw new Error("workspace bundle v2: recovery needs at least one recovery code");
    if (normalized.length > RECOVERY_MAX_CODES) throw new Error(`workspace bundle v2: recovery accepts at most ${RECOVERY_MAX_CODES} codes`);
    if (new Set(normalized).size !== normalized.length) throw new Error("workspace bundle v2: recovery codes must be distinct");
    // The MEK is the payload key; every slot wraps it and nothing stores it
    // bare — the passphrase slot first, then one slot per distinct code.
    const mek = randomBytes(32);
    key = mek;
    const passphraseKdf: BundleKdf = { ...kdf, saltB64: encodeBase64(salt) };
    keySlots = [
      { kind: "passphrase", kdf: passphraseKdf, ...wrapMek(deriveKey(passphrase, kdf, salt), mek, { kind: "passphrase", kdf: passphraseKdf }) },
      ...normalized.map((code) => {
        const slotKdf: BundleKdf = { ...DEFAULT_KDF, saltB64: encodeBase64(randomBytes(SALT_BYTES)) };
        const slotSalt = decodeBase64(slotKdf.saltB64);
        if (slotSalt === null || slotSalt.byteLength !== SALT_BYTES) {
          throw new Error("workspace bundle v2: could not mint a recovery slot salt"); // unreachable: fresh base64
        }
        const slotId = sha256Hex(code);
        return {
          kind: "recovery" as const,
          slotId,
          kdf: slotKdf,
          ...wrapMek(deriveKey(code, slotKdf, slotSalt), mek, { kind: "recovery", slotId, kdf: slotKdf }),
        };
      }),
    ];
  } else {
    key = deriveKey(passphrase, kdf, salt);
  }
  const envelope: BundleEnvelope = {
    magic: BUNDLE_MAGIC,
    schema: BUNDLE_SCHEMA,
    createdAt: Date.now(),
    producer: BUNDLE_PRODUCER,
    kdf: { name: "scrypt", N: kdf.N, r: kdf.r, p: kdf.p, keyLen: kdf.keyLen, saltB64: encodeBase64(salt) },
    cipher: { name: "aes-256-gcm", ivB64: encodeBase64(iv), tagB64: "" },
    encoding: "gzip+json",
    counts: parsed.counts,
    payloadSha256: sha256Hex(plaintext),
    ciphertextB64: "",
  };
  if (keySlots !== undefined) envelope.keySlots = keySlots;
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(canonicalHeader(envelope), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const sealed: BundleEnvelope = {
    ...envelope,
    cipher: { name: "aes-256-gcm", ivB64: encodeBase64(iv), tagB64: encodeBase64(cipher.getAuthTag()) },
    ciphertextB64: encodeBase64(ciphertext),
  };
  const bytes = Buffer.from(JSON.stringify(sealed), "utf8");
  if (bytes.byteLength > LIMITS.maxBundleBytes) {
    throw new Error(`workspace bundle v2: the sealed bundle is ${bytes.byteLength} bytes, above the ${LIMITS.maxBundleBytes}-byte limit`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Read — decrypt
// ---------------------------------------------------------------------------

export type BundleStatus =
  | "ok"
  | "malformed-envelope"
  | "unknown-version"
  | "bad-key"
  | "truncated"
  | "tampered"
  | "limit-exceeded"
  | "check-failed";

/** Everything a read learned, including where it stopped. `payload` is kept
 * whenever the payload parsed, even if a later gate rejected it: verify's job
 * is to name the property that broke, and it cannot do that from a null. */
interface Inspection {
  status: BundleStatus;
  error: string | null;
  envelope: BundleEnvelope | null;
  payload: BundlePayloadV2 | null;
  /** true once the GCM tag verified, even if a later structural check failed:
   * "this ciphertext is the one that was sealed" and "this payload is usable"
   * are different facts and verify reports both. */
  authenticated: boolean;
}

function parseEnvelope(text: string): BundleEnvelope | null {
  try {
    const parsed = bundleEnvelopeSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parsePayload(text: string): BundlePayloadV2 | null {
  try {
    const parsed = bundlePayloadSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function countsEqual(left: BundleCounts, right: BundleCounts): boolean {
  return (
    left.files === right.files &&
    left.messages === right.messages &&
    left.threads === right.threads &&
    left.totalBytes === right.totalBytes
  );
}

/** Every way the payload can contradict what it declares about itself. */
function payloadProblem(payload: BundlePayloadV2): { status: BundleStatus; error: string } | null {
  for (const file of payload.files) {
    if (!isSafeRelativePath(file.path)) return { status: "malformed-envelope", error: `manifest path ${file.path} is not a safe relative path` };
  }
  if (payload.files.length !== payload.counts.files) {
    return { status: "tampered", error: `the manifest holds ${payload.files.length} files but declares ${payload.counts.files}` };
  }
  if (payload.files.length > LIMITS.maxFiles || payload.files.length > LIMITS.maxManifestEntries) {
    return { status: "limit-exceeded", error: `the manifest holds more than ${LIMITS.maxFiles} files` };
  }
  if (payload.counts.messages > LIMITS.maxMessages) {
    return { status: "limit-exceeded", error: `the transcript declares more than ${LIMITS.maxMessages} messages` };
  }
  if (payload.counts.totalBytes > LIMITS.maxTotalBytes) {
    return { status: "limit-exceeded", error: `the files declare more than ${LIMITS.maxTotalBytes} bytes` };
  }
  let total = 0;
  for (const file of payload.files) {
    total += file.size;
    if (file.size > LIMITS.maxFileBytes) return { status: "limit-exceeded", error: `${file.path} is above the ${LIMITS.maxFileBytes}-byte per-file limit` };
    const body = decodeBase64(file.bodyB64);
    if (body === null || body.byteLength !== file.size) {
      return { status: "tampered", error: `${file.path} carries ${body === null ? "an undecodable body" : "a body of the wrong length"}` };
    }
    if (sha256Hex(body) !== file.sha256) return { status: "tampered", error: `${file.path} does not match the hash it records` };
  }
  if (total !== payload.counts.totalBytes) {
    return { status: "tampered", error: `the files total ${total} bytes but the payload declares ${payload.counts.totalBytes}` };
  }
  if (manifestDigest(payload.files) !== payload.manifestSha256) {
    return { status: "tampered", error: "the manifest does not match its recorded digest" };
  }
  return null;
}

/** Read a bundle as far as it can be read, without throwing for any input.
 * The order is deliberate: version before key (so a newer bundle can be
 * reported without the passphrase), structure before AEAD (so a truncated
 * body is named as such rather than as a wrong key), and payload integrity
 * before the payload is handed to anyone. */
function inspectBundle(bytes: Buffer, options: DecryptBundleV2Options): Inspection {
  const fail = (status: BundleStatus, error: string, envelope: BundleEnvelope | null): Inspection => ({
    status,
    error,
    envelope,
    payload: null,
    authenticated: false,
  });
  const envelope = parseEnvelope(bytes.toString("utf8"));
  if (envelope === null) {
    return fail("malformed-envelope", "the bundle is not a readable v2 envelope", null);
  }
  if (envelope.schema !== BUNDLE_SCHEMA) {
    return fail("unknown-version", `bundle schema ${envelope.schema} is not supported by this build`, envelope);
  }
  if (
    envelope.counts.files > LIMITS.maxFiles ||
    envelope.counts.messages > LIMITS.maxMessages ||
    envelope.counts.threads > LIMITS.maxManifestEntries ||
    envelope.counts.totalBytes > LIMITS.maxTotalBytes ||
    bytes.byteLength > LIMITS.maxBundleBytes
  ) {
    return fail("limit-exceeded", "the envelope declares more data than the limits allow", envelope);
  }
  const kdfIssue = kdfProblem(envelope.kdf);
  if (kdfIssue !== null) {
    return fail("malformed-envelope", kdfIssue, envelope);
  }
  const salt = decodeBase64(envelope.kdf.saltB64);
  const iv = decodeBase64(envelope.cipher.ivB64);
  const tag = decodeBase64(envelope.cipher.tagB64);
  const ciphertext = decodeBase64(envelope.ciphertextB64);
  if (salt === null || salt.byteLength !== SALT_BYTES || iv === null || iv.byteLength !== IV_BYTES || tag === null || tag.byteLength !== TAG_BYTES) {
    return fail("malformed-envelope", "the envelope carries an unusable salt, IV or authentication tag", envelope);
  }
  if (ciphertext === null || ciphertext.byteLength === 0) {
    return fail("truncated", "the compressed body is missing or unreadable", envelope);
  }
  let plaintext: Buffer;
  try {
    const payloadKey = payloadKeyFor(envelope, options, salt);
    if (payloadKey === null) {
      return fail("bad-key", "the bundle did not authenticate — wrong passphrase or recovery code, or the envelope was edited", envelope);
    }
    const decipher = createDecipheriv("aes-256-gcm", payloadKey, iv);
    decipher.setAAD(Buffer.from(canonicalHeader(envelope), "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return fail("bad-key", "the bundle did not authenticate — wrong passphrase, or the envelope was edited", envelope);
  }
  let inflated: Buffer;
  try {
    inflated = gunzipSync(plaintext, { maxOutputLength: LIMITS.maxInflatedBytes });
  } catch (error) {
    const status: BundleStatus = error instanceof RangeError ? "limit-exceeded" : "truncated";
    return { status, error: "the compressed body did not inflate", envelope, payload: null, authenticated: true };
  }
  if (sha256Hex(inflated) !== envelope.payloadSha256) {
    return { status: "tampered", error: "the payload does not match the hash recorded for it", envelope, payload: null, authenticated: true };
  }
  const payload = parsePayload(inflated.toString("utf8"));
  if (payload === null) {
    return { status: "malformed-envelope", error: "the payload is not a readable v2 payload", envelope, payload: null, authenticated: true };
  }
  if (!countsEqual(envelope.counts, payload.counts)) {
    return { status: "tampered", error: "the envelope and the payload declare different counts", envelope, payload, authenticated: true };
  }
  const problem = payloadProblem(payload);
  if (problem !== null) return { status: problem.status, error: problem.error, envelope, payload, authenticated: true };
  return { status: "ok", error: null, envelope, payload, authenticated: true };
}

export interface DecryptBundleV2Options {
  /** The standing way to open a bundle. Optional only because a recovery
   *  code can stand in for it. */
  passphrase?: string;
  /** K1: a recovery code opens the bundle INSTEAD of the passphrase. When it
   *  is present nothing falls back to the passphrase, so a wrong code is
   *  reported rather than masked by a correct passphrase. */
  recoveryCode?: string;
}

export interface DecryptBundleV2Result {
  status: BundleStatus;
  envelope?: BundleEnvelope;
  payload?: BundlePayloadV2;
  error?: string;
}

/** Decrypt a v2 bundle. Never throws: every failure is a status, because a
 * caller that has to catch in order to learn "wrong passphrase" will
 * eventually catch something else with it. */
export function decryptBundleV2(bytes: Buffer, options: DecryptBundleV2Options): DecryptBundleV2Result {
  const inspection = inspectBundle(bytes, options);
  const result: DecryptBundleV2Result = { status: inspection.status };
  if (inspection.envelope !== null) result.envelope = inspection.envelope;
  // only an accepted payload leaves this function: verify may inspect one it
  // rejected, a caller about to act on the contents may not
  if (inspection.payload !== null && inspection.status === "ok") result.payload = inspection.payload;
  if (inspection.error !== null) result.error = inspection.error;
  return result;
}

// ---------------------------------------------------------------------------
// Read — verify
// ---------------------------------------------------------------------------

export interface VerifyCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export interface BundleSummary {
  files: number;
  messages: number;
  threads: number;
  totalBytes: number;
  skipped: number;
  skippedTruncated: boolean;
  transcriptMethod: string;
  payloadBytes: number;
}

export interface VerifyBundleV2Result {
  status: BundleStatus;
  checks: VerifyCheck[];
  envelope?: BundleEnvelope;
  summary?: BundleSummary;
}

/** The checks every verify reports, in order. Exported so a caller can assert
 * the contract it is relying on rather than discovering a renamed check. */
export const VERIFY_CHECKS = [
  "envelope-readable",
  "counts-declared",
  "authenticated",
  "payload-schema",
  "manifest-count",
  "manifest-paths-safe",
  "manifest-hash-consistent",
  "memory-bodies-intact",
  "transcript-counts",
  "transcripts-linked",
  "limits-respected",
] as const;

/** Which messages a thread's branch head and parent links actually point at.
 * A head that resolves to nothing is a broken transcript, and the whole point
 * of verifying is to say so before a restore believes it. */
function threadLinksResolve(thread: BundleThread): string | null {
  const ids = new Set(thread.messages.map((message) => message.id));
  if (thread.activeLeafId !== null && !ids.has(thread.activeLeafId)) {
    return `${thread.threadId}: the branch head ${thread.activeLeafId} is not in the bundle`;
  }
  for (const message of thread.messages) {
    const parentId = parentIdOf(message.json);
    if (parentId !== null && !ids.has(parentId)) {
      return `${thread.threadId}: message ${message.id} follows ${parentId}, which is not in the bundle`;
    }
  }
  return null;
}

/** The parent link out of a stored Message row, or null when the row is a root
 * or carries no link at all. */
function parentIdOf(json: string): string | null {
  try {
    const parsed = JSON.parse(json);
    const link = z.object({ parentId: z.string().max(512).nullable().optional() }).safeParse(parsed);
    return link.success ? (link.data.parentId ?? null) : null;
  } catch {
    return null;
  }
}

/** Report every structural guarantee as its own line, so a failure names the
 * property that broke instead of "the bundle is bad". Never throws. */
export function verifyBundleV2(bytes: Buffer, options: DecryptBundleV2Options): VerifyBundleV2Result {
  const inspection = inspectBundle(bytes, options);
  const envelope = inspection.envelope;
  const payload = inspection.payload;
  const checks: VerifyCheck[] = [];
  const note = (check: string, ok: boolean, detail: string) => {
    checks.push({ check, ok, detail });
  };
  const notEvaluated = (detail: string) => `not evaluated — ${detail}`;

  note("envelope-readable", envelope !== null, envelope === null ? (inspection.error ?? "the envelope could not be read") : `schema ${envelope.schema}, producer ${envelope.producer}`);
  note(
    "counts-declared",
    envelope !== null && payload !== null ? countsEqual(envelope.counts, payload.counts) : false,
    payload === null ? notEvaluated("the payload was not readable") : "envelope counts match the payload counts",
  );
  const authenticated = inspection.authenticated;
  note("authenticated", authenticated, authenticated ? "AES-256-GCM authentication passed" : notEvaluated(inspection.error ?? inspection.status));
  note("payload-schema", payload !== null, payload === null ? notEvaluated(inspection.error ?? inspection.status) : `payload schema ${payload.schema}, app ${payload.appVersion}`);
  note(
    "manifest-count",
    payload !== null && payload.files.length === payload.counts.files && payload.files.length <= LIMITS.maxManifestEntries,
    payload === null ? notEvaluated(inspection.error ?? inspection.status) : `${payload.files.length} manifest entries against ${payload.counts.files} declared`,
  );
  const unsafePaths = payload === null ? [] : payload.files.filter((file) => !isSafeRelativePath(file.path)).map((file) => file.path);
  note(
    "manifest-paths-safe",
    payload !== null && unsafePaths.length === 0,
    payload === null ? notEvaluated(inspection.error ?? inspection.status) : unsafePaths.length === 0 ? "every manifest path is a safe relative path" : `unsafe paths: ${unsafePaths.join(", ")}`,
  );
  const digestOk = payload !== null && manifestDigest(payload.files) === payload.manifestSha256;
  note("manifest-hash-consistent", digestOk, payload === null ? notEvaluated(inspection.error ?? inspection.status) : digestOk ? "the manifest matches its recorded digest" : "the manifest does not match its recorded digest");
  const bodiesOk =
    payload !== null &&
    payload.files.every((file) => {
      const body = decodeBase64(file.bodyB64);
      return body !== null && body.byteLength === file.size && sha256Hex(body) === file.sha256;
    });
  note("memory-bodies-intact", bodiesOk, payload === null ? notEvaluated(inspection.error ?? inspection.status) : bodiesOk ? "every body matches the hash and length recorded for it" : "a body does not match the hash recorded for it");
  const transcriptCountsOk =
    payload !== null &&
    payload.transcripts.threads.length === payload.transcripts.counts.threads &&
    payload.transcripts.threads.reduce((total, thread) => total + thread.messages.length, 0) === payload.transcripts.counts.messages &&
    payload.counts.threads === payload.transcripts.counts.threads &&
    payload.counts.messages === payload.transcripts.counts.messages;
  note("transcript-counts", transcriptCountsOk, payload === null ? notEvaluated(inspection.error ?? inspection.status) : transcriptCountsOk ? `${payload.transcripts.counts.threads} threads, ${payload.transcripts.counts.messages} messages` : "the transcript counts do not match the rows present");
  const brokenLinks = payload === null ? [] : payload.transcripts.threads.map(threadLinksResolve).filter((issue) => issue !== null);
  note("transcripts-linked", payload !== null && brokenLinks.length === 0, payload === null ? notEvaluated(inspection.error ?? inspection.status) : brokenLinks.length === 0 ? "every branch head and parent link resolves inside its thread" : brokenLinks.join("; "));
  const limitsOk =
    payload !== null &&
    payload.files.length <= LIMITS.maxFiles &&
    payload.files.every((file) => file.size <= LIMITS.maxFileBytes) &&
    payload.counts.totalBytes <= LIMITS.maxTotalBytes &&
    payload.counts.messages <= LIMITS.maxMessages &&
    bytes.byteLength <= LIMITS.maxBundleBytes;
  note("limits-respected", limitsOk, payload === null ? notEvaluated(inspection.error ?? inspection.status) : limitsOk ? "every declared count is inside the limits" : "a declared count is outside the limits");

  let status = inspection.status;
  if (status === "ok" && checks.some((check) => !check.ok)) status = "check-failed";
  const result: VerifyBundleV2Result = { status, checks };
  if (envelope !== null) result.envelope = envelope;
  if (payload !== null) {
    result.summary = {
      files: payload.files.length,
      messages: payload.counts.messages,
      threads: payload.counts.threads,
      totalBytes: payload.counts.totalBytes,
      skipped: payload.skipped.length,
      skippedTruncated: payload.skippedTruncated,
      transcriptMethod: payload.transcripts.method,
      payloadBytes: bytes.byteLength,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Restore plan — a dry run, and only a dry run
// ---------------------------------------------------------------------------

export interface RestorePlanEntry {
  kind: "file" | "thread";
  path: string;
  detail: string;
}

export interface RestorePlanV2 {
  creates: RestorePlanEntry[];
  conflicts: RestorePlanEntry[];
  unchanged: RestorePlanEntry[];
  blocked: RestorePlanEntry[];
  writesNothing: true;
}

// ---------------------------------------------------------------------------
// Restore — selective categories (§12)
// ---------------------------------------------------------------------------

/** The eight categories the Restore Center may select (§12). `settings` and
 * `attachments` are the bundle's OWN exclusions — config.json and the
 * attachment tree never enter a payload — so they classify no file today, and
 * a selection of only one of them is a refusal below rather than a silent
 * no-op restore. `conversations` is the transcript: a payload block, not a
 * file. */
export const RESTORE_CATEGORIES = [
  "agents",
  "conversations",
  "memory",
  "settings",
  "workspaces",
  "automations",
  "social",
  "attachments",
] as const;

export type RestoreCategory = (typeof RESTORE_CATEGORIES)[number];

/** Which category one payload path belongs to, decided by prefix. Every file
 * the v2 subset can produce classifies — SUBSET_ROOT_FILES, MEMORY.md,
 * `memory/**` and `workspaces/**` — and the exhaustiveness case in the
 * restore suite pins this classifier against the real scan, so a future
 * subset addition cannot be silently dropped by a partial restore. A path
 * that classifies null rides only a full restore. `decisions.json` is the
 * approval ledger and rides automations with routines and goals: §11 covers
 * the three in one sentence. */
export function restoreCategoryOf(path: string): RestoreCategory | null {
  if (path === BOTS_FILE_NAME || path === GROUPS_FILE_NAME) return "agents";
  if (path === "routines.json" || path === "goals.json" || path === "decisions.json") return "automations";
  if (path === "social.json") return "social";
  if (path === "MEMORY.md" || path.startsWith("memory/")) return "memory";
  if (path.startsWith(WORKSPACES_PREFIX)) return "workspaces";
  return null;
}

/** A payload projected down to the selected categories. */
interface ProjectedRestore {
  payload: BundlePayloadV2;
  /** was `conversations` among the selection? The stage writes the transcript
   * only when this is true. */
  includeTranscript: boolean;
}

/** Keep only the files that classify into `categories`, recomputing every
 * field the payload checker cross-validates (counts.files, counts.totalBytes,
 * manifestSha256) so the projection still describes itself as if it were a
 * bundle payload. counts.threads, counts.messages and the transcript block
 * stay untouched because they still describe the transcript; counts.bots is
 * never cross-validated — the staged receipt recomputes it from what is
 * actually staged. Selecting every category returns the payload unchanged, so
 * a full restore is byte for byte today's. The transcript is NOT zeroed here:
 * whether it is written is carried by `includeTranscript`, because zeroing
 * would make a conversations-less projection indistinguishable from a bundle
 * that genuinely holds no threads. */
function projectCategories(
  payload: BundlePayloadV2,
  categories: readonly RestoreCategory[],
): { ok: true; value: ProjectedRestore } | { ok: false; error: string } {
  const schema = bundlePayloadSchema.safeParse(payload);
  if (!schema.success) return { ok: false, error: "the payload does not match the v2 schema" };
  const selected: RestoreCategory[] = [];
  for (const raw of categories) {
    if (!RESTORE_CATEGORIES.includes(raw)) {
      return { ok: false, error: `unknown restore category: ${JSON.stringify(raw)}` };
    }
    if (!selected.includes(raw)) selected.push(raw);
  }
  if (selected.length === 0) return { ok: false, error: "no restore category was selected" };
  const includeTranscript = selected.includes("conversations");
  if (selected.length === RESTORE_CATEGORIES.length) {
    return { ok: true, value: { payload: schema.data, includeTranscript: true } };
  }
  const files = schema.data.files.filter((file) => {
    const category = restoreCategoryOf(file.path);
    return category !== null && selected.includes(category);
  });
  if (files.length === 0 && !includeTranscript) {
    return { ok: false, error: "the selected categories match nothing in this bundle" };
  }
  return {
    ok: true,
    value: {
      payload: {
        ...schema.data,
        files,
        counts: {
          ...schema.data.counts,
          files: files.length,
          totalBytes: files.reduce((total, file) => total + file.size, 0),
        },
        manifestSha256: manifestDigest(files),
      },
      includeTranscript,
    },
  };
}

/** The wire body a restore selection is parsed from: `categories` arrives
 * unvalidated beside the other request fields, and this module is where it
 * stops being unvalidated. */
export interface RestoreSelectionWire {
  categories?: unknown;
}

/** A parsed restore selection. Absent `categories` is the full restore of
 * today; `error` names exactly why a selection was refused. */
export interface RestoreSelectionParse {
  categories?: RestoreCategory[];
  error?: string;
}

/** Parse the restore selection off a wire body: absent is the full restore of
 * today, everything else must be a non-empty array of known categories. The
 * vocabulary lives here, beside the classifier that gives it meaning, so
 * every route parses it the same way. */
export function parseRestoreCategories(body?: RestoreSelectionWire): RestoreSelectionParse {
  const raw = body?.categories;
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) return { error: "categories must be an array of restore categories" };
  if (raw.length === 0) return { error: "categories must select at least one category" };
  const categories: RestoreCategory[] = [];
  for (const entry of raw) {
    if (!RESTORE_CATEGORIES.includes(entry)) {
      return { error: `unknown restore category: ${JSON.stringify(entry)}` };
    }
    if (!categories.includes(entry)) categories.push(entry);
  }
  return { categories };
}

export interface PlanRestoreV2Options {
  dataDir: string;
  /** Restore only these categories (§12). Absent, or all of them, plans the
   * full restore — byte for byte the plan of today. */
  categories?: readonly RestoreCategory[];
}

/** Diff a payload against a target directory without touching it.
 *
 * This does not open the target database even read-only: SQLite creates
 * `-shm`/`-wal` sidecars next to a WAL database, and a dry run that writes
 * those has already written to the target. Transcript threads — when
 * `conversations` is among the categories — are therefore always reported as
 * creates: deciding merge-versus-insert is exactly the decision that needs
 * the staged writer, not a plan. */
export function planRestoreV2(payload: BundlePayloadV2, options: PlanRestoreV2Options): RestorePlanV2 {
  const plan: RestorePlanV2 = { creates: [], conflicts: [], unchanged: [], blocked: [], writesNothing: true };
  const parsed = bundlePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    plan.blocked.push({ kind: "file", path: "-", detail: "the payload does not match the v2 schema" });
    return plan;
  }
  const projection: { ok: true; value: ProjectedRestore } | { ok: false; error: string } =
    options.categories === undefined
      ? { ok: true, value: { payload: parsed.data, includeTranscript: true } }
      : projectCategories(parsed.data, options.categories);
  if (!projection.ok) {
    plan.blocked.push({ kind: "file", path: "-", detail: projection.error });
    return plan;
  }
  const data = projection.value.payload;
  const includeTranscript = projection.value.includeTranscript;
  for (const file of data.files) {
    const target = confinedTarget(options.dataDir, file.path);
    if (target === null) {
      plan.blocked.push({ kind: "file", path: file.path, detail: "unsafe-path" });
      continue;
    }
    if (!existsSync(target)) {
      plan.creates.push({ kind: "file", path: file.path, detail: `${file.size} bytes` });
      continue;
    }
    let existing: Buffer | null = null;
    try {
      existing = readFileSync(target);
    } catch {
      existing = null;
    }
    if (existing !== null && sha256Hex(existing) === file.sha256) {
      plan.unchanged.push({ kind: "file", path: file.path, detail: "the target already holds these bytes" });
      continue;
    }
    plan.conflicts.push({
      kind: "file",
      path: file.path,
      detail: existing === null ? "the target exists and could not be read" : "the target holds different bytes",
    });
  }
  if (includeTranscript) {
    for (const thread of data.transcripts.threads) {
      plan.creates.push({ kind: "thread", path: thread.threadId, detail: `${thread.messages.length} messages, head ${thread.activeLeafId ?? "none"}` });
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Restore — stage
// ---------------------------------------------------------------------------

/** A step a restore is about to take. The seams (`onStage`, `onCommit`) fire
 * immediately before the step runs, so a throw lands with that step's effects
 * not yet applied. `path` names the entry the step concerns, when it concerns
 * one. */
export interface RestoreEvent {
  step: "validate" | "staging-dir" | "file" | "transcript" | "manifest" | "move" | "write" | "consume";
  path?: string;
}

/** One property that stopped a restore, and why. A refusal reports every
 * property it can check rather than the first: "refused" with no reason is a
 * report the operator cannot act on. */
export interface RestoreBlocked {
  path: string;
  detail: string;
}

/** One id this restore issued, against the id the bundle carried. `kind` keeps
 * a bot named `thread-1` apart from a thread named `thread-1`. An empty
 * `mapping` means no id changed. */
export interface RestoreIdMapping {
  kind: "bot" | "thread";
  from: string;
  to: string;
}

/** A bot whose grants did not travel. A bot record holds standing permissions
 * (`alwaysAllow`, `autoApprove`), a connection switch (`composio`), a browser
 * capability and provider session handles. A bundle carries the record, but a
 * file may not re-establish a grant, so every restored bot is listed here for
 * the owner to decide again on this installation. */
export interface ReconsentEntry {
  botId: string;
  restoredId: string;
  reason: string;
}

export interface StagedCounts {
  files: number;
  messages: number;
  threads: number;
  bots: number;
  bytes: number;
}

const RESTORE_MANIFEST = ".muster-restore-staging.json";
const RESTORE_FORMAT = "muster-restore-staging";
/** The transcript is rebuilt from the payload's rows, never copied: the rows
 * are the data, the file is a rendering of them. */
const STAGED_TRANSCRIPT = "messages.db";
const BOTS_FILE_NAME = "bots.json";
const GROUPS_FILE_NAME = "groups.json";
const WORKSPACES_PREFIX = "workspaces/";

/** Bot-record fields that are a granted capability, an approval the owner gave
 * on a different installation, a provider session handle, or a pointer at a
 * machine or folder belonging to the installation the bundle came from. They
 * are dropped rather than restored. */
export const RESTORE_DROPPED_BOT_FIELDS = [
  "alwaysAllow",
  "autoApprove",
  "approvePeerComms",
  "resumeCursors",
  "computer",
  "cwd",
  "ownerId",
  // a workspace holds at most one coordinator, and the boot migration keeps
  // whichever record it meets first (server/store.ts:487-498): a restored bot
  // carrying the flag could take the role from the installation's own
  "chiefOfStaff",
] as const;

/** Capability switches whose *absence* means "allowed" (`composio` defaults to
 * on, `browser` to off). Dropping `composio` would silently re-grant a
 * connection, so these are written explicitly off instead. */
export const RESTORE_DISABLED_BOT_FIELDS = ["composio", "browser"] as const;

/** The same rule per task record: a cursor resumes a provider session this
 * installation never opened, and a folder was pinned on the other machine. */
export const RESTORE_DROPPED_TASK_FIELDS = ["resumeCursors", "lastInstanceId", "cwd"] as const;

/** Group records carry the same non-portable pointers, plus the transient
 * `busyBotId` the store itself never persists. */
export const RESTORE_DROPPED_GROUP_FIELDS = ["busyBotId", "ownerId", "cwd", "pinnedCwd"] as const;

const stagedFileSchema = z.object({
  path: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().min(0).max(LIMITS.maxFileBytes),
});

const stagedCountsSchema = z.object({
  files: z.number().int().min(0).max(LIMITS.maxFiles + 1),
  messages: z.number().int().min(0).max(LIMITS.maxMessages),
  threads: z.number().int().min(0).max(LIMITS.maxManifestEntries),
  bots: z.number().int().min(0).max(LIMITS.maxManifestEntries),
  /** bytes counts the staging tree the stage just wrote, transcript included,
   * so it is deliberately unbounded here: a bound below the size of a large
   * transcript's database would make the stage write a manifest its own reader
   * rejects. The payload's own bounds were enforced before any of this. */
  bytes: z.number().int().min(0),
});

/** What a staging tree is, and what it holds. `commitRestoreV2` reads this
 * before it moves anything and refuses a tree without it: a directory of files
 * is not a restore, and a half-written one must never be mistaken for one. */
const stagingManifestSchema = z.object({
  format: z.literal(RESTORE_FORMAT),
  schema: z.literal(BUNDLE_SCHEMA),
  stagedAt: z.number().int(),
  appVersion: z.string().min(1).max(128),
  transcriptMethod: z.string().min(1).max(128),
  remappedIds: z.boolean(),
  counts: stagedCountsSchema,
  files: z.array(stagedFileSchema).min(1).max(LIMITS.maxFiles + 1),
  /** set by a completed commit, so the same tree cannot be applied twice */
  consumedAt: z.number().int().optional(),
});

type StagingManifest = z.infer<typeof stagingManifestSchema>;

/** Lenient on purpose: a bundle from another build carries fields this one
 * does not know, and the whole point of restoring is to keep them. */
const botRecordSchema = z.looseObject({
  id: z.string().min(1).max(512),
  threadId: z.string().min(1).max(512).optional(),
  tasks: z
    .array(z.looseObject({ threadId: z.string().min(1).max(512).optional() }))
    .max(LIMITS.maxManifestEntries)
    .optional(),
});

const groupRecordSchema = z.looseObject({
  id: z.string().min(1).max(512),
  threadId: z.string().min(1).max(512).optional(),
  memberIds: z.array(z.string().min(1).max(512)).max(LIMITS.maxManifestEntries).optional(),
  /** `{kind: "member", botId}` names the member a plain message reaches
   * (server/store.ts:426-433). Left untyped on purpose: the field has several
   * shapes, and one that names no member is left exactly as the bundle held
   * it rather than failing the whole restore. */
  defaultResponder: z.unknown().optional(),
});

/** The responder shape that carries a bot id. */
const groupResponderSchema = z.looseObject({ botId: z.string().min(1).max(512) });

const botReferenceSchema = z.looseObject({ botId: z.string().min(1).max(512) });
const commReferenceSchema = z.looseObject({ withBotId: z.string().min(1).max(512) });
const reactionSchema = z.looseObject({ by: z.string().min(1).max(512) });
/** The bot ids a serialized Message carries inside itself. */
const messageReferencesSchema = z.looseObject({
  from: botReferenceSchema.optional(),
  comm: commReferenceSchema.optional(),
  reactions: z.array(reactionSchema).max(LIMITS.maxMessages).optional(),
});

const botRecordsSchema = z.array(botRecordSchema).max(LIMITS.maxManifestEntries);
const groupRecordsSchema = z.array(groupRecordSchema).max(LIMITS.maxManifestEntries);

type BotRecords = z.infer<typeof botRecordsSchema>;
type GroupRecords = z.infer<typeof groupRecordsSchema>;
type MessageReferences = z.infer<typeof messageReferencesSchema>;

/** Everything a staged restore would write, decided before a byte is. */
interface StagedPlan {
  files: Array<{ path: string; body: Buffer }>;
  transcript: BundleTranscript;
  mapping: RestoreIdMapping[];
  reconsent: ReconsentEntry[];
  counts: StagedCounts;
  transcriptMethod: string;
  remappedIds: boolean;
}

type PlanOutcome = { ok: true; plan: StagedPlan } | { ok: false; blocked: RestoreBlocked[] };

/** Rewrite the bot ids a serialized Message carries inside itself: group
 * sender attribution (`from.botId`), comm chips (`comm.withBotId`) and
 * reactions (`reactions[].by`). A row that names no bot is returned as the
 * exact string the bundle held rather than a re-serialization, so a remap
 * only touches the rows that actually reference one. */
function remapMessageJson(json: string, botIds: ReadonlyMap<string, string>): string {
  if (botIds.size === 0) return json;
  let row: MessageReferences;
  try {
    const decoded = messageReferencesSchema.safeParse(JSON.parse(json));
    if (!decoded.success) return json;
    row = decoded.data;
  } catch {
    return json;
  }
  let changed = false;
  const from = row.from;
  if (from !== undefined) {
    const to = botIds.get(from.botId);
    if (to !== undefined) {
      from.botId = to;
      changed = true;
    }
  }
  const comm = row.comm;
  if (comm !== undefined) {
    const to = botIds.get(comm.withBotId);
    if (to !== undefined) {
      comm.withBotId = to;
      changed = true;
    }
  }
  for (const reaction of row.reactions ?? []) {
    const to = botIds.get(reaction.by);
    if (to !== undefined) {
      reaction.by = to;
      changed = true;
    }
  }
  return changed ? JSON.stringify(row) : json;
}

/** Bot records as this installation will hold them: a fresh id, a fresh thread
 * binding, and no grant or pointer that belonged to the other machine. Written
 * back with the store's own formatting (`JSON.stringify(bots, null, 2)`,
 * server/store.ts:566) so a restored file is the file the app would have
 * written. Returns null when the document is not a JSON array of records. */
function portBotRecords(
  text: string,
  botIds: ReadonlyMap<string, string>,
  threadIds: ReadonlyMap<string, string>,
): BotRecords | null {
  try {
    const decoded = botRecordsSchema.safeParse(JSON.parse(text));
    if (!decoded.success) return null;
    return decoded.data.map((record) => {
      const next = { ...record };
      for (const field of RESTORE_DROPPED_BOT_FIELDS) delete next[field];
      for (const field of RESTORE_DISABLED_BOT_FIELDS) next[field] = false;
      const id = botIds.get(record.id);
      if (id !== undefined) next.id = id;
      const threadId = record.threadId === undefined ? undefined : threadIds.get(record.threadId);
      if (threadId !== undefined) next.threadId = threadId;
      next.tasks = record.tasks?.map((task) => {
        const remapped = { ...task };
        for (const field of RESTORE_DROPPED_TASK_FIELDS) delete remapped[field];
        const mapped = task.threadId === undefined ? undefined : threadIds.get(task.threadId);
        if (mapped !== undefined) remapped.threadId = mapped;
        return remapped;
      });
      return next;
    });
  } catch {
    return null;
  }
}

/** Group records as this installation will hold them. Group ids are not bot
 * ids and are left alone; membership, the room's thread and the member a plain
 * message reaches all follow the remap, because a member list or a responder
 * pointing at ids that no longer exist is a room that cannot dispatch. */
function portGroupRecords(
  text: string,
  botIds: ReadonlyMap<string, string>,
  threadIds: ReadonlyMap<string, string>,
): GroupRecords | null {
  try {
    const decoded = groupRecordsSchema.safeParse(JSON.parse(text));
    if (!decoded.success) return null;
    return decoded.data.map((record) => {
      const next = { ...record };
      for (const field of RESTORE_DROPPED_GROUP_FIELDS) delete next[field];
      if (record.memberIds !== undefined) {
        next.memberIds = record.memberIds.map((member) => botIds.get(member) ?? member);
      }
      const threadId = record.threadId === undefined ? undefined : threadIds.get(record.threadId);
      if (threadId !== undefined) next.threadId = threadId;
      const responder = groupResponderSchema.safeParse(record.defaultResponder);
      if (responder.success) {
        const mapped = botIds.get(responder.data.botId);
        if (mapped !== undefined) next.defaultResponder = { ...responder.data, botId: mapped };
      }
      return next;
    });
  } catch {
    return null;
  }
}

/** Every way a payload can contradict itself, collected rather than
 * short-circuited. This runs before the staging directory exists, so a
 * refusal here has written nothing at all. */
function restorePayloadProblems(payload: BundlePayloadV2, stagingDir: string): RestoreBlocked[] {
  const blocked: RestoreBlocked[] = [];
  const decoded = bundlePayloadSchema.safeParse(payload);
  if (!decoded.success) {
    blocked.push({ path: "-", detail: "the payload does not match the v2 schema" });
    return blocked;
  }
  const data = decoded.data;
  if (data.files.length !== data.counts.files) {
    blocked.push({
      path: "-",
      detail: `the manifest holds ${data.files.length} files but declares ${data.counts.files}`,
    });
  }
  if (data.files.length > LIMITS.maxFiles || data.files.length > LIMITS.maxManifestEntries) {
    blocked.push({ path: "-", detail: `the manifest holds more than ${LIMITS.maxFiles} files` });
  }
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const file of data.files) {
    if (!isSafeRelativePath(file.path) || confinedTarget(stagingDir, file.path) === null) {
      blocked.push({ path: file.path, detail: "unsafe-path" });
      continue;
    }
    if (file.path === STAGED_TRANSCRIPT || file.path.startsWith(`${STAGED_TRANSCRIPT}-`)) {
      blocked.push({ path: file.path, detail: "the manifest claims a name that belongs to the transcript database" });
      continue;
    }
    if (file.path === RESTORE_MANIFEST) {
      blocked.push({ path: file.path, detail: "the manifest claims the path the restore writes its own manifest to" });
      continue;
    }
    if (seenPaths.has(file.path)) {
      blocked.push({ path: file.path, detail: "duplicate manifest path" });
      continue;
    }
    seenPaths.add(file.path);
    totalBytes += file.size;
    if (file.size > LIMITS.maxFileBytes) {
      blocked.push({ path: file.path, detail: `above the ${LIMITS.maxFileBytes}-byte per-file limit` });
      continue;
    }
    const body = decodeBase64(file.bodyB64);
    if (body === null || body.byteLength !== file.size) {
      blocked.push({
        path: file.path,
        detail: body === null ? "the body cannot be decoded" : "the body is not the length it declares",
      });
      continue;
    }
    if (sha256Hex(body) !== file.sha256) {
      blocked.push({ path: file.path, detail: "the body does not match the hash recorded for it" });
    }
  }
  if (data.counts.totalBytes > LIMITS.maxTotalBytes) {
    blocked.push({ path: "-", detail: `the files declare more than ${LIMITS.maxTotalBytes} bytes` });
  } else if (totalBytes !== data.counts.totalBytes) {
    blocked.push({
      path: "-",
      detail: `the files total ${totalBytes} bytes but the payload declares ${data.counts.totalBytes}`,
    });
  }
  if (manifestDigest(data.files) !== data.manifestSha256) {
    blocked.push({ path: "-", detail: "the manifest does not match its recorded digest" });
  }
  const threads = data.transcripts.threads;
  const messages = threads.reduce((total, thread) => total + thread.messages.length, 0);
  if (threads.length !== data.transcripts.counts.threads) {
    blocked.push({
      path: "-",
      detail: `the transcript holds ${threads.length} threads but declares ${data.transcripts.counts.threads}`,
    });
  }
  if (messages !== data.transcripts.counts.messages) {
    blocked.push({
      path: "-",
      detail: `the transcript holds ${messages} messages but declares ${data.transcripts.counts.messages}`,
    });
  }
  if (data.counts.threads !== threads.length || data.counts.messages !== messages) {
    blocked.push({ path: "-", detail: "the payload counts do not match the transcript's rows" });
  }
  if (threads.length > LIMITS.maxManifestEntries) {
    blocked.push({ path: "-", detail: `the transcript holds more than ${LIMITS.maxManifestEntries} threads` });
  }
  if (messages > LIMITS.maxMessages) {
    blocked.push({ path: "-", detail: `the transcript holds more than ${LIMITS.maxMessages} messages` });
  }
  const seenThreads = new Set<string>();
  for (const thread of threads) {
    if (seenThreads.has(thread.threadId)) {
      blocked.push({ path: thread.threadId, detail: "duplicate thread id" });
      continue;
    }
    seenThreads.add(thread.threadId);
    const ids = new Set<string>();
    for (const message of thread.messages) {
      if (ids.has(message.id)) {
        blocked.push({ path: `${thread.threadId}/${message.id}`, detail: "duplicate message id in its thread" });
        continue;
      }
      ids.add(message.id);
    }
    if (thread.activeLeafId !== null && !ids.has(thread.activeLeafId)) {
      blocked.push({
        path: thread.threadId,
        detail: `the recorded branch head ${thread.activeLeafId} is not among the messages`,
      });
    }
  }
  return blocked;
}

/** Decide every byte a stage would write, and every id it would issue, without
 * touching the filesystem. Refusals here leave nothing behind because nothing
 * has been created yet. */
function buildStagedPlan(
  payload: BundlePayloadV2,
  stagingDir: string,
  remapIds: boolean,
  includeTranscript: boolean,
): PlanOutcome {
  const blocked = restorePayloadProblems(payload, stagingDir);
  if (blocked.length > 0) return { ok: false, blocked };
  const botsFile = payload.files.find((file) => file.path === BOTS_FILE_NAME);
  const groupsFile = payload.files.find((file) => file.path === GROUPS_FILE_NAME);
  const botIds = new Set<string>();
  for (const file of payload.files) {
    if (!file.path.startsWith(WORKSPACES_PREFIX)) continue;
    const botId = file.path.split("/")[1];
    if (botId !== undefined && botId.length > 0) botIds.add(botId);
  }
  let botRecords: BotRecords | null = null;
  if (botsFile !== undefined) {
    const body = decodeBase64(botsFile.bodyB64);
    if (body === null) return { ok: false, blocked: [{ path: BOTS_FILE_NAME, detail: "the body cannot be decoded" }] };
    botRecords = portBotRecords(body.toString("utf8"), new Map<string, string>(), new Map<string, string>());
    if (botRecords === null) {
      return {
        ok: false,
        blocked: [{ path: BOTS_FILE_NAME, detail: "the bot store is not a JSON array of bot records" }],
      };
    }
    for (const record of botRecords) botIds.add(record.id);
  }
  let groupsText: string | null = null;
  if (groupsFile !== undefined) {
    const body = decodeBase64(groupsFile.bodyB64);
    if (body === null) return { ok: false, blocked: [{ path: GROUPS_FILE_NAME, detail: "the body cannot be decoded" }] };
    groupsText = body.toString("utf8");
    if (portGroupRecords(groupsText, new Map<string, string>(), new Map<string, string>()) === null) {
      return {
        ok: false,
        blocked: [{ path: GROUPS_FILE_NAME, detail: "the group store is not a JSON array of group records" }],
      };
    }
  }
  const botIdMap = new Map<string, string>();
  const mapping: RestoreIdMapping[] = [];
  for (const from of [...botIds].sort()) {
    const to = remapIds ? randomUUID() : from;
    botIdMap.set(from, to);
    if (remapIds) mapping.push({ kind: "bot", from, to });
  }
  const threadIdMap = new Map<string, string>();
  if (includeTranscript) {
    for (const thread of payload.transcripts.threads) {
      const to = remapIds ? randomUUID() : thread.threadId;
      threadIdMap.set(thread.threadId, to);
      if (remapIds) mapping.push({ kind: "thread", from: thread.threadId, to });
    }
  }
  const reconsent: ReconsentEntry[] = [...botIds].sort().map((botId) => ({
    botId,
    restoredId: botIdMap.get(botId) ?? botId,
    reason: remapIds
      ? "permissions and connection grants do not travel in a bundle, and this bot was restored under a fresh id"
      : "permissions and connection grants do not travel in a bundle",
  }));
  const files: Array<{ path: string; body: Buffer }> = [];
  for (const file of payload.files) {
    const body = decodeBase64(file.bodyB64);
    if (body === null) return { ok: false, blocked: [{ path: file.path, detail: "the body cannot be decoded" }] };
    const segments = file.path.split("/");
    const botDir = segments[1];
    const mapped = botDir === undefined ? undefined : botIdMap.get(botDir);
    const stagedPath =
      segments[0] === "workspaces" && mapped !== undefined
        ? [segments[0], mapped, ...segments.slice(2)].join("/")
        : file.path;
    let staged = body;
    if (file.path === BOTS_FILE_NAME && botRecords !== null) {
      const ported = portBotRecords(body.toString("utf8"), botIdMap, threadIdMap) ?? botRecords;
      staged = Buffer.from(JSON.stringify(ported, null, 2), "utf8");
    } else if (file.path === GROUPS_FILE_NAME && groupsText !== null) {
      const ported = portGroupRecords(groupsText, botIdMap, threadIdMap);
      if (ported !== null) staged = Buffer.from(JSON.stringify(ported, null, 2), "utf8");
    }
    files.push({ path: stagedPath, body: staged });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const transcript: BundleTranscript = includeTranscript
    ? {
        method: payload.transcripts.method,
        threads: payload.transcripts.threads.map((thread) => ({
          threadId: threadIdMap.get(thread.threadId) ?? thread.threadId,
          activeLeafId: thread.activeLeafId,
          messages: thread.messages.map((message) =>
            remapIds ? { ...message, json: remapMessageJson(message.json, botIdMap) } : message,
          ),
        })),
        counts: { ...payload.transcripts.counts },
      }
    : { method: payload.transcripts.method, threads: [], counts: { threads: 0, messages: 0 } };
  const messages = transcript.threads.reduce((total, thread) => total + thread.messages.length, 0);
  return {
    ok: true,
    plan: {
      files,
      transcript,
      mapping,
      reconsent,
      counts: {
        files: files.length + (includeTranscript ? 1 : 0),
        messages,
        threads: transcript.threads.length,
        bots: botIds.size,
        bytes: files.reduce((total, file) => total + file.body.byteLength, 0),
      },
      transcriptMethod: payload.transcripts.method,
      remappedIds: remapIds,
    },
  };
}

/** Rebuild the transcript as a new database.
 *
 * The three statements below are the declaration from
 * server/message-db.ts:39-55, character for character — a staged database with
 * its own idea of the schema is one the app has to repair on first open. WAL
 * is deliberately not set here: the app turns it on when it opens the file
 * (message-db.ts:37), and a staged database with a `-wal` beside it would be a
 * second file to carry for no gain.
 *
 * Rows are inserted in the order the bundle recorded (`seq`, the source
 * rowid), and every value is bound, never interpolated. `thread_state` is
 * written from the payload's own head rather than inferred from the last row
 * inserted: a branch whose newest row is not its head must come back with the
 * head it had. */
function writeStagedTranscript(dbPath: string, transcript: BundleTranscript): void {
  // owner-only, on creation and on a file that predates it — transcripts are
  // private conversations (server/message-db.ts:30-35)
  closeSync(openSync(dbPath, "a", 0o600));
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    /* best effort, as in the live store */
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id))",
    );
    db.exec("CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id)");
    db.exec("CREATE TABLE IF NOT EXISTS thread_state (thread_id TEXT PRIMARY KEY, active_leaf_id TEXT)");
    const insert = db.prepare(
      "INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const state = db.prepare("INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?)");
    db.exec("BEGIN");
    try {
      for (const thread of transcript.threads) {
        const rows = [...thread.messages].sort((a, b) => a.seq - b.seq);
        for (const message of rows) {
          insert.run(thread.threadId, message.id, message.at, message.role, message.kind, message.text, message.json);
        }
        state.run(thread.threadId, thread.activeLeafId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export interface StageRestoreV2Options {
  stagingDir: string;
  /** Issue fresh bot and thread ids (default), or keep the bundle's. Grants
   * and connection switches are dropped either way. */
  remapIds?: boolean;
  /** Restore only these categories (§12). Absent, or all of them, stages the
   * full bundle — byte for byte the stage of today. */
  categories?: readonly RestoreCategory[];
  /** Test seam, called before each step. A throw cleans the staging tree up
   * and returns `failed`; nothing outside `stagingDir` is touched. */
  onStage?: (event: RestoreEvent) => void;
}

export interface StagedRestoreResult {
  status: "staged" | "refused" | "failed";
  stagingDir: string;
  blocked: RestoreBlocked[];
  mapping: RestoreIdMapping[];
  reconsentRequired: ReconsentEntry[];
  /** the staged relative paths, the transcript included */
  files: string[];
  counts?: StagedCounts;
  error?: string;
}

/** Write a complete, hashed copy of a payload into `stagingDir`.
 *
 * This never reads or writes a live installation. The caller names a directory
 * that must be absent or empty and everything lands inside it: the payload is
 * validated in full first — schema, every path, the declared counts, every
 * manifest hash, every limit — and a payload that fails any of that returns
 * `refused` with nothing written, not even the directory. Each file is written
 * temp-then-rename, so a reader never sees a half-written one. */
export function stageRestoreV2(payload: BundlePayloadV2, options: StageRestoreV2Options): StagedRestoreResult {
  const stagingDir = resolve(options.stagingDir);
  const remapIds = options.remapIds ?? true;
  const report = options.onStage ?? (() => {});
  const refuse = (blocked: RestoreBlocked[]): StagedRestoreResult => ({
    status: "refused",
    stagingDir,
    blocked,
    mapping: [],
    reconsentRequired: [],
    files: [],
  });
  const projection: { ok: true; value: ProjectedRestore } | { ok: false; error: string } =
    options.categories === undefined
      ? { ok: true, value: { payload, includeTranscript: true } }
      : projectCategories(payload, options.categories);
  if (!projection.ok) return refuse([{ path: "-", detail: projection.error }]);
  const plannedPayload = projection.value.payload;
  const includeTranscript = projection.value.includeTranscript;
  const existing = lstatOrNull(stagingDir);
  if (existing !== null) {
    if (!existing.isDirectory()) {
      return refuse([{ path: stagingDir, detail: "the staging path exists and is not a directory" }]);
    }
    let occupied: string[];
    try {
      occupied = readdirSync(stagingDir);
    } catch (error) {
      return refuse([
        {
          path: stagingDir,
          detail: `the staging directory could not be read (${error instanceof Error ? error.message : String(error)})`,
        },
      ]);
    }
    if (occupied.length > 0) {
      return refuse([{ path: stagingDir, detail: "the staging directory exists and is not empty" }]);
    }
  }
  const outcome = buildStagedPlan(plannedPayload, stagingDir, remapIds, includeTranscript);
  if (!outcome.ok) return refuse(outcome.blocked);
  const plan = outcome.plan;
  const files: string[] = [];
  let stagedCounts: StagedCounts = plan.counts;
  try {
    report({ step: "validate" });
    mkdirSync(stagingDir, { recursive: true });
    report({ step: "staging-dir", path: stagingDir });
    for (const file of plan.files) {
      report({ step: "file", path: file.path });
      const target = confinedTarget(stagingDir, file.path);
      if (target === null) throw new Error(`${file.path} is not a safe relative path`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileAtomic(target, file.body);
      files.push(file.path);
    }
    const entries: Array<{ path: string; sha256: string; size: number }> = plan.files.map((file) => ({
      path: file.path,
      sha256: sha256Hex(file.body),
      size: file.body.byteLength,
    }));
    if (includeTranscript) {
      report({ step: "transcript", path: STAGED_TRANSCRIPT });
      const transcriptPath = join(stagingDir, STAGED_TRANSCRIPT);
      writeStagedTranscript(transcriptPath, plan.transcript);
      const transcriptBody = readFileSync(transcriptPath);
      entries.push({
        path: STAGED_TRANSCRIPT,
        sha256: sha256Hex(transcriptBody),
        size: transcriptBody.byteLength,
      });
      files.push(STAGED_TRANSCRIPT);
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    // the counts describe the staging tree that now exists, the transcript
    // counted only when it was staged: a `files` that counted it beside a
    // `bytes` that did not would be two different claims about one directory
    const counts: StagedCounts = {
      files: entries.length,
      messages: plan.counts.messages,
      threads: plan.counts.threads,
      bots: plan.counts.bots,
      bytes: entries.reduce((total, entry) => total + entry.size, 0),
    };
    stagedCounts = counts;
    const manifest: StagingManifest = {
      format: RESTORE_FORMAT,
      schema: BUNDLE_SCHEMA,
      stagedAt: Date.now(),
      appVersion: payload.appVersion,
      transcriptMethod: plan.transcriptMethod,
      remappedIds: plan.remappedIds,
      counts,
      files: entries,
    };
    report({ step: "manifest", path: RESTORE_MANIFEST });
    writeFileAtomic(join(stagingDir, RESTORE_MANIFEST), JSON.stringify(manifest));
  } catch (error) {
    // whatever went wrong, the staging tree is this call's own work: it did
    // not exist, or was empty, when the call started
    const reason = error instanceof Error ? error.message : String(error);
    let cleanupFailure: string | null = null;
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // say so rather than reporting a clean failure over a tree that is still
      // on disk
      cleanupFailure = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    }
    const failed: StagedRestoreResult = {
      status: "failed",
      stagingDir,
      blocked: [],
      mapping: plan.mapping,
      reconsentRequired: plan.reconsent,
      files: [],
      error:
        cleanupFailure === null
          ? reason
          : `${reason}; the staging directory could not be removed (${cleanupFailure})`,
    };
    return failed;
  }
  return {
    status: "staged",
    stagingDir,
    blocked: [],
    mapping: plan.mapping,
    reconsentRequired: plan.reconsent,
    files,
    counts: stagedCounts,
  };
}
// ---------------------------------------------------------------------------
// Restore — commit
// ---------------------------------------------------------------------------

export interface CommitRestoreV2Options {
  stagingDir: string;
  dataDir: string;
  backupDir: string;
  /** explicit and literal: a restore into a live installation is never
   * something a caller does by accident */
  confirm: boolean;
  /** Test seam, called before each step. A throw rolls the commit back. */
  onCommit?: (event: RestoreEvent) => void;
}

export interface CommitRestoreResult {
  status: "committed" | "rolled-back" | "refused";
  /** the covered relative paths that existed and were moved into `backupDir` */
  moved: string[];
  /** the covered relative paths written into the data directory */
  written: string[];
  backupDir: string;
  blocked: RestoreBlocked[];
  error?: string;
  /** populated only when a rollback step itself failed; a `rolled-back` result
   * with entries here did not fully restore the tree */
  rollbackFailures?: string[];
}

/** Whether `child` is `parent` or sits inside it, judged on the paths the
 * filesystem actually holds rather than on the strings the caller passed.
 * `resolve` alone cannot tell that `/tmp` and `/private/tmp` are one directory,
 * so a guard built on it can be walked around by spelling one of the two the
 * long way — and the guard that stops a backup directory being created inside
 * the live tree is exactly that kind of guard. */
function containsPath(parent: string, child: string): boolean {
  return containedIn(realPath(child), realPath(parent));
}

/** Whether an already-resolved `target` is `root` or sits inside it. */
function containedIn(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** The real path of `path`, with every component that exists resolved through
 * its links. For a path that does not exist yet, the deepest existing ancestor
 * is resolved and the missing segments are re-appended, so a directory that is
 * about to be created is still compared against where it will really land. */
function realPath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : join(real, ...[...missing].reverse());
    } catch {
      const parent = dirname(current);
      // nothing on this path exists, or the walk reached a broken link at the
      // root: fall back to the string form rather than looping forever
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** The home directory, or null when the process has no usable HOME. */
function homeDir(): string | null {
  try {
    return resolve(homedir());
  } catch {
    return null;
  }
}

/** Create `dir` and its missing parents, recording only the directories this
 * call brought into being — a rollback removes those and nothing else. */
function ensureDirectory(dir: string, created: string[]): void {
  const missing: string[] = [];
  let current = resolve(dir);
  for (;;) {
    if (existsSync(current)) break;
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (missing.length === 0) return;
  mkdirSync(dir, { recursive: true });
  created.push(...missing);
}

/** Move a file, falling back to copy-then-unlink when the two paths are on
 * different filesystems (rename cannot cross one). The copy is verified
 * against the source before the original is unlinked, so a failed move leaves
 * the original where it was. */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    const crossDevice = error instanceof Error && "code" in error && error.code === "EXDEV";
    if (!crossDevice) throw error;
    copyFileSync(from, to);
    if (sha256Hex(readFileSync(to)) !== sha256Hex(readFileSync(from))) {
      try {
        unlinkSync(to);
      } catch {
        /* the original is still in place, which is what matters */
      }
      throw new Error(`moving ${from} across filesystems produced a different file`);
    }
    unlinkSync(from);
  }
}

function parseStagingManifest(text: string): StagingManifest | null {
  try {
    const decoded = stagingManifestSchema.safeParse(JSON.parse(text));
    return decoded.success ? decoded.data : null;
  } catch {
    return null;
  }
}

interface StagedEntry {
  path: string;
  body: Buffer;
  mode: number;
}

type PreflightOutcome = { ok: true; entries: StagedEntry[] } | { ok: false; blocked: RestoreBlocked[] };

/** Everything that must be true before a single live path is touched: the
 * staging manifest is readable and unconsumed, every staged file matches the
 * hash and size recorded for it, every covered path is safe, and no covered
 * path is something this overlay could not put back. */
function preflightCommit(stagingDir: string, dataDir: string): PreflightOutcome {
  const manifestPath = join(stagingDir, RESTORE_MANIFEST);
  const blocked: RestoreBlocked[] = [];
  const raw = lstatOrNull(manifestPath);
  if (raw === null || !raw.isFile()) {
    return { ok: false, blocked: [{ path: RESTORE_MANIFEST, detail: "the staging tree carries no staging manifest" }] };
  }
  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      blocked: [
        {
          path: RESTORE_MANIFEST,
          detail: `the staging manifest could not be read (${error instanceof Error ? error.message : String(error)})`,
        },
      ],
    };
  }
  const decoded = parseStagingManifest(manifestText);
  if (decoded === null) {
    return { ok: false, blocked: [{ path: RESTORE_MANIFEST, detail: "the staging manifest is not readable" }] };
  }
  if (decoded.consumedAt !== undefined) {
    return {
      ok: false,
      blocked: [{ path: RESTORE_MANIFEST, detail: "the staging manifest was already consumed by an earlier commit" }],
    };
  }
  const entries: StagedEntry[] = [];
  const seen = new Set<string>();
  const rootReal = realPath(dataDir);
  const stagingReal = realPath(stagingDir);
  for (const entry of decoded.files) {
    const stagedPath = isSafeRelativePath(entry.path) ? confinedTarget(stagingDir, entry.path) : null;
    const live = isSafeRelativePath(entry.path) ? confinedTarget(dataDir, entry.path) : null;
    if (stagedPath === null || live === null) {
      blocked.push({ path: entry.path, detail: "unsafe-path" });
      continue;
    }
    if (seen.has(entry.path)) {
      blocked.push({ path: entry.path, detail: "duplicate staging manifest path" });
      continue;
    }
    seen.add(entry.path);
    // the path string is confined, but a link on it is not: a directory that
    // sits under the root by name can still point out of the tree, and the
    // move and the write would both follow it
    if (!containedIn(realPath(dirname(stagedPath)), stagingReal)) {
      blocked.push({ path: entry.path, detail: "a directory on this path is a link out of the staging tree" });
      continue;
    }
    if (!containedIn(realPath(dirname(live)), rootReal)) {
      blocked.push({ path: entry.path, detail: "a directory on this path is a link out of the data directory" });
      continue;
    }
    const info = lstatOrNull(stagedPath);
    if (info === null || !info.isFile()) {
      blocked.push({ path: entry.path, detail: "the staging tree does not hold this file" });
      continue;
    }
    const body = readFileSync(stagedPath);
    if (body.byteLength !== entry.size || sha256Hex(body) !== entry.sha256) {
      blocked.push({ path: entry.path, detail: "the staged file does not match the staging manifest" });
      continue;
    }
    for (const sidecar of ["-wal", "-shm", "-journal"]) {
      if (existsSync(`${live}${sidecar}`)) {
        blocked.push({
          path: entry.path,
          detail: `a ${sidecar} sidecar sits beside this path, so the live database is not checkpointed`,
        });
      }
    }
    const liveInfo = lstatOrNull(live);
    if (liveInfo !== null && !liveInfo.isFile()) {
      blocked.push({ path: entry.path, detail: "the live path exists and is not a regular file" });
    }
    entries.push({ path: entry.path, body, mode: info.mode & 0o777 });
  }
  if (entries.length === 0 && blocked.length === 0) {
    blocked.push({ path: "-", detail: "the staging manifest lists no files" });
  }
  if (blocked.length > 0) return { ok: false, blocked };
  return { ok: true, entries };
}

interface RollbackInput {
  dataDir: string;
  backupDir: string;
  moved: string[];
  written: string[];
  createdDirs: string[];
}

/** Put a rolled-back tree back the way it was.
 *
 * Files moved into `backupDir` are *copied* back, not moved back: the backup
 * is the owner's pre-restore copy and stays where it is. Files this commit
 * created where nothing existed are removed, and the directories it created go
 * too if they are empty. Returns one line per step that itself failed; an
 * empty list is the claim that the tree is byte-identical to what it was. */
function rollbackCommit(input: RollbackInput): string[] {
  const failures: string[] = [];
  for (const path of input.written) {
    if (input.moved.includes(path)) continue;
    const target = confinedTarget(input.dataDir, path);
    if (target === null) {
      failures.push(`${path}: not a safe relative path`);
      continue;
    }
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch (error) {
      failures.push(`${path}: could not be removed again (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  for (const path of input.moved) {
    const backup = confinedTarget(input.backupDir, path);
    const target = confinedTarget(input.dataDir, path);
    if (backup === null || target === null) {
      failures.push(`${path}: not a safe relative path`);
      continue;
    }
    try {
      const expected = sha256Hex(readFileSync(backup));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(backup, target);
      chmodSync(target, statSync(backup).mode & 0o777);
      if (sha256Hex(readFileSync(target)) !== expected) {
        failures.push(`${path}: the restored file does not match the backup`);
      }
    } catch (error) {
      failures.push(`${path}: could not be restored (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  // deepest first, not most-recent first: `ensureDirectory` records a whole
  // missing chain, and removing a parent before its child leaves the parent
  // behind because the child still makes it non-empty
  const deepestFirst = [...input.createdDirs].sort(
    (a, b) => b.split(sep).length - a.split(sep).length,
  );
  for (const dir of deepestFirst) {
    try {
      rmdirSync(dir);
    } catch {
      /* not empty, or not ours to remove: both are fine */
    }
  }
  return failures;
}

/** Overlay a staged restore onto a live installation.
 *
 * This is the only function in this module that may write into a live tree, so
 * its guards are as much the deliverable as its happy path. It moves the
 * current version of exactly the paths the staging manifest covers into
 * `backupDir`, preserving their relative structure, then writes the staged
 * files into `dataDir` through `writeFileAtomic`. Anything the bundle does not
 * cover — `config.json`, `auth.secret`, attachments, everything else — is left
 * exactly as it was: this replaces the paths it covers and preserves the rest.
 *
 * Every step is inside one try: if any of them throws, the moved paths are
 * restored, the files this commit newly created are removed, and the result is
 * `rolled-back` with the reason. After a rollback the live directory is
 * byte-identical to what it was. `backupDir` is never deleted — it is the
 * owner's pre-restore copy and it stays.
 *
 * The covered paths are expected to be at rest. A `messages.db` with a
 * `-wal`/`-shm`/`-journal` sidecar is refused rather than moved, because
 * moving the database alone would drop transactions that have not been
 * checkpointed. */
export function commitRestoreV2(options: CommitRestoreV2Options): CommitRestoreResult {
  const stagingDir = resolve(options.stagingDir);
  const dataDir = resolve(options.dataDir);
  const backupDir = resolve(options.backupDir);
  const report = options.onCommit ?? (() => {});
  const refuse = (blocked: RestoreBlocked[]): CommitRestoreResult => ({
    status: "refused",
    moved: [],
    written: [],
    backupDir,
    blocked,
  });
  if (options.confirm !== true) {
    return refuse([{ path: "-", detail: "a restore into a live installation requires confirm: true" }]);
  }
  if (containsPath(dataDir, stagingDir)) {
    return refuse([{ path: stagingDir, detail: "the staging directory is the data directory or sits inside it" }]);
  }
  if (containsPath(dataDir, backupDir)) {
    return refuse([{ path: backupDir, detail: "the backup directory is the data directory or sits inside it" }]);
  }
  if (containsPath(backupDir, dataDir)) {
    return refuse([{ path: dataDir, detail: "the data directory sits inside the backup directory" }]);
  }
  if (existsSync(backupDir)) {
    return refuse([{ path: backupDir, detail: "the backup directory already exists" }]);
  }
  const dataInfo = lstatOrNull(dataDir);
  if (dataInfo === null) {
    return refuse([{ path: dataDir, detail: "the data directory does not exist" }]);
  }
  if (!dataInfo.isDirectory()) {
    return refuse([{ path: dataDir, detail: "the data directory is not a directory" }]);
  }
  if (dataDir === parse(dataDir).root) {
    return refuse([{ path: dataDir, detail: "the data directory is the filesystem root" }]);
  }
  const home = homeDir();
  if (home !== null && realPath(dataDir) === realPath(home)) {
    return refuse([{ path: dataDir, detail: "the data directory is the home directory itself" }]);
  }
  const stagingInfo = lstatOrNull(stagingDir);
  if (stagingInfo === null) {
    return refuse([{ path: stagingDir, detail: "the staging directory does not exist" }]);
  }
  if (!stagingInfo.isDirectory()) {
    return refuse([{ path: stagingDir, detail: "the staging path is not a directory" }]);
  }
  let stagedNames: string[];
  try {
    stagedNames = readdirSync(stagingDir);
  } catch (error) {
    return refuse([
      {
        path: stagingDir,
        detail: `the staging directory could not be read (${error instanceof Error ? error.message : String(error)})`,
      },
    ]);
  }
  if (stagedNames.length === 0) {
    return refuse([{ path: stagingDir, detail: "the staging directory is empty" }]);
  }
  const preflight = preflightCommit(stagingDir, dataDir);
  if (!preflight.ok) return refuse(preflight.blocked);
  const moved: string[] = [];
  const written: string[] = [];
  const createdDirs: string[] = [];
  try {
    for (const entry of preflight.entries) {
      const live = confinedTarget(dataDir, entry.path);
      if (live === null || !existsSync(live)) continue;
      report({ step: "move", path: entry.path });
      ensureDirectory(dirname(join(backupDir, ...entry.path.split("/"))), []);
      moveFile(live, join(backupDir, ...entry.path.split("/")));
      moved.push(entry.path);
    }
    for (const entry of preflight.entries) {
      const target = confinedTarget(dataDir, entry.path);
      if (target === null) throw new Error(`${entry.path} is not a safe relative path`);
      report({ step: "write", path: entry.path });
      ensureDirectory(dirname(target), createdDirs);
      writeFileAtomic(target, entry.body, { mode: entry.mode });
      written.push(entry.path);
    }
    report({ step: "consume", path: RESTORE_MANIFEST });
    const manifest = parseStagingManifest(readFileSync(join(stagingDir, RESTORE_MANIFEST), "utf8"));
    if (manifest === null) throw new Error("the staging manifest disappeared during the commit");
    writeFileAtomic(join(stagingDir, RESTORE_MANIFEST), JSON.stringify({ ...manifest, consumedAt: Date.now() }));
  } catch (error) {
    const rollbackFailures = rollbackCommit({ dataDir, backupDir, moved, written, createdDirs });
    const result: CommitRestoreResult = {
      status: "rolled-back",
      moved,
      written,
      backupDir,
      blocked: [],
      error: error instanceof Error ? error.message : String(error),
    };
    if (rollbackFailures.length > 0) result.rollbackFailures = rollbackFailures;
    return result;
  }
  return { status: "committed", moved, written, backupDir, blocked: [] };
}

// ---------------------------------------------------------------------------
// Restore — decrypt, verify, stage, commit
// ---------------------------------------------------------------------------

export interface RestoreBundleV2Options {
  passphrase: string;
  stagingDir: string;
  dataDir: string;
  backupDir: string;
  confirm: boolean;
  remapIds?: boolean;
  /** Restore only these categories (§12); absent is the full restore. */
  categories?: readonly RestoreCategory[];
  onStage?: (event: RestoreEvent) => void;
  onCommit?: (event: RestoreEvent) => void;
}

export interface RestoreBundleV2Result {
  status: "committed" | "rolled-back" | "refused" | "failed";
  /** the stage this run stopped at; `done` means the commit ran and succeeded,
   * `commit` means it ran and rolled back or refused */
  stoppedAt: "decrypt" | "verify" | "stage" | "commit" | "done";
  decrypt: DecryptBundleV2Result;
  verify?: VerifyBundleV2Result;
  staged?: StagedRestoreResult;
  commit?: CommitRestoreResult;
  error?: string;
}

/** The whole restore as one call: decrypt, verify, stage, commit.
 *
 * It exists so that a caller cannot wire the four in the wrong order or forget
 * one. Every stage's own result is returned, so a caller can see where the run
 * stopped. A run that stops before the commit has not entered a write path:
 * `dataDir` is untouched, not "restored". */
export function restoreBundleV2(bytes: Buffer, options: RestoreBundleV2Options): RestoreBundleV2Result {
  const decrypt = decryptBundleV2(bytes, { passphrase: options.passphrase });
  if (decrypt.status !== "ok" || decrypt.payload === undefined) {
    const result: RestoreBundleV2Result = { status: "refused", stoppedAt: "decrypt", decrypt };
    if (decrypt.error !== undefined) result.error = decrypt.error;
    return result;
  }
  const verify = verifyBundleV2(bytes, { passphrase: options.passphrase });
  if (verify.status !== "ok") {
    return {
      status: "refused",
      stoppedAt: "verify",
      decrypt,
      verify,
      error: `the bundle did not verify: ${verify.status}`,
    };
  }
  const stageOptions: StageRestoreV2Options = { stagingDir: options.stagingDir };
  if (options.remapIds !== undefined) stageOptions.remapIds = options.remapIds;
  if (options.categories !== undefined) stageOptions.categories = options.categories;
  if (options.onStage !== undefined) stageOptions.onStage = options.onStage;
  const staged = stageRestoreV2(decrypt.payload, stageOptions);
  if (staged.status !== "staged") {
    const result: RestoreBundleV2Result = {
      // a stage that was refused and a stage that broke are different facts
      status: staged.status === "failed" ? "failed" : "refused",
      stoppedAt: "stage",
      decrypt,
      verify,
      staged,
    };
    if (staged.error !== undefined) result.error = staged.error;
    return result;
  }
  const commitOptions: CommitRestoreV2Options = {
    stagingDir: options.stagingDir,
    dataDir: options.dataDir,
    backupDir: options.backupDir,
    confirm: options.confirm,
  };
  if (options.onCommit !== undefined) commitOptions.onCommit = options.onCommit;
  const commit = commitRestoreV2(commitOptions);
  const result: RestoreBundleV2Result = {
    status: commit.status === "committed" ? "committed" : "refused",
    stoppedAt: commit.status === "committed" ? "done" : "commit",
    decrypt,
    verify,
    staged,
    commit,
  };
  if (commit.status === "rolled-back") result.status = "rolled-back";
  if (commit.error !== undefined) result.error = commit.error;
  return result;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

export interface BundleSelfTest {
  canonicalJsonStable: boolean;
  pathSafetyAccepts: boolean;
  pathSafetyRejects: boolean;
  limitsDeclared: boolean;
}

/** Four properties this module's correctness rests on, checked at runtime.
 * Cheap, pure, no I/O — the point is that a caller can assert the invariants
 * it depends on without exporting the internals. */
export function selftest(): BundleSelfTest {
  const header = (overrides: Partial<BundleEnvelope>): BundleEnvelope => ({
    magic: BUNDLE_MAGIC,
    schema: BUNDLE_SCHEMA,
    createdAt: 1_760_000_000_000,
    producer: BUNDLE_PRODUCER,
    kdf: { name: "scrypt", N: DEFAULT_KDF.N, r: DEFAULT_KDF.r, p: DEFAULT_KDF.p, keyLen: DEFAULT_KDF.keyLen, saltB64: "AAAA" },
    cipher: { name: "aes-256-gcm", ivB64: "AAAA", tagB64: "AAAA" },
    encoding: "gzip+json",
    counts: { files: 0, messages: 0, threads: 0, totalBytes: 0 },
    payloadSha256: "0".repeat(64),
    ciphertextB64: "AAAA",
    ...overrides,
  });
  const left = header({});
  const right = header({ ciphertextB64: "BBBB", cipher: { name: "aes-256-gcm", ivB64: "AAAA", tagB64: "BBBB" } });
  const stableAcrossExcludedFields = canonicalHeader(left) === canonicalHeader(right);
  const stableAcrossEdits = canonicalHeader(left) !== canonicalHeader({ ...left, counts: { files: 0, messages: 1, threads: 0, totalBytes: 0 } });
  const canonicalJsonStable = stableAcrossExcludedFields && stableAcrossEdits;
  const pathSafetyAccepts =
    isSafeRelativePath("bots.json") &&
    isSafeRelativePath("MEMORY.md") &&
    isSafeRelativePath("memory/topic.md") &&
    isSafeRelativePath("workspaces/bot-1/memory/topic.md");
  const pathSafetyRejects =
    !isSafeRelativePath("../auth.secret") &&
    !isSafeRelativePath("memory/../../auth.secret") &&
    !isSafeRelativePath("/etc/passwd") &&
    !isSafeRelativePath("workspaces\\bot-1") &&
    !isSafeRelativePath("./bots.json") &&
    !isSafeRelativePath("memory//topic.md") &&
    !isSafeRelativePath("");
  const limitsDeclared =
    LIMITS.maxFiles === 4096 &&
    LIMITS.maxFileBytes === 33_554_432 &&
    LIMITS.maxTotalBytes === 268_435_456 &&
    LIMITS.maxManifestEntries === 4096 &&
    LIMITS.maxMessages === 200_000 &&
    LIMITS.maxBundleBytes === 536_870_912 &&
    LIMITS.maxInflatedBytes === 536_870_912;
  return { canonicalJsonStable, pathSafetyAccepts, pathSafetyRejects, limitsDeclared };
}
