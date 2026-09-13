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
// THERE IS DELIBERATELY NO RESTORE WRITER HERE. `planRestoreV2` is a dry run
// that reports what a restore would do and writes nothing — not one byte, and
// it will not even open the target database, because opening a WAL database
// can create `-shm`/`-wal` sidecars. The staged, all-or-nothing transactional
// restore (write to a staging tree, verify, swap, roll back on any failure) is
// the next slice of the contract in
// docs/plans/portable-backup-contract-2026-09-12.md. Nothing in this module
// is wired into a route: it is inert until that slice lands.

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";

import { z } from "zod";

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
const BUNDLE_SCHEMA = 2;
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

const bundleEnvelopeSchema = z.object({
  magic: z.literal(BUNDLE_MAGIC),
  // deliberately not a literal: an envelope from a newer producer must be
  // readable enough to report its version, not least because reporting it
  // requires no key at all
  schema: z.number().int(),
  createdAt: z.number().int(),
  producer: z.string().min(1).max(128),
  kdf: bundleKdfSchema,
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
function manifestDigest(files: readonly BundleFileEntry[]): string {
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

// ---------------------------------------------------------------------------
// Export — build the payload
// ---------------------------------------------------------------------------

const SUBSET_ROOT_FILES = new Set(["bots.json", "groups.json", "MEMORY.md"]);

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
  const key = deriveKey(passphrase, kdf, salt);
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
function inspectBundle(bytes: Buffer, passphrase: string): Inspection {
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
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, envelope.kdf, salt), iv);
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
  passphrase: string;
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
  const inspection = inspectBundle(bytes, options.passphrase);
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
  const inspection = inspectBundle(bytes, options.passphrase);
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

export interface PlanRestoreV2Options {
  dataDir: string;
}

/** Diff a payload against a target directory without touching it.
 *
 * This does not open the target database even read-only: SQLite creates
 * `-shm`/`-wal` sidecars next to a WAL database, and a dry run that writes
 * those has already written to the target. Transcript threads are therefore
 * always reported as creates — deciding merge-versus-insert is exactly the
 * decision that needs the staged writer, not a plan. */
export function planRestoreV2(payload: BundlePayloadV2, options: PlanRestoreV2Options): RestorePlanV2 {
  const plan: RestorePlanV2 = { creates: [], conflicts: [], unchanged: [], blocked: [], writesNothing: true };
  const parsed = bundlePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    plan.blocked.push({ kind: "file", path: "-", detail: "the payload does not match the v2 schema" });
    return plan;
  }
  for (const file of parsed.data.files) {
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
  for (const thread of parsed.data.transcripts.threads) {
    plan.creates.push({ kind: "thread", path: thread.threadId, detail: `${thread.messages.length} messages, head ${thread.activeLeafId ?? "none"}` });
  }
  return plan;
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
