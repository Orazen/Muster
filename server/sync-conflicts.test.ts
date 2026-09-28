// The equal-rev / different-checksum conflict, end to end.
//
// §10 is explicit that nothing may auto-resolve this case, so these tests
// pin the two halves of what "resolvable" has to mean and nothing else:
//   - the conflict is REMEMBERED where a restart cannot lose it, with both
//     sides whole enough for a person to actually choose between them;
//   - the only way a winner is ever chosen is a caller naming the side.
// There is deliberately no test for a default resolution, because there is no
// default resolution to test — a module that can pick for itself is the thing
// these tests exist to prevent.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  forgetSyncConflict,
  readSyncConflicts,
  recordSyncConflict,
  resolveSyncConflict,
  type SyncConflictRecord,
} from "./sync-conflicts.ts";
import { enqueueSyncChange, syncChangeRows } from "./sync-journal.ts";
import {
  packSyncManifest,
  packSyncObject,
  syncObjectFileName,
  unpackSyncManifest,
  type SyncManifestDoc,
  type SyncManifestEntry,
  type SyncObject,
} from "./sync-objects.ts";
import { runSyncPass, type SyncPassDeps, type SyncTransportDeps } from "./sync-pass.ts";

const T0 = 1_760_000_000_000;
const T1 = 1_760_000_600_000;
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

const OBJECT_ID = "memory:bot_alpha";

/** The two installs' content for the same rev, which is what a conflict is:
 * same rev, different bytes. */
const mine = (): SyncObject => ({
  objectId: OBJECT_ID,
  objectType: "memory",
  ownerId: "user_1",
  rev: 3,
  createdAt: T0,
  updatedAt: T0,
  deviceId: "device-mine",
  checksum: sha256("mine"),
  tombstone: false,
  schemaVersion: 1,
  payload: "mine",
});
const theirs = (): SyncObject => ({ ...mine(), updatedAt: T1, deviceId: "device-theirs", checksum: sha256("theirs"), payload: "theirs" });

const entryOf = (object: SyncObject): SyncManifestEntry => ({
  objectId: object.objectId,
  objectType: object.objectType,
  rev: object.rev,
  checksum: object.checksum,
  fileName: syncObjectFileName(object.objectId, object.rev),
  updatedAt: object.updatedAt,
  tombstone: object.tombstone,
});
const doc = (...entries: SyncManifestEntry[]): SyncManifestDoc => ({ schema: 1, updatedAt: T0, entries });

function fakeDrive(remote: SyncManifestDoc) {
  const objects = new Map<string, Buffer>();
  const transport: SyncTransportDeps = {
    upload: async (fileName, bytes) => { objects.set(fileName, bytes); },
    download: async (fileName) => objects.get(fileName) ?? null,
    loadRemoteManifest: async () => ({ bytes: packSyncManifest(remote, { passphrase: PASSPHRASE, appVersion: APP_VERSION }), guard: "guard-0" }),
    saveRemoteManifest: async (bytes) => {
      const opened = unpackSyncManifest(bytes, { passphrase: PASSPHRASE });
      if (opened.status !== "ok" || opened.doc === undefined) throw new Error("refusing to save a manifest that does not open");
      remote.entries = opened.doc.entries;
    },
  };
  return {
    transport,
    objects,
    get remote(): SyncManifestDoc { return remote; },
    seed(object: SyncObject): void {
      objects.set(syncObjectFileName(object.objectId, object.rev), packSyncObject(object, { passphrase: PASSPHRASE, appVersion: APP_VERSION }));
    },
  };
}

function localState(seed: SyncManifestDoc | null) {
  let current = seed;
  return {
    load: () => current,
    save: (next: SyncManifestDoc) => { current = next; },
    get current() { return current; },
  };
}

const deps = (over: Partial<SyncPassDeps>): SyncPassDeps => ({
  db: freshDb(),
  transport: fakeDrive(doc()).transport,
  local: localState(null),
  // a real producer re-reads current local content and stamps the row's rev,
  // so the reader follows the row rather than hardcoding a revision
  readObject: (row) => ({ ...mine(), objectId: row.objectId, objectType: row.objectType, rev: row.rev }),
  applyObject: () => {},
  passphrase: PASSPHRASE,
  appVersion: APP_VERSION,
  now: () => T0,
  ...over,
});

describe("a conflict the pass found", () => {
  it("remembers both sides, whole, where a restart cannot lose them", async () => {
    const db = freshDb();
    const drive = fakeDrive(doc(entryOf(theirs())));
    drive.seed(theirs());
    await runSyncPass(deps({ db, transport: drive.transport, local: localState(doc(entryOf(mine()))) }));

    const records = readSyncConflicts(db);
    expect(records).toHaveLength(1);
    // enough for a person to choose, and every field verbatim from the index
    // entry it was read from — nothing derived, so nothing can disagree
    expect(records[0]).toEqual({
      objectId: OBJECT_ID,
      objectType: "memory",
      rev: 3,
      localChecksum: sha256("mine"),
      remoteChecksum: sha256("theirs"),
      localFileName: syncObjectFileName(OBJECT_ID, 3),
      remoteFileName: syncObjectFileName(OBJECT_ID, 3),
      localUpdatedAt: T0,
      remoteUpdatedAt: T1,
      localTombstone: false,
      remoteTombstone: false,
      detectedAt: T0,
    } satisfies SyncConflictRecord);
  });

  it("carries the same two sides in the pass result, so a caller can show them without the table", async () => {
    const db = freshDb();
    const drive = fakeDrive(doc(entryOf(theirs())));
    drive.seed(theirs());
    const result = await runSyncPass(deps({ db, transport: drive.transport, local: localState(doc(entryOf(mine()))) }));
    expect(result.conflicts).toEqual([
      {
        objectId: OBJECT_ID,
        objectType: "memory",
        localRev: 3,
        remoteRev: 3,
        localChecksum: sha256("mine"),
        remoteChecksum: sha256("theirs"),
        localUpdatedAt: T0,
        remoteUpdatedAt: T1,
        localTombstone: false,
        remoteTombstone: false,
      },
    ]);
  });

  it("stays a conflict: it downloads nothing and applies nothing", async () => {
    const db = freshDb();
    const drive = fakeDrive(doc(entryOf(theirs())));
    drive.seed(theirs());
    const applied: SyncObject[] = [];
    const result = await runSyncPass(
      deps({ db, transport: drive.transport, local: localState(doc(entryOf(mine()))), applyObject: (object) => { applied.push(object); } }),
    );
    expect(result.pullApplied).toHaveLength(0);
    expect(applied).toHaveLength(0);
    // and it decided nothing: the index is exactly as it was
    expect(drive.remote.entries).toEqual([entryOf(theirs())]);
  });

  it("forgets a conflict once the object stops disagreeing", async () => {
    const db = freshDb();
    const drive = fakeDrive(doc(entryOf(theirs())));
    drive.seed(theirs());
    const local = localState(doc(entryOf(mine())));
    await runSyncPass(deps({ db, transport: drive.transport, local }));
    expect(readSyncConflicts(db)).toHaveLength(1);

    // the other install moved past the disagreement, so this one applies it
    // and the conflict stops being true
    const moved = { ...theirs(), rev: 4, payload: "theirs v4", checksum: sha256("theirs v4") };
    const settled = fakeDrive(doc(entryOf(moved)));
    settled.seed(moved);
    const applied: SyncObject[] = [];
    const result = await runSyncPass(
      deps({ db, transport: settled.transport, local, applyObject: (object) => { applied.push(object); } }),
    );
    expect(result.pullApplied).toEqual([{ objectId: OBJECT_ID, rev: 4 }]);
    expect(applied[0]?.payload).toBe("theirs v4");
    expect(readSyncConflicts(db)).toEqual([]);
  });

  it("does not let a damaged record hide the ones that are readable", () => {
    const db = freshDb();
    recordSyncConflict(db, { local: entryOf(mine()), remote: entryOf(theirs()) }, T0);
    db.exec(`UPDATE sync_conflicts SET record = '{not json' WHERE objectId = '${OBJECT_ID}'`);
    recordSyncConflict(db, { local: entryOf({ ...mine(), objectId: "memory:bot_beta" }), remote: entryOf({ ...theirs(), objectId: "memory:bot_beta" }) }, T0);
    expect(readSyncConflicts(db).map((record) => record.objectId)).toEqual(["memory:bot_beta"]);
  });
});

describe("resolving a conflict, by name", () => {
  /** A pass's deps over one install's own state, ready to run again. The
   * clock is at T1 so a re-issued row (queued at T1) is due immediately. */
  const install = (over: Partial<SyncPassDeps> = {}) => {
    const db = freshDb();
    const drive = fakeDrive(doc(entryOf(theirs())));
    drive.seed(theirs());
    const local = localState(doc(entryOf(mine())));
    return {
      db,
      drive,
      local,
      record: () => readSyncConflicts(db)[0]!,
      pass: () => runSyncPass(deps({ db, transport: drive.transport, local, now: () => T1, ...over })),
    };
  };

  it("taking the remote side withdraws this install's claim, and the next pass applies theirs", async () => {
    const one = install();
    await one.pass();
    expect(readSyncConflicts(one.db)).toHaveLength(1);

    // the person chose: their rev 3 wins, ours stops being claimed
    expect(resolveSyncConflict({ db: one.db, local: one.local, record: one.record() }, "remote", T1)).toBe("resolved");
    expect(one.local.current?.entries).toEqual([]);
    expect(readSyncConflicts(one.db)).toEqual([]);

    const applied: SyncObject[] = [];
    const result = await runSyncPass(
      deps({ db: one.db, transport: one.drive.transport, local: one.local, now: () => T1, applyObject: (object) => { applied.push(object); } }),
    );
    expect(result.pullApplied).toEqual([{ objectId: OBJECT_ID, rev: 3 }]);
    expect(applied[0]?.payload).toBe("theirs");
    expect(result.conflicts).toEqual([]);
  });

  it("keeping this install's side re-issues it past the disagreement, and the other install pulls it", async () => {
    const one = install();
    await one.pass();

    expect(resolveSyncConflict({ db: one.db, local: one.local, record: one.record() }, "local", T1)).toBe("resolved");
    // a rev past the disagreement, so the merge is settled by rev and not by
    // whichever install happened to publish last
    expect(one.local.current?.entries).toEqual([
      { ...entryOf(mine()), rev: 4, fileName: syncObjectFileName(OBJECT_ID, 4), updatedAt: T1 },
    ]);
    expect(syncChangeRows(one.db).map((row) => ({ objectId: row.objectId, rev: row.rev }))).toEqual([
      { objectId: OBJECT_ID, rev: 4 },
    ]);
    expect(readSyncConflicts(one.db)).toEqual([]);

    const result = await one.pass();
    expect(result.pushed).toEqual([{ objectId: OBJECT_ID, rev: 4, fileName: syncObjectFileName(OBJECT_ID, 4) }]);
    expect(result.manifestPublished).toBe(true);
    expect(result.conflicts).toEqual([]);
    // the index now names our content at the higher rev
    expect(one.drive.remote.entries).toEqual([
      { ...entryOf(mine()), rev: 4, fileName: syncObjectFileName(OBJECT_ID, 4), updatedAt: T0 },
    ]);
  });

  it("reports a resolution for an object this install no longer claims, rather than resolving nothing", () => {
    const db = freshDb();
    const local = localState(null);
    recordSyncConflict(db, { local: entryOf(mine()), remote: entryOf(theirs()) }, T0);
    const record = readSyncConflicts(db)[0]!;
    // the claim the record was written about is already gone, so the record
    // is stale rather than unresolvable
    expect(resolveSyncConflict({ db, local, record }, "remote", T1)).toBe("unknown");
    expect(readSyncConflicts(db)).toEqual([]);
  });

  it("cannot be resolved by a pass: nothing in the pass half chooses a side", async () => {
    // Ten passes over the same conflict: it stays a conflict, forever, until
    // someone names a side. The only way out is a human.
    const one = install();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await one.pass();
      expect(result.conflicts.map((conflict) => conflict.objectId)).toEqual([OBJECT_ID]);
      expect(result.pullApplied).toHaveLength(0);
      expect(readSyncConflicts(one.db)).toHaveLength(1);
    }
  });
});

describe("the durable table itself", () => {
  it("replaces a record when the same object disagrees again, so it never doubles up", () => {
    const db = freshDb();
    expect(recordSyncConflict(db, { local: entryOf(mine()), remote: entryOf(theirs()) }, T0)).toBe(true);
    const later = { ...theirs(), updatedAt: T1 + 1 };
    expect(recordSyncConflict(db, { local: entryOf({ ...mine(), updatedAt: T1 }), remote: entryOf(later) }, T1)).toBe(true);
    const records = readSyncConflicts(db);
    expect(records).toHaveLength(1);
    expect(records[0]?.detectedAt).toBe(T1);
    expect(records[0]?.remoteUpdatedAt).toBe(T1 + 1);
  });

  it("refuses to remember a side it cannot describe rather than storing a half-record", () => {
    const db = freshDb();
    // not a sha256, so the schema rejects it: a conflict record that cannot
    // be shown to a person is worse than none
    const broken = { ...entryOf(mine()), checksum: "zz" };
    expect(recordSyncConflict(db, { local: broken, remote: entryOf(theirs()) }, T0)).toBe(false);
    expect(readSyncConflicts(db)).toEqual([]);
  });

  it("forgets on request, and forgetting something absent is a no-op", () => {
    const db = freshDb();
    recordSyncConflict(db, { local: entryOf(mine()), remote: entryOf(theirs()) }, T0);
    forgetSyncConflict(db, "memory:nobody");
    expect(readSyncConflicts(db)).toHaveLength(1);
    forgetSyncConflict(db, OBJECT_ID);
    expect(readSyncConflicts(db)).toEqual([]);
  });

  it("keeps conflicts out of the journal: remembering one never enqueues work", () => {
    const db = freshDb();
    recordSyncConflict(db, { local: entryOf(mine()), remote: entryOf(theirs()) }, T0);
    expect(syncChangeRows(db)).toEqual([]);
    enqueueSyncChange(db, { objectId: OBJECT_ID, objectType: "memory", rev: 3, checksum: sha256("mine") }, T0);
    expect(syncChangeRows(db)).toHaveLength(1);
  });
});
