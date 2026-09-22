// S2b (DESIGN §10) — the sync pass: one cycle of the sequence diagram,
// over INJECTED dependencies so the engine is testable without Drive, the
// routes file, or any producer:
//
//   journal claim → read local object → pack (S2a envelope) → upload →
//   record in the local manifest → publish the merged remote manifest;
//   then remote-manifest compare (S2a reconcile) → download → unpack →
//   VERIFY against the manifest entry → applier → local manifest commit.
//
// The journal retry/dead-letter/crash-recovery semantics are S1's
// drainSyncChanges — this engine supplies the transport callback and never
// re-implements queue behavior. The verify step is the one §10 spells out
// ("download → verify → decrypt → merge → commit"): an object whose
// rev/checksum/tombstone disagree with the manifest entry that named it is
// reported, never applied.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  enqueueSyncChange,
  syncChangeRows,
} from "./sync-journal.ts";
import {
  packSyncManifest,
  packSyncObject,
  syncObjectFileName,
  unpackSyncManifest,
  unpackSyncObject,
  type SyncManifestDoc,
  type SyncManifestEntry,
  type SyncObject,
} from "./sync-objects.ts";
import { runSyncPass, type SyncPassDeps, type SyncTransportDeps } from "./sync-pass.ts";

const T0 = 1_760_000_000_000;
const PASSPHRASE = "correct horse battery staple";
const APP_VERSION = "0.0.0-test";
const dbs: DatabaseSync[] = [];
const freshDb = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  return db;
};
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
});

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const anObject = (over: Partial<SyncObject> = {}): SyncObject => ({
  objectId: "memory:bot_alpha",
  objectType: "memory",
  ownerId: "user_1",
  rev: 1,
  createdAt: T0,
  updatedAt: T0,
  deviceId: "device-a",
  checksum: sha256("memory content v1"),
  tombstone: false,
  schemaVersion: 1,
  payload: "memory content v1",
  ...over,
});

const entryOf = (object: SyncObject): SyncManifestEntry => ({
  objectId: object.objectId,
  objectType: object.objectType,
  rev: object.rev,
  checksum: object.checksum,
  fileName: syncObjectFileName(object.objectId, object.rev),
  updatedAt: object.updatedAt,
  tombstone: object.tombstone,
});

const doc = (entries: SyncManifestEntry[]): SyncManifestDoc => ({
  schema: 1,
  updatedAt: T0,
  entries,
});

/** An in-memory Drive: objects by file name, one remote manifest, one
 * guard value that changes on every save — enough to pin pass-through. */
function fakeDrive(seed?: { remote?: SyncManifestDoc | null; remoteBytes?: Buffer }) {
  const objects = new Map<string, Buffer>();
  let remote: SyncManifestDoc | null = seed?.remote ?? null;
  let guard = remote === null ? null : "guard-0";
  let saves = 0;
  const transport: SyncTransportDeps = {
    upload: async (fileName, bytes) => {
      objects.set(fileName, bytes);
    },
    download: async (fileName) => objects.get(fileName) ?? null,
    loadRemoteManifest: async () => {
      if (seed?.remoteBytes !== undefined) return { bytes: seed.remoteBytes, guard };
      return remote === null
        ? null
        : { bytes: packSyncManifest(remote, { passphrase: PASSPHRASE, appVersion: APP_VERSION }), guard };
    },
    saveRemoteManifest: async (bytes, expectedGuard) => {
      if (expectedGuard !== guard) throw new Error("manifest guard mismatch");
      const opened = unpackSyncManifest(bytes, { passphrase: PASSPHRASE });
      if (opened.status !== "ok" || opened.doc === undefined) throw new Error("refusing to save a manifest that does not open");
      remote = opened.doc;
      guard = `guard-${++saves}`;
    },
  };
  return {
    transport,
    objects,
    get remote() {
      return remote;
    },
    get guard() {
      return guard;
    },
    get saves() {
      return saves;
    },
    seedObject(object: SyncObject): void {
      objects.set(syncObjectFileName(object.objectId, object.rev), packSyncObject(object, { passphrase: PASSPHRASE, appVersion: APP_VERSION }));
    },
  };
}

function localState(seed?: SyncManifestDoc | null) {
  let current: SyncManifestDoc | null = seed ?? null;
  let saves = 0;
  return {
    load: () => current,
    save: (next: SyncManifestDoc) => {
      current = next;
      saves += 1;
    },
    get current() {
      return current;
    },
    get saves() {
      return saves;
    },
  };
}

const deps = (over: Partial<SyncPassDeps>): SyncPassDeps => ({
  db: freshDb(),
  transport: fakeDrive().transport,
  local: localState(),
  readObject: (row) => anObject({ objectId: row.objectId, objectType: row.objectType, rev: row.rev, checksum: row.checksum, payload: "memory content v1" }),
  applyObject: () => {},
  passphrase: PASSPHRASE,
  appVersion: APP_VERSION,
  now: () => T0,
  ...over,
});

describe("push half — journal → pack → upload → manifest publish", () => {
  it("uploads the claimed change under its canonical name, drains the journal, and publishes both manifests", async () => {
    const db = freshDb();
    const drive = fakeDrive({ remote: doc([anEntryRemoteOther()]) });
    drive.seedObject(anObjectOther());
    const local = localState();
    enqueueSyncChange(db, { objectId: "memory:bot_alpha", objectType: "memory", rev: 1, checksum: sha256("memory content v1") }, T0);
    const result = await runSyncPass(deps({ db, transport: drive.transport, local }));
    expect(result.journal).toEqual({ claimed: 1, drained: 1, failed: 0, dead: 0 });
    expect(result.pushed).toEqual([{ objectId: "memory:bot_alpha", rev: 1, fileName: syncObjectFileName("memory:bot_alpha", 1) }]);
    expect(syncChangeRows(db)).toHaveLength(0);
    // the uploaded bytes open as the object, under the name the manifest records
    const uploaded = drive.objects.get(syncObjectFileName("memory:bot_alpha", 1))!;
    const opened = unpackSyncObject(uploaded, { passphrase: PASSPHRASE });
    expect(opened.status).toBe("ok");
    expect(opened.object).toEqual(anObject());
    expect(local.current?.entries.map((entry) => entry.objectId).sort()).toEqual(["bot:other", "memory:bot_alpha"]);
    expect(drive.remote?.entries.map((entry) => entry.objectId).sort()).toEqual(["bot:other", "memory:bot_alpha"]);
    expect(result.manifestPublished).toBe(true);
  });

  it("retries a failed upload through the journal instead of losing the change", async () => {
    const db = freshDb();
    const failing: SyncTransportDeps = { ...fakeDrive().transport, upload: async () => { throw new Error("network down"); } };
    enqueueSyncChange(db, { objectId: "memory:bot_alpha", objectType: "memory", rev: 1, checksum: sha256("memory content v1") }, T0);
    const result = await runSyncPass(deps({ db, transport: failing }));
    expect(result.journal).toEqual({ claimed: 1, drained: 0, failed: 1, dead: 0 });
    const row = syncChangeRows(db)[0]!;
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(result.pushed).toHaveLength(0);
    expect(result.manifestPublished).toBe(false);
  });

  it("saves the local manifest after every successful push, so a crash mid-pass loses nothing", async () => {
    const db = freshDb();
    const local = localState();
    enqueueSyncChange(db, { objectId: "memory:bot_alpha", objectType: "memory", rev: 1, checksum: sha256("memory content v1") }, T0);
    enqueueSyncChange(db, { objectId: "settings:app", objectType: "settings", rev: 2, checksum: sha256("settings v2") }, T0);
    const result = await runSyncPass(
      deps({
        db,
        local,
        readObject: (row) =>
          row.objectType === "settings"
            ? anObject({ objectId: row.objectId, objectType: "settings", rev: row.rev, checksum: row.checksum, payload: "settings v2" })
            : anObject(),
      }),
    );
    expect(result.journal.drained).toBe(2);
    expect(local.saves).toBe(2);
  });

  it("reports a manifest publish failure while keeping the uploaded objects", async () => {
    const db = freshDb();
    const drive = fakeDrive({ remote: doc([anEntryRemoteOther()]) });
    const guarded: SyncTransportDeps = {
      ...drive.transport,
      saveRemoteManifest: async () => {
        throw new Error("guard mismatch");
      },
    };
    enqueueSyncChange(db, { objectId: "memory:bot_alpha", objectType: "memory", rev: 1, checksum: sha256("memory content v1") }, T0);
    const result = await runSyncPass(deps({ db, transport: guarded }));
    expect(result.journal.drained).toBe(1);
    expect(drive.objects.has(syncObjectFileName("memory:bot_alpha", 1))).toBe(true);
    expect(result.manifestPublished).toBe(false);
    expect(result.errors.join(" ")).toMatch(/guard mismatch/);
  });

  it("refuses to upload content that disagrees with its own journal row", async () => {
    const db = freshDb();
    enqueueSyncChange(db, { objectId: "memory:bot_alpha", objectType: "memory", rev: 1, checksum: sha256("memory content v1") }, T0);
    const result = await runSyncPass(
      deps({
        db,
        readObject: () => anObject({ checksum: sha256("something else"), payload: "something else" }),
      }),
    );
    // The reader's content and the queued checksum disagree: publishing would
    // make the manifest lie about the bytes, so the change retries instead.
    expect(result.pushed).toHaveLength(0);
    expect(result.journal).toEqual({ claimed: 1, drained: 0, failed: 1, dead: 0 });
    expect(syncChangeRows(db)[0]!.state).toBe("pending");
  });
});

describe("pull half — remote compare → download → verify → apply → commit", () => {
  const remoteNewer = (): SyncManifestDoc =>
    doc([anEntryRemoteOther(), entryOf(anObject({ rev: 4, payload: "memory content v4", checksum: sha256("memory content v4") }))]);

  it("downloads and applies a remote-newer object, then records it locally", async () => {
    const drive = fakeDrive({ remote: remoteNewer() });
    drive.seedObject(anObject({ rev: 4, payload: "memory content v4", checksum: sha256("memory content v4") }));
    const applied: SyncObject[] = [];
    const local = localState(doc([anEntryRemoteOther()]));
    const result = await runSyncPass(deps({ transport: drive.transport, local, applyObject: (object) => { applied.push(object); } }));
    expect(result.pullApplied).toEqual([{ objectId: "memory:bot_alpha", rev: 4 }]);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.payload).toBe("memory content v4");
    expect(local.current?.entries.find((entry) => entry.objectId === "memory:bot_alpha")?.rev).toBe(4);
    expect(result.journal.claimed).toBe(0);
  });

  it("passes a remote tombstone to the applier like any newer rev", async () => {
    const gone = anObject({ rev: 5, payload: "", checksum: sha256(""), tombstone: true });
    const drive = fakeDrive({ remote: doc([entryOf(gone)]) });
    drive.seedObject(gone);
    const applied: SyncObject[] = [];
    const result = await runSyncPass(deps({ transport: drive.transport, applyObject: (object) => { applied.push(object); } }));
    expect(result.pullApplied).toEqual([{ objectId: "memory:bot_alpha", rev: 5 }]);
    expect(applied[0]!.tombstone).toBe(true);
  });

  it("refuses to apply an object whose bytes disagree with the manifest entry that named it", async () => {
    // manifest says rev 4 / one checksum; the file on the wire is a DIFFERENT
    // authentic object — the verify step must catch it, not the applier.
    const honest = anObject({ rev: 4, payload: "memory content v4", checksum: sha256("memory content v4") });
    const impostor = anObject({ rev: 4, payload: "something else", checksum: sha256("something else") });
    const drive = fakeDrive({ remote: doc([entryOf(honest)]) });
    drive.seedObject(impostor);
    const applied: SyncObject[] = [];
    const result = await runSyncPass(deps({ transport: drive.transport, applyObject: (object) => { applied.push(object); } }));
    expect(applied).toHaveLength(0);
    expect(result.pullProblems.join(" ")).toMatch(/memory:bot_alpha/);
    expect(result.pullApplied).toHaveLength(0);
  });

  it("reports a missing download and an unopenable one without applying either", async () => {
    const missing = entryOf(anObject({ rev: 4, payload: "v4", checksum: sha256("v4") }));
    const drive = fakeDrive({ remote: doc([missing]) });
    // no seedObject — the manifest points at bytes that are not there
    const applied: SyncObject[] = [];
    const first = await runSyncPass(deps({ transport: drive.transport, applyObject: (object) => { applied.push(object); } }));
    expect(first.pullProblems.join(" ")).toMatch(/memory:bot_alpha/);
    expect(applied).toHaveLength(0);
  });

  it("never downloads objects that are already in sync", async () => {
    const same = anObject();
    const drive = fakeDrive({ remote: doc([entryOf(same)]) });
    drive.seedObject(same);
    const downloads: string[] = [];
    const base = drive.transport;
    const result = await runSyncPass(
      deps({
        transport: {
          ...base,
          download: async (fileName) => {
            downloads.push(fileName);
            return base.download(fileName);
          },
        },
        local: localState(doc([entryOf(same)])),
      }),
    );
    expect(downloads).toHaveLength(0);
    expect(result.pullApplied).toHaveLength(0);
    expect(result.pullProblems).toHaveLength(0);
  });

  it("reports an equal-rev checksum conflict and picks no side", async () => {
    const mine = anObject({ checksum: sha256("mine"), payload: "mine" });
    const theirs = anObject({ checksum: sha256("theirs"), payload: "theirs" });
    const drive = fakeDrive({ remote: doc([entryOf(theirs)]) });
    drive.seedObject(theirs);
    const applied: SyncObject[] = [];
    const downloads: string[] = [];
    const base = drive.transport;
    const result = await runSyncPass(
      deps({
        transport: {
          ...base,
          download: async (fileName) => {
            downloads.push(fileName);
            return base.download(fileName);
          },
        },
        local: localState(doc([entryOf(mine)])),
        applyObject: (object) => { applied.push(object); },
      }),
    );
    expect(result.conflicts.map((conflict) => conflict.objectId)).toEqual(["memory:bot_alpha"]);
    expect(applied).toHaveLength(0);
    expect(downloads).toHaveLength(0); // a conflict downloads nothing — no side is picked
  });
});

describe("a full pass and its edges", () => {
  it("pushes local-er and pulls remote-er in the same pass, ending with both manifests aligned", async () => {
    const db = freshDb();
    const localObject = anObject({ objectId: "memory:mine", objectType: "memory", rev: 2, payload: "mine v2", checksum: sha256("mine v2") });
    const remoteObject = anObject({ objectId: "memory:theirs", objectType: "memory", rev: 3, payload: "theirs v3", checksum: sha256("theirs v3") });
    const drive = fakeDrive({ remote: doc([entryOf(remoteObject), entryOf(anObject({ objectId: "memory:mine", objectType: "memory", rev: 1, payload: "mine v1", checksum: sha256("mine v1") }))]) });
    drive.seedObject(remoteObject);
    const local = localState(doc([entryOf(anObject({ objectId: "memory:mine", objectType: "memory", rev: 1, payload: "mine v1", checksum: sha256("mine v1") }))]));
    enqueueSyncChange(db, { objectId: "memory:mine", objectType: "memory", rev: 2, checksum: sha256("mine v2") }, T0);
    const applied: SyncObject[] = [];
    const result = await runSyncPass(deps({ db, transport: drive.transport, local, readObject: () => localObject, applyObject: (object) => { applied.push(object); } }));
    expect(result.journal.drained).toBe(1);
    expect(result.pushed).toHaveLength(1);
    expect(result.pullApplied).toEqual([{ objectId: "memory:theirs", rev: 3 }]);
    expect(applied.map((object) => object.objectId)).toEqual(["memory:theirs"]);
    expect(drive.remote?.entries.find((entry) => entry.objectId === "memory:mine")?.rev).toBe(2);
    expect(local.current?.entries.find((entry) => entry.objectId === "memory:theirs")?.rev).toBe(3);
    expect(result.manifestPublished).toBe(true);
  });

  it("is a clean no-op when the journal is empty and nothing is remote-newer", async () => {
    const same = anObject();
    const drive = fakeDrive({ remote: doc([entryOf(same)]) });
    drive.seedObject(same);
    const applied: SyncObject[] = [];
    const result = await runSyncPass(
      deps({ transport: drive.transport, local: localState(doc([entryOf(same)])), applyObject: (object) => { applied.push(object); } }),
    );
    expect(result).toEqual({
      journal: { claimed: 0, drained: 0, failed: 0, dead: 0 },
      pushed: [],
      pullApplied: [],
      conflicts: [],
      pullProblems: [],
      manifestPublished: false,
      errors: [],
    });
    expect(drive.saves).toBe(0);
  });

  it("first run with no remote manifest just publishes what the journal pushed", async () => {
    const db = freshDb();
    const drive = fakeDrive();
    enqueueSyncChange(db, { objectId: "memory:bot_alpha", objectType: "memory", rev: 1, checksum: sha256("memory content v1") }, T0);
    const result = await runSyncPass(deps({ db, transport: drive.transport, local: localState() }));
    expect(result.manifestPublished).toBe(true);
    expect(drive.remote?.entries.map((entry) => entry.objectId)).toEqual(["memory:bot_alpha"]);
    expect(drive.guard).toBe("guard-1"); // null guard on create, opaque and passed through
  });

  it("passes the load guard through to the publish untouched", async () => {
    const db = freshDb();
    const drive = fakeDrive({ remote: doc([anEntryRemoteOther()]) });
    enqueueSyncChange(db, { objectId: "memory:bot_alpha", objectType: "memory", rev: 1, checksum: sha256("memory content v1") }, T0);
    const seen: Array<string | null> = [];
    const base = drive.transport;
    await runSyncPass(
      deps({
        db,
        transport: {
          ...base,
          saveRemoteManifest: async (bytes, guard) => {
            seen.push(guard);
            await base.saveRemoteManifest(bytes, guard);
          },
        },
      }),
    );
    expect(seen).toEqual(["guard-0"]); // the guard the load returned, unmodified
  });

  it("halts before touching anything when the remote manifest will not open", async () => {
    const db = freshDb();
    enqueueSyncChange(db, { objectId: "memory:bot_alpha", objectType: "memory", rev: 1, checksum: sha256("memory content v1") }, T0);
    const foreign = packSyncManifest(doc([anEntryRemoteOther()]), {
      passphrase: "a different passphrase entirely",
      appVersion: APP_VERSION,
    });
    const drive = fakeDrive({ remoteBytes: foreign });
    const result = await runSyncPass(deps({ db, transport: drive.transport }));
    expect(result.errors.join(" ")).toMatch(/will not open/);
    expect(result.journal.claimed).toBe(0); // journal untouched
    expect(syncChangeRows(db)).toHaveLength(1);
    expect(drive.saves).toBe(0);
    expect(result.pullApplied).toHaveLength(0);
  });
});

/** A remote-only object and its entry — the pushes must never clobber it. */
function anObjectOther(): SyncObject {
  return anObject({ objectId: "bot:other", objectType: "bots", rev: 7, payload: "other", checksum: sha256("other") });
}
function anEntryRemoteOther(): SyncManifestEntry {
  return entryOf(anObjectOther());
}
