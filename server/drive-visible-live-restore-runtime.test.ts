import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { applyLiveAccountRestore, LiveRestoreResult, LiveRestoreRuntime } from "./drive-visible-live-restore.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import type { TaskPlanEngine } from "./task-engine.ts";
import type { ModelSelection } from "./contracts.ts";
import type { FollowUpAccount } from "./follow-up-identity.ts";
import { holdRestoreRootIdentity, type RestoreRootIdentity } from "./drive-visible-live-writer-authority.ts";
import { acquireDataDirExclusivity } from "./data-dir-exclusivity.ts";
import { createLiveRestoreRuntime, productionLiveRestoreRegistration } from "./drive-visible-live-restore-runtime.ts";
import { userInstanceOwner } from "./user-keys.ts";

interface LiveFixture {
  runtime: LiveRestoreRuntime;
  authority: RestoreRootIdentity;
  resolveAccount: () => import("./drive-visible-account-bundle.ts").AuthenticatedVisibleAccount | null;
  archive: Buffer; digest: string; selection: ModelSelection;
  store: Store; plans: TaskPlanEngine; foreign: BotRecord;
  aliceAccount: FollowUpAccount; originalBots: string;
}
let parent: string, ownedRoot: string, authorityOnlyRoot: string;
let fix: LiveFixture;
let importer: typeof import("./drive-visible-live-restore.ts"), mdb: typeof import("./message-db.ts");
const published: Array<{ account: { userId: string; workspaceId: string }; bots: string[]; groups: string[] }> = [];
const held: RestoreRootIdentity[] = [];
const botsFile = () => join(ownedRoot, "bots.json");
const bytes = (path: string) => readFileSync(path, "utf8");
const applyRestore = (extra: Partial<Parameters<typeof applyLiveAccountRestore>[0]> = {}) =>
  importer.applyLiveAccountRestore({ runtime: fix.runtime, resolveAccount: fix.resolveAccount, archive: fix.archive,
    key: { custody: "user-held", passphrase: "SYNTHETIC-OFFLINE-RECOVERY" }, selection: fix.selection,
    expectedSourceDigest: fix.digest, operationId: randomUUID(), ...extra });
/** The single-operation journal lists exactly one id after any settle. */
async function receiptStatus(): Promise<{ status: string; phase: string; count: number }> {
  const journal = await import("./drive-visible-live-journal.ts");
  const holder = journal.openLiveJournal(ownedRoot);
  try {
    const ids = holder.list();
    if (ids.length !== 1) throw new Error(`Unexpected journal entries: ${ids.length}`);
    const entry = holder.load(ids[0]!);
    if (!entry) throw new Error("Journal entry vanished");
    return { count: 1, ...entry.receipt };
  } finally { holder.release(); }
}

beforeEach(async () => {
  vi.resetModules(); published.length = 0;
  parent = realpathSync(mkdtempSync(join(tmpdir(), "muster-live-writer-")));
  ownedRoot = join(parent, "data"); mkdirSync(ownedRoot, { mode: 0o755 });
  authorityOnlyRoot = mkdtempSync(join(parent, "authority-only-"));
  vi.stubEnv("OMB_DATA_DIR", ownedRoot);
  const [s, m, p, i, archive, settings, identity, fake] = await Promise.all([
    import("./store.ts"), import("./message-db.ts"), import("./task-engine.ts"),
    import("./drive-visible-live-restore.ts"), import("./drive-visible-account-archive.ts"),
    import("./drive-visible-settings.ts"), import("./follow-up-identity.ts"), import("./testing/fake-driver.ts")]);
  mdb = m; importer = i;
  const auth = new DatabaseSync(join(ownedRoot, "auth.db"));
  auth.exec(`CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE member(id TEXT PRIMARY KEY,userId TEXT,organizationId TEXT,createdAt INTEGER);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,activeOrganizationId TEXT,expiresAt INTEGER);
    CREATE TABLE account(userId TEXT,providerId TEXT,accountId TEXT);
    INSERT INTO user VALUES('alice'),('bob');INSERT INTO organization VALUES('alice-org'),('bob-org');
    INSERT INTO member VALUES('alice-member','alice','alice-org',1),('bob-member','bob','bob-org',1);
    INSERT INTO account VALUES('alice','google','alice-google'),('bob','google','bob-google');`);
  auth.prepare("INSERT INTO session VALUES('alice-session','alice','alice-org',?)").run(Date.now() + 60_000);
  const resolveAccount = () => {
    const session = z.object({ id: z.string().min(1), userId: z.string().min(1) })
      .safeParse(auth.prepare("SELECT id,userId FROM session WHERE id='alice-session' AND expiresAt>?").get(Date.now()));
    if (!session.success) return null;
    const account = identity.resolveFollowUpAccount(auth, { userId: session.data.userId, sessionId: session.data.id }, false);
    const google = z.object({ accountId: z.string().min(1) })
      .safeParse(auth.prepare("SELECT accountId FROM account WHERE userId=? AND providerId='google'").get(session.data.userId));
    return account && google.success ? { account, googleSub: google.data.accountId } : null;
  };
  const selection = { instanceId: "fakeApi:alice", model: "fake-1" };
  const store = new s.Store(() => selection), plans = new p.TaskPlanEngine({ file: join(ownedRoot, "task-plans.json") });
  const own = store.createBot({ ownerId: "alice", name: "Original", modelSelection: selection }, { seedMessages: false });
  const peer = store.createBot({ ownerId: "alice", name: "Peer", modelSelection: selection }, { seedMessages: false });
  const foreign = store.createBot({ ownerId: "bob", name: "Foreign", modelSelection: { instanceId: "fakeApi:bob", model: "fake-1" } }, { seedMessages: false });
  const rows: Message[] = [
    { id: "root", parentId: null, at: 1, role: "user", kind: "text", text: "Root" },
    { id: "older", parentId: "root", at: 2, role: "bot", kind: "text", text: "Selected older" },
    { id: "newer", parentId: "root", at: 3, role: "bot", kind: "text", text: "Newer fork" }];
  mdb.replaceThreadFromSync(own.threadId, rows, "older");
  mdb.replaceThreadFromSync(peer.threadId, [], null); mdb.replaceThreadFromSync(foreign.threadId, [], null);
  store.createGroup("Original room", [own.id, peer.id], false, "alice", { kind: "member", botId: peer.id });
  plans.create({ botId: own.id, ownerId: "alice", threadId: own.threadId, title: "Original plan", steps: ["Keep"], start: false });
  plans.create({ botId: foreign.id, ownerId: "bob", threadId: foreign.threadId, title: "Foreign plan", steps: ["Remain"], start: false });
  for (const bot of [own, peer, foreign]) mkdirSync(join(ownedRoot, "workspaces", bot.id), { recursive: true });
  const aliceAccount = resolveAccount()!.account;
  settings.captureAccountSettings(auth, aliceAccount, { theme: "dark" });
  const built = archive.buildAccountRecoveryArchive({
    source: { account: aliceAccount, dataDir: ownedRoot, store, plans, settingsSnapshot: settings.readAccountSettings(auth, aliceAccount)! },
    resolveAccount, key: { custody: "user-held", passphrase: "SYNTHETIC-OFFLINE-RECOVERY" }, appVersion: "test" });
  if (built.status !== "ready") throw Error(JSON.stringify(built));
  const fakeHandle = fake.makeFakeDriver();
  const ownedInstance = await fakeHandle.driver.create({ instanceId: selection.instanceId, displayName: "Owned engine", environment: {}, enabled: true, config: {} });
  const foreignInstance = await fakeHandle.driver.create({ instanceId: "fakeApi:bob", displayName: "Foreign engine", environment: {}, enabled: true, config: {} });
  const instances = [ownedInstance, foreignInstance];
  const authority = holdRestoreRootIdentity(ownedRoot); held.push(authority);
  const runtime = createLiveRestoreRuntime({
    dataDir: ownedRoot, store, plans, rootIdentity: authority, instances: () => [...instances],
    readAccountSettings: account => settings.readAccountSettings(auth, account),
    engineChoices: (account) => instances.filter(instance => instance.enabled
      && userInstanceOwner(instance.instanceId) === account.userId && instance.models.options.length > 0)
      .slice(0, 64).map(instance => ({ label: "Fixture engine", selection: { instanceId: instance.instanceId, model: instance.models.options[0]!.id } })),
    publishRecords: (account, ids) => { published.push({ account, bots: ids.bots, groups: ids.groups }); },
  });
  const inspected = archive.inspectAccountRecoveryArchive({ bytes: built.bytes, key: { custody: "user-held", passphrase: "SYNTHETIC-OFFLINE-RECOVERY" }, resolveAccount });
  if (inspected.status !== "ready") throw Error("No real archive inspection");
  fix = { runtime, authority, resolveAccount, archive: built.bytes, digest: inspected.state.sourceDigest,
    selection: { instanceId: selection.instanceId, model: selection.model },
    store, plans, foreign, aliceAccount, originalBots: bytes(botsFile()) };
});
afterEach(() => {
  for (const holder of held.splice(0)) { try { holder.release(); } catch { /* already retired */ } }
  published.length = 0; mdb?.closeMessageDb();
  vi.unstubAllEnvs(); rmSync(parent, { recursive: true, force: true });
});

describe("held root identity, without host writer exclusion", () => {
  it("is a held descriptor identity that refuses claims, swaps and release — and takes no request input", () => {
    const holder = holdRestoreRootIdentity(authorityOnlyRoot);
    expect(() => holder.assertReady()).not.toThrow();
    const claim = acquireDataDirExclusivity(authorityOnlyRoot, "root identity probe");
    expect(() => holder.assertReady()).toThrow(/exclusive-restore claim/);
    claim.release();
    expect(() => holder.assertReady()).not.toThrow();
    // A whole-tree swap replaces the directory inode; the capability cannot
    // survive a tree it does not hold.
    const away = join(parent, "whole-tree-away");
    renameSync(authorityOnlyRoot, away);
    mkdirSync(authorityOnlyRoot, { mode: 0o755 });
    expect(() => holder.assertReady()).toThrow();
    rmSync(authorityOnlyRoot, { recursive: true, force: true });
    renameSync(away, authorityOnlyRoot);
    expect(() => holder.assertReady()).not.toThrow();
    holder.release();
    expect(() => holder.assertReady()).toThrow(/released/);
    holder.release();
  });
  it("derives root identity only from held filesystem state, never from a caller-supplied boolean or marker", () => {
    const holder = holdRestoreRootIdentity(authorityOnlyRoot);
    expect(() => holder.assertReady()).not.toThrow();
    // Destroying the directory the capability holds must refuse; nothing the
    // caller passes can change this verdict.
    rmSync(authorityOnlyRoot, { recursive: true, force: true });
    // EVEN a re-created directory at the same path is a foreign tree: the
    // held inode is gone, so nothing re-elevates the verdict.
    mkdirSync(authorityOnlyRoot, { mode: 0o755 });
    expect(() => holder.assertReady()).toThrow(/real directory/);
    holder.release();
  });
  it("does not exclude an owned same-UID child using a pre-opened file descriptor and SQLite connection", () => {
    const file = join(authorityOnlyRoot, "external-writer.txt"), sqlFile = join(authorityOnlyRoot, "external-writer.db");
    writeFileSync(file, "before-raw-writer");
    const fd = openSync(file, "r+");
    const db = new DatabaseSync(sqlFile);
    db.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('before-sql-writer')");
    const holder = holdRestoreRootIdentity(authorityOnlyRoot); held.push(holder);
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { writeSync, fsyncSync } from "node:fs";
        import { DatabaseSync } from "node:sqlite";
        const raw = Buffer.from("newer-raw-writer!");
        writeSync(3, raw, 0, raw.length, 0); fsyncSync(3);
        const db = new DatabaseSync(process.argv[1]);
        db.exec("UPDATE evidence SET value='newer-sql-writer'"); db.close();
        console.log(JSON.stringify({ uid: process.getuid?.(), wroteRaw: true, wroteSql: true }));
      `, sqlFile], { stdio: ["ignore", "pipe", "pipe", fd], timeout: 10_000,
        env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
      expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ uid: process.getuid?.(), wroteRaw: true, wroteSql: true });
      expect(readFileSync(file, "utf8")).toBe("newer-raw-writer!");
      expect(db.prepare("SELECT value FROM evidence").get()).toEqual({ value: "newer-sql-writer" });
      expect(holder.kind).toBe("root-identity-only");
      // These foreign writes changed no directory identity or restore claim.
      // Passing this assertion is the counterexample, never exclusion proof.
      expect(() => holder.assertReady()).not.toThrow();
    } finally { closeSync(fd); db.close(); }
  });

});

describe("owned cooperating runtime factory under the root identity handle", () => {
  it("mirrors the running registry's owned engine, the real settings reader and bounded engine choices", () => {
    const owned = fix.runtime.resolveEngine!(fix.selection, fix.aliceAccount);
    expect(owned).toMatchObject({ ownerId: "alice", selection: fix.selection,
      instance: { instanceId: "fakeApi:alice", enabled: true, driverKind: "fake" } });
    expect(fix.runtime.resolveEngine!({ instanceId: "fakeApi:bob", model: "fake-1" }, fix.aliceAccount)).toBeNull();
    expect(fix.runtime.resolveEngine!({ instanceId: "unownedOther:alice", model: "anything" }, fix.aliceAccount)).toBeNull();
    expect(fix.runtime.readSettings!(fix.aliceAccount)).toMatchObject({ userId: "alice", workspaceId: "alice-org" });
    expect(fix.runtime.readSettings!({ userId: "bob", workspaceId: "bob-org", sessionId: "none", isPrimary: false })).toBeNull();
    expect(fix.runtime.engineChoices?.(fix.aliceAccount)).toEqual([{ label: "Fixture engine",
      selection: { instanceId: "fakeApi:alice", model: "fake-1" } }]);
    expect(fix.runtime.engineChoices?.({ userId: "bob", workspaceId: "bob-org", sessionId: "none", isPrimary: false }))
      .toEqual([{ label: "Fixture engine", selection: { instanceId: "fakeApi:bob", model: "fake-1" } }]);
    expect(resolve(fix.runtime.dataDir)).toBe(resolve(ownedRoot));
  });

  it("applies the additive restore through an owned cooperating runtime and publishes restored records", async () => {
    const committed: LiveRestoreResult = await applyRestore();
    expect(committed).toMatchObject({ status: "committed", scope: "account-owned", mode: "additive",
      execution: "not-started", rollback: "pending-only", durability: "process-restart-only" });
    expect(fix.store.bots).toHaveLength(5);
    expect(published).toHaveLength(1);
    expect(published[0]!.account).toEqual({ userId: "alice", workspaceId: "alice-org" });
    expect(published[0]!.bots).toEqual(Object.values(committed.mapping.bot));
    expect(published[0]!.groups).toEqual(Object.values(committed.mapping.group));
    for (const botId of published[0]!.bots) expect(fix.store.bot(botId)).toMatchObject({ ownerId: "alice" });
    for (const groupId of published[0]!.groups) expect(fix.store.group(groupId)).toMatchObject({ ownerId: "alice" });
    // Restored scope only: the unrelated account's thread id is never a target.
    expect(Object.values(committed.mapping.thread)).not.toContain(fix.foreign.threadId);
    expect(bytes(botsFile())).not.toBe(fix.originalBots);
    expect(await receiptStatus()).toMatchObject({ count: 1, status: "committed", phase: "committed" });
  });

  it("refuses apply while whole-tree restore machinery holds a real claim, and commits after release", async () => {
    const claim = acquireDataDirExclusivity(ownedRoot, "whole-tree restore holds the marker");
    await expect(applyRestore()).rejects.toThrow(/exclusive-restore claim/);
    expect(bytes(botsFile())).toBe(fix.originalBots);
    claim.release();
    const committed: LiveRestoreResult = await applyRestore();
    expect(committed.status).toBe("committed");
    expect(fix.store.bots).toHaveLength(5);
    expect(await receiptStatus()).toMatchObject({ count: 1, status: "committed" });
  });

  it("revalidates root identity at every boundary: retiring it mid-restore rolls back the affected scope", async () => {
    await expect(applyRestore({ onPhase: phase => { if (phase === "plans") fix.authority.release(); } }))
      .rejects.toMatchObject({ code: "rolled-back" });
    expect(bytes(botsFile())).toBe(fix.originalBots);
    expect(fix.store.bots).toHaveLength(3);
    expect(fix.store.bot(fix.foreign.id)).toMatchObject({ name: "Foreign" });
    expect(mdb.recoveryThreadIds()).toHaveLength(3);
    expect(fix.plans.listPlans()).toHaveLength(2);
    expect(await receiptStatus()).toMatchObject({ count: 1, status: "rolled-back", phase: "compensated" });
    // A released capability re-adopts nothing; a fresh hold is a new proof.
    const next = holdRestoreRootIdentity(ownedRoot); held.push(next);
    expect(() => next.assertReady()).not.toThrow();
  });

  it("excludes a deferred in-process writer during the synchronous frame and resumes it after release", async () => {
    let frameBytes = "", resumed = false;
    await expect(applyRestore({ onPhase: phase => {
      if (phase === "readback") frameBytes = bytes(botsFile());
      if (phase === "roster") setImmediate(() => {
        resumed = true;
        fix.store.patchBot(fix.foreign.id, { name: "Postframe foreign update" });
      });
    } })).resolves.toMatchObject({ status: "committed" });
    // The synchronous frame has returned; give the resumed writer its own
    // macrotask slot and then observe its newer bytes.
    await new Promise((taskDone) => setImmediate(taskDone));
    // The queued genuine store writer could only run after the synchronous
    // commit/compensation frame returned: the postimage observed during the
    // frame stayed exactly the committed bytes, and the resumed bytes then
    // carried the writer's newer name.
    expect(resumed).toBe(true);
    expect(bytes(botsFile())).not.toBe(frameBytes);
    expect(bytes(botsFile())).toContain("Postframe foreign update");
    expect(fix.store.bots).toHaveLength(5);
    expect(mdb.readThreadSnapshot(fix.foreign.threadId)).toMatchObject({ messages: [] });
    expect(await receiptStatus()).toMatchObject({ count: 1, status: "committed", phase: "committed" });
  });

  it("detects and refuses a mid-frame newer save, preserving its newer bytes instead of overwriting", async () => {
    let saved = false;
    await expect(applyRestore({ onPhase: phase => {
      if (phase === "roster") { saved = true; fix.store.patchBot(fix.foreign.id, { name: "Newer midframe foreign save" }); }
    } })).rejects.toMatchObject({ code: "rollback-failed" });
    expect(saved).toBe(true);
    expect(bytes(botsFile())).toContain("Newer midframe foreign save");
    expect(mdb.readThreadSnapshot(fix.foreign.threadId)).toMatchObject({ messages: [] });
    expect(await receiptStatus()).toMatchObject({ count: 1, status: "rollback-failed" });
  });
});


describe("production live restore registration stays refused", () => {
  it.each([undefined, "1"])("refuses actual apply/receipt routes before any account or data access with flag %s", async (flag) => {
    vi.stubEnv("OMB_LIVE_RESTORE_APPLY", flag);
    const { handleVisibleDriveRoute, VISIBLE_DRIVE_ROUTE_PREFIX } = await import("./drive-visible-routes.ts");
    const before = { files: readdirSync(ownedRoot).sort(), bots: bytes(botsFile()) };
    const touched = vi.fn(() => { throw new Error("Refused registration must not touch account, source or transport"); });
    const registration = productionLiveRestoreRegistration();
    expect(registration).not.toHaveProperty("liveRestore");
    const server = createServer((request, response) => {
      void handleVisibleDriveRoute(request, response, request.method ?? "POST", new URL(request.url ?? "/", "http://127.0.0.1").pathname, {
        db: touched, publicBaseUrl: "http://127.0.0.1", deploymentSecret: touched,
        operator: touched, appVersion: "owned-refused-registration", google: { clientId: "", clientSecret: "" },
        source: touched, session: async () => touched(), fetch: touched,
        ...registration,
      }).catch(error => { response.writeHead(500); response.end(String(error)); });
    });
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    try {
      const address = z.object({ address: z.literal("127.0.0.1"), family: z.literal("IPv4"),
        port: z.number().int().min(1).max(65_535) }).strict().parse(server.address());
      for (const action of ["restore/apply", "restore/receipt"]) {
        const response = await fetch(`http://127.0.0.1:${address.port}${VISIBLE_DRIVE_ROUTE_PREFIX}/${action}`, {
          method: "POST", body: "not a valid request", redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "visible-route-unavailable" });
      }
      expect(touched).not.toHaveBeenCalled(); expect(published).toHaveLength(0);
      expect({ files: readdirSync(ownedRoot).sort(), bots: bytes(botsFile()) }).toEqual(before);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      expect(server.listening).toBe(false);
    }
  });
});
