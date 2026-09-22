// S2c red/green — the real wiring around the pass, still over injected
// deps so Drive, the clock and the passphrase store stay fake here:
//   1. the Drive transport (base64 byte bridge, stat-BEFORE-download
//      modifiedTime guard, verify-before-write manifest save),
//   2. the persisted local-manifest store (loud on corruption),
//   3. the engine: debounced single-flight trigger around the pass —
//      the pass is the ONLY claimant of the journal, so a drainer and a
//      pass can never double-drain a row.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SYNC_MANIFEST_FILE_NAME, manifestDocSchema, type SyncManifestDoc } from "./sync-objects.ts";
import type { SyncJournalRow } from "./sync-journal.ts";
import {
  driveSyncTransport,
  localSyncManifestStore,
  startSyncEngine,
  type DriveTransportFns,
  type SyncEngineResult,
} from "./sync-wiring.ts";

const T0 = 1_760_000_000_000;
const HEX64 = "a".repeat(64);
const now = () => T0;

const entry = (objectId: string, rev: number): SyncManifestDoc["entries"][number] => ({
  objectId,
  objectType: "memory",
  rev,
  checksum: HEX64,
  fileName: `muster-${encodeURIComponent(objectId)}-${rev}.enc`,
  updatedAt: T0,
  tombstone: false,
});

const doc = (...entries: SyncManifestDoc["entries"]): SyncManifestDoc => ({
  schema: 1,
  updatedAt: T0,
  entries,
});

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

/** In-memory Drive: name → base64 text, plus a modifiedTime per name. */
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
      const found = files.get(fileName);
      return found ?? null;
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

describe("driveSyncTransport", () => {
  let drive: FakeDrive;
  const getAccessToken = async () => "token-abc";

  beforeEach(() => {
    drive = fakeDrive();
  });

  it("round-trips binary object bytes through the base64 bridge exactly", async () => {
    const transport = driveSyncTransport({ getAccessToken, drive: drive.fns });
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x80, 0x7f]);
    await transport.upload("muster-obj-1.enc", bytes);
    const upload = drive.calls.find((call) => call.kind === "upload");
    expect(upload?.payload).toBe(bytes.toString("base64"));
    const back = await transport.download("muster-obj-1.enc");
    expect(back?.equals(bytes)).toBe(true);
  });

  it("returns null for a file Drive does not have", async () => {
    const transport = driveSyncTransport({ getAccessToken, drive: drive.fns });
    expect(await transport.download("muster-absent-1.enc")).toBeNull();
  });

  it("hands back raw text bytes when the file is not our base64 encoding", async () => {
    const transport = driveSyncTransport({ getAccessToken, drive: drive.fns });
    drive.files.set("muster-foreign-1.enc", "not base64 of anything");
    const back = await transport.download("muster-foreign-1.enc");
    expect(back?.toString("utf8")).toBe("not base64 of anything");
  });

  it("loads the manifest stat-BEFORE-download so the guard predates the bytes", async () => {
    const transport = driveSyncTransport({ getAccessToken, drive: drive.fns });
    const envelopeBytes = Buffer.from("sealed-manifest-bytes");
    drive.files.set(SYNC_MANIFEST_FILE_NAME, envelopeBytes.toString("base64"));
    drive.stats.set(SYNC_MANIFEST_FILE_NAME, "2026-09-22T10:00:00.000Z");
    const loaded = await transport.loadRemoteManifest();
    expect(loaded?.guard).toBe("2026-09-22T10:00:00.000Z");
    expect(loaded?.bytes.equals(envelopeBytes)).toBe(true);
    const order = drive.calls.filter((call) => call.fileName === SYNC_MANIFEST_FILE_NAME).map((call) => call.kind);
    expect(order).toEqual(["stat", "download"]);
  });

  it("load reports first-run absence as null", async () => {
    const transport = driveSyncTransport({ getAccessToken, drive: drive.fns });
    expect(await transport.loadRemoteManifest()).toBeNull();
  });

  it("save creates when the guard says first run and Drive agrees there is no file", async () => {
    const transport = driveSyncTransport({ getAccessToken, drive: drive.fns });
    const envelopeBytes = Buffer.from("sealed");
    await transport.saveRemoteManifest(envelopeBytes, null);
    expect(drive.files.get(SYNC_MANIFEST_FILE_NAME)).toBe(envelopeBytes.toString("base64"));
  });

  it("save refuses a first-run create when someone else already created the file", async () => {
    const transport = driveSyncTransport({ getAccessToken, drive: drive.fns });
    drive.files.set(SYNC_MANIFEST_FILE_NAME, "other");
    drive.stats.set(SYNC_MANIFEST_FILE_NAME, "2026-09-22T10:00:00.000Z");
    await expect(transport.saveRemoteManifest(Buffer.from("sealed"), null)).rejects.toThrow(/already exists|appeared/);
    expect(drive.calls.some((call) => call.kind === "upload")).toBe(false);
  });

  it("save refuses to overwrite when the remote moved since the load", async () => {
    const transport = driveSyncTransport({ getAccessToken, drive: drive.fns });
    drive.files.set(SYNC_MANIFEST_FILE_NAME, "other");
    drive.stats.set(SYNC_MANIFEST_FILE_NAME, "2026-09-22T10:05:00.000Z");
    await expect(
      transport.saveRemoteManifest(Buffer.from("sealed"), "2026-09-22T10:00:00.000Z"),
    ).rejects.toThrow(/changed|concurrent/);
    expect(drive.calls.some((call) => call.kind === "upload")).toBe(false);
  });

  it("save refuses when the manifest vanished under a non-null guard", async () => {
    const transport = driveSyncTransport({ getAccessToken, drive: drive.fns });
    await expect(
      transport.saveRemoteManifest(Buffer.from("sealed"), "2026-09-22T10:00:00.000Z"),
    ).rejects.toThrow(/vanished|no longer/);
    expect(drive.calls.some((call) => call.kind === "upload")).toBe(false);
  });

  it("save writes through when the guard still matches", async () => {
    const transport = driveSyncTransport({ getAccessToken, drive: drive.fns });
    drive.files.set(SYNC_MANIFEST_FILE_NAME, "old");
    drive.stats.set(SYNC_MANIFEST_FILE_NAME, "2026-09-22T10:00:00.000Z");
    const envelopeBytes = Buffer.from("sealed");
    await transport.saveRemoteManifest(envelopeBytes, "2026-09-22T10:00:00.000Z");
    expect(drive.files.get(SYNC_MANIFEST_FILE_NAME)).toBe(envelopeBytes.toString("base64"));
  });
});

describe("localSyncManifestStore", () => {
  let path: string;

  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), "muster-sync-store-")), "local-manifest.json");
  });

  it("reads as null before anything is saved, then round-trips", () => {
    const store = localSyncManifestStore(path);
    expect(store.load()).toBeNull();
    const saved = doc(entry("memory:bot-1", 3));
    store.save(saved);
    expect(store.load()).toEqual(saved);
  });

  it("persists plain JSON the manifest schema itself re-accepts", () => {
    const store = localSyncManifestStore(path);
    store.save(doc(entry("memory:bot-1", 1)));
    const parsed = manifestDocSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(parsed.schema).toBe(1);
    expect(parsed.entries[0]?.objectId).toBe("memory:bot-1");
  });

  it("refuses to save a doc the manifest schema rejects", () => {
    const store = localSyncManifestStore(path);
    // type-valid (a string), schema-invalid (not a sha256): the check is
    // the schema, not the compiler
    const invalid: SyncManifestDoc = {
      schema: 1,
      updatedAt: T0,
      entries: [{ ...entry("memory:bot-1", 1), checksum: "zz" }],
    };
    expect(() => store.save(invalid)).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("fails loudly on a corrupt file instead of silently starting at zero", () => {
    const store = localSyncManifestStore(path);
    writeFileSync(path, "{not json", { mode: 0o600 });
    expect(() => store.load()).toThrow();
  });
});

const zeroDrain = { claimed: 0, drained: 0, failed: 0, dead: 0 };

function fakePassResult(errors: string[]): SyncEngineResult {
  return {
    journal: zeroDrain,
    pushed: [],
    pullApplied: [],
    conflicts: [],
    pullProblems: [],
    manifestPublished: false,
    errors,
  };
}

describe("startSyncEngine", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  const base = () => ({
    db,
    transport: driveSyncTransport({ getAccessToken: async () => "t", drive: fakeDrive().fns }),
    local: localSyncManifestStore(join(tmpdir(), `muster-engine-${Date.now()}.json`)),
    readObject: (_row: SyncJournalRow) => {
      throw new Error("not used");
    },
    applyObject: () => {
      throw new Error("not used");
    },
    passphrase: () => "correct horse battery staple",
    appVersion: "0.0.0-test",
    now,
  });

  it("coalesces a burst of notifies into one pass", async () => {
    let runs = 0;
    const engine = startSyncEngine({
      ...base(),
      debounceMs: 5,
      runPass: async () => {
        runs += 1;
        return fakePassResult([]);
      },
    });
    engine.notify();
    engine.notify();
    engine.notify();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(runs).toBe(1);
    engine.stop();
  });

  it("flush runs immediately without waiting for the debounce", async () => {
    let runs = 0;
    const engine = startSyncEngine({
      ...base(),
      debounceMs: 10_000,
      runPass: async () => {
        runs += 1;
        return fakePassResult([]);
      },
    });
    const result = await engine.flush();
    expect(runs).toBe(1);
    expect(result.errors).toEqual([]);
    engine.stop();
  });

  it("joins an in-flight pass instead of starting a second one", async () => {
    let runs = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = startSyncEngine({
      ...base(),
      debounceMs: 2,
      runPass: async () => {
        runs += 1;
        await gate;
        return fakePassResult([]);
      },
    });
    const first = engine.flush();
    engine.notify();
    const second = engine.flush();
    release();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toBe(1);
    engine.stop();
  });

  it("holds the queue without a passphrase instead of running the pass", async () => {
    let runs = 0;
    const engine = startSyncEngine({
      ...base(),
      passphrase: () => null,
      runPass: async () => {
        runs += 1;
        return fakePassResult([]);
      },
    });
    const result = await engine.flush();
    expect(runs).toBe(0);
    expect(result.errors.join(" ")).toMatch(/passphrase/);
    engine.stop();
  });

  it("turns a throwing pass into a reported error, never an unhandled rejection", async () => {
    const engine = startSyncEngine({
      ...base(),
      runPass: async () => {
        throw new Error("Drive said no");
      },
    });
    const result = await engine.flush();
    expect(result.errors.join(" ")).toMatch(/Drive said no/);
    engine.stop();
  });

  it("is inert after stop: notify schedules nothing and flush returns zero", async () => {
    let runs = 0;
    const engine = startSyncEngine({
      ...base(),
      debounceMs: 2,
      runPass: async () => {
        runs += 1;
        return fakePassResult([]);
      },
    });
    engine.stop();
    engine.notify();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(0);
    const result = await engine.flush();
    expect(result.journal).toEqual(zeroDrain);
    expect(result.errors).toEqual([]);
  });

  it("passes ITS transport and local store through to the pass untouched", async () => {
    const opts = base();
    let seen: {
      sameTransport: boolean;
      sameLocal: boolean;
      passphrase: string;
      appVersion: string;
    } | null = null;
    const engine = startSyncEngine({
      ...opts,
      runPass: async (deps) => {
        seen = {
          sameTransport: deps.transport === opts.transport,
          sameLocal: deps.local === opts.local,
          passphrase: deps.passphrase,
          appVersion: deps.appVersion,
        };
        return fakePassResult([]);
      },
    });
    await engine.flush();
    expect(seen).toEqual({
      sameTransport: true,
      sameLocal: true,
      passphrase: "correct horse battery staple",
      appVersion: "0.0.0-test",
    });
    engine.stop();
  });
});
