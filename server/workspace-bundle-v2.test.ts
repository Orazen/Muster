// Workspace bundle v2 — the format's own suite.
//
// Every fixture is owned and throwaway: a temp data directory per case, a
// real `messages.db` created with the schema from server/message-db.ts:40-56,
// and a cleanup that removes what this file made. Nothing here starts a
// server, reads a real install or writes outside its own temp directory.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import {
  LIMITS,
  VERIFY_CHECKS,
  buildPayloadV2,
  decryptBundleV2,
  encryptBundleV2,
  isSafeRelativePath,
  planRestoreV2,
  selftest,
  verifyBundleV2,
  type BundlePayloadV2,
} from "./workspace-bundle-v2.ts";

const PASSPHRASE = "correct horse battery staple";
const APP_VERSION = "1.12.0";
const AUTH_SECRET = "fixture-auth-secret-do-not-ship";
const BOT_THREAD = "thread-bot-1";
const ROOM_THREAD = "thread-room-1";
const CLOCK_BASE = 1_760_000_000_000;

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "muster-bundle-v2-suite-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of roots) await removeTempDir(root);
});

// ---------------------------------------------------------------------------
// Fixture: a data directory shaped like a real install
// ---------------------------------------------------------------------------

interface FixtureMessage {
  id: string;
  role: "bot" | "user";
  kind: string;
  text?: string;
  parentId?: string | null;
}

interface TranscriptFixture {
  threadId: string;
  messages: FixtureMessage[];
  activeLeafId: string | null;
}

/** The declaration from server/message-db.ts:40-56, verbatim. A fixture that
 * invents its own schema proves nothing about the real one. Literal SQL, no
 * interpolation; every value below is bound. */
function writeTranscript(dbPath: string, fixtures: TranscriptFixture[]): void {
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
    let clock = CLOCK_BASE;
    for (const fixture of fixtures) {
      for (const message of fixture.messages) {
        clock += 1_000;
        insert.run(
          fixture.threadId,
          message.id,
          clock,
          message.role,
          message.kind,
          message.text ?? null,
          JSON.stringify({ ...message, at: clock }),
        );
      }
      state.run(fixture.threadId, fixture.activeLeafId);
    }
  } finally {
    db.close();
  }
}

/** m3 is the newest row; the recorded branch head is m2. A restore that takes
 * the newest row instead of the head is the bug this fixture catches. */
const BOT_MESSAGES: FixtureMessage[] = [
  { id: "m1", role: "user", kind: "text", text: "run the migration", parentId: null },
  { id: "m2", role: "bot", kind: "text", text: "on it", parentId: "m1" },
  { id: "m3", role: "bot", kind: "text", text: "other branch", parentId: "m1" },
  { id: "m4", role: "bot", kind: "activity", text: undefined, parentId: "m2" },
];

interface Fixture {
  dataDir: string;
  memoryBody: string;
}

function writeFixture(root: string, transcript = true): Fixture {
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  mkdirSync(join(dataDir, "workspaces", "bot-1", "memory"), { recursive: true });
  const memoryBody = "# Notes\n\nthe rota lives in memory/rota.md\n";
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{ id: "bot-1", name: "Orchard" }]));
  writeFileSync(join(dataDir, "groups.json"), JSON.stringify([{ id: "group-1", name: "Workshop" }]));
  writeFileSync(join(dataDir, "MEMORY.md"), "# MEMORY\n\nroot notes\n");
  writeFileSync(join(dataDir, "memory", "rota.md"), memoryBody);
  writeFileSync(join(dataDir, "workspaces", "bot-1", "MEMORY.md"), "# MEMORY\n\nbot notes\n");
  writeFileSync(join(dataDir, "workspaces", "bot-1", "memory", "topic.md"), "# Topic\n\nbot topic\n");
  writeFileSync(join(dataDir, "auth.secret"), AUTH_SECRET);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ provider: "none" }));
  if (transcript) {
    writeTranscript(join(dataDir, "messages.db"), [
      { threadId: BOT_THREAD, messages: BOT_MESSAGES, activeLeafId: "m2" },
      {
        threadId: ROOM_THREAD,
        messages: [{ id: "r1", role: "user", kind: "text", text: "hello room" }],
        activeLeafId: "r1",
      },
    ]);
  }
  return { dataDir, memoryBody };
}

interface SealedFixture {
  fixture: Fixture;
  sealed: Buffer;
}

function sealedFixture(root: string): SealedFixture {
  const fixture = writeFixture(root);
  const payload = buildPayloadV2({ dataDir: fixture.dataDir, appVersion: APP_VERSION });
  return { fixture, sealed: encryptBundleV2(payload, { passphrase: PASSPHRASE }) };
}

/** Open a bundle and insist it opened, so callers do not each unwrap an
 * optional or assert their way past a failure. */
function openPayload(sealed: Buffer, passphrase = PASSPHRASE): BundlePayloadV2 {
  const result = decryptBundleV2(sealed, { passphrase });
  expect(result.status).toBe("ok");
  if (result.payload === undefined) throw new Error("expected a payload from an ok bundle");
  return result.payload;
}

interface EnvelopeJson {
  magic: string;
  schema: number;
  kdf: { N: number; r: number; p: number; keyLen: number; saltB64: string; name: string };
  cipher: { ivB64: string; tagB64: string; name: string };
  counts: { files: number; messages: number; threads: number; totalBytes: number };
  payloadSha256: string;
  ciphertextB64: string;
  producer: string;
  encoding: string;
  createdAt: number;
}

/** Re-serialize an envelope with fields replaced, the way a buggy or hostile
 * producer would: the sealed body stays, the declarations change. */
function reseal(sealed: Buffer, mutate: (envelope: EnvelopeJson) => void): Buffer {
  const envelope: EnvelopeJson = JSON.parse(sealed.toString("utf8"));
  mutate(envelope);
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function fingerprint(root: string): string[] {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const absolute = join(dir, entry);
      const relative = prefix === "" ? entry : `${prefix}/${entry}`;
      const info = lstatSync(absolute);
      if (info.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      const body = info.isSymbolicLink() ? Buffer.from("symlink") : readFileSync(absolute);
      lines.push(`${relative} ${info.size} ${createHash("sha256").update(body).digest("hex")}`);
    }
  };
  walk(root, "");
  return lines;
}

/** Snapshot directories this module creates for its VACUUM INTO copy. */
function scratchSnapshots(): string[] {
  return readdirSync(tmpdir()).filter((entry) => entry.startsWith("muster-bundle-v2-"));
}

// ---------------------------------------------------------------------------

describe("workspace bundle v2", () => {
  it("round trips every message, the branch and the recorded head", () => {
    const root = makeRoot();
    const openBefore = scratchSnapshots();
    const { fixture, sealed } = sealedFixture(root);
    // the snapshot is this module's only write, and it is gone before the
    // export returns
    expect(scratchSnapshots()).toEqual(openBefore);

    const payload = openPayload(sealed);
    const botThread = payload.transcripts.threads.find((thread) => thread.threadId === BOT_THREAD);
    expect(botThread).toBeDefined();
    expect(botThread?.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(botThread?.messages.map((message) => message.json)).toEqual(
      BOT_MESSAGES.map((message, index) => JSON.stringify({ ...message, at: CLOCK_BASE + (index + 1) * 1_000 })),
    );
    // recorded head m2, newest row m4 — the head is read from thread_state,
    // not inferred from row order
    expect(botThread?.activeLeafId).toBe("m2");
    expect(botThread?.messages[3]?.text).toBeNull();
    expect(payload.transcripts.method).toBe("vacuum-into");
    expect(payload.counts).toEqual({ files: 6, messages: 5, threads: 2, totalBytes: expect.any(Number) });
    expect(payload.files.map((file) => file.path)).toEqual([
      "MEMORY.md",
      "bots.json",
      "groups.json",
      "memory/rota.md",
      "workspaces/bot-1/MEMORY.md",
      "workspaces/bot-1/memory/topic.md",
    ]);
    expect(payload.files.find((file) => file.path === "memory/rota.md")?.bodyB64).toBe(
      Buffer.from(fixture.memoryBody, "utf8").toString("base64"),
    );
    expect(payload.counts.totalBytes).toBe(payload.files.reduce((total, file) => total + file.size, 0));

    const verified = verifyBundleV2(sealed, { passphrase: PASSPHRASE });
    expect(verified.status).toBe("ok");
    expect(verified.checks.map((check) => check.check)).toEqual([...VERIFY_CHECKS]);
    expect(verified.checks.filter((check) => !check.ok)).toEqual([]);
    expect(verified.summary).toEqual({
      files: 6,
      messages: 5,
      threads: 2,
      totalBytes: expect.any(Number),
      skipped: 3,
      skippedTruncated: false,
      transcriptMethod: "vacuum-into",
      payloadBytes: sealed.byteLength,
    });
  });

  it("keeps the installation secret out of the bundle, so recovery is passphrase-only", () => {
    const root = makeRoot();
    const { fixture, sealed } = sealedFixture(root);
    expect(sealed.toString("utf8")).not.toContain(AUTH_SECRET);
    const payload = openPayload(sealed);
    // every file the scan walked past is named with a reason — including the
    // transcript database, which is not a manifest file
    expect(payload.skipped).toEqual([
      { path: "auth.secret", reason: "outside-subset" },
      { path: "config.json", reason: "outside-subset" },
      { path: "messages.db", reason: "outside-subset" },
    ]);
    expect(JSON.stringify(payload)).not.toContain(AUTH_SECRET);
    // the bundle was built from files that no longer exist
    rmSync(join(fixture.dataDir, "auth.secret"));
    rmSync(join(fixture.dataDir, "messages.db"));
    const verified = verifyBundleV2(sealed, { passphrase: PASSPHRASE });
    expect(verified.status).toBe("ok");
    expect(verified.summary?.messages).toBe(5);
    expect(verified.checks.find((check) => check.check === "authenticated")?.ok).toBe(true);
  });

  it("refuses a flipped ciphertext byte without throwing", () => {
    const root = makeRoot();
    const { sealed } = sealedFixture(root);
    const flipped = reseal(sealed, (envelope) => {
      const body = Buffer.from(envelope.ciphertextB64, "base64");
      body[0] = (body[0] ?? 0) ^ 0x40;
      envelope.ciphertextB64 = body.toString("base64");
    });
    const result = decryptBundleV2(flipped, { passphrase: PASSPHRASE });
    expect(result.status).toBe("bad-key");
    expect(result.payload).toBeUndefined();
    expect(result.error).toContain("did not authenticate");
    expect(() => decryptBundleV2(flipped, { passphrase: PASSPHRASE })).not.toThrow();
    const verified = verifyBundleV2(flipped, { passphrase: PASSPHRASE });
    expect(verified.status).toBe("bad-key");
    expect(verified.checks.find((check) => check.check === "authenticated")?.ok).toBe(false);
    expect(verified.checks.find((check) => check.check === "envelope-readable")?.ok).toBe(true);
  });

  it("reports a wrong passphrase as bad-key", () => {
    const root = makeRoot();
    const { sealed } = sealedFixture(root);
    const result = decryptBundleV2(sealed, { passphrase: "wrong passphrase entirely" });
    expect(result.status).toBe("bad-key");
    expect(verifyBundleV2(sealed, { passphrase: "wrong passphrase entirely" }).status).toBe("bad-key");
  });

  it("reports a newer envelope schema as unknown-version without the key", () => {
    const root = makeRoot();
    const { sealed } = sealedFixture(root);
    const newer = reseal(sealed, (envelope) => {
      envelope.schema = 3;
    });
    // the version gate runs before any key is derived, so even a wrong
    // passphrase reports the version rather than a key failure
    const result = decryptBundleV2(newer, { passphrase: "irrelevant" });
    expect(result.status).toBe("unknown-version");
    expect(result.envelope?.schema).toBe(3);
  });

  it("never returns ok for a truncated buffer", () => {
    const root = makeRoot();
    const { sealed } = sealedFixture(root);
    // a buffer cut mid-envelope: the JSON itself is incomplete
    const cut = sealed.subarray(0, Math.floor(sealed.byteLength / 2));
    expect(decryptBundleV2(cut, { passphrase: PASSPHRASE }).status).toBe("malformed-envelope");
    // a body cut mid-base64: the envelope reads, the compressed body does not
    const shortBody = reseal(sealed, (envelope) => {
      envelope.ciphertextB64 = `${envelope.ciphertextB64.slice(0, 8)}A`;
    });
    const shortResult = decryptBundleV2(shortBody, { passphrase: PASSPHRASE });
    expect(shortResult.status).toBe("truncated");
    expect(shortResult.error).toContain("compressed body");
    expect(verifyBundleV2(shortBody, { passphrase: PASSPHRASE }).status).toBe("truncated");
  });

  it("refuses a manifest path that climbs out of the data directory", () => {
    const root = makeRoot();
    const { fixture, sealed } = sealedFixture(root);
    const payload = openPayload(sealed);
    const hostile: BundlePayloadV2 = {
      ...payload,
      files: payload.files.map((file) => (file.path === "MEMORY.md" ? { ...file, path: "../auth.secret" } : file)),
    };
    const hostileSealed = encryptBundleV2(hostile, { passphrase: PASSPHRASE });
    const result = decryptBundleV2(hostileSealed, { passphrase: PASSPHRASE });
    expect(result.status).toBe("malformed-envelope");
    expect(result.error).toContain("not a safe relative path");
    const verified = verifyBundleV2(hostileSealed, { passphrase: PASSPHRASE });
    expect(verified.checks.find((check) => check.check === "manifest-paths-safe")?.ok).toBe(false);
    expect(verified.checks.find((check) => check.check === "manifest-paths-safe")?.detail).toContain("../auth.secret");
    const plan = planRestoreV2(hostile, { dataDir: join(fixture.dataDir, "dry-run") });
    expect(plan.blocked).toEqual([{ kind: "file", path: "../auth.secret", detail: "unsafe-path" }]);
    expect(plan.creates.some((entry) => entry.path === "../auth.secret")).toBe(false);
    expect(plan.creates.filter((entry) => entry.kind === "file")).toHaveLength(hostile.files.length - 1);
    expect(plan.unchanged).toEqual([]);
    // the refused entry was not smuggled into a blocked-then-created plan
    expect(existsSync(join(fixture.dataDir, "dry-run"))).toBe(false);
  });

  it("fails memory-bodies-intact when a body contradicts its own recorded hash", () => {
    const root = makeRoot();
    const { sealed } = sealedFixture(root);
    const payload = openPayload(sealed);
    const tampered: BundlePayloadV2 = {
      ...payload,
      files: payload.files.map((file) => {
        if (file.path !== "memory/rota.md") return file;
        const body = Buffer.from(file.bodyB64, "base64");
        body[0] = (body[0] ?? 0) ^ 0x01;
        return { ...file, bodyB64: body.toString("base64") };
      }),
    };
    const resealed = encryptBundleV2(tampered, { passphrase: PASSPHRASE });
    const verified = verifyBundleV2(resealed, { passphrase: PASSPHRASE });
    const bodies = verified.checks.find((check) => check.check === "memory-bodies-intact");
    expect(bodies?.ok).toBe(false);
    expect(bodies?.detail).toContain("does not match the hash");
    // the manifest is internally consistent and the seal is genuine: only the
    // body lies about itself
    expect(verified.checks.find((check) => check.check === "manifest-hash-consistent")?.ok).toBe(true);
    expect(verified.checks.find((check) => check.check === "authenticated")?.ok).toBe(true);
    expect(verified.status).toBe("tampered");
    expect(decryptBundleV2(resealed, { passphrase: PASSPHRASE }).status).toBe("tampered");
  });

  it("reports a symlink in the data directory as skipped and never follows it", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const canary = "outside-the-data-directory-canary";
    writeFileSync(join(outside, "canary.md"), canary);
    symlinkSync(join(outside, "canary.md"), join(fixture.dataDir, "memory", "linked.md"));
    symlinkSync(outside, join(fixture.dataDir, "workspaces", "bot-2"));

    const payload = buildPayloadV2({ dataDir: fixture.dataDir, appVersion: APP_VERSION });
    expect(payload.files.some((file) => file.path === "memory/linked.md")).toBe(false);
    expect(payload.skipped).toEqual(
      expect.arrayContaining([
        { path: "memory/linked.md", reason: "symlink" },
        { path: "workspaces/bot-2", reason: "symlink" },
      ]),
    );
    expect(JSON.stringify(payload)).not.toContain(canary);
    expect(payload.transcripts.threads.map((thread) => thread.threadId)).toEqual([BOT_THREAD, ROOM_THREAD]);
  });

  it("aborts the export when one file is above the per-file limit", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const huge = join(fixture.dataDir, "memory", "huge.md");
    writeFileSync(huge, "x");
    truncateSync(huge, LIMITS.maxFileBytes + 1);
    expect(() => buildPayloadV2({ dataDir: fixture.dataDir, appVersion: APP_VERSION })).toThrow(
      /above the 33554432-byte per-file limit/u,
    );
    // the refused export left the offending file alone
    expect(existsSync(huge)).toBe(true);
  });

  it("fails loudly when the data directory is missing", () => {
    const root = makeRoot();
    const missing = join(root, "not-here");
    expect(() => buildPayloadV2({ dataDir: missing, appVersion: APP_VERSION })).toThrow(/does not exist/u);
    expect(existsSync(missing)).toBe(false);
  });

  it("plans a restore without writing a byte to the target", () => {
    const root = makeRoot();
    const { sealed } = sealedFixture(root);
    const payload = openPayload(sealed);
    const target = join(root, "target");
    mkdirSync(join(target, "memory"), { recursive: true });
    const identical = payload.files.find((file) => file.path === "memory/rota.md");
    if (identical === undefined) throw new Error("fixture is missing the memory file");
    writeFileSync(join(target, "memory", "rota.md"), Buffer.from(identical.bodyB64, "base64"));
    writeFileSync(join(target, "MEMORY.md"), "a different local file\n");

    const before = fingerprint(target);
    const plan = planRestoreV2(payload, { dataDir: target });
    expect(fingerprint(target)).toEqual(before);
    expect(plan.writesNothing).toBe(true);
    expect(plan.unchanged).toEqual([
      { kind: "file", path: "memory/rota.md", detail: "the target already holds these bytes" },
    ]);
    expect(plan.conflicts.map((entry) => entry.path)).toEqual(["MEMORY.md"]);
    expect(plan.creates.filter((entry) => entry.kind === "file").map((entry) => entry.path).sort()).toEqual([
      "bots.json",
      "groups.json",
      "workspaces/bot-1/MEMORY.md",
      "workspaces/bot-1/memory/topic.md",
    ]);
    expect(plan.creates.filter((entry) => entry.kind === "thread").map((entry) => entry.path)).toEqual([BOT_THREAD, ROOM_THREAD]);
    expect(plan.creates.find((entry) => entry.kind === "thread" && entry.path === BOT_THREAD)?.detail).toBe("4 messages, head m2");
    expect(plan.blocked).toEqual([]);

    // a target that does not exist is still not created by a plan
    const absent = join(root, "absent");
    const absentPlan = planRestoreV2(payload, { dataDir: absent });
    expect(absentPlan.creates).toHaveLength(payload.files.length + payload.transcripts.threads.length);
    expect(fingerprint(target)).toEqual(before);
    expect(existsSync(absent)).toBe(false);
  });

  it("fails check-failed when transcript counts contradict the rows present", () => {
    const root = makeRoot();
    const { sealed } = sealedFixture(root);
    const payload = openPayload(sealed);
    // the counts live inside the sealed payload, so a producer that lies about
    // them is a producer defect the verifier has to catch on its own
    const lying = encryptBundleV2(
      { ...payload, transcripts: { ...payload.transcripts, counts: { threads: 2, messages: 99 } } },
      { passphrase: PASSPHRASE },
    );
    expect(decryptBundleV2(lying, { passphrase: PASSPHRASE }).status).toBe("ok");
    const verified = verifyBundleV2(lying, { passphrase: PASSPHRASE });
    expect(verified.checks.find((check) => check.check === "transcript-counts")?.ok).toBe(false);
    // the envelope and the payload still agree with each other; the lie is
    // between the payload's own counts and its own rows
    expect(verified.checks.find((check) => check.check === "counts-declared")?.ok).toBe(true);
    expect(verified.status).toBe("check-failed");
  });

  it("refuses a payload whose declared file count contradicts its manifest", () => {
    const root = makeRoot();
    const { sealed } = sealedFixture(root);
    const payload = openPayload(sealed);
    const lying = encryptBundleV2(
      { ...payload, counts: { ...payload.counts, files: payload.counts.files + 1 } },
      { passphrase: PASSPHRASE },
    );
    const result = decryptBundleV2(lying, { passphrase: PASSPHRASE });
    expect(result.status).toBe("tampered");
    expect(result.error).toContain("declares");
    const verified = verifyBundleV2(lying, { passphrase: PASSPHRASE });
    expect(verified.checks.find((check) => check.check === "manifest-count")?.ok).toBe(false);
    // counts-declared compares the authenticated envelope against the payload;
    // this producer kept those two in step, so the contradiction is between the
    // payload's own count and its own manifest, which manifest-count names
    expect(verified.checks.find((check) => check.check === "counts-declared")?.ok).toBe(true);
    expect(verified.status).toBe("tampered");
  });

  it("declares the limits and keeps its own invariants", () => {
    expect(LIMITS).toEqual({
      maxFiles: 4096,
      maxFileBytes: 32 * 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024,
      maxManifestEntries: 4096,
      maxMessages: 200_000,
      maxBundleBytes: 512 * 1024 * 1024,
      maxInflatedBytes: 512 * 1024 * 1024,
    });
    expect(selftest()).toEqual({
      canonicalJsonStable: true,
      pathSafetyAccepts: true,
      pathSafetyRejects: true,
      limitsDeclared: true,
    });
    const root = makeRoot();
    const fixture = writeFixture(root);
    const payload = buildPayloadV2({ dataDir: fixture.dataDir, appVersion: APP_VERSION });
    expect(() => encryptBundleV2(payload, { passphrase: "short" })).toThrow(/at least 8 characters/u);
    expect(isSafeRelativePath("workspaces/bot-1/memory/topic.md")).toBe(true);
    expect(isSafeRelativePath("workspaces/bot-1/../../auth.secret")).toBe(false);
  });
});
