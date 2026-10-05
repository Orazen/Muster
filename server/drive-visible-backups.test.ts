import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAccountVisibleBackup, writeAccountRecoveryBackup, MAX_VISIBLE_RECOVERY_COPY_BYTES, VisibleBackupError, type VisibleBackupClient } from "./drive-visible-backups.ts";
import type { AuthenticatedVisibleAccount } from "./drive-visible-account-bundle.ts";
import type { DriveFileRef } from "./drive-visible.ts";
import * as archiveCodec from "./drive-visible-account-archive.ts";
import * as visibleParser from "./drive-visible.ts";
import { Store } from "./store.ts";
import { TaskPlanEngine } from "./task-engine.ts";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { decryptBundleV2 } from "./workspace-bundle-v2.ts";

const account = { userId: "alice", sessionId: "alice-session", workspaceId: "alice-workspace", isPrimary: false };
const authority = { account, googleSub: "verified-google-subject" };
const folder = (id: string, name: string, parent: string): DriveFileRef => ({ id, name, parents: [parent], mimeType: "application/vnd.google-apps.folder" });
describe("explicit immutable encrypted account copies", () => {
  let root: string;
  let current: AuthenticatedVisibleAccount | null;
  let validLease: boolean;
  let stored: Buffer;
  let source: Parameters<typeof writeAccountVisibleBackup>[0]["bundle"]["source"];
  let client: VisibleBackupClient;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "muster-visible-copy-"));
    mkdirSync(join(root, "workspaces", "own"), { recursive: true });
    writeFileSync(join(root, "workspaces", "own", "MEMORY.md"), "Account-owned memory");
    current = authority; validLease = true; stored = Buffer.alloc(0);
    source = { account, dataDir: root,
      settingsSnapshot: { userId: account.userId, workspaceId: account.workspaceId, values: { theme: "dark" } },
      store: { bots: [{ id: "own", ownerId: account.userId, threadId: "own-thread", name: "Own", title: "Own",
        description: "Own persona", notifications: false, unread: false, color: "green", createdAt: 1,
        modelSelection: { instanceId: "offline", model: "test" }, tasks: [], resumeCursors: {} }], groups: [],
        snapshotThread: () => ({ status: "ready", source: "sqlite", activeLeafId: "m", messages: [
          { id: "m", role: "user", kind: "text", at: 1, text: "Account-owned transcript", parentId: null },
        ] }) }, plans: { listPlans: () => [] } };
    client = {
      resolveRootId: vi.fn(async () => "root-id"),
      listFiles: vi.fn(async args => args.q.includes("name = 'Muster'") ? [folder("visible", "Muster", "root-id")]
        : args.q.includes("name = 'backups'") ? [folder("backups", "backups", "visible")] : []),
      createFolder: vi.fn(async (name, parent) => folder(name === "Muster" ? "visible" : "backups", name, parent)),
      createBinaryFile: vi.fn(async (name, parent, bytes) => {
        stored = Buffer.from(bytes);
        return { id: "encrypted-copy", name, parents: [parent], mimeType: "application/octet-stream" };
      }),
      getBinaryFile: vi.fn(async () => ({ body: Buffer.from(stored) })),
      createFile: vi.fn(async () => { throw new Error("Forbidden text creation"); }),
      getFile: vi.fn(async () => { throw new Error("Forbidden text reading"); }),
      updateFile: vi.fn(async () => { throw new Error("Forbidden overwrite"); }),
    };
  });
  afterEach(() => { vi.restoreAllMocks(); closeMessageDb(); rmSync(root, { recursive: true, force: true }); });
  const input = (): Parameters<typeof writeAccountVisibleBackup>[0] => ({
    bundle: { source, resolveAccount: () => current, appVersion: "1.23.3",
      key: { custody: "user-held", passphrase: "synthetic-user-owned-recovery",
        kdf: { name: "scrypt", N: 16384, r: 8, p: 1, keyLen: 32, saltB64: "" } } },
    lease: { googleSub: authority.googleSub, assertCurrent: () => { if (!validLease) throw new Error("Revoked"); },
      run: async operation => operation("SYNTHETIC-TOKEN") }, client,
  });

  it("copies real encrypted six-entry payload, downloads it and reports projection limitations", async () => {
    const result = await writeAccountVisibleBackup(input());
    expect(result).toMatchObject({ status: "verified", scope: "account-owned", apply: "unsupported", created: true,
      fileId: "encrypted-copy", visibleFolderId: "visible", backupFolderId: "backups", bytes: stored.length });
    expect(result.name).toMatch(/^muster-account-visible-v1-[a-f0-9]{64}\.enc$/);
    const opened = decryptBundleV2(stored, { passphrase: input().bundle.key.passphrase });
    expect(opened.status).toBe("ok"); expect(opened.payload?.files).toHaveLength(6);
    expect(stored.toString()).not.toContain("Account-owned transcript");
    expect(stored.toString()).not.toContain("synthetic-user-owned-recovery");
    expect(client.createFile).not.toHaveBeenCalled(); expect(client.updateFile).not.toHaveBeenCalled();
    expect(client.getBinaryFile).toHaveBeenCalledOnce();
    expect(result.unsupported).toContain("runtime-apply");
  });
  it("creates missing folders under the exact parent only", async () => {
    client.listFiles = vi.fn(async () => []);
    expect((await writeAccountVisibleBackup(input())).status).toBe("verified");
    expect(client.createFolder).toHaveBeenNthCalledWith(1, "Muster", "root-id");
    expect(client.createFolder).toHaveBeenNthCalledWith(2, "backups", "visible");
  });
  it("adopts an existing authenticated same-source copy on retry instead of overwriting or duplicating", async () => {
    const first = await writeAccountVisibleBackup(input());
    const originalBytes = Buffer.from(stored);
    const previous = client.listFiles;
    client.listFiles = async args => args.q.includes("muster-account-visible-v1-")
      ? [{ id: first.fileId, name: first.name, parents: ["backups"], mimeType: "application/octet-stream" }] : previous(args);
    const second = await writeAccountVisibleBackup(input());
    expect(second).toEqual({ ...first, created: false });
    expect(stored).toEqual(originalBytes); expect(client.createBinaryFile).toHaveBeenCalledOnce();
    expect(client.updateFile).not.toHaveBeenCalled();
  });
  it.each(["visible", "backups"])("refuses duplicate %s folders before creating an encrypted copy", async level => {
    client.listFiles = vi.fn(async args => args.q.includes("name = 'Muster'")
      ? [folder("visible", "Muster", "root-id"), ...(level === "visible" ? [folder("other", "Muster", "root-id")] : [])]
      : [folder("backups", "backups", "visible"), folder("other-backups", "backups", "visible")]);
    await expect(writeAccountVisibleBackup(input())).rejects.toMatchObject({ code: "ambiguous-folder" });
    expect(client.createBinaryFile).not.toHaveBeenCalled();
  });
  it("refuses duplicate encrypted names without choosing or overwriting", async () => {
    const previous = client.listFiles;
    client.listFiles = vi.fn(async args => args.q.includes("muster-account-visible-v1-")
      ? [folder("copy-one", "ambiguous", "backups"), folder("copy-two", "ambiguous", "backups")] : previous(args));
    await expect(writeAccountVisibleBackup(input())).rejects.toMatchObject({ code: "ambiguous-copy" });
    expect(client.createBinaryFile).not.toHaveBeenCalled(); expect(client.updateFile).not.toHaveBeenCalled();
  });
  it.each(["name", "parent", "mime", "id"])("rejects mismatched returned copy %s", mismatch => {
    client.createBinaryFile = vi.fn(async (name, parent, bytes) => {
      stored = Buffer.from(bytes);
      return { id: mismatch === "id" ? "../outside" : "created", name: mismatch === "name" ? "other.enc" : name,
        parents: [mismatch === "parent" ? "foreign-parent" : parent], mimeType: mismatch === "mime" ? "text/plain" : "application/octet-stream" };
    });
    return expect(writeAccountVisibleBackup(input())).rejects.toMatchObject({ code: "invalid-copy" });
  });
  it.each(["same-size", "truncated"])("refuses %s downloaded corruption and preserves the created receipt", async mode => {
    client.getBinaryFile = vi.fn(async () => {
      const changed = Buffer.from(stored);
      changed[0] ^= 1;
      return { body: mode === "truncated" ? changed.subarray(1) : changed };
    });
    await expect(writeAccountVisibleBackup(input())).rejects.toMatchObject({ code: "verification-failed", createdFileId: "encrypted-copy" });
    expect(client.updateFile).not.toHaveBeenCalled();
  });
  it.each(["account", "session", "workspace", "google", "lease"])("stops on %s change between requests", async field => {
    client.listFiles = vi.fn(async () => {
      if (field === "lease") validLease = false;
      else current = { ...authority, account: { ...account,
        userId: field === "account" ? "bob" : account.userId,
        sessionId: field === "session" ? "new" : account.sessionId,
        workspaceId: field === "workspace" ? "other" : account.workspaceId },
        googleSub: field === "google" ? "other-google" : authority.googleSub };
      return [];
    });
    await expect(writeAccountVisibleBackup(input())).rejects.toBeInstanceOf(VisibleBackupError);
    expect(client.createFolder).not.toHaveBeenCalled(); expect(client.createBinaryFile).not.toHaveBeenCalled();
  });
  it("does not report verified after cancellation during read-back", async () => {
    client.getBinaryFile = vi.fn(async () => { validLease = false; return { body: stored }; });
    await expect(writeAccountVisibleBackup(input())).rejects.toMatchObject({ code: "operation-failed", createdFileId: "encrypted-copy" });
  });
  it("preserves the created file ID when cancellation wins during remote creation", async () => {
    const create = client.createBinaryFile;
    client.createBinaryFile = async (...args) => { const result = await create(...args); validLease = false; return result; };
    await expect(writeAccountVisibleBackup(input())).rejects.toMatchObject({ code: "operation-failed", createdFileId: "encrypted-copy" });
    expect(client.getBinaryFile).not.toHaveBeenCalled();
  });
  it("never overwrites a conflicting pre-existing copy even with the expected name", async () => {
    const previous = client.listFiles;
    client.listFiles = async args => {
      if (!args.q.includes("muster-account-visible-v1-")) return previous(args);
      const name = /name = '([^']+)'/.exec(args.q)![1]!;
      return [{ id: "existing", name, parents: ["backups"], mimeType: "application/octet-stream" }];
    };
    client.getBinaryFile = async () => ({ body: Buffer.from("conflicting prior copy") });
    await expect(writeAccountVisibleBackup(input())).rejects.toMatchObject({ code: "verification-failed" });
    expect(client.createBinaryFile).not.toHaveBeenCalled(); expect(client.updateFile).not.toHaveBeenCalled();
  });
  it("sanitizes transport errors without deleting the incomplete remote copy", async () => {
    client.getBinaryFile = vi.fn(async () => { throw new Error("SYNTHETIC-CREDENTIAL-DO-NOT-EXPOSE"); });
    try { await writeAccountVisibleBackup(input()); throw new Error("Expected failure"); }
    catch (error) {
      expect(error).toMatchObject({ name: "VisibleBackupError", code: "operation-failed", createdFileId: "encrypted-copy" });
      expect(String(error)).not.toContain("SYNTHETIC-CREDENTIAL");
    }
    expect(client.updateFile).not.toHaveBeenCalled();
  });
  it("refuses unreadable source and unavailable authority before any remote operation", async () => {
    source = { ...source, settingsSnapshot: null };
    await expect(writeAccountVisibleBackup(input())).rejects.toMatchObject({ code: "bundle-unavailable" });
    current = null;
    await expect(writeAccountVisibleBackup(input())).rejects.toMatchObject({ code: "account-unavailable" });
    expect(client.listFiles).not.toHaveBeenCalled();
  });

  const richInput = (): Parameters<typeof writeAccountRecoveryBackup>[0] => {
    const old = input();
    return { lease: old.lease, client: old.client, archive: { ...old.bundle,
      source: { ...old.bundle.source,
        store: { ...old.bundle.source.store, bots: old.bundle.source.store.bots.map(bot => ({ ...bot,
          tasks: [{ threadId: bot.threadId, title: "Owned task", createdAt: 1, resumeCursors: {} }] })) }, plans: { listPlans: old.bundle.source.plans.listPlans, transitionsFor: () => [] } } } };
  };
  it("backs up real restarted Store branches and actual TaskPlanEngine history with the rich codec", async () => {
    closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true });
    const initial = new Store(() => ({ instanceId: "offline", model: "test" }));
    const own = initial.createBot({ ownerId: account.userId, name: "Own actual bot" }, { seedMessages: false });
    const other = initial.createBot({ ownerId: "bob", name: "Foreign" }, { seedMessages: false });
    const first = initial.appendMessage(own.threadId, { role: "user", kind: "text", text: "Durable root" });
    const selected = initial.appendMessage(own.threadId, { role: "bot", kind: "screen", png: "AA==", mime: "image/png", text: "Selected rich history" });
    const fork = initial.appendMessage(own.threadId, { role: "bot", kind: "activity", parentId: first.id, tool: { name: "Inert historical tool", ok: true } });
    initial.setActiveLeaf(own.threadId, selected.id);
    initial.appendMessage(other.threadId, { role: "user", kind: "text", text: "EXCLUDED-FOREIGN-CONTENT" });
    closeMessageDb();
    const store = new Store(() => ({ instanceId: "offline", model: "test" }));
    const plans = new TaskPlanEngine({ file: join(DATA_DIR, "task-plans.json"), now: () => 5 });
    plans.start();
    try {
      const plan = plans.create({ botId: own.id, ownerId: account.userId, threadId: own.threadId, title: "Actual durable plan", steps: [{ title: "Checkpoint", kind: "checkpoint" }] });
      plans.control(plan.id, { action: "pause" });
      const offered = richInput();
      offered.archive.source = { ...offered.archive.source, store, plans, dataDir: DATA_DIR };
      const receipt = await writeAccountRecoveryBackup(offered);
      expect(receipt).toMatchObject({ status: "verified", format: "account-recovery-v1", apply: "unsupported", created: true });
      expect(receipt.name).toMatch(/^muster-account-recovery-v1-[a-f0-9]{64}\.enc$/);
      const opened = archiveCodec.inspectAccountRecoveryArchive({ bytes: stored,
        key: { custody: "user-held", passphrase: offered.archive.key.passphrase }, resolveAccount: () => current });
      if (opened.status !== "ready") throw new Error(JSON.stringify(opened));
      expect(opened.state.threads).toMatchObject([{ activeLeafId: selected.id, messages: [{ id: first.id }, { id: selected.id, png: "AA==" }, { id: fork.id }] }]);
      expect(opened.state.plans).toMatchObject([{ id: plan.id, status: "paused" }]);
      expect(opened.state.transitions.length).toBe(plans.transitionsFor().length);
      expect(opened.state.transitions.length).toBeGreaterThan(0);
      expect(JSON.stringify(opened.state)).not.toContain("EXCLUDED-FOREIGN-CONTENT");
      expect(store.snapshotThread(own.threadId)).toMatchObject({ status: "ready", activeLeafId: selected.id });
      expect(client.updateFile).not.toHaveBeenCalled();
    } finally { plans.stop(); closeMessageDb(); }
  });
  it("reuses only a real same-source rich copy and keeps the projection namespace separate", async () => {
    const first = await writeAccountRecoveryBackup(richInput());
    const bytes = Buffer.from(stored), previous = client.listFiles;
    client.listFiles = async args => args.q.includes("muster-account-recovery-v1-")
      ? [{ id: first.fileId, name: first.name, parents: ["backups"], mimeType: "application/octet-stream" }] : previous(args);
    const next = await writeAccountRecoveryBackup(richInput());
    expect(next).toEqual({ ...first, created: false }); expect(stored).toEqual(bytes);
    expect(client.createBinaryFile).toHaveBeenCalledOnce();
    const legacy = await writeAccountVisibleBackup(input());
    expect(legacy.name).toMatch(/^muster-account-visible-v1-/);
    expect(client.createBinaryFile).toHaveBeenCalledTimes(2);
  });
  it("cannot adopt different-source bytes under a forged expected rich name", async () => {
    await writeAccountRecoveryBackup(richInput());
    const previous = client.listFiles;
    source.store.bots[0]!.description = "Changed account persona";
    client.listFiles = async args => args.q.includes("muster-account-recovery-v1-")
      ? [{ id: "prior", name: /name = '([^']+)'/.exec(args.q)![1]!, parents: ["backups"], mimeType: "application/octet-stream" }] : previous(args);
    await expect(writeAccountRecoveryBackup(richInput())).rejects.toMatchObject({ code: "verification-failed" });
    expect(client.createBinaryFile).toHaveBeenCalledOnce(); expect(client.updateFile).not.toHaveBeenCalled();
  });
  it.each(["settings", "parser", "transitions", "snapshot"])("missing %s prerequisite refuses rich copies with zero Drive operations", async missing => {
    const offered = richInput();
    if (missing === "settings") offered.archive.source = { ...offered.archive.source, settingsSnapshot: null };
    if (missing === "parser") vi.spyOn(visibleParser, "parseVisibleFiles").mockImplementation(() => { throw new Error("Parser unavailable"); });
    if (missing === "transitions") offered.archive.source.plans.transitionsFor = () => { throw new Error("No actual transition reader"); };
    if (missing === "snapshot") offered.archive.source.store.snapshotThread = () => ({ status: "unavailable", reason: "source-unavailable" });
    await expect(writeAccountRecoveryBackup(offered)).rejects.toMatchObject({ code: "archive-unavailable" });
    expect(client.resolveRootId).not.toHaveBeenCalled(); expect(client.createFolder).not.toHaveBeenCalled(); expect(client.createBinaryFile).not.toHaveBeenCalled();
  });
  it.each([MAX_VISIBLE_RECOVERY_COPY_BYTES, MAX_VISIBLE_RECOVERY_COPY_BYTES + 1])("enforces the runtime media boundary at %i bytes before folder mutation", async length => {
    const offered = richInput(), actual = archiveCodec.buildAccountRecoveryArchive(offered.archive);
    if (actual.status !== "ready") throw new Error("Missing real source");
    // Fault injection at the codec output only exercises the size boundary;
    // malformed ciphertext at the accepted size still cannot verify.
    vi.spyOn(archiveCodec, "buildAccountRecoveryArchive").mockReturnValue({ ...actual, bytes: Buffer.alloc(length) });
    await expect(writeAccountRecoveryBackup(offered)).rejects.toMatchObject({ code: length > MAX_VISIBLE_RECOVERY_COPY_BYTES ? "copy-too-large" : "verification-failed" });
    if (length > MAX_VISIBLE_RECOVERY_COPY_BYTES) {
      expect(client.resolveRootId).not.toHaveBeenCalled(); expect(client.listFiles).not.toHaveBeenCalled();
      expect(client.createFolder).not.toHaveBeenCalled(); expect(client.createBinaryFile).not.toHaveBeenCalled();
    } else expect(client.createBinaryFile).toHaveBeenCalledOnce();
  });
  it.each(["root", "list", "folder", "upload", "readback"])("revocation during rich %s prevents success and subsequent calls", async stage => {
    if (stage === "root") client.resolveRootId = vi.fn(async () => { validLease = false; return "root-id"; });
    if (stage === "list") client.listFiles = vi.fn(async () => { validLease = false; return []; });
    if (stage === "folder") { client.listFiles = vi.fn(async () => []); client.createFolder = vi.fn(async (name, parent) => { validLease = false; return folder("made-folder", name, parent); }); }
    if (stage === "upload") { const create = client.createBinaryFile; client.createBinaryFile = vi.fn(async (name, parent, bytes) => { const result = await create(name, parent, bytes); validLease = false; return result; }); }
    if (stage === "readback") client.getBinaryFile = vi.fn(async () => { validLease = false; return { body: Buffer.from(stored) }; });
    const failure = ["upload", "readback"].includes(stage)
      ? { code: "operation-failed", createdFileId: "encrypted-copy" } : { code: "operation-failed" };
    await expect(writeAccountRecoveryBackup(richInput())).rejects.toMatchObject(failure);
    if (["root", "list", "folder"].includes(stage)) expect(client.createBinaryFile).not.toHaveBeenCalled();
    if (stage === "upload") expect(client.getBinaryFile).not.toHaveBeenCalled();
    expect(client.updateFile).not.toHaveBeenCalled();
  });
  it("source or account replacement never turns a rich copy into success", async () => {
    const previous = client.listFiles;
    client.listFiles = async args => { current = { ...authority, account: { ...account, sessionId: "replacement" } }; return previous(args); };
    await expect(writeAccountRecoveryBackup(richInput())).rejects.toMatchObject({ code: "account-changed" });
    expect(client.createBinaryFile).not.toHaveBeenCalled();
  });

});
