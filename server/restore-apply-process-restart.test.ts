// Process-level acceptance for the v2 restore boundary: staging is served by
// the live HTTP route, but bytes are not committed until the next real server
// process enters server/index.ts through bootWithRestoreFirst, before Store.
// Every path is owned by this test; child environments and network access are
// isolated, and no provider, Drive, hosted, or production service is involved.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import {
  buildPayloadV2,
  encryptBundleV2,
  RESTORE_EXCLUDED_ROOT_FILES,
  SUBSET_ROOT_FILES,
  type BundlePayloadV2,
} from "./workspace-bundle-v2.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PASSPHRASE = "owned-process-restart-passphrase";
const APP_VERSION = "process-restart-test";
const BACKUPS_DIR = ".restore-backups";
const MESSAGE_AT = 1_760_000_000_001;
const OUTPUT_LIMIT = 12_000;

const modelSelectionSchema = z.object({ instanceId: z.string(), model: z.string() });
const botRecordSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  color: z.string(),
  notifications: z.boolean(),
  unread: z.boolean(),
  modelSelection: modelSelectionSchema,
  resumeCursors: z.record(z.string(), z.string()).optional(),
  busy: z.boolean(),
  activity: z.string(),
  createdAt: z.number(),
  alwaysAllow: z.array(z.string()).optional(),
  autoApprove: z.boolean().optional(),
  approvePeerComms: z.boolean().optional(),
  ownerId: z.string().optional(),
  composio: z.boolean().optional(),
  browser: z.boolean().optional(),
});
const botListSchema = z.array(botRecordSchema);
const stagedBotSchema = botRecordSchema
  .omit({ alwaysAllow: true, autoApprove: true, approvePeerComms: true, ownerId: true, resumeCursors: true })
  .extend({ composio: z.boolean(), browser: z.boolean() });
const stagedBotListSchema = z.array(stagedBotSchema);
const defaultResponderSchema = z.object({ botId: z.string(), kind: z.literal("member") });
const groupRecordSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  memberIds: z.array(z.string()),
  defaultResponder: defaultResponderSchema,
  name: z.string(),
  bulletin: z.string(),
  unread: z.boolean(),
  createdAt: z.number(),
});
const groupListSchema = z.array(groupRecordSchema);
const routineRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  botId: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  schedule: z.object({ type: z.literal("daily"), at: z.string() }),
  prompt: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const routinesDocumentSchema = z.object({ routines: z.array(routineRecordSchema) });
const goalRecordSchema = z.object({
  id: z.string(),
  botId: z.string(),
  text: z.string(),
  status: z.string(),
  rounds: z.number(),
  maxRounds: z.number(),
});
const goalsDocumentSchema = z.object({ goals: z.array(goalRecordSchema) });
const decisionsDocumentSchema = z.object({ entries: z.array(z.never()) });
const socialDocumentSchema = z.object({
  profiles: z.array(z.never()),
  requests: z.array(z.never()),
  friendships: z.array(z.never()),
});
const configDocumentSchema = z.object({
  profile: z.object({ name: z.string() }),
  branding: z.object({ orgName: z.string() }),
});
const persistedTranscriptRowSchema = z.object({
  threadId: z.string(),
  id: z.string(),
  text: z.string().nullable(),
  json: z.string(),
});
const persistedTranscriptRowsSchema = z.array(persistedTranscriptRowSchema);
const sqliteTableNameSchema = z.object({ name: z.string() });
const sqliteCountSchema = z.object({ count: z.number() });
const restoreReceiptSchema = z.object({ status: z.string(), backupDir: z.string().optional() });
type BotRecord = z.infer<typeof botRecordSchema>;
type GroupRecord = z.infer<typeof groupRecordSchema>;
type FixtureJson =
  | BotRecord[]
  | GroupRecord[]
  | z.infer<typeof routinesDocumentSchema>
  | z.infer<typeof goalsDocumentSchema>
  | z.infer<typeof decisionsDocumentSchema>
  | z.infer<typeof socialDocumentSchema>
  | z.infer<typeof configDocumentSchema>;

interface OwnedProcess {
  phase: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  stopped: boolean;
}

interface ProcessReceipt {
  phase: string;
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderr: string;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeJson(path: string, value: FixtureJson): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${path}: fixture JSON serialization returned no text`);
  writeFileSync(path, serialized, { mode: 0o600 });
}

function writeSyntheticAuthSession(dataDir: string): void {
  const db = new DatabaseSync(join(dataDir, "auth.db"));
  try {
    db.exec(`CREATE TABLE session (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      token TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );`);
    db.prepare('INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run("synthetic-source-session", "synthetic-source-user", "not-a-real-session-token", "2099-01-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.000Z");
  } finally {
    db.close();
  }
}

function bot(id: string, name: string, threadId: string, withForeignGrants = false) {
  // All persisted profile defaults are explicit so Store construction does not
  // migrate this fixture and obscure the archive's file-hash assertions.
  const record: BotRecord = {
    id,
    threadId,
    name,
    title: `${name} title`,
    description: "",
    color: "blue",
    notifications: true,
    unread: false,
    modelSelection: { instanceId: "", model: "" },
    resumeCursors: withForeignGrants ? { [threadId]: "source-resume-cursor" } : {},
    busy: false,
    activity: "idle",
    createdAt: 1,
  };
  if (withForeignGrants) {
    record.alwaysAllow = ["Bash:git"];
    record.autoApprove = true;
    record.approvePeerComms = true;
    record.ownerId = "source-installation-owner";
    record.composio = true;
    record.browser = true;
  }
  return record;
}

function group(id: string, name: string, threadId: string, botId: string): GroupRecord {
  return {
    id,
    threadId,
    memberIds: [botId],
    defaultResponder: { botId, kind: "member" },
    name,
    bulletin: `${name} bulletin`,
    unread: false,
    createdAt: 1,
  };
}

function writeTranscript(dataDir: string, threadId: string, messageId: string, text: string): void {
  const db = new DatabaseSync(join(dataDir, "messages.db"));
  try {
    db.exec(`
      CREATE TABLE messages (
        thread_id TEXT NOT NULL,
        id TEXT NOT NULL,
        at INTEGER NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT,
        json TEXT NOT NULL,
        PRIMARY KEY (thread_id, id)
      );
      CREATE INDEX messages_thread ON messages(thread_id);
      CREATE TABLE thread_state (thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);
    `);
    const message = { id: messageId, at: MESSAGE_AT, role: "user", kind: "text", text };
    db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(threadId, messageId, MESSAGE_AT, "user", "text", text, JSON.stringify(message));
    db.prepare("INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?)").run(threadId, messageId);
  } finally {
    db.close();
  }
}

function makeInstall(options: {
  dataDir: string;
  id: string;
  name: string;
  threadId: string;
  groupId: string;
  messageId: string;
  messageText: string;
  routineEnabled: boolean;
  goalStatus: "active" | "stopped";
  configName: string;
  authSecret: string;
  withForeignGrants?: boolean;
}): void {
  const { dataDir, id, name, threadId, groupId, messageId, messageText, routineEnabled, goalStatus, withForeignGrants } = options;
  mkdirSync(join(dataDir, "memory"), { recursive: true, mode: 0o700 });
  writeJson(join(dataDir, "bots.json"), [bot(id, name, threadId, withForeignGrants)]);
  writeJson(join(dataDir, "groups.json"), [group(groupId, `${name} room`, `thread-${groupId}`, id)]);
  writeFileSync(join(dataDir, "MEMORY.md"), `# MEMORY\n\n${name} installation memory.\n`, { mode: 0o600 });
  writeFileSync(join(dataDir, "memory", "topic.md"), `# Topic\n\n${name} topic.\n`, { mode: 0o600 });
  writeJson(join(dataDir, "routines.json"), {
    routines: [{
      id: `routine-${id}`,
      name: `${name} routine`,
      botId: id,
      enabled: routineEnabled,
      nextRunAt: routineEnabled ? 1_800_000_000_000 : null,
      schedule: { type: "daily", at: "08:00" },
      prompt: `${name} routine prompt`,
      createdAt: 1,
      updatedAt: 1,
    }],
  });
  writeJson(join(dataDir, "goals.json"), {
    goals: [{ id: `goal-${id}`, botId: id, text: `${name} goal`, status: goalStatus, rounds: 1, maxRounds: 5 }],
  });
  writeJson(join(dataDir, "decisions.json"), { entries: [] });
  writeJson(join(dataDir, "social.json"), { profiles: [], requests: [], friendships: [] });
  // Deliberately distinct source and target identities. Both files are outside
  // the portable subset; the target's exact bytes must survive the overlay.
  writeJson(join(dataDir, "config.json"), {
    profile: { name: options.configName },
    branding: { orgName: options.configName },
  });
  writeFileSync(join(dataDir, "auth.secret"), options.authSecret, { mode: 0o600 });
  writeTranscript(dataDir, threadId, messageId, messageText);
}

function supportedInventory(dataDir: string): string[] {
  const rootFiles = [...SUBSET_ROOT_FILES].filter((name) => existsSync(join(dataDir, name)));
  const memoryFiles = existsSync(join(dataDir, "memory"))
    ? readdirSync(join(dataDir, "memory"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => `memory/${entry.name}`)
    : [];
  return [...rootFiles, ...memoryFiles].sort();
}

function expectedAfterSafetyTransform(file: BundlePayloadV2["files"][number]): Buffer {
  const original = Buffer.from(file.bodyB64, "base64");
  if (file.path === "bots.json") {
    const bots = botListSchema.parse(JSON.parse(original.toString("utf8")));
    const stagedBots = bots.map((record) => stagedBotSchema.parse({ ...record, composio: false, browser: false }));
    return Buffer.from(JSON.stringify(stagedBots, null, 2));
  }
  if (file.path === "groups.json") {
    const groups = groupListSchema.parse(JSON.parse(original.toString("utf8")));
    return Buffer.from(JSON.stringify(groups, null, 2));
  }
  if (file.path === "routines.json") {
    const document = routinesDocumentSchema.parse(JSON.parse(original.toString("utf8")));
    const transformed = { routines: document.routines.map((routine) => ({ ...routine, enabled: false, nextRunAt: null })) };
    return Buffer.from(JSON.stringify(transformed, null, 2));
  }
  if (file.path === "goals.json") {
    const document = goalsDocumentSchema.parse(JSON.parse(original.toString("utf8")));
    const transformed = {
      goals: document.goals.map((goal) => ({ ...goal, status: goal.status === "active" ? "stopped" : goal.status })),
    };
    return Buffer.from(JSON.stringify(transformed, null, 2));
  }
  return original;
}

async function requestJson(base: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    ...init,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const rosterSchema = z.object({
  bots: z.array(z.object({ id: z.string(), name: z.string() })),
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
});
const stagingManifestSchema = z.object({
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().min(0) })),
});
const threadSchema = z.object({
  messages: z.array(z.object({ id: z.string(), text: z.string().optional() })),
});

async function readRoster(base: string) {
  const response = await requestJson(base, "/api/bots");
  expect(response.status).toBe(200);
  return rosterSchema.parse(response.body);
}

async function readThread(base: string, threadId: string) {
  const response = await requestJson(base, `/api/threads/${threadId}/messages`);
  expect(response.status).toBe(200);
  return threadSchema.parse(response.body);
}

function readPersistedTranscript(dbPath: string): Array<{ threadId: string; id: string; text: string | null; json: string }> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT thread_id AS threadId, id, text, json FROM messages ORDER BY thread_id, rowid").all();
    return persistedTranscriptRowsSchema.parse(rows);
  } finally {
    db.close();
  }
}

function readSessionCountIfPresent(authDbPath: string): number {
  if (!existsSync(authDbPath)) return 0;
  const db = new DatabaseSync(authDbPath, { readOnly: true });
  try {
    const table = sqliteTableNameSchema.optional().parse(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'").get(),
    );
    if (!table) return 0;
    const row = sqliteCountSchema.parse(db.prepare('SELECT COUNT(*) AS count FROM "session"').get());
    return row.count;
  } finally {
    db.close();
  }
}

// Windows Node uses forced process termination for child.kill("SIGTERM"), so
// this harness cannot require a catchable graceful signal and exitCode 0 there.
// Keep this platform skip until the production server exposes a shutdown IPC/HTTP primitive.
describe.skipIf(process.platform === "win32")("v2 restore across a real process restart", () => {
  it("stages over HTTP, applies before Store construction on the next boot, and remains stable on a second restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "muster-restore-process-restart-"));
    const sourceDir = join(root, "synthetic-source");
    const dataDir = join(root, "target", "data");
    const home = join(root, "target", "home");
    const companionDir = join(root, "target", "companion");
    const staticDir = join(root, "target", "static");
    const preloadPath = join(root, "deny-network.mjs");
    const networkLog = join(root, "blocked-network-attempts.log");
    const targetStagingDir = `${dataDir}.restore-staging`;
    const targetBackupsDir = join(dataDir, BACKUPS_DIR);
    for (const directory of [sourceDir, dataDir, home, companionDir, staticDir]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Owned restore process fixture</title>", { mode: 0o600 });
    writeFileSync(preloadPath, `
import { appendFileSync } from "node:fs";
import { Socket } from "node:net";
const recordAndBlock = (kind, detail = "") => {
  appendFileSync(${JSON.stringify(networkLog)}, JSON.stringify({ kind, detail }) + "\\n");
  throw new Error("outbound network disabled in restore process fixture");
};
globalThis.fetch = async (input) => recordAndBlock("fetch", String(input));
Socket.prototype.connect = function (...args) {
  const first = args[0];
  const detail = first && typeof first === "object"
    ? String(first.host ?? first.hostname ?? "") + ":" + String(first.port ?? "")
    : String(first) + ":" + String(args[1] ?? "");
  return recordAndBlock("socket connect", detail);
};
`, { mode: 0o600 });

    makeInstall({
      dataDir: sourceDir,
      id: "bot-archive",
      name: "Archive",
      threadId: "thread-archive",
      groupId: "group-archive",
      messageId: "message-archive",
      messageText: "transcript from the staged archive",
      routineEnabled: true,
      goalStatus: "active",
      configName: "Synthetic source installation",
      authSecret: "synthetic-source-auth-secret-not-for-use",
      withForeignGrants: true,
    });
    writeSyntheticAuthSession(sourceDir);
    makeInstall({
      dataDir,
      id: "bot-live",
      name: "Live target",
      threadId: "thread-live",
      groupId: "group-live",
      messageId: "message-live",
      messageText: "old content still held by the live process",
      routineEnabled: false,
      goalStatus: "stopped",
      configName: "Target installation identity",
      authSecret: "target-auth-secret-owned-by-this-install",
    });

    const targetConfigBefore = readFileSync(join(dataDir, "config.json"));
    const targetAuthSecretBefore = readFileSync(join(dataDir, "auth.secret"));
    expect(existsSync(join(dataDir, "auth.db")), "the disposable target must start without inherited sessions").toBe(false);
    expect(targetConfigBefore.equals(readFileSync(join(sourceDir, "config.json")))).toBe(false);
    expect(targetAuthSecretBefore.equals(readFileSync(join(sourceDir, "auth.secret")))).toBe(false);
    expect(readSessionCountIfPresent(join(sourceDir, "auth.db")), "the source archive fixture contains a synthetic session").toBe(1);

    const payload = buildPayloadV2({ dataDir: sourceDir, appVersion: APP_VERSION });
    const bundle = encryptBundleV2(payload, { passphrase: PASSPHRASE }).toString("utf8");
    const manifestPaths = payload.files.map((file) => file.path).sort();
    expect(manifestPaths).toEqual([
      "MEMORY.md",
      "bots.json",
      "decisions.json",
      "goals.json",
      "groups.json",
      "memory/topic.md",
      "routines.json",
      "social.json",
    ]);
    for (const file of payload.files) {
      const body = Buffer.from(file.bodyB64, "base64");
      expect(body.byteLength, `${file.path} manifest size`).toBe(file.size);
      expect(sha256(body), `${file.path} manifest hash`).toBe(file.sha256);
    }
    const archivedBotFile = payload.files.find((file) => file.path === "bots.json");
    if (!archivedBotFile) throw new Error("the source payload must include bots.json");
    const archivedBots = botListSchema.parse(JSON.parse(Buffer.from(archivedBotFile.bodyB64, "base64").toString("utf8")));
    expect(archivedBots[0]?.resumeCursors).toEqual({ "thread-archive": "source-resume-cursor" });
    for (const excluded of RESTORE_EXCLUDED_ROOT_FILES) {
      expect(manifestPaths, `${excluded} must not be carried by a v2 archive`).not.toContain(excluded);
    }
    expect(RESTORE_EXCLUDED_ROOT_FILES).toContain("auth.db");
    expect(payload.transcripts.threads.map((thread) => thread.threadId)).toEqual(["thread-archive"]);
    expect(payload.transcripts.threads[0]?.messages.map((message) => message.id)).toEqual(["message-archive"]);

    const port = await freePortBlock([0, 1, 2], 46_000, 9_000);
    const base = `http://127.0.0.1:${port}`;
    const networkDeniedImport = `--import=${preloadPath}`;
    const processReceipts: ProcessReceipt[] = [];
    const children: OwnedProcess[] = [];
    let stagedManifest: z.infer<typeof stagingManifestSchema> | undefined;
    let active: OwnedProcess | undefined;

    const startServer = async (phase: string): Promise<OwnedProcess> => {
      const env = pairingServerEnvironment({
        home,
        dataDirectory: dataDir,
        companionDirectory: companionDir,
        staticDir,
        port,
        webhookPort: port + 1,
        // No externally reusable auth key: the server reads this install's
        // own synthetic DATA_DIR/auth.secret because this env is then removed.
        secret: "temporary-unused-test-environment-secret",
      });
      delete env.BETTER_AUTH_SECRET;
      env.OMB_HOST = "127.0.0.1";
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} ${networkDeniedImport}`.trim();
      const providerKeys = Object.keys(env).filter((key) => /(?:API_KEY|TOKEN|SECRET)$/u.test(key) && key !== "NODE_OPTIONS");
      expect(providerKeys, "child starts without inherited provider credentials").toEqual([]);

      const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
        cwd: ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const owned: OwnedProcess = { phase, child, stdout: "", stderr: "", stopped: false };
      child.stdout?.on("data", (chunk: Buffer | string) => {
        owned.stdout = (owned.stdout + String(chunk)).slice(-OUTPUT_LIMIT);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        owned.stderr = (owned.stderr + String(chunk)).slice(-OUTPUT_LIMIT);
      });
      children.push(owned);
      active = owned;
      if (!child.pid) throw new Error(`${phase}: server child did not get a PID`);
      await waitForOwnedServer(child, base, { timeoutMs: 30_000 });
      return owned;
    };

    const stopServer = async (owned: OwnedProcess): Promise<void> => {
      if (owned.stopped) return;
      const pid = owned.child.pid;
      await waitForExit(owned.child, { signal: "SIGTERM", graceMs: 5_000 });
      const receipt: ProcessReceipt = {
        phase: owned.phase,
        pid,
        exitCode: owned.child.exitCode,
        signalCode: owned.child.signalCode,
        stderr: owned.stderr.trim().slice(-4_000),
      };
      processReceipts.push(receipt);
      const didExit = receipt.exitCode !== null || receipt.signalCode !== null;
      if (didExit) {
        owned.stopped = true;
        if (active === owned) active = undefined;
      }
      expect(didExit, `${owned.phase} child ${pid} did not exit after SIGTERM and exit wait`).toBe(true);
      expect(receipt.exitCode, `${owned.phase} child ${pid} clean exit code`).toBe(0);
      expect(receipt.signalCode, `${owned.phase} child ${pid} was not force-killed`).toBeNull();
    };

    const assertRestoredState = async () => {
      if (!stagedManifest) throw new Error("the HTTP restore route did not leave a staging manifest to compare");
      const stagedEntries = new Map(stagedManifest.files.map((entry) => [entry.path, entry]));
      const roster = await readRoster(base);
      expect(roster.bots.map((entry) => entry.id)).toEqual(["bot-archive"]);
      expect(roster.groups.map((entry) => entry.id)).toEqual(["group-archive"]);

      const thread = await readThread(base, "thread-archive");
      expect(thread.messages.map((message) => [message.id, message.text])).toEqual([
        ["message-archive", "transcript from the staged archive"],
      ]);

      expect(supportedInventory(dataDir)).toEqual(manifestPaths);
      for (const file of payload.files) {
        const diskBytes = readFileSync(join(dataDir, file.path));
        const stagedEntry = stagedEntries.get(file.path);
        expect(stagedEntry, `${file.path} is listed by the route-generated staging manifest`).toBeDefined();
        if (file.path === "routines.json" || file.path === "goals.json") {
          expect(sha256(diskBytes), `${file.path} hash after its boot safety transform`).toBe(sha256(expectedAfterSafetyTransform(file)));
        } else if (file.path !== "bots.json" && file.path !== "groups.json") {
          // bots/groups are deliberately re-canonicalized by the restore port
          // and Store; all byte-stable paths must match the real stage receipt.
          expect(sha256(diskBytes), `${file.path} persisted hash vs staged manifest`).toBe(stagedEntry!.sha256);
        }
        if (file.path === "routines.json") {
          const routines = routinesDocumentSchema.parse(JSON.parse(diskBytes.toString("utf8")));
          expect(routines.routines[0]).toMatchObject({ enabled: false, nextRunAt: null });
        }
        if (file.path === "goals.json") {
          const goals = goalsDocumentSchema.parse(JSON.parse(diskBytes.toString("utf8")));
          expect(goals.goals[0]?.status).toBe("stopped");
        }
      }
      const restoredBot = botListSchema.parse(JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")))[0];
      if (!restoredBot) throw new Error("the restored bot file must contain its archive record");
      expect(restoredBot).toMatchObject({
        id: "bot-archive",
        threadId: "thread-archive",
        name: "Archive",
        composio: false,
        browser: false,
        resumeCursors: {},
      });
      for (const grant of ["alwaysAllow", "autoApprove", "approvePeerComms", "ownerId"]) {
        expect(restoredBot, `foreign grant ${grant} must not reactivate`).not.toHaveProperty(grant);
      }
      const restoredGroup = groupListSchema.parse(JSON.parse(readFileSync(join(dataDir, "groups.json"), "utf8")))[0];
      if (!restoredGroup) throw new Error("the restored group file must contain its archive record");
      expect(restoredGroup).toMatchObject({
        id: "group-archive",
        threadId: "thread-group-archive",
        name: "Archive room",
        memberIds: ["bot-archive"],
        defaultResponder: { botId: "bot-archive", kind: "member" },
      });

      const expectedTranscript = payload.transcripts.threads.flatMap((thread) =>
        thread.messages.map((message) => ({ threadId: thread.threadId, id: message.id, text: message.text, json: message.json })),
      );
      const persistedTranscript = readPersistedTranscript(join(dataDir, "messages.db"));
      expect(persistedTranscript.map(({ threadId, id, text, json }) => ({ threadId, id, text, json }))).toEqual(expectedTranscript);
      expect(new Set(persistedTranscript.map((row) => row.threadId))).toEqual(new Set(payload.transcripts.threads.map((thread) => thread.threadId)));

      expect(readFileSync(join(dataDir, "config.json")).equals(targetConfigBefore), "target config is excluded and remains byte-identical").toBe(true);
      expect(readFileSync(join(dataDir, "auth.secret")).equals(targetAuthSecretBefore), "target installation signing identity remains byte-identical").toBe(true);
      expect(readSessionCountIfPresent(join(dataDir, "auth.db")), "no session is imported from the source archive").toBe(0);
    };

    try {
      const first = await startServer("stage-only process");
      const oldRoster = await readRoster(base);
      expect(oldRoster.bots.map((entry) => entry.id)).toEqual(["bot-live"]);
      expect(oldRoster.groups.map((entry) => entry.id)).toEqual(["group-live"]);
      const oldThread = await readThread(base, "thread-live");
      expect(oldThread.messages.map((message) => [message.id, message.text])).toEqual([
        ["message-live", "old content still held by the live process"],
      ]);
      expect(readSessionCountIfPresent(join(dataDir, "auth.db"))).toBe(0);

      const staged = await requestJson(base, "/api/workspace/v2/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: PASSPHRASE, payload: bundle, confirm: true }),
      });
      expect(staged.status).toBe(200);
      expect(staged.body).toMatchObject({ staged: true, restartRequired: true });
      expect(existsSync(targetStagingDir)).toBe(true);
      stagedManifest = stagingManifestSchema.parse(JSON.parse(readFileSync(join(targetStagingDir, ".muster-restore-staging.json"), "utf8")));
      expect(stagedManifest.files.map((entry) => entry.path).filter((path) => path !== "messages.db").sort()).toEqual(manifestPaths);
      expect(stagedManifest.files.map((entry) => entry.path).sort()).toEqual([...manifestPaths, "messages.db"].sort());
      for (const entry of stagedManifest.files) {
        const stagedBytes = readFileSync(join(targetStagingDir, entry.path));
        expect(stagedBytes.byteLength, `${entry.path} stage receipt size`).toBe(entry.size);
        expect(sha256(stagedBytes), `${entry.path} stage receipt hash`).toBe(entry.sha256);
        if (entry.path === "messages.db") continue;
        const payloadFile = payload.files.find((file) => file.path === entry.path);
        if (!payloadFile) throw new Error(`${entry.path}: stage manifest path has no corresponding payload file`);
        const payloadBytes = Buffer.from(payloadFile.bodyB64, "base64");
        const expectedStageBytes = entry.path === "bots.json" || entry.path === "groups.json"
          ? expectedAfterSafetyTransform(payloadFile)
          : payloadBytes;
        expect(stagedBytes.equals(expectedStageBytes), `${entry.path} staged bytes vs payload (or explicit canonicalization)`).toBe(true);
        expect(entry.sha256, `${entry.path} stage-manifest hash vs payload (or explicit canonicalization)`).toBe(sha256(expectedStageBytes));
        expect(entry.size, `${entry.path} stage-manifest size vs payload (or explicit canonicalization)`).toBe(expectedStageBytes.byteLength);
      }
      const expectedStagedTranscript = payload.transcripts.threads.flatMap((thread) =>
        thread.messages.map((message) => ({ threadId: thread.threadId, id: message.id, text: message.text, json: message.json })),
      );
      const stagedTranscript = readPersistedTranscript(join(targetStagingDir, "messages.db"));
      expect(stagedTranscript.map(({ threadId, id, text, json }) => ({ threadId, id, text, json }))).toEqual(expectedStagedTranscript);
      const stagedBots = stagedBotListSchema.parse(JSON.parse(readFileSync(join(targetStagingDir, "bots.json"), "utf8")));
      const stagedBot = stagedBots[0];
      if (!stagedBot) throw new Error("the staged bot file must contain its archive record");
      expect(stagedBot).toMatchObject({ id: "bot-archive", composio: false, browser: false });
      expect(stagedBot).not.toHaveProperty("resumeCursors");
      for (const grant of ["alwaysAllow", "autoApprove", "approvePeerComms", "ownerId"]) {
        expect(stagedBot, `staged foreign grant ${grant} must not reactivate`).not.toHaveProperty(grant);
      }
      expect(readFileSync(join(dataDir, "bots.json"), "utf8")).toContain("bot-live");
      expect((await readRoster(base)).bots.map((entry) => entry.id)).toEqual(["bot-live"]);
      expect((await readThread(base, "thread-live")).messages[0]?.text).toBe("old content still held by the live process");
      const statusWhileRunning = await requestJson(base, "/api/workspace/v2/status");
      expect(statusWhileRunning.body).toMatchObject({ pending: { source: "file" }, receipt: null });
      await stopServer(first);

      // This is a fresh production entry-point process. server/index.ts calls
      // bootWithRestoreFirst(DATA_DIR, () => new Store(...)) synchronously before
      // listening, so readiness implies the real boot apply and Store load ran.
      const second = await startServer("first boot applying restore");
      await assertRestoredState();
      expect(existsSync(join(dataDir, "pending-restore.json"))).toBe(false);
      expect(existsSync(targetStagingDir)).toBe(false);
      const receiptPath = join(dataDir, "last-restore.json");
      const receiptBytesAfterApply = readFileSync(receiptPath);
      const receipt = restoreReceiptSchema.parse(JSON.parse(receiptBytesAfterApply.toString("utf8")));
      expect(receipt.status).toBe("committed");
      expect(receipt.backupDir).toBeDefined();
      const backupDir = receipt.backupDir;
      if (!backupDir) throw new Error("the committed receipt must point to the target safety copy");
      expect(existsSync(join(backupDir, "bots.json"))).toBe(true);
      const backupBots = botListSchema.parse(JSON.parse(readFileSync(join(backupDir, "bots.json"), "utf8")));
      const backedUpBot = backupBots[0];
      if (!backedUpBot) throw new Error("the target safety copy must contain its original bot");
      expect(backedUpBot).toMatchObject({ id: "bot-live" });
      const safetyCopyNamesAfterApply = readdirSync(targetBackupsDir).sort();
      expect(safetyCopyNamesAfterApply).toEqual([backupDir.slice(targetBackupsDir.length + 1)]);
      await stopServer(second);

      // A second fresh restart has no pending work: it must not apply again,
      // make another safety copy, or let a stale Store write the old roster.
      const third = await startServer("second post-restore restart");
      await assertRestoredState();
      expect(existsSync(join(dataDir, "pending-restore.json"))).toBe(false);
      expect(existsSync(targetStagingDir)).toBe(false);
      expect(readFileSync(receiptPath).equals(receiptBytesAfterApply), "a no-op restart must not rewrite the committed receipt").toBe(true);
      expect(readdirSync(targetBackupsDir).sort()).toEqual(safetyCopyNamesAfterApply);
      await stopServer(third);
      expect(processReceipts).toHaveLength(3);

      const blockedNetworkAttempts = existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "";
      // Startup may probe the public model catalog. The child preload rejects
      // fetch/socket calls before DNS/TCP; retain the denied-attempt log rather
      // than treating a blocked call as contact with a real service.
      if (blockedNetworkAttempts) console.info(`[restore-process-restart] blocked-network-attempts=${blockedNetworkAttempts.trim()}`);
    } finally {
      try {
        if (active) await stopServer(active);
      } finally {
        // Keep the child PID, exit result, and captured stderr visible in the
        // focused test log as a cleanup receipt for this isolated run.
        await removeTempDir(root);
        console.info(`[restore-process-restart] ${JSON.stringify({ children: processReceipts, tempRootRemoved: !existsSync(root) })}`);
        expect(existsSync(root), "all owned children exited before the disposable fixture root was removed").toBe(false);
      }
    }
  }, 120_000);
});
