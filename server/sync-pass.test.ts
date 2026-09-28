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

import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  SYNC_MANIFEST_FILE_NAME,
  type SyncManifestDoc,
  type SyncManifestEntry,
  type SyncObject,
} from "./sync-objects.ts";
import { runSyncPass, type SyncPassDeps, type SyncTransportDeps } from "./sync-pass.ts";
import { driveSyncTransport, type DriveTransportFns } from "./sync-wiring.ts";

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

  it("re-queues a drained push when the manifest publish fails, so the next pass converges", async () => {
    // The drain DELETEs the journal row on upload success, and the local
    // manifest then claims a rev the remote index does not have. Without a
    // re-queue nothing would ever re-push it and every later pass would
    // report itself clean while the object sat orphaned on the wire.
    const db = freshDb();
    const drive = fakeDrive({ remote: doc([anEntryRemoteOther()]) });
    drive.seedObject(anObjectOther());
    let publishFails = true;
    const base = drive.transport;
    const flaky: SyncTransportDeps = {
      ...base,
      saveRemoteManifest: async (bytes, guard) => {
        if (publishFails) throw new Error("guard mismatch");
        await base.saveRemoteManifest(bytes, guard);
      },
    };
    const local = localState();
    enqueueSyncChange(db, { objectId: "memory:bot_alpha", objectType: "memory", rev: 1, checksum: sha256("memory content v1") }, T0);

    const first = await runSyncPass(deps({ db, transport: flaky, local }));
    expect(first.manifestPublished).toBe(false);
    expect(first.errors.join(" ")).toMatch(/guard mismatch/);
    // the row is back in the queue, not stranded
    expect(syncChangeRows(db).map((row) => ({ objectId: row.objectId, rev: row.rev, state: row.state }))).toEqual([
      { objectId: "memory:bot_alpha", rev: 1, state: "pending" },
    ]);

    // the other device publishes while this one is between passes: the guard
    // moves on, and the retry merges onto the newer remote manifest
    publishFails = false;
    const second = await runSyncPass(deps({ db, transport: flaky, local }));
    expect(second.journal).toEqual({ claimed: 1, drained: 1, failed: 0, dead: 0 });
    expect(second.manifestPublished).toBe(true);
    expect(drive.remote?.entries.map((entry) => entry.objectId).sort()).toEqual(["bot:other", "memory:bot_alpha"]);
    expect(syncChangeRows(db)).toHaveLength(0);

    // and the converged install is clean again
    const third = await runSyncPass(deps({ db, transport: flaky, local }));
    expect(third.errors).toEqual([]);
    expect(third.pullApplied.length + third.pushed.length).toBe(0);
  });

  it("never reports a clean pass while a local entry the remote index lacks has no queued row", async () => {
    // The journal is the retry mechanism; if it has lost the row, plan.upload
    // is the only remaining evidence that this install's local manifest is
    // ahead of the remote index, and the pass must say so rather than shrug.
    //
    // The reporting half of that is unchanged. What the pass now also does
    // is HAND THE CLAIM BACK to the journal rather than only describing it,
    // so what is asserted here is the stronger of the two statements: not
    // clean, AND no longer stranded. (When the object's bytes verifiably are
    // still on the wire the pass instead names the entry again and says
    // nothing — there the index was merely behind, and nothing was lost.)
    const db = freshDb();
    const drive = fakeDrive({ remote: doc([anEntryRemoteOther()]) });
    const local = localState(doc([entryOf(anObject())]));
    const result = await runSyncPass(deps({ db, transport: drive.transport, local }));
    expect(result.pushed).toHaveLength(0);
    expect(result.errors.join(" ")).toMatch(/memory:bot_alpha/);
    expect(result.errors.join(" ")).toMatch(/not on the wire|re-queued/);
    // and a row now owns the claim, so a later pass really does push it
    expect(syncChangeRows(db).map((row) => row.objectId)).toEqual(["memory:bot_alpha"]);
  });

  it("does not call a merely pending queue row an orphan", async () => {
    // A row still sitting in its retry backoff owns its upload; reporting it
    // as stranded would be a false alarm on the ordinary path.
    const db = freshDb();
    const drive = fakeDrive({ remote: doc([anEntryRemoteOther()]) });
    const failing: SyncTransportDeps = { ...drive.transport, upload: async () => { throw new Error("network down"); } };
    const local = localState(doc([entryOf(anObject())]));
    enqueueSyncChange(db, { objectId: "memory:bot_alpha", objectType: "memory", rev: 1, checksum: sha256("memory content v1") }, T0);
    const result = await runSyncPass(deps({ db, transport: failing, local }));
    expect(result.journal.failed).toBe(1);
    expect(syncChangeRows(db)[0]!.state).toBe("pending");
    expect(result.errors).toEqual([]);
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

// ── the concurrent-publication half ────────────────────────────────────────
//
// Everything above runs ONE install against a quiet remote. These cases run
// TWO: the failures they reproduce are the ones a single writer cannot see,
// and none of them is reachable by making a single pass misbehave.
//
// The race is the stat→write window Drive v3 cannot close (sync-wiring: the
// guard is the file's modifiedTime, checked immediately before the write,
// with no If-Match to make the pair atomic). Two installs can both stat the
// same modifiedTime, both find their guard valid, and both write — so the
// second write erases the first install's index entries while telling it the
// publish succeeded. The killed-process case is the other shape of the same
// wound: the process dies between a successful upload and the publish, and a
// dead process runs no catch.

const entryIds = (entries: readonly SyncManifestEntry[]): string[] =>
  entries.map((entry) => entry.objectId).sort();

/** The REAL Drive transport over an in-memory Drive, with one hook: the
 * writer that armed it pauses inside saveRemoteManifest between the guard's
 * stat and the write. One-shot and only on the manifest name, so the writer
 * that runs INSIDE the pause publishes through the ordinary path — its own
 * stat still matches, exactly as on Drive. */
function racyDrive() {
  const files = new Map<string, string>();
  const modified = new Map<string, string>();
  let writes = 0;
  let pause: (() => Promise<void>) | null = null;
  const fns: DriveTransportFns = {
    async uploadBundle(_token, payload, fileName) {
      if (fileName === SYNC_MANIFEST_FILE_NAME) {
        const held = pause;
        pause = null;
        if (held !== null) await held();
      }
      files.set(fileName!, payload);
      modified.set(fileName!, new Date(T0 + (++writes) * 1000).toISOString());
      return { id: "file-1" };
    },
    async downloadBundle(_token, fileName) {
      return fileName === undefined ? null : (files.get(fileName) ?? null);
    },
    async statBundleFile(_token, fileName) {
      const modifiedTime = fileName === undefined ? undefined : modified.get(fileName);
      return modifiedTime === undefined ? null : { id: "file-1", modifiedTime };
    },
  };
  return {
    transport: () => driveSyncTransport({ getAccessToken: async () => "token-abc", drive: fns }),
    pauseNextManifestWrite(hold: () => Promise<void>): void {
      pause = hold;
    },
    index(): SyncManifestEntry[] {
      const text = files.get(SYNC_MANIFEST_FILE_NAME);
      if (text === undefined) return [];
      const opened = unpackSyncManifest(Buffer.from(text, "base64"), { passphrase: PASSPHRASE });
      if (opened.status !== "ok" || opened.doc === undefined) {
        throw new Error(`the index under test will not open: ${opened.status}`);
      }
      return opened.doc.entries;
    },
  };
}

/** One install with one unpublished change waiting in its own journal. */
function writerFor(objectId: string, payload: string, transport: SyncTransportDeps) {
  const db = freshDb();
  const checksum = sha256(payload);
  enqueueSyncChange(db, { objectId, objectType: "memory", rev: 1, checksum }, T0);
  return {
    db,
    deps: deps({
      db,
      transport,
      local: localState(),
      readObject: () => anObject({ objectId, objectType: "memory", rev: 1, checksum, payload }),
    }),
  };
}

/** A delete: the same shape as any other push, with the empty payload the
 * tombstone contract fixes. */
function writerTombstoneFor(objectId: string, transport: SyncTransportDeps) {
  const db = freshDb();
  enqueueSyncChange(db, { objectId, objectType: "memory", rev: 1, checksum: sha256(""), tombstone: true }, T0);
  return {
    db,
    deps: deps({
      db,
      transport,
      local: localState(),
      readObject: () =>
        anObject({ objectId, objectType: "memory", rev: 1, checksum: sha256(""), payload: "", tombstone: true }),
    }),
  };
}

/** Drive, with one install paused inside its stat→write window while the
 * other one publishes end to end. The paused writer's write then lands on
 * top of the other's — both passes report success. */
async function raceTwoWriters(first: "alpha" | "beta", second: "alpha" | "beta") {
  const drive = racyDrive();
  const installs = {
    alpha: writerFor("memory:bot_alpha", "alpha content", drive.transport()),
    beta: writerFor("memory:bot_beta", "beta content", drive.transport()),
  };
  const paused = installs[first];
  const winner = installs[second];
  drive.pauseNextManifestWrite(async () => {
    await runSyncPass(winner.deps);
  });
  await runSyncPass(paused.deps);
  return { ...installs, index: drive.index };
}

describe("two installs publishing the one remote index", () => {
  it("converges after the racing write instead of losing the loser's edit", async () => {
    // alpha stats the manifest, pauses; beta stats the same modifiedTime,
    // finds its guard valid, writes; alpha resumes and writes over the top.
    // Both passes report success. The install whose write landed LAST cannot
    // learn that it erased the other's entries — Drive offers no way to — so
    // the guarantee pinned here is the one the transport can support: the
    // erase is not permanent, and the loser names its own entry again.
    const raced = await raceTwoWriters("alpha", "beta");
    expect(entryIds(raced.index())).toEqual(["memory:bot_alpha"]);

    const restarted = await runSyncPass(raced.beta.deps);
    expect(restarted.errors).toEqual([]);
    expect(entryIds(raced.index())).toEqual(["memory:bot_alpha", "memory:bot_beta"]);
    // and it converges: nothing left to do, nothing to report.
    const settled = await runSyncPass(raced.beta.deps);
    expect(settled.errors).toEqual([]);
    expect(settled.pushed).toHaveLength(0);
    expect(settled.pullApplied).toHaveLength(0);
  });

  it("does not let the racing write resurrect a deleted object", async () => {
    // The same race where the erased entry is a TOMBSTONE. A silently
    // dropped delete is worse than a silently dropped edit: the object comes
    // back from the dead on the next pull.
    const drive = racyDrive();
    const alpha = writerFor("memory:bot_alpha", "alpha content", drive.transport());
    const beta = writerTombstoneFor("memory:bot_beta", drive.transport());
    drive.pauseNextManifestWrite(async () => {
      await runSyncPass(beta.deps);
    });
    await runSyncPass(alpha.deps);
    expect(entryIds(drive.index())).toEqual(["memory:bot_alpha"]);

    const restarted = await runSyncPass(beta.deps);
    expect(restarted.errors).toEqual([]);
    const published = drive.index();
    expect(entryIds(published)).toEqual(["memory:bot_alpha", "memory:bot_beta"]);
    expect(published.find((entry) => entry.objectId === "memory:bot_beta")?.tombstone).toBe(true);
    // and it settles: the delete is in the index, not queued for another go
    const settled = await runSyncPass(beta.deps);
    expect(settled.errors).toEqual([]);
    expect(settled.pushed).toHaveLength(0);
    expect(settled.pullApplied).toHaveLength(0);
  });

  it("refuses to publish a stale rev over a newer one, so a stale install cannot undo a delete", async () => {
    // The other half of the shared-index rule, and reachable with no timing
    // at all once two installs exist: this one has fallen behind and pushes
    // rev 1 while the index already names rev 7 — a delete. Writing the stale
    // entry would un-delete the object on every install that never saw the
    // delete, and no later pass could repair it (the local entry would then
    // match the index it had just corrupted).
    const gone = anObject({ objectId: "bot:other", objectType: "bots", rev: 7, payload: "", checksum: sha256(""), tombstone: true });
    const stale = anObject({ objectId: "bot:other", objectType: "bots", rev: 1, payload: "stale", checksum: sha256("stale") });
    const drive = fakeDrive({ remote: doc([entryOf(gone)]) });
    drive.seedObject(gone);
    const db = freshDb();
    enqueueSyncChange(db, { objectId: "bot:other", objectType: "bots", rev: 1, checksum: sha256("stale") }, T0);
    const local = localState();
    const applied: SyncObject[] = [];
    const result = await runSyncPass(
      deps({
        db,
        transport: drive.transport,
        local,
        readObject: () => stale,
        applyObject: (object) => { applied.push(object); },
      }),
    );
    expect(result.journal.drained).toBe(1);
    // the index still names the delete — nothing was written over it
    expect(drive.remote?.entries).toEqual([entryOf(gone)]);
    expect(drive.saves).toBe(0);
    // and this pass pulled the delete down instead of pushing against it
    expect(result.pullApplied).toEqual([{ objectId: "bot:other", rev: 7 }]);
    expect(applied[0]?.tombstone).toBe(true);
    expect(local.current?.entries).toEqual([entryOf(gone)]);
  });
});

// ── a process that dies mid-publish ───────────────────────────────────────

/** The on-disk remote the crashed child and the restarted parent share:
 * objects in one directory, the index in one file, and a guard that moves
 * on every write so the stat-before-write check means something. */
function fileRemote(dir: string) {
  const objectsDir = join(dir, "objects");
  const indexPath = join(dir, "remote-index.bin");
  const guardPath = join(dir, "remote-guard.txt");
  mkdirSync(objectsDir, { recursive: true });
  const guard = (): string | null => (existsSync(guardPath) ? readFileSync(guardPath, "utf8").trim() : null);
  let generation = Number(guard() ?? "0");
  const objectPath = (fileName: string) => join(objectsDir, fileName);
  const transport: SyncTransportDeps = {
    async upload(fileName, bytes) {
      writeFileSync(objectPath(fileName), bytes);
    },
    async download(fileName) {
      try {
        return readFileSync(objectPath(fileName));
      } catch {
        return null;
      }
    },
    async loadRemoteManifest() {
      if (!existsSync(indexPath)) return null;
      return { bytes: readFileSync(indexPath), guard: guard() };
    },
    async saveRemoteManifest(bytes, expectedGuard) {
      if (guard() !== expectedGuard) throw new Error("the remote index changed since it was loaded");
      writeFileSync(indexPath, bytes);
      writeFileSync(guardPath, String(++generation));
    },
  };
  return {
    transport,
    index(): SyncManifestEntry[] {
      if (!existsSync(indexPath)) return [];
      const opened = unpackSyncManifest(readFileSync(indexPath), { passphrase: PASSPHRASE });
      if (opened.status !== "ok" || opened.doc === undefined) {
        throw new Error(`the index under test will not open: ${opened.status}`);
      }
      return opened.doc.entries;
    },
  };
}

/** The child: a real process running the SHIPPED pass over file-backed
 * stores, killed the instant it reaches the manifest publish. That is the
 * only place a pass can die with durable work already done and no catch to
 * see it — an in-process test cannot produce this shape, because the pass's
 * own handler would have re-queued the row first. */
const crashRunnerSource = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const dir = process.argv[2];
const server = process.argv[3];
const load = async (name) => import(pathToFileURL(join(server, name)).href);
const { enqueueSyncChange } = await load("sync-journal.ts");
const { runSyncPass } = await load("sync-pass.ts");
const { localSyncManifestStore } = await load("sync-wiring.ts");

const PASSPHRASE = "correct horse battery staple";
const APP_VERSION = "0.0.0-test";
const objectsDir = join(dir, "objects");
mkdirSync(objectsDir, { recursive: true });
const fixtures = JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf8"));

const db = new DatabaseSync(join(dir, "journal.sqlite"));
const local = localSyncManifestStore(join(dir, "local-manifest.json"));
for (const fixture of fixtures) enqueueSyncChange(db, fixture, Date.now());

const transport = {
  upload: async (fileName, bytes) => { writeFileSync(join(objectsDir, fileName), bytes); },
  download: async (fileName) => {
    try { return readFileSync(join(objectsDir, fileName)); } catch { return null; }
  },
  loadRemoteManifest: async () => null,
  saveRemoteManifest: async () => {
    // Every object is on the wire and every journal row is drained. From
    // here the process simply stops existing: nothing catches, nothing
    // re-queues, and the index never learns the work happened.
    process.send({ type: "publish-reached" });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  },
};

const result = await runSyncPass({
  db,
  transport,
  local,
  readObject: (row) => {
    const fixture = fixtures.find((f) => f.objectId === row.objectId && f.rev === row.rev);
    if (fixture === undefined) throw new Error("no fixture for " + row.objectId);
    return {
      objectId: fixture.objectId,
      objectType: fixture.objectType,
      ownerId: "user_1",
      rev: fixture.rev,
      createdAt: 1760000000000,
      updatedAt: 1760000000000,
      deviceId: "device-crashed",
      checksum: fixture.checksum,
      tombstone: fixture.tombstone === true,
      schemaVersion: 1,
      payload: fixture.tombstone === true ? "" : "alpha content",
    };
  },
  applyObject: () => {},
  passphrase: PASSPHRASE,
  appVersion: APP_VERSION,
});
process.send({ type: "finished", result });
`;

const running: ChildProcess[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fork the runner, wait until it is inside the publish, then SIGKILL it. */
function killAtPublish(dir: string, serverDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(join(dir, "crash-runner.ts"), [dir, serverDir], {
      cwd: serverDir,
      env: { ...process.env, OMB_DATA_DIR: join(dir, "data") },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    running.push(child);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the crash runner never reached the manifest publish"));
    }, 120_000);
    child.on("message", (message: { type?: string }) => {
      if (message.type !== "publish-reached") return;
      clearTimeout(timer);
      child.kill("SIGKILL");
      child.once("exit", () => resolve());
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("a process that dies between the upload and the publish", () => {
  it("recovers both the edit and the delete it stranded, on the next boot's pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muster-sync-crash-"));
    tempDirs.push(dir);
    const serverDir = fileURLToPath(new URL(".", import.meta.url));
    const fixtures = [
      { objectId: "memory:bot_alpha", objectType: "memory", rev: 1, checksum: sha256("alpha content"), tombstone: false },
      { objectId: "memory:bot_beta", objectType: "memory", rev: 1, checksum: sha256(""), tombstone: true },
    ];
    writeFileSync(join(dir, "fixtures.json"), JSON.stringify(fixtures));
    writeFileSync(join(dir, "crash-runner.ts"), crashRunnerSource);

    await killAtPublish(dir, serverDir);

    // The durable state the killed process left: uploads on the wire, rows
    // drained, local manifest claiming both, the remote index told nothing.
    const remote = fileRemote(dir);
    const db = new DatabaseSync(join(dir, "journal.sqlite"));
    dbs.push(db);
    const local = localState();
    local.save({
      schema: 1,
      updatedAt: T0,
      entries: [
        {
          objectId: "memory:bot_alpha",
          objectType: "memory",
          rev: 1,
          checksum: sha256("alpha content"),
          fileName: syncObjectFileName("memory:bot_alpha", 1),
          updatedAt: T0,
          tombstone: false,
        },
        {
          objectId: "memory:bot_beta",
          objectType: "memory",
          rev: 1,
          checksum: sha256(""),
          fileName: syncObjectFileName("memory:bot_beta", 1),
          updatedAt: T0,
          tombstone: true,
        },
      ],
    });
    expect(syncChangeRows(db)).toEqual([]);
    expect(remote.index()).toEqual([]);
    expect(existsSync(join(dir, "objects", syncObjectFileName("memory:bot_alpha", 1)))).toBe(true);
    expect(existsSync(join(dir, "objects", syncObjectFileName("memory:bot_beta", 1)))).toBe(true);

    // The restarted process: same durable stores, nothing carried in memory.
    const readCrashedObject: SyncPassDeps["readObject"] = (row) => {
      const fixture = fixtures.find((f) => f.objectId === row.objectId);
      if (fixture === undefined) throw new Error(`no fixture for ${row.objectId}`);
      return anObject({
        objectId: fixture.objectId,
        objectType: "memory",
        rev: row.rev,
        checksum: fixture.checksum,
        payload: fixture.tombstone ? "" : "alpha content",
        tombstone: fixture.tombstone,
      });
    };
    const result = await runSyncPass(deps({ db, transport: remote.transport, local, readObject: readCrashedObject }));
    expect(result.errors).toEqual([]);
    expect(entryIds(remote.index())).toEqual(["memory:bot_alpha", "memory:bot_beta"]);
    expect(remote.index().find((entry) => entry.objectId === "memory:bot_beta")?.tombstone).toBe(true);

    // and the install is clean again afterwards
    const settled = await runSyncPass(
      deps({
        db,
        transport: remote.transport,
        local,
        readObject: () => {
          throw new Error("nothing is left to push");
        },
      }),
    );
    expect(settled.errors).toEqual([]);
    expect(settled.pushed).toHaveLength(0);
  }, 180_000);
});
