// Workspace bundle v2 — the restore half's own suite.
//
// Every fixture here is owned and throwaway: a temp root per case, a real
// `messages.db` built with the declaration from server/message-db.ts:39-55,
// and a cleanup that removes what this file made. Nothing here starts a
// server, reads a real installation, or writes outside the temp directories
// this file created — the data directories are synthetic, and the only paths
// a commit is ever pointed at are ones built from `mkdtempSync`.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import {
  RESTORE_DISABLED_BOT_FIELDS,
  RESTORE_DROPPED_BOT_FIELDS,
  RESTORE_DROPPED_GROUP_FIELDS,
  buildPayloadV2,
  commitRestoreV2,
  decryptBundleV2,
  encryptBundleV2,
  restoreBundleV2,
  stageRestoreV2,
  verifyBundleV2,
  type BundlePayloadV2,
  type RestoreEvent,
  type StagedRestoreResult,
} from "./workspace-bundle-v2.ts";

const PASSPHRASE = "correct horse battery staple";
const APP_VERSION = "1.12.0";
const AUTH_SECRET = "fixture-auth-secret-do-not-ship";
const BOT_ONE = "bot-1";
const BOT_TWO = "bot-2";
const BOT_THREAD = "thread-bot-1";
const ROOM_THREAD = "thread-room-1";
const MANIFEST_NAME = ".muster-restore-staging.json";
const CLOCK_BASE = 1_760_000_000_000;

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "muster-bundle-restore-suite-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of roots) await removeTempDir(root);
});

// ---------------------------------------------------------------------------
// Fixture: a data directory shaped like a real installation
// ---------------------------------------------------------------------------

interface FixtureMessage {
  id: string;
  role: "bot" | "user";
  kind: string;
  text?: string;
  parentId?: string | null;
  /** group sender attribution, as Message.from declares it */
  from?: { botId: string; name: string; color: string };
  reactions?: Array<{ emoji: string; by: string }>;
  /** a comm chip: "messaged @X" in the caller's chat, as Message.comm declares it */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: string };
}

interface TranscriptFixture {
  threadId: string;
  messages: FixtureMessage[];
  activeLeafId: string | null;
}

/** The declaration from server/message-db.ts:39-55, verbatim. A fixture that
 * invents its own schema proves nothing about the real one. Literal SQL, no
 * interpolation; every value below is bound. */
function writeTranscript(dbPath: string, fixtures: TranscriptFixture[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id))");
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

/** m4 is the newest row and m2 is the recorded head: a restore that takes the
 * newest row instead of the head is the bug this catches. */
const BOT_MESSAGES: FixtureMessage[] = [
  { id: "m1", role: "user", kind: "text", text: "run the migration", parentId: null },
  { id: "m2", role: "bot", kind: "text", text: "on it", parentId: "m1" },
  { id: "m3", role: "bot", kind: "text", text: "other branch", parentId: "m1" },
  { id: "m4", role: "bot", kind: "activity", parentId: "m2" },
];

/** r2 is a group reply: it carries bot ids inside its own serialized body. */
const ROOM_MESSAGES: FixtureMessage[] = [
  { id: "r1", role: "user", kind: "text", text: "morning room", parentId: null },
  {
    id: "r2",
    role: "bot",
    kind: "text",
    text: "morning",
    parentId: "r1",
    from: { botId: BOT_ONE, name: "Orchard", color: "green" },
    reactions: [{ emoji: "👍", by: BOT_TWO }],
    comm: { groupId: "group-1", withBotId: BOT_TWO, withName: "Ferry", withColor: "blue" },
  },
];

/** Bot records carrying every kind of field the restore must not carry over:
 * a standing permission, a self-approval switch, a connection switch, a
 * browser capability, provider session handles, another machine's folder and
 * another installation's owner id — beside fields that must survive. */
const BOT_RECORDS = [
  {
    id: BOT_ONE,
    threadId: BOT_THREAD,
    name: "Orchard",
    title: "Gardener",
    description: "keeps the rota",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "claude", model: "opus" },
    resumeCursors: { claude: "session-from-installation-a" },
    alwaysAllow: ["Bash:git"],
    autoApprove: true,
    composio: true,
    browser: true,
    computer: "vm",
    cwd: "/somewhere/on/installation-a",
    ownerId: "user-from-installation-a",
    chiefOfStaff: true,
    createdAt: CLOCK_BASE,
    tasks: [
      {
        threadId: BOT_THREAD,
        title: "rota",
        createdAt: CLOCK_BASE,
        resumeCursors: { claude: "task-cursor-from-a" },
        lastInstanceId: "instance-from-a",
        cwd: "/somewhere/on/installation-a",
      },
    ],
  },
  {
    id: BOT_TWO,
    threadId: ROOM_THREAD,
    name: "Ferry",
    title: "Courier",
    description: "carries messages",
    notifications: false,
    color: "blue",
    unread: false,
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    resumeCursors: {},
    alwaysAllow: [],
    createdAt: CLOCK_BASE,
    tasks: [],
  },
];

/** The responder shape the real store writes for a non-DM room
 * (`server/store.ts:614`): a plain message reaches this member, and
 * `roomResponders` finds it by id or dispatches to nobody
 * (`server/store.ts:426-433`). */
const GROUP_RECORDS = [
  {
    id: "group-1",
    threadId: ROOM_THREAD,
    name: "Workshop",
    memberIds: [BOT_ONE, BOT_TWO],
    defaultResponder: { kind: "member", botId: BOT_ONE },
    bulletin: "everyone says good morning",
    unread: false,
    createdAt: CLOCK_BASE,
    ownerId: "user-from-installation-a",
    cwd: "/somewhere/on/installation-a",
    pinnedCwd: "/somewhere/on/installation-a",
    busyBotId: null,
  },
];

interface Fixture {
  dataDir: string;
}

/** Named documents a case wants written instead of the fixture's own, so a
 * payload that is internally consistent but wrong in one other way can be
 * exported through the real build path rather than hand-assembled. */
interface FixtureOverrides {
  botsJson?: string;
  groupsJson?: string;
}

/** The bot-record fields a restore must not carry, written out here rather than
 * read from the module's own list: an expectation derived from the
 * implementation cannot notice the implementation dropping a field from its own
 * list. The two are asserted to agree, below. */
const MUST_NOT_SURVIVE = [
  "alwaysAllow",
  "approvePeerComms",
  "autoApprove",
  "chiefOfStaff",
  "computer",
  "cwd",
  "ownerId",
  "resumeCursors",
];

function writeFixture(root: string, overrides: FixtureOverrides = {}): Fixture {
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  mkdirSync(join(dataDir, "workspaces", BOT_ONE, "memory"), { recursive: true });
  mkdirSync(join(dataDir, "workspaces", BOT_TWO, "memory"), { recursive: true });
  writeFileSync(join(dataDir, "bots.json"), overrides.botsJson ?? JSON.stringify(BOT_RECORDS, null, 2));
  writeFileSync(join(dataDir, "groups.json"), overrides.groupsJson ?? JSON.stringify(GROUP_RECORDS, null, 2));
  writeFileSync(join(dataDir, "MEMORY.md"), "# MEMORY\n\nroot notes\n");
  writeFileSync(join(dataDir, "memory", "rota.md"), "# Rota\n\nthe rota lives here\n");
  writeFileSync(join(dataDir, "memory", "decisions.md"), "# Decisions\n\nwe ship on fridays\n");
  writeFileSync(join(dataDir, "workspaces", BOT_ONE, "MEMORY.md"), "# MEMORY\n\nbot one notes\n");
  writeFileSync(join(dataDir, "workspaces", BOT_ONE, "memory", "topic.md"), "# Topic\n\nbot one topic\n");
  writeFileSync(join(dataDir, "workspaces", BOT_TWO, "memory", "topic.md"), "# Topic\n\nbot two topic\n");
  writeFileSync(join(dataDir, "auth.secret"), AUTH_SECRET);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ provider: "none" }));
  writeTranscript(join(dataDir, "messages.db"), [
    { threadId: BOT_THREAD, messages: BOT_MESSAGES, activeLeafId: "m2" },
    { threadId: ROOM_THREAD, messages: ROOM_MESSAGES, activeLeafId: "r2" },
  ]);
  return { dataDir };
}

/** An installation that already holds files the bundle covers, with its own
 * bytes, beside files it does not cover. */
function localInstall(root: string): string {
  const install = join(root, "install");
  mkdirSync(join(install, "memory"), { recursive: true });
  mkdirSync(join(install, "workspaces", BOT_ONE), { recursive: true });
  writeFileSync(
    join(install, "bots.json"),
    JSON.stringify([{ id: BOT_ONE, name: "Local Orchard", alwaysAllow: ["Bash:rm"] }], null, 2),
  );
  writeFileSync(join(install, "MEMORY.md"), "# MEMORY\n\nlocal root notes\n");
  writeFileSync(join(install, "memory", "rota.md"), "local rota\n");
  writeFileSync(join(install, "workspaces", BOT_ONE, "MEMORY.md"), "local bot one notes\n");
  writeFileSync(join(install, "config.json"), JSON.stringify({ provider: "none" }, null, 2));
  writeFileSync(join(install, "auth.secret"), "this-installations-own-secret");
  writeFileSync(join(install, "attachments.txt"), "an attachment this bundle never covers\n");
  return install;
}

function exportBundle(fixture: Fixture): Buffer {
  const payload = buildPayloadV2({ dataDir: fixture.dataDir, appVersion: APP_VERSION });
  return encryptBundleV2(payload, { passphrase: PASSPHRASE });
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
  ciphertextB64: string;
}

/** Re-serialize an envelope with fields replaced, the way a buggy or hostile
 * producer would: the sealed body stays, the declarations change. */
function reseal(sealed: Buffer, mutate: (envelope: EnvelopeJson) => void): Buffer {
  const envelope: EnvelopeJson = JSON.parse(sealed.toString("utf8"));
  mutate(envelope);
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function flipFirstByte(base64: string): string {
  const body = Buffer.from(base64, "base64");
  body[0] = (body[0] ?? 0) ^ 0x01;
  return body.toString("base64");
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** Every entry under `root`, with its mode and its content hash. Directories
 * are part of the fingerprint: a rollback that leaves an empty directory the
 * commit created has not restored the tree it found. */
function fingerprint(root: string): string[] {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const absolute = join(dir, entry);
      const relative = prefix === "" ? entry : `${prefix}/${entry}`;
      const info = lstatSync(absolute);
      if (info.isDirectory()) {
        lines.push(`${relative}/ 0o${(info.mode & 0o777).toString(8)}`);
        walk(absolute, relative);
        continue;
      }
      const body = info.isSymbolicLink() ? Buffer.from("symlink") : readFileSync(absolute);
      lines.push(`${relative} 0o${(info.mode & 0o777).toString(8)} ${info.size} ${sha256(body)}`);
    }
  };
  walk(root, "");
  return lines;
}

interface RestoredRow {
  id: string;
  role: string;
  kind: string;
  text: string | null;
  json: string;
}

interface RestoredThread {
  threadId: string;
  activeLeafId: string | null;
  rows: RestoredRow[];
}

/** Read a transcript database the way the app does — through the declared
 * schema, ordered by rowid — without importing the live store, which is bound
 * to the process's own DATA_DIR. */
function readTranscript(dbPath: string): RestoredThread[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // SAFETY: the select lists exactly the columns the row shape declares
    const states = db
      .prepare("SELECT thread_id, active_leaf_id FROM thread_state ORDER BY thread_id")
      .all() as Array<{ thread_id: string; active_leaf_id: string | null }>;
    return states.map((state) => {
      // SAFETY: the select lists exactly the columns the row shape declares
      const rows = db
        .prepare("SELECT id, role, kind, text, json FROM messages WHERE thread_id = ? ORDER BY rowid")
        .all(state.thread_id) as Array<{ id: string; role: string; kind: string; text: string | null; json: string }>;
      return { threadId: state.thread_id, activeLeafId: state.active_leaf_id, rows };
    });
  } finally {
    db.close();
  }
}

function idMap(mapping: Array<{ kind: string; from: string; to: string }>, kind: "bot" | "thread"): Map<string, string> {
  return new Map(mapping.filter((entry) => entry.kind === kind).map((entry) => [entry.from, entry.to]));
}

/** The path a staged file lands at, once bot directories are remapped. */
function stagedPathFor(path: string, botIds: Map<string, string>): string {
  if (!path.startsWith("workspaces/")) return path;
  const segments = path.split("/");
  const botId = segments[1] ?? "";
  const mapped = botIds.get(botId);
  if (mapped === undefined) return path;
  return ["workspaces", mapped, ...segments.slice(2)].join("/");
}

interface RestoredRecord {
  id: string;
  name?: string;
  threadId?: string;
  memberIds?: string[];
  composio?: boolean;
  browser?: boolean;
  defaultResponder?: { kind?: string; botId?: string };
  tasks?: Array<{ threadId?: string }>;
}

/** Read a restored JSON document this suite has already asserted is an array
 * of records, to inspect the fields the cases below name. */
function readRecords(path: string): RestoredRecord[] {
  // SAFETY: the restore's own schema decides which fields exist, and every
  // case that reads a record asserts on the fields it uses
  return JSON.parse(readFileSync(path, "utf8")) as RestoredRecord[];
}

interface StagingManifestJson {
  format: string;
  counts: { files: number; messages: number; threads: number; bots: number; bytes: number };
  files: Array<{ path: string; sha256: string; size: number }>;
  consumedAt?: number;
}

/** Read the manifest a stage wrote into its staging tree. */
function readStagingManifest(stagingDir: string): StagingManifestJson {
  // SAFETY: the stage writes this document to its own schema; the cases that
  // read it assert on the fields they use
  return JSON.parse(readFileSync(join(stagingDir, MANIFEST_NAME), "utf8")) as StagingManifestJson;
}

// ---------------------------------------------------------------------------

describe("workspace bundle v2 restore", () => {
  it("restores a destroyed installation from the bundle bytes and the passphrase alone", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const payload = openPayload(sealed);
    const verified = verifyBundleV2(sealed, { passphrase: PASSPHRASE });
    expect(verified.status).toBe("ok");

    // fixture A is gone: no data directory, no secret, no transcript
    rmSync(fixture.dataDir, { recursive: true, force: true });
    expect(existsSync(fixture.dataDir)).toBe(false);

    // B is a fresh, empty installation with no auth.secret of its own
    const install = join(root, "install-b");
    mkdirSync(install, { recursive: true });
    const stagingDir = join(root, "staging");
    const backupDir = join(root, "backup");

    const result = restoreBundleV2(sealed, {
      passphrase: PASSPHRASE,
      stagingDir,
      dataDir: install,
      backupDir,
      confirm: true,
    });
    expect(result.status).toBe("committed");
    expect(result.stoppedAt).toBe("done");
    expect(result.decrypt.status).toBe("ok");
    expect(result.verify?.status).toBe("ok");
    expect(result.staged?.status).toBe("staged");
    expect(result.commit?.status).toBe("committed");
    // nothing was there to move, and no installation secret came with it
    expect(result.commit?.moved).toEqual([]);
    expect(existsSync(join(install, "auth.secret"))).toBe(false);
    expect(existsSync(join(install, "config.json"))).toBe(false);

    const mapping = result.staged?.mapping ?? [];
    const botIds = idMap(mapping, "bot");
    const threadIds = idMap(mapping, "thread");
    expect([...botIds.keys()].sort()).toEqual([BOT_ONE, BOT_TWO]);
    expect([...threadIds.keys()].sort()).toEqual([BOT_THREAD, ROOM_THREAD]);
    expect([...botIds.values()]).not.toContain(BOT_ONE);
    expect([...threadIds.values()]).not.toContain(BOT_THREAD);

    // the transcript: exact ids, roles and text, under fresh thread ids
    const restored = readTranscript(join(install, "messages.db"));
    expect(restored.map((thread) => thread.threadId).sort()).toEqual(
      [...threadIds.values()].sort(),
    );
    const botThread = restored.find((thread) => thread.threadId === threadIds.get(BOT_THREAD));
    expect(botThread).toBeDefined();
    expect(botThread?.rows.map((row) => [row.id, row.role, row.kind, row.text])).toEqual([
      ["m1", "user", "text", "run the migration"],
      ["m2", "bot", "text", "on it"],
      ["m3", "bot", "text", "other branch"],
      ["m4", "bot", "activity", null],
    ]);
    // the recorded head, not the newest row
    expect(botThread?.activeLeafId).toBe("m2");
    const room = restored.find((thread) => thread.threadId === threadIds.get(ROOM_THREAD));
    expect(room?.activeLeafId).toBe("r2");

    // message bodies that name no bot come back byte-identical
    const sourceBotThread = payload.transcripts.threads.find((thread) => thread.threadId === BOT_THREAD);
    expect(botThread?.rows.map((row) => row.json)).toEqual(sourceBotThread?.messages.map((message) => message.json));
    // and a body that does name one names the bot it was restored as
    const reply = room?.rows.find((row) => row.id === "r2");
    const replyBody = JSON.parse(reply?.json ?? "{}");
    expect(replyBody.from.botId).toBe(botIds.get(BOT_ONE));
    expect(replyBody.reactions[0].by).toBe(botIds.get(BOT_TWO));
    expect(replyBody.comm.withBotId).toBe(botIds.get(BOT_TWO));
    expect(replyBody.text).toBe("morning");
    expect(replyBody.parentId).toBe("r1");

    // every memory file is present at its remapped path, byte for byte
    for (const file of payload.files) {
      if (file.path === "bots.json" || file.path === "groups.json") continue;
      const restoredPath = join(install, ...stagedPathFor(file.path, botIds).split("/"));
      const body = readFileSync(restoredPath);
      expect(sha256(body)).toBe(file.sha256);
      expect(body.byteLength).toBe(file.size);
    }
    expect(sha256(readFileSync(join(install, "memory", "rota.md")))).toBe(
      sha256("# Rota\n\nthe rota lives here\n"),
    );

    // the bot store is reborn without the grants that belonged to A
    const bots = readRecords(join(install, "bots.json"));
    expect(bots.map((bot) => bot.id)).toEqual([botIds.get(BOT_ONE), botIds.get(BOT_TWO)]);
    const orchard = bots[0] ?? {};
    expect(orchard.name).toBe("Orchard");
    expect(orchard.threadId).toBe(threadIds.get(BOT_THREAD));
    // the restored record holds exactly the source record's keys, less the
    // literal list above — not less whatever the module's own constant happens
    // to say, so a field that silently stopped being dropped shows up here
    expect(Object.keys(orchard).sort()).toEqual(
      Object.keys(BOT_RECORDS[0])
        .filter((key) => !MUST_NOT_SURVIVE.includes(key))
        .sort(),
    );
    expect(MUST_NOT_SURVIVE.every((field) => !(field in orchard))).toBe(true);
    // and the module's declared policy is the literal list this case just used
    expect([...RESTORE_DROPPED_BOT_FIELDS].sort()).toEqual([...MUST_NOT_SURVIVE].sort());
    expect([...RESTORE_DISABLED_BOT_FIELDS].sort()).toEqual(["browser", "composio"]);
    expect(orchard.composio).toBe(false);
    expect(orchard.browser).toBe(false);

    // the room dispatches to the member it was restored as, not to an id that
    // no longer exists
    const groups = readRecords(join(install, "groups.json"));
    expect(groups[0]?.defaultResponder).toEqual({ kind: "member", botId: botIds.get(BOT_ONE) });
    expect(groups[0]?.memberIds).toEqual([botIds.get(BOT_ONE), botIds.get(BOT_TWO)]);

    // every bot has to re-consent, and the reason says so
    expect(result.staged?.reconsentRequired.map((entry) => entry.botId)).toEqual([BOT_ONE, BOT_TWO]);
    expect(result.staged?.reconsentRequired[0]?.restoredId).toBe(botIds.get(BOT_ONE));
    expect(result.staged?.reconsentRequired.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("replaces the paths it covers and leaves everything else exactly as it was", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const payload = openPayload(sealed);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const backupDir = join(root, "backup");
    const localConfig = readFileSync(join(install, "config.json"));
    const localSecret = readFileSync(join(install, "auth.secret"));
    const localAttachment = readFileSync(join(install, "attachments.txt"));
    const localBots = readFileSync(join(install, "bots.json"));
    const localRota = readFileSync(join(install, "memory", "rota.md"));

    const result = restoreBundleV2(sealed, {
      passphrase: PASSPHRASE,
      stagingDir,
      dataDir: install,
      backupDir,
      confirm: true,
    });
    expect(result.status).toBe("committed");
    const botIds = idMap(result.staged?.mapping ?? [], "bot");

    // files the bundle does not cover are untouched, byte for byte
    expect(readFileSync(join(install, "config.json"))).toEqual(localConfig);
    expect(readFileSync(join(install, "auth.secret"))).toEqual(localSecret);
    expect(readFileSync(join(install, "attachments.txt"))).toEqual(localAttachment);

    // the pre-restore copies of the covered paths are in the backup, unmodified.
    // `workspaces/bot-1/...` is NOT among them: with fresh ids the staged path
    // is `workspaces/<new bot id>/...`, so a local directory that merely shares
    // the bundle's old bot id is not the same bot and is never moved.
    expect([...(result.commit?.moved ?? [])].sort()).toEqual(
      ["MEMORY.md", "bots.json", "memory/rota.md"].sort(),
    );
    expect(readFileSync(join(backupDir, "bots.json"))).toEqual(localBots);
    expect(readFileSync(join(backupDir, "memory", "rota.md"))).toEqual(localRota);
    expect(readFileSync(join(install, "workspaces", BOT_ONE, "MEMORY.md"), "utf8")).toBe(
      "local bot one notes\n",
    );
    // the backup holds the covered paths and only those: the installation's own
    // secret is not copied anywhere
    expect(existsSync(join(backupDir, "auth.secret"))).toBe(false);
    expect(existsSync(join(backupDir, "config.json"))).toBe(false);
    // and the bot's files arrived under its fresh directory instead
    expect(readFileSync(join(install, "workspaces", botIds.get(BOT_ONE) ?? "", "MEMORY.md"), "utf8")).toBe(
      "# MEMORY\n\nbot one notes\n",
    );

    // the covered paths hold the bundle's bytes now
    expect(sha256(readFileSync(join(install, "memory", "rota.md")))).toBe(
      payload.files.find((file) => file.path === "memory/rota.md")?.sha256,
    );
    expect(readFileSync(join(install, "memory", "rota.md"))).not.toEqual(localRota);
    expect(readRecords(join(install, "bots.json")).map((bot) => bot.id)).toEqual([
      botIds.get(BOT_ONE),
      botIds.get(BOT_TWO),
    ]);
    expect(readTranscript(join(install, "messages.db"))).toHaveLength(2);
  });

  it("refuses a wrong passphrase without touching the installation", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const before = fingerprint(install);

    const result = restoreBundleV2(sealed, {
      passphrase: "an entirely different passphrase",
      stagingDir,
      dataDir: install,
      backupDir: join(root, "backup"),
      confirm: true,
    });
    expect(result.status).toBe("refused");
    expect(result.stoppedAt).toBe("decrypt");
    expect(result.decrypt.status).toBe("bad-key");
    expect(result.staged).toBeUndefined();
    expect(result.commit).toBeUndefined();
    expect(fingerprint(install)).toEqual(before);
    // it stopped before the write path, so no staging tree and no backup
    expect(existsSync(stagingDir)).toBe(false);
    expect(existsSync(join(root, "backup"))).toBe(false);
  });

  it("refuses a tampered bundle without touching the installation", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const payload = openPayload(sealed);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const backupDir = join(root, "backup");
    const before = fingerprint(install);

    // a flipped byte in the sealed body
    const flipped = reseal(sealed, (envelope) => {
      const body = Buffer.from(envelope.ciphertextB64, "base64");
      body[0] = (body[0] ?? 0) ^ 0x40;
      envelope.ciphertextB64 = body.toString("base64");
    });
    const wrongKey = restoreBundleV2(flipped, {
      passphrase: PASSPHRASE,
      stagingDir,
      dataDir: install,
      backupDir,
      confirm: true,
    });
    expect(wrongKey.status).toBe("refused");
    expect(wrongKey.stoppedAt).toBe("decrypt");
    expect(wrongKey.decrypt.status).toBe("bad-key");

    // a body that contradicts the hash recorded for it, sealed by a producer
    // that holds the passphrase
    const swapped = encryptBundleV2(
      {
        ...payload,
        files: payload.files.map((file) =>
          file.path === "memory/rota.md" ? { ...file, bodyB64: flipFirstByte(file.bodyB64) } : file,
        ),
      },
      { passphrase: PASSPHRASE },
    );
    const tampered = restoreBundleV2(swapped, {
      passphrase: PASSPHRASE,
      stagingDir,
      dataDir: install,
      backupDir,
      confirm: true,
    });
    expect(tampered.status).toBe("refused");
    expect(tampered.stoppedAt).toBe("decrypt");
    expect(tampered.decrypt.status).toBe("tampered");
    expect(tampered.decrypt.error).toContain("hash");

    expect(fingerprint(install)).toEqual(before);
    expect(existsSync(stagingDir)).toBe(false);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("refuses a payload that climbs out of the tree before it writes anything", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const payload = openPayload(sealed);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const before = fingerprint(install);
    const hostile: BundlePayloadV2 = {
      ...payload,
      files: payload.files.map((file) => (file.path === "MEMORY.md" ? { ...file, path: "../auth.secret" } : file)),
    };

    // through the wrapper the payload never opens at all
    const wrapped = restoreBundleV2(encryptBundleV2(hostile, { passphrase: PASSPHRASE }), {
      passphrase: PASSPHRASE,
      stagingDir,
      dataDir: install,
      backupDir: join(root, "backup"),
      confirm: true,
    });
    expect(wrapped.status).toBe("refused");
    expect(wrapped.stoppedAt).toBe("decrypt");
    expect(wrapped.decrypt.error).toContain("not a safe relative path");
    expect(existsSync(stagingDir)).toBe(false);

    // and handed the payload directly, the stage names the path and stops. The
    // renamed path also breaks the total and the manifest digest, so those are
    // reported too — the point is that every contradiction is named and none of
    // them reached a write.
    const staged = stageRestoreV2(hostile, { stagingDir });
    expect(staged.status).toBe("refused");
    expect(staged.blocked[0]).toEqual({ path: "../auth.secret", detail: "unsafe-path" });
    expect(staged.blocked.slice(1).map((entry) => entry.detail)).toEqual([
      expect.stringContaining("the files total"),
      "the manifest does not match its recorded digest",
    ]);
    expect(staged.files).toEqual([]);
    expect(fingerprint(install)).toEqual(before);
    // nothing was written — not even the staging directory, and not the file
    // the hostile path pointed at
    expect(existsSync(stagingDir)).toBe(false);
    expect(existsSync(join(root, "auth.secret"))).toBe(false);
    expect(readFileSync(join(install, "auth.secret"), "utf8")).toBe("this-installations-own-secret");
  });

  it("cleans up its staging tree when a staged step throws", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const before = fingerprint(install);

    const atFile = restoreBundleV2(sealed, {
      passphrase: PASSPHRASE,
      stagingDir,
      dataDir: install,
      backupDir: join(root, "backup"),
      confirm: true,
      onStage: (event: RestoreEvent) => {
        if (event.step === "file" && event.path === "memory/decisions.md") {
          throw new Error("injected staging fault");
        }
      },
    });
    expect(atFile.status).toBe("failed");
    expect(atFile.stoppedAt).toBe("stage");
    expect(atFile.staged?.status).toBe("failed");
    expect(atFile.staged?.error).toContain("injected staging fault");
    expect(existsSync(stagingDir)).toBe(false);
    expect(fingerprint(install)).toEqual(before);

    // the same, one step later: the transcript is where a stage does its own
    // writing rather than a temp-then-rename of a bundle body
    const atTranscript = restoreBundleV2(sealed, {
      passphrase: PASSPHRASE,
      stagingDir,
      dataDir: install,
      backupDir: join(root, "backup"),
      confirm: true,
      onStage: (event: RestoreEvent) => {
        if (event.step === "transcript") throw new Error("injected transcript fault");
      },
    });
    expect(atTranscript.status).toBe("failed");
    expect(atTranscript.staged?.error).toContain("injected transcript fault");
    expect(existsSync(stagingDir)).toBe(false);
    expect(fingerprint(install)).toEqual(before);
    expect(existsSync(join(root, "backup"))).toBe(false);
  });

  it("rolls back to the byte when a commit fails between the backup move and the writes", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const backupDir = join(root, "backup");
    const before = fingerprint(install);
    expect(stageRestoreV2(openPayload(sealed), { stagingDir }).status).toBe("staged");

    const result = commitRestoreV2({
      stagingDir,
      dataDir: install,
      backupDir,
      confirm: true,
      onCommit: (event: RestoreEvent) => {
        if (event.step === "write") throw new Error("injected commit fault");
      },
    });
    expect(result.status).toBe("rolled-back");
    expect(result.error).toContain("injected commit fault");
    expect(result.written).toEqual([]);
    expect([...result.moved].sort()).toEqual(["MEMORY.md", "bots.json", "memory/rota.md"].sort());
    expect(result.rollbackFailures).toBeUndefined();
    // byte-identical, directories and modes included
    expect(fingerprint(install)).toEqual(before);
    // the pre-restore copies stay: the backup is never deleted, and it is not
    // a move-back
    expect(readFileSync(join(backupDir, "bots.json"))).toEqual(
      readFileSync(join(install, "bots.json")),
    );
    expect(readFileSync(join(backupDir, "memory", "rota.md"), "utf8")).toBe("local rota\n");
    // a rolled-back commit does not consume the staging tree
    expect(readStagingManifest(stagingDir).consumedAt).toBeUndefined();
  });

  it("rolls back when a commit fails during the move phase", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const backupDir = join(root, "backup");
    const before = fingerprint(install);
    expect(stageRestoreV2(openPayload(sealed), { stagingDir }).status).toBe("staged");

    const result = commitRestoreV2({
      stagingDir,
      dataDir: install,
      backupDir,
      confirm: true,
      onCommit: (event: RestoreEvent) => {
        if (event.step === "move" && event.path === "memory/rota.md") throw new Error("injected move fault");
      },
    });
    expect(result.status).toBe("rolled-back");
    expect(result.error).toContain("injected move fault");
    expect(result.moved).toEqual(["MEMORY.md", "bots.json"]);
    expect(result.written).toEqual([]);
    expect(result.rollbackFailures).toBeUndefined();
    expect(fingerprint(install)).toEqual(before);
    // the two files that were moved are in the backup and back in place
    expect(readFileSync(join(backupDir, "MEMORY.md"), "utf8")).toBe("# MEMORY\n\nlocal root notes\n");
    expect(readFileSync(join(install, "MEMORY.md"), "utf8")).toBe("# MEMORY\n\nlocal root notes\n");
  });

  it("rolls back a commit that failed after every file was written", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const backupDir = join(root, "backup");
    const before = fingerprint(install);
    const staged = stageRestoreV2(openPayload(sealed), { stagingDir });
    expect(staged.status).toBe("staged");

    const result = commitRestoreV2({
      stagingDir,
      dataDir: install,
      backupDir,
      confirm: true,
      onCommit: (event: RestoreEvent) => {
        if (event.step === "consume") throw new Error("injected fault after the writes");
      },
    });
    expect(result.status).toBe("rolled-back");
    expect(result.error).toContain("injected fault after the writes");
    // every covered path was written, then every one of them was undone
    expect(result.written).toEqual(staged.files);
    expect(result.written.length).toBeGreaterThan(3);
    expect(result.rollbackFailures).toBeUndefined();
    expect(fingerprint(install)).toEqual(before);
    // the files this commit created are gone again, and the ones it replaced
    // hold their own bytes
    expect(existsSync(join(install, "messages.db"))).toBe(false);
    expect(existsSync(join(install, "groups.json"))).toBe(false);
    expect(sha256(readFileSync(join(install, "MEMORY.md")))).toBe(
      sha256("# MEMORY\n\nlocal root notes\n"),
    );
    expect(readTranscript(join(stagingDir, "messages.db")).length).toBe(2);
  });

  it("refuses to write without an explicit confirmation, and keeps the staging tree for a later one", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const backupDir = join(root, "backup");
    const before = fingerprint(install);
    expect(stageRestoreV2(openPayload(sealed), { stagingDir }).status).toBe("staged");

    const refused = commitRestoreV2({ stagingDir, dataDir: install, backupDir, confirm: false });
    expect(refused.status).toBe("refused");
    expect(refused.blocked).toEqual([
      { path: "-", detail: "a restore into a live installation requires confirm: true" },
    ]);
    expect(refused.moved).toEqual([]);
    expect(refused.written).toEqual([]);
    // nothing was moved, and the backup directory was never created
    expect(existsSync(backupDir)).toBe(false);
    expect(fingerprint(install)).toEqual(before);
    // a refusal confirms nothing either: the staging tree is still usable
    const committed = commitRestoreV2({ stagingDir, dataDir: install, backupDir, confirm: true });
    expect(committed.status).toBe("committed");
    expect(readStagingManifest(stagingDir).consumedAt).toBeTypeOf("number");
  });

  it("refuses a live installation it must not touch, and a staging tree it did not write", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const payload = openPayload(sealed);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const backupDir = join(root, "backup");
    const before = fingerprint(install);
    expect(stageRestoreV2(payload, { stagingDir }).status).toBe("staged");
    const base = { stagingDir, dataDir: install, backupDir, confirm: true };

    // the filesystem root
    const rootRefusal = commitRestoreV2({ ...base, dataDir: "/" });
    expect(rootRefusal.status).toBe("refused");
    expect(rootRefusal.blocked).toEqual([
      { path: "/", detail: "the data directory is the filesystem root" },
    ]);

    // the home directory itself. HOME is pointed at a synthetic directory
    // first, so a guard that failed would move files inside this case's own
    // temp root rather than the real home.
    const previousHome = process.env.HOME;
    const fakeHome = join(root, "home");
    mkdirSync(join(fakeHome, "memory"), { recursive: true });
    writeFileSync(join(fakeHome, "MEMORY.md"), "# MEMORY\n\nhome notes\n");
    const homeBefore = fingerprint(fakeHome);
    process.env.HOME = fakeHome;
    try {
      // the guard compares against what the process calls home
      expect(homedir()).toBe(fakeHome);
      const homeRefusal = commitRestoreV2({ ...base, dataDir: fakeHome });
      expect(homeRefusal.status).toBe("refused");
      expect(homeRefusal.blocked).toEqual([
        { path: fakeHome, detail: "the data directory is the home directory itself" },
      ]);
      expect(fingerprint(fakeHome)).toEqual(homeBefore);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    // a data directory that is not there, or is not a directory
    expect(commitRestoreV2({ ...base, dataDir: join(root, "absent") }).blocked).toEqual([
      { path: join(root, "absent"), detail: "the data directory does not exist" },
    ]);
    const notADirectory = join(root, "a-file");
    writeFileSync(notADirectory, "not a directory\n");
    expect(commitRestoreV2({ ...base, dataDir: notADirectory }).blocked).toEqual([
      { path: notADirectory, detail: "the data directory is not a directory" },
    ]);

    // a backup directory that already exists
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "earlier-backup.txt"), "an earlier backup\n");
    expect(commitRestoreV2(base).blocked).toEqual([
      { path: backupDir, detail: "the backup directory already exists" },
    ]);
    rmSync(backupDir, { recursive: true, force: true });

    // the backup inside the data directory, and the data directory inside the
    // backup
    expect(commitRestoreV2({ ...base, backupDir: join(install, "backup") }).status).toBe("refused");
    expect(commitRestoreV2({ ...base, dataDir: join(backupDir, "live") }).status).toBe("refused");

    // an empty staging directory is refused, and a non-empty one the stage did
    // not write is refused with its contents left alone
    const emptyStaging = join(root, "empty-staging");
    mkdirSync(emptyStaging, { recursive: true });
    expect(commitRestoreV2({ ...base, stagingDir: emptyStaging }).blocked).toEqual([
      { path: emptyStaging, detail: "the staging directory is empty" },
    ]);
    const busyStaging = join(root, "busy-staging");
    mkdirSync(busyStaging, { recursive: true });
    writeFileSync(join(busyStaging, "someone-elses-notes.txt"), "not mine\n");
    const busyBefore = fingerprint(busyStaging);
    const refusedStage = stageRestoreV2(payload, { stagingDir: busyStaging });
    expect(refusedStage.status).toBe("refused");
    expect(refusedStage.blocked).toEqual([
      { path: busyStaging, detail: "the staging directory exists and is not empty" },
    ]);
    expect(readFileSync(join(busyStaging, "someone-elses-notes.txt"), "utf8")).toBe("not mine\n");
    expect(fingerprint(busyStaging)).toEqual(busyBefore);

    // a staging tree that lost its manifest is not a restore
    const manifest = join(stagingDir, MANIFEST_NAME);
    const manifestBody = readFileSync(manifest);
    rmSync(manifest);
    expect(commitRestoreV2(base).blocked).toEqual([
      { path: MANIFEST_NAME, detail: "the staging tree carries no staging manifest" },
    ]);
    writeFileSync(manifest, "this is not the manifest a stage writes\n");
    expect(commitRestoreV2(base).blocked).toEqual([
      { path: MANIFEST_NAME, detail: "the staging manifest is not readable" },
    ]);
    writeFileSync(manifest, manifestBody);

    // every one of those refusals left the installation and the staging tree
    // exactly where they were
    expect(fingerprint(install)).toEqual(before);
    expect(readStagingManifest(stagingDir).consumedAt).toBeUndefined();
    const committed = commitRestoreV2(base);
    expect(committed.status).toBe("committed");
  });

  it("refuses to apply the same staging tree twice", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const backupDir = join(root, "backup");
    expect(stageRestoreV2(openPayload(sealed), { stagingDir }).status).toBe("staged");

    const first = commitRestoreV2({ stagingDir, dataDir: install, backupDir, confirm: true });
    expect(first.status).toBe("committed");
    const afterCommit = fingerprint(install);

    // a second commit against the same tree, with a backup directory of its
    // own so the refusal is the manifest and not the backup
    const secondBackup = join(root, "backup-2");
    const second = commitRestoreV2({
      stagingDir,
      dataDir: install,
      backupDir: secondBackup,
      confirm: true,
    });
    expect(second.status).toBe("refused");
    expect(second.blocked).toEqual([
      { path: MANIFEST_NAME, detail: "the staging manifest was already consumed by an earlier commit" },
    ]);
    expect(second.moved).toEqual([]);
    expect(second.written).toEqual([]);
    expect(existsSync(secondBackup)).toBe(false);
    expect(fingerprint(install)).toEqual(afterCommit);
  });

  it("issues fresh ids by default and keeps the bundle's when asked", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const payload = openPayload(sealed);

    const freshDir = join(root, "staging-fresh");
    const fresh = stageRestoreV2(payload, { stagingDir: freshDir });
    expect(fresh.status).toBe("staged");
    const botIds = idMap(fresh.mapping, "bot");
    const threadIds = idMap(fresh.mapping, "thread");
    expect(fresh.mapping).toHaveLength(4);
    expect([...botIds.keys()].sort()).toEqual([BOT_ONE, BOT_TWO]);
    expect([...threadIds.keys()].sort()).toEqual([BOT_THREAD, ROOM_THREAD]);
    for (const [from, to] of [...botIds, ...threadIds]) {
      expect(to).not.toBe(from);
      expect(to.length).toBeGreaterThan(10);
    }
    // a bot and a thread never share an id, which is why the mapping says which
    // kind each entry is
    expect([...botIds.values()].some((id) => [...threadIds.values()].includes(id))).toBe(false);

    // the staged tree holds the fresh ids and the fresh paths
    expect(fresh.files).toContain(`workspaces/${botIds.get(BOT_ONE)}/MEMORY.md`);
    expect(fresh.files).not.toContain(`workspaces/${BOT_ONE}/MEMORY.md`);
    const stagedBots = readRecords(join(freshDir, "bots.json"));
    expect(stagedBots.map((bot) => bot.id)).toEqual([botIds.get(BOT_ONE), botIds.get(BOT_TWO)]);
    expect(stagedBots[0]?.threadId).toBe(threadIds.get(BOT_THREAD));
    expect(stagedBots[0]?.tasks?.[0]?.threadId).toBe(threadIds.get(BOT_THREAD));
    expect(stagedBots[0]?.name).toBe("Orchard");
    for (const field of RESTORE_DROPPED_BOT_FIELDS) expect(field in (stagedBots[0] ?? {})).toBe(false);
    for (const field of RESTORE_DISABLED_BOT_FIELDS) expect(stagedBots[0]?.[field]).toBe(false);
    const stagedGroups = readRecords(join(freshDir, "groups.json"));
    expect(stagedGroups[0]?.memberIds).toEqual([botIds.get(BOT_ONE), botIds.get(BOT_TWO)]);
    expect(stagedGroups[0]?.threadId).toBe(threadIds.get(ROOM_THREAD));
    expect(stagedGroups[0]?.defaultResponder).toEqual({ kind: "member", botId: botIds.get(BOT_ONE) });
    for (const field of RESTORE_DROPPED_GROUP_FIELDS) expect(field in (stagedGroups[0] ?? {})).toBe(false);
    expect(stagedGroups[0]?.name).toBe("Workshop");
    expect(readTranscript(join(freshDir, "messages.db")).map((thread) => thread.threadId).sort()).toEqual(
      [...threadIds.values()].sort(),
    );
    // every bot has to re-consent, and the entry names both ids
    expect(fresh.reconsentRequired.map((entry) => entry.botId)).toEqual([BOT_ONE, BOT_TWO]);
    expect(fresh.reconsentRequired.map((entry) => entry.restoredId)).toEqual([
      botIds.get(BOT_ONE),
      botIds.get(BOT_TWO),
    ]);
    expect(fresh.reconsentRequired[0]?.reason).toContain("do not travel in a bundle");
    expect(fresh.reconsentRequired[0]?.reason).toContain("fresh id");

    // with the bundle's own ids, nothing is remapped and the body a message
    // carries inside itself is untouched
    const keptDir = join(root, "staging-kept");
    const kept = stageRestoreV2(payload, { stagingDir: keptDir, remapIds: false });
    expect(kept.status).toBe("staged");
    expect(kept.mapping).toEqual([]);
    expect(kept.files).toContain(`workspaces/${BOT_ONE}/MEMORY.md`);
    expect(readRecords(join(keptDir, "bots.json")).map((bot) => bot.id)).toEqual([BOT_ONE, BOT_TWO]);
    const keptOrchard = readRecords(join(keptDir, "bots.json"))[0] ?? {};
    expect(MUST_NOT_SURVIVE.every((field) => !(field in keptOrchard))).toBe(true);
    expect(keptOrchard.composio).toBe(false);
    // the room's responder keeps the id the bundle used, because nothing was
    // remapped
    expect(readRecords(join(keptDir, "groups.json"))[0]?.defaultResponder).toEqual({
      kind: "member",
      botId: BOT_ONE,
    });
    const keptThreads = readTranscript(join(keptDir, "messages.db"));
    expect(keptThreads.map((thread) => thread.threadId)).toEqual([BOT_THREAD, ROOM_THREAD].sort());
    const keptRoom = keptThreads.find((thread) => thread.threadId === ROOM_THREAD);
    const sourceRoom = payload.transcripts.threads.find((thread) => thread.threadId === ROOM_THREAD);
    expect(keptRoom?.rows.map((row) => row.json)).toEqual(sourceRoom?.messages.map((message) => message.json));
    expect(keptRoom?.activeLeafId).toBe("r2");
    // the grants still do not travel, and the owner is still asked
    expect(kept.reconsentRequired.map((entry) => entry.botId)).toEqual([BOT_ONE, BOT_TWO]);
    expect(kept.reconsentRequired.map((entry) => entry.restoredId)).toEqual([BOT_ONE, BOT_TWO]);
    expect(kept.reconsentRequired[0]?.reason).not.toContain("fresh id");

    // keeping the ids is what makes the overlay land on the same paths: the
    // local bot directory is replaced, with its own copy kept
    const install = localInstall(root);
    const backupDir = join(root, "backup");
    const result = commitRestoreV2({ stagingDir: keptDir, dataDir: install, backupDir, confirm: true });
    expect(result.status).toBe("committed");
    expect(result.moved).toContain(`workspaces/${BOT_ONE}/MEMORY.md`);
    expect(readFileSync(join(install, "workspaces", BOT_ONE, "MEMORY.md"), "utf8")).toBe(
      "# MEMORY\n\nbot one notes\n",
    );
    expect(readFileSync(join(backupDir, "workspaces", BOT_ONE, "MEMORY.md"), "utf8")).toBe(
      "local bot one notes\n",
    );
  });

  it("creates the transcript owner-only, staged and committed", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = join(root, "install");
    mkdirSync(install, { recursive: true });
    const stagingDir = join(root, "staging");
    expect(stageRestoreV2(openPayload(sealed), { stagingDir }).status).toBe("staged");

    const stagedMode = statSync(join(stagingDir, "messages.db")).mode & 0o777;
    expect(stagedMode.toString(8)).toBe("600");
    const result = commitRestoreV2({
      stagingDir,
      dataDir: install,
      backupDir: join(root, "backup"),
      confirm: true,
    });
    expect(result.status).toBe("committed");
    expect((statSync(join(install, "messages.db")).mode & 0o777).toString(8)).toBe("600");
    // and the transcript is the one the payload carried, not an empty database
    expect(readTranscript(join(install, "messages.db")).length).toBe(2);
  });

  it("refuses a live tree when a link makes two spellings one directory", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = join(root, "real", "install");
    mkdirSync(install, { recursive: true });
    writeFileSync(join(install, "config.json"), "{}\n");
    // root/alias and root/real are one directory wearing two names
    symlinkSync(join(root, "real"), join(root, "alias"));
    const stagingDir = join(root, "staging");
    expect(stageRestoreV2(openPayload(sealed), { stagingDir }).status).toBe("staged");
    const before = fingerprint(install);

    // this backup path is physically inside the data directory although the
    // two spellings do not say so
    const aliasBackup = join(root, "alias", "install", "backup");
    const result = commitRestoreV2({ stagingDir, dataDir: install, backupDir: aliasBackup, confirm: true });
    expect(result.status).toBe("refused");
    expect(result.blocked).toEqual([
      { path: aliasBackup, detail: "the backup directory is the data directory or sits inside it" },
    ]);
    expect(result.moved).toEqual([]);
    expect(fingerprint(install)).toEqual(before);
    expect(existsSync(aliasBackup)).toBe(false);

    // and the other direction: a data directory spelled through the link, with
    // a backup directory that really contains it
    const mirrored = commitRestoreV2({
      stagingDir,
      dataDir: join(root, "alias", "install"),
      backupDir: join(root, "real"),
      confirm: true,
    });
    expect(mirrored.status).toBe("refused");
    // the refusal names the path the caller passed, which is the one it can act on
    expect(mirrored.blocked).toEqual([
      {
        path: join(root, "alias", "install"),
        detail: "the data directory sits inside the backup directory",
      },
    ]);
    expect(fingerprint(install)).toEqual(before);
  });

  it("refuses a live tree whose covered directory is a link out of it", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "rota.md"), "a file outside the installation\n");
    const install = join(root, "install");
    mkdirSync(install, { recursive: true });
    // `memory/` is covered by the bundle, and it points out of the tree
    symlinkSync(outside, join(install, "memory"));
    const stagingDir = join(root, "staging");
    expect(stageRestoreV2(openPayload(sealed), { stagingDir }).status).toBe("staged");
    const outsideBefore = fingerprint(outside);

    const result = commitRestoreV2({
      stagingDir,
      dataDir: install,
      backupDir: join(root, "backup"),
      confirm: true,
    });
    expect(result.status).toBe("refused");
    expect(result.blocked).toContainEqual({
      path: "memory/rota.md",
      detail: "a directory on this path is a link out of the data directory",
    });
    expect(result.moved).toEqual([]);
    expect(result.written).toEqual([]);
    expect(fingerprint(outside)).toEqual(outsideBefore);
    expect(readFileSync(join(outside, "rota.md"), "utf8")).toBe("a file outside the installation\n");
    expect(existsSync(join(root, "backup"))).toBe(false);
  });

  it("refuses a covered path that is not a file, or that has a database sidecar beside it", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = join(root, "install");
    mkdirSync(install, { recursive: true });
    const stagingDir = join(root, "staging");
    const backupDir = join(root, "backup");
    expect(stageRestoreV2(openPayload(sealed), { stagingDir }).status).toBe("staged");

    // a directory where the bundle would write a file
    mkdirSync(join(install, "MEMORY.md"), { recursive: true });
    const notAFile = commitRestoreV2({ stagingDir, dataDir: install, backupDir, confirm: true });
    expect(notAFile.status).toBe("refused");
    expect(notAFile.blocked).toEqual([
      { path: "MEMORY.md", detail: "the live path exists and is not a regular file" },
    ]);
    expect(notAFile.moved).toEqual([]);
    expect(existsSync(join(install, "MEMORY.md"))).toBe(true);
    rmSync(join(install, "MEMORY.md"), { recursive: true });

    // a database that is not checkpointed: moving the file alone would drop
    // whatever the write-ahead log still holds
    writeFileSync(join(install, "messages.db"), "a live database\n");
    writeFileSync(join(install, "messages.db-wal"), "uncheckpointed rows\n");
    const sidecar = commitRestoreV2({ stagingDir, dataDir: install, backupDir, confirm: true });
    expect(sidecar.status).toBe("refused");
    expect(sidecar.blocked).toEqual([
      {
        path: "messages.db",
        detail: "a -wal sidecar sits beside this path, so the live database is not checkpointed",
      },
    ]);
    expect(readFileSync(join(install, "messages.db"), "utf8")).toBe("a live database\n");
    expect(readFileSync(join(install, "messages.db-wal"), "utf8")).toBe("uncheckpointed rows\n");
    expect(existsSync(backupDir)).toBe(false);

    // the staging directory inside the data directory is refused too
    expect(stageRestoreV2(openPayload(sealed), { stagingDir: join(install, "staging") }).status).toBe("staged");
    expect(
      commitRestoreV2({ stagingDir: join(install, "staging"), dataDir: install, backupDir, confirm: true }).blocked,
    ).toEqual([
      {
        path: join(install, "staging"),
        detail: "the staging directory is the data directory or sits inside it",
      },
    ]);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("refuses a staging tree that no longer matches its own manifest", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const before = fingerprint(install);
    expect(stageRestoreV2(openPayload(sealed), { stagingDir }).status).toBe("staged");

    // one byte different, same length: only the recorded hash can catch this
    writeFileSync(join(stagingDir, "MEMORY.md"), "# NEMORY\n\nroot notes\n");
    expect(statSync(join(stagingDir, "MEMORY.md")).size).toBe(21);
    const result = commitRestoreV2({
      stagingDir,
      dataDir: install,
      backupDir: join(root, "backup"),
      confirm: true,
    });
    expect(result.status).toBe("refused");
    expect(result.blocked).toEqual([
      { path: "MEMORY.md", detail: "the staged file does not match the staging manifest" },
    ]);
    expect(result.moved).toEqual([]);
    expect(fingerprint(install)).toEqual(before);
    expect(existsSync(join(root, "backup"))).toBe(false);
  });

  it("refuses a store that is not an array, and a manifest that claims a transcript name", () => {
    const oddRoot = makeRoot();
    const oddStaging = join(oddRoot, "staging");
    const odd = writeFixture(oddRoot, { botsJson: JSON.stringify({ bots: [] }, null, 2) });
    const refusedStore = stageRestoreV2(openPayload(exportBundle(odd)), { stagingDir: oddStaging });
    expect(refusedStore.status).toBe("refused");
    expect(refusedStore.blocked).toEqual([
      { path: "bots.json", detail: "the bot store is not a JSON array of bot records" },
    ]);
    expect(existsSync(oddStaging)).toBe(false);

    const groupRoot = makeRoot();
    const groupStaging = join(groupRoot, "staging");
    const oddGroups = writeFixture(groupRoot, { groupsJson: "\"not a room\"\n" });
    const refusedGroups = stageRestoreV2(openPayload(exportBundle(oddGroups)), { stagingDir: groupStaging });
    expect(refusedGroups.status).toBe("refused");
    expect(refusedGroups.blocked).toEqual([
      { path: "groups.json", detail: "the group store is not a JSON array of group records" },
    ]);
    expect(existsSync(groupStaging)).toBe(false);

    // a payload that claims a name belonging to the database the restore
    // rebuilds itself, sidecars included
    const root = makeRoot();
    const fixture = writeFixture(root);
    const payload = openPayload(exportBundle(fixture));
    const hostile: BundlePayloadV2 = {
      ...payload,
      files: payload.files.map((file) =>
        file.path === "memory/decisions.md" ? { ...file, path: "messages.db-shm" } : file,
      ),
    };
    const reservedStaging = join(root, "staging");
    const reserved = stageRestoreV2(hostile, { stagingDir: reservedStaging });
    expect(reserved.status).toBe("refused");
    expect(reserved.blocked).toContainEqual({
      path: "messages.db-shm",
      detail: "the manifest claims a name that belongs to the transcript database",
    });
    expect(existsSync(reservedStaging)).toBe(false);
  });

  it("stops at verify, and says where it stopped, before any write path", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const payload = openPayload(sealed);
    // a producer that lies about its own transcript counts: the seal is
    // genuine, so the run has to stop at the checks rather than at the key
    const lying = encryptBundleV2(
      { ...payload, transcripts: { ...payload.transcripts, counts: { threads: 2, messages: 99 } } },
      { passphrase: PASSPHRASE },
    );
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const before = fingerprint(install);

    const result = restoreBundleV2(lying, {
      passphrase: PASSPHRASE,
      stagingDir,
      dataDir: install,
      backupDir: join(root, "backup"),
      confirm: true,
    });
    expect(result.status).toBe("refused");
    expect(result.stoppedAt).toBe("verify");
    expect(result.decrypt.status).toBe("ok");
    expect(result.verify?.status).toBe("check-failed");
    expect(result.verify?.checks.find((check) => check.check === "transcript-counts")?.ok).toBe(false);
    expect(result.staged).toBeUndefined();
    expect(result.commit).toBeUndefined();
    expect(existsSync(stagingDir)).toBe(false);
    expect(fingerprint(install)).toEqual(before);
  });

  it("says so when a rollback could not put a path back", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const install = localInstall(root);
    const stagingDir = join(root, "staging");
    const backupDir = join(root, "backup");
    const before = fingerprint(install);
    expect(stageRestoreV2(openPayload(sealed), { stagingDir }).status).toBe("staged");

    const result = commitRestoreV2({
      stagingDir,
      dataDir: install,
      backupDir,
      confirm: true,
      onCommit: (event: RestoreEvent) => {
        // MEMORY.md has already been moved into the backup by now; replace the
        // copy with a directory so the rollback cannot read it back
        if (event.step !== "move" || event.path !== "bots.json") return;
        rmSync(join(backupDir, "MEMORY.md"));
        mkdirSync(join(backupDir, "MEMORY.md"));
        throw new Error("injected fault beside an unreadable backup");
      },
    });
    expect(result.status).toBe("rolled-back");
    expect(result.moved).toEqual(["MEMORY.md"]);
    expect(result.rollbackFailures).toEqual([expect.stringContaining("MEMORY.md")]);
    // the field is the point: without it this result would claim a clean
    // rollback with a path missing from the live tree
    expect(fingerprint(install)).not.toEqual(before);
    expect(existsSync(join(install, "MEMORY.md"))).toBe(false);
  });

  it("stages a manifest that describes the tree it wrote", () => {
    const root = makeRoot();
    const fixture = writeFixture(root);
    const sealed = exportBundle(fixture);
    const stagingDir = join(root, "staging");
    const staged = stageRestoreStage(sealed, stagingDir);
    const manifest = readStagingManifest(stagingDir);

    expect(manifest.format).toBe("muster-restore-staging");
    expect(manifest.files.map((entry) => entry.path)).toEqual(staged.files);
    expect(manifest.counts).toEqual({
      files: staged.files.length,
      messages: 6,
      threads: 2,
      bots: 2,
      bytes: manifest.files.reduce((total, entry) => total + entry.size, 0),
    });
    // each recorded hash is the hash of the file that is really there
    for (const entry of manifest.files) {
      const body = readFileSync(join(stagingDir, ...entry.path.split("/")));
      expect(sha256(body)).toBe(entry.sha256);
      expect(body.byteLength).toBe(entry.size);
    }
  });
});

/** Stage a bundle's payload and insist it staged, so a case can read the tree
 * rather than unwrap a status first. */
function stageRestoreStage(sealed: Buffer, stagingDir: string): StagedRestoreResult {
  const staged = stageRestoreV2(openPayload(sealed), { stagingDir });
  expect(staged.status).toBe("staged");
  return staged;
}
