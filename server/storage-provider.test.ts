// P1 (local-first plan §13/R1) — the StorageProvider seam, both
// implementations under the drive-transport/sync-wiring/sync-pass test
// patterns: guard refusals, byte fidelity, first-run absence, alias
// equivalence between the §13 names and the engine's seam, and one REAL
// sync pass driven end-to-end by LocalStorageProvider (push on install A,
// pull on install B, real files in a temp directory — no live ~/.muster,
// no Drive, no adapter at the seam).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { enqueueSyncChange } from "./sync-journal.ts";
import { runSyncPass, type SyncTransportDeps } from "./sync-pass.ts";
import { SYNC_MANIFEST_FILE_NAME, syncObjectFileName, type SyncObject } from "./sync-objects.ts";
import { googleDriveStorageProvider, localSyncManifestStore, type DriveTransportFns } from "./sync-wiring.ts";
import { localStorageProvider, type StorageProvider } from "./storage-provider.ts";

const T0 = 1_760_000_000_000;
const PASSPHRASE = "correct horse battery staple";
const APP_VERSION = "0.0.0-test";
const now = () => T0;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const BINARY = Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x80, 0x7f]);

// Every write in this file lands under a fresh mkdtemp root; nothing here
// can reach the live ~/.muster data root or port 8845.
const tempRoots: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "muster-storage-provider-"));
  tempRoots.push(dir);
  return dir;
};
const dbs: DatabaseSync[] = [];
const freshDb = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  return db;
};
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("LocalStorageProvider (filesystem mirror)", () => {
  it("reads as null before anything is written, then round-trips binary bytes exactly", async () => {
    const provider: StorageProvider = localStorageProvider(join(tempDir(), "store"));
    expect(await provider.read("muster-obj-1.enc")).toBeNull();
    await provider.write("muster-obj-1.enc", BINARY);
    const back = await provider.read("muster-obj-1.enc");
    expect(back?.equals(BINARY)).toBe(true);
  });

  it.each(["../escape", "sub/name", "a\\b", "", ".", ".."])(
    "refuses unsafe file name %j on read and write, creating nothing inside or outside the directory",
    async (fileName) => {
      const root = tempDir();
      const dir = join(root, "store");
      const provider = localStorageProvider(dir);
      await expect(provider.write(fileName, BINARY)).rejects.toThrow(/unsafe storage file name/);
      await expect(provider.read(fileName)).rejects.toThrow(/unsafe storage file name/);
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it("getManifest reports first-run absence as null", async () => {
    const provider = localStorageProvider(join(tempDir(), "store"));
    expect(await provider.getManifest()).toBeNull();
  });

  it("creates on a first-run save and returns the file's modified time as the guard", async () => {
    const dir = join(tempDir(), "store");
    const provider = localStorageProvider(dir);
    const sealed = Buffer.from("sealed-manifest-bytes");
    await provider.saveManifest(sealed, null);
    const loaded = await provider.getManifest();
    expect(loaded?.bytes.equals(sealed)).toBe(true);
    const stat = statSync(join(dir, SYNC_MANIFEST_FILE_NAME));
    expect(loaded?.guard).toBe(new Date(stat.mtimeMs).toISOString());
  });

  it("save refuses a first-run create when someone else already created the file", async () => {
    const dir = join(tempDir(), "store");
    const provider = localStorageProvider(dir);
    await provider.saveManifest(Buffer.from("sealed-1"), null);
    await expect(provider.saveManifest(Buffer.from("clobber"), null)).rejects.toThrow(/already exists/);
    expect((await provider.getManifest())?.bytes.toString()).toBe("sealed-1");
  });

  it("save refuses to overwrite when the manifest moved since the load", async () => {
    const dir = join(tempDir(), "store");
    const provider = localStorageProvider(dir);
    const manifestPath = join(dir, SYNC_MANIFEST_FILE_NAME);
    await provider.saveManifest(Buffer.from("sealed-1"), null);
    const loaded = await provider.getManifest();
    // an external writer bumps the file after our load
    utimesSync(manifestPath, new Date(T0 + 10_000), new Date(T0 + 10_000));
    await expect(provider.saveManifest(Buffer.from("sealed-2"), loaded!.guard)).rejects.toThrow(/changed/);
    expect((await provider.getManifest())?.bytes.toString()).toBe("sealed-1");
  });

  it("save refuses when the manifest vanished under a non-null guard, creating no directory", async () => {
    const dir = join(tempDir(), "store");
    const provider = localStorageProvider(dir);
    await expect(provider.saveManifest(Buffer.from("sealed"), "2026-09-22T10:00:00.000Z")).rejects.toThrow(/vanished/);
    expect(existsSync(dir)).toBe(false);
  });

  it("save writes through when the guard still matches", async () => {
    const dir = join(tempDir(), "store");
    const provider = localStorageProvider(dir);
    await provider.saveManifest(Buffer.from("sealed-1"), null);
    const loaded = await provider.getManifest();
    const next = Buffer.from("sealed-2");
    await provider.saveManifest(next, loaded!.guard);
    const reloaded = await provider.getManifest();
    expect(reloaded?.bytes.equals(next)).toBe(true);
    expect(reloaded?.guard).toBe(new Date(statSync(join(dir, SYNC_MANIFEST_FILE_NAME)).mtimeMs).toISOString());
  });

  it("writes owner-only permissions: a 0700 directory and 0600 files", async () => {
    const dir = join(tempDir(), "store");
    const provider = localStorageProvider(dir);
    await provider.write("muster-obj-1.enc", Buffer.from("payload"));
    await provider.saveManifest(Buffer.from("sealed"), null);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "muster-obj-1.enc")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, SYNC_MANIFEST_FILE_NAME)).mode & 0o777).toBe(0o600);
  });

  it("requires an explicit directory — it never defaults to the live data root", () => {
    expect(() => localStorageProvider("")).toThrow(/explicit directory/);
  });

  it("aliases the seam names to the §13 names — one implementation, both vocabularies", async () => {
    const dir = join(tempDir(), "store");
    const provider = localStorageProvider(dir);
    await provider.write("muster-a-1.enc", BINARY);
    expect((await provider.download("muster-a-1.enc"))?.equals(BINARY)).toBe(true);
    await provider.upload("muster-b-1.enc", BINARY);
    expect((await provider.read("muster-b-1.enc"))?.equals(BINARY)).toBe(true);
    expect(await provider.loadRemoteManifest()).toBeNull();
    expect(await provider.getManifest()).toBeNull();
    await provider.saveManifest(Buffer.from("sealed"), null);
    const viaSeam = await provider.loadRemoteManifest();
    const via13 = await provider.getManifest();
    expect(viaSeam?.bytes.toString()).toBe("sealed");
    expect(via13?.bytes.equals(viaSeam!.bytes)).toBe(true);
    expect(via13?.guard).toBe(viaSeam?.guard);
    // the guarded refusal is shared, not duplicated
    await expect(provider.saveRemoteManifest(Buffer.from("x"), null)).rejects.toThrow(/already exists/);
    await expect(provider.saveManifest(Buffer.from("x"), null)).rejects.toThrow(/already exists/);
  });
});

describe("a real sync pass driven by LocalStorageProvider — no adapter, real files", () => {
  it("pushes a journal row from install A into one directory and pulls it onto install B without push-back", async () => {
    const root = tempDir();
    const shared = join(root, "shared-storage");
    const payload = "memory content v1";
    const object: SyncObject = {
      objectId: "memory:bot_alpha",
      objectType: "memory",
      ownerId: "user_1",
      rev: 1,
      createdAt: T0,
      updatedAt: T0,
      deviceId: "device-a",
      checksum: sha256(payload),
      tombstone: false,
      schemaVersion: 1,
      payload,
    };

    // install A: one queued change, pushed through the local provider
    const dbA = freshDb();
    enqueueSyncChange(dbA, { objectId: object.objectId, objectType: object.objectType, rev: 1, checksum: object.checksum }, T0);
    const localA = localSyncManifestStore(join(root, "a-manifest.json"));
    const passA = await runSyncPass({
      db: dbA,
      transport: localStorageProvider(shared),
      local: localA,
      readObject: () => object,
      applyObject: () => {},
      passphrase: PASSPHRASE,
      appVersion: APP_VERSION,
      now,
    });
    expect(passA.errors).toEqual([]);
    expect(passA.pushed).toEqual([{ objectId: object.objectId, rev: 1, fileName: syncObjectFileName(object.objectId, 1) }]);
    expect(passA.manifestPublished).toBe(true);
    expect(readdirSync(shared).sort()).toEqual([SYNC_MANIFEST_FILE_NAME, syncObjectFileName(object.objectId, 1)].sort());

    // install B: fresh local state, the same directory as its view of remote
    const dbB = freshDb();
    const localB = localSyncManifestStore(join(root, "b-manifest.json"));
    const applied: SyncObject[] = [];
    const passB = await runSyncPass({
      db: dbB,
      transport: localStorageProvider(shared),
      local: localB,
      readObject: () => {
        throw new Error("B has nothing queued — the pull must not read objects");
      },
      applyObject: (appliedObject) => {
        applied.push(appliedObject);
      },
      passphrase: PASSPHRASE,
      appVersion: APP_VERSION,
      now,
    });
    expect(passB.errors).toEqual([]);
    expect(passB.journal.claimed).toBe(0);
    expect(passB.pushed).toEqual([]); // the applier never pushes back
    expect(passB.pullApplied).toEqual([{ objectId: object.objectId, rev: 1 }]);
    expect(passB.pullProblems).toEqual([]);
    expect(passB.conflicts).toEqual([]);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.payload).toBe(payload);
    expect(localB.load()?.entries.find((entry) => entry.objectId === object.objectId)?.rev).toBe(1);
  });
});

// The injected Drive contract, re-faked here the way sync-wiring.test.ts
// shapes it: name → base64 text, plus a modifiedTime per name.
interface DriveCall {
  kind: "upload" | "download" | "stat";
  fileName: string | undefined;
  payload?: string;
}

interface FakeDrive {
  fns: DriveTransportFns;
  calls: DriveCall[];
  files: Map<string, string>;
  stats: Map<string, string>;
}

function fakeDrive(): FakeDrive {
  const calls: DriveCall[] = [];
  const files = new Map<string, string>();
  const stats = new Map<string, string>();
  const fns: DriveTransportFns = {
    async uploadBundle(_accessToken, payload, fileName) {
      calls.push({ kind: "upload", fileName, payload });
      if (fileName !== undefined) {
        files.set(fileName, payload);
        stats.set(fileName, new Date(Date.now()).toISOString());
      }
      return { id: "file-1" };
    },
    async downloadBundle(_accessToken, fileName) {
      calls.push({ kind: "download", fileName });
      if (fileName === undefined) return null;
      return files.get(fileName) ?? null;
    },
    async statBundleFile(_accessToken, fileName) {
      calls.push({ kind: "stat", fileName });
      if (fileName === undefined) return null;
      const modified = stats.get(fileName);
      if (modified === undefined || !files.has(fileName)) return null;
      return { id: "file-1", modifiedTime: modified };
    },
  };
  return { fns, calls, files, stats };
}

describe("GoogleDriveStorageProvider (pure wrap of the existing transport)", () => {
  const getAccessToken = async () => "token-abc";

  it("aliases write/read to the seam — identical call logs and a byte-exact base64 round-trip", async () => {
    const a = fakeDrive();
    const b = fakeDrive();
    const via13 = googleDriveStorageProvider({ getAccessToken, drive: a.fns });
    const viaSeam = googleDriveStorageProvider({ getAccessToken, drive: b.fns });
    await via13.write("muster-obj-1.enc", BINARY);
    await viaSeam.upload("muster-obj-1.enc", BINARY);
    expect(a.calls).toEqual(b.calls);
    expect(a.files).toEqual(b.files);
    expect(a.files.get("muster-obj-1.enc")).toBe(BINARY.toString("base64"));
    expect((await via13.read("muster-obj-1.enc"))?.equals(BINARY)).toBe(true);
    expect((await viaSeam.download("muster-obj-1.enc"))?.equals(BINARY)).toBe(true);
  });

  it("hands back raw text bytes when the file is not our base64 encoding", async () => {
    const drive = fakeDrive();
    const provider = googleDriveStorageProvider({ getAccessToken, drive: drive.fns });
    drive.files.set("muster-foreign-1.enc", "not base64 of anything");
    const back = await provider.read("muster-foreign-1.enc");
    expect(back?.toString("utf8")).toBe("not base64 of anything");
  });

  it("getManifest stats BEFORE downloading so the guard predates the bytes", async () => {
    const drive = fakeDrive();
    const provider = googleDriveStorageProvider({ getAccessToken, drive: drive.fns });
    const envelopeBytes = Buffer.from("sealed-manifest-bytes");
    drive.files.set(SYNC_MANIFEST_FILE_NAME, envelopeBytes.toString("base64"));
    drive.stats.set(SYNC_MANIFEST_FILE_NAME, "2026-09-22T10:00:00.000Z");
    const loaded = await provider.getManifest();
    expect(loaded?.guard).toBe("2026-09-22T10:00:00.000Z");
    expect(loaded?.bytes.equals(envelopeBytes)).toBe(true);
    const order = drive.calls.filter((call) => call.fileName === SYNC_MANIFEST_FILE_NAME).map((call) => call.kind);
    expect(order).toEqual(["stat", "download"]);
  });

  it("getManifest reports first-run absence as null", async () => {
    const drive = fakeDrive();
    const provider = googleDriveStorageProvider({ getAccessToken, drive: drive.fns });
    expect(await provider.getManifest()).toBeNull();
  });

  it("saveManifest creates on first run and writes through under a matching guard", async () => {
    const drive = fakeDrive();
    const provider = googleDriveStorageProvider({ getAccessToken, drive: drive.fns });
    const first = Buffer.from("sealed");
    await provider.saveManifest(first, null);
    expect(drive.files.get(SYNC_MANIFEST_FILE_NAME)).toBe(first.toString("base64"));
    drive.stats.set(SYNC_MANIFEST_FILE_NAME, "2026-09-22T10:00:00.000Z");
    const second = Buffer.from("sealed-2");
    await provider.saveManifest(second, "2026-09-22T10:00:00.000Z");
    expect(drive.files.get(SYNC_MANIFEST_FILE_NAME)).toBe(second.toString("base64"));
  });

  it("saveManifest refuses a first-run create when someone else already created the file", async () => {
    const drive = fakeDrive();
    const provider = googleDriveStorageProvider({ getAccessToken, drive: drive.fns });
    drive.files.set(SYNC_MANIFEST_FILE_NAME, "other");
    drive.stats.set(SYNC_MANIFEST_FILE_NAME, "2026-09-22T10:00:00.000Z");
    await expect(provider.saveManifest(Buffer.from("sealed"), null)).rejects.toThrow(/already exists|appeared/);
    expect(drive.calls.some((call) => call.kind === "upload")).toBe(false);
  });

  it("saveManifest refuses to overwrite when the remote moved since the load", async () => {
    const drive = fakeDrive();
    const provider = googleDriveStorageProvider({ getAccessToken, drive: drive.fns });
    drive.files.set(SYNC_MANIFEST_FILE_NAME, "other");
    drive.stats.set(SYNC_MANIFEST_FILE_NAME, "2026-09-22T10:05:00.000Z");
    await expect(provider.saveManifest(Buffer.from("sealed"), "2026-09-22T10:00:00.000Z")).rejects.toThrow(
      /changed|concurrent/,
    );
    expect(drive.calls.some((call) => call.kind === "upload")).toBe(false);
  });

  it("saveManifest refuses when the manifest vanished under a non-null guard", async () => {
    const drive = fakeDrive();
    const provider = googleDriveStorageProvider({ getAccessToken, drive: drive.fns });
    await expect(provider.saveManifest(Buffer.from("sealed"), "2026-09-22T10:00:00.000Z")).rejects.toThrow(
      /vanished|no longer/,
    );
    expect(drive.calls.some((call) => call.kind === "upload")).toBe(false);
  });

  it("injects at the pass's SyncTransportDeps seam with no adapter", async () => {
    const drive = fakeDrive();
    const provider: StorageProvider = googleDriveStorageProvider({ getAccessToken, drive: drive.fns });
    // compile-time proof: a StorageProvider IS the pass's injected seam…
    const transport: SyncTransportDeps = provider;
    // …and the seam methods it exposes behave exactly as the transport's
    await transport.upload("muster-obj-1.enc", BINARY);
    expect((await transport.download("muster-obj-1.enc"))?.equals(BINARY)).toBe(true);
    const viaSeam = await transport.loadRemoteManifest();
    const via13 = await provider.getManifest();
    expect(viaSeam).toBeNull();
    expect(via13).toBeNull();
    await provider.saveManifest(Buffer.from("sealed"), null);
    const seamLoaded = await transport.loadRemoteManifest();
    expect(seamLoaded?.bytes.toString()).toBe("sealed");
    expect((await provider.getManifest())?.guard).toBe(seamLoaded?.guard);
  });
});
