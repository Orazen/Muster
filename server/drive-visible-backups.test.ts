import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAccountVisibleBackup, VisibleBackupError, type VisibleBackupClient } from "./drive-visible-backups.ts";
import type { AuthenticatedVisibleAccount } from "./drive-visible-account-bundle.ts";
import type { DriveFileRef } from "./drive-visible.ts";
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
  afterEach(() => rmSync(root, { recursive: true, force: true }));
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
});
