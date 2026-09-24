// Loop200 / P5a (docs/plans/local-first-architecture-plan-2026-09-23.md,
// §8 "P5 — Event protocol + device identity + revocation", R5/R12) — the
// typed event receipts and the install identity, plus the regression for a
// bug this work exposed in the journal itself.
//
// What is pinned here:
//   - the type vocabulary derived from (objectType, rev, tombstone, applied):
//     rev 1 is `created`, later revs are `updated`, a producer that knows it
//     is deleting says `deleted`, and an install that replayed a peer's rev
//     says `applied`;
//   - a receipt is an identifier list, never content: a real transcript
//     write whose message body and "secret" values are then grepped for in
//     the event FILE, plus the exact key set of every line;
//   - only a real enqueue earns an event — a duplicate or stale enqueue is
//     not a change — and a receipt that cannot be written never fails the
//     write it describes;
//   - identity is stable per install, different across installs, and the
//     same value the sync objects carry (one device_id, two views);
//   - retention is bounded: daily `sync-*.ndjson` files, oldest pruned, a
//     damaged line skipped rather than blinding the read;
//   - the P5 gate itself: two installs, one owner — install A writes a
//     message and sees `chat.created` under ITS device id; A's pass pushes;
//     install B's pass pulls, verifies and applies, sees `chat.applied`
//     under B's OWN device id, and holds the same message;
//   - the Loop200 regression: a second write to the same object must keep
//     `objectType` intact so the dispatcher still routes it — the exact case
//     that used to overwrite the type with the object id and dead-letter
//     every push after the first.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Type-only on purpose: a VALUE import of sync-objects / sync-wiring here
// would pull config.ts into the module graph before beforeEach points
// OMB_DATA_DIR at the throwaway root, and the real ~/.muster would receive
// the test's writes. Every runtime module is loaded fresh per install.
import type { SyncManifestDoc } from "./sync-objects.ts";
import type { LocalManifestStore } from "./sync-wiring.ts";

const T0 = 1_760_000_000_000;
const PASSPHRASE = "correct horse battery staple";
const APP_VERSION = "0.0.0-test";
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const day = 86_400_000;

let home: string;
let prevDataDir: string | undefined;
const dbs: DatabaseSync[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sync-events-"));
  prevDataDir = process.env.OMB_DATA_DIR;
  process.env.OMB_DATA_DIR = home;
});

afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  if (prevDataDir === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = prevDataDir;
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

const message = (id: string, at: number, text: string) => ({
  id,
  at,
  role: "bot" as const,
  kind: "text" as const,
  text,
});

// SQL results go straight through zod — the house pattern, no assertions
const countSchema = z.object({ n: z.number().int() });
const journalCount = (db: DatabaseSync): number => {
  try {
    return countSchema.parse(db.prepare("SELECT COUNT(*) AS n FROM sync_journal").get()).n;
  } catch {
    return 0; // no journal table yet means nothing was ever enqueued
  }
};

/** The shared "remote" both installs push to and pull from — a byte map,
 * which is all SyncTransportDeps is. */
function remoteTransport(store: Map<string, Buffer>) {
  return {
    async upload(fileName: string, bytes: Buffer) {
      store.set(fileName, bytes);
    },
    async download(fileName: string) {
      return store.get(fileName) ?? null;
    },
    async loadRemoteManifest() {
      const bytes = store.get("muster-manifest.json");
      return bytes === undefined ? null : { bytes, guard: null };
    },
    async saveRemoteManifest(bytes: Buffer) {
      store.set("muster-manifest.json", bytes);
    },
  };
}

/** One install: fresh modules against the CURRENT OMB_DATA_DIR, its own
 * journal db, its own local manifest, the real chat producer wired through
 * the real hook registry, and the real pass deps (dispatch included). */
async function install(remote: Map<string, Buffer> = new Map(), dataDir: string = home) {
  vi.resetModules();
  const [events, hooks, chats, dispatch, journal, objects, pass] = await Promise.all([
    import("./sync-events.ts"),
    import("./sync-hooks.ts"),
    import("./sync-chats.ts"),
    import("./sync-dispatch.ts"),
    import("./sync-journal.ts"),
    import("./sync-objects.ts"),
    import("./sync-pass.ts"),
  ]);
  const msgdb = await import("./message-db.ts");
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const localFile = join(dataDir, "local.json");
  // The schema comes from this install's own freshly-loaded module, which is
  // why the store is built here and not in a shared helper: a module-level
  // parser would have to take `unknown`, and the house rule is that a
  // boundary parser names its own input.
  const local: LocalManifestStore = {
    load(): SyncManifestDoc | null {
      if (!existsSync(localFile)) return null;
      return objects.manifestDocSchema.parse(JSON.parse(readFileSync(localFile, "utf8")));
    },
    save(doc: SyncManifestDoc): void {
      objects.manifestDocSchema.parse(doc);
      writeFileSync(localFile, JSON.stringify(doc), { mode: 0o600 });
    },
  };
  hooks.setChatChangeListener(chats.createChatProducer({ db, local, notify: () => {} }));
  return {
    events,
    hooks,
    chats,
    dispatch,
    journal,
    pass,
    msgdb,
    db,
    local,
    remote,
    runPass: (passphrase = PASSPHRASE) =>
      pass.runSyncPass({
        db,
        transport: remoteTransport(remote),
        local: { load: () => local.load(), save: (doc) => local.save(doc) },
        readObject: dispatch.createObjectRead(),
        applyObject: dispatch.createObjectApply(),
        passphrase,
        appVersion: APP_VERSION,
      }),
  };
}

describe("the type vocabulary", () => {
  it("derives created, updated, deleted and applied from what actually happened", async () => {
    const { events } = await install();
    expect(events.syncEventType("chat", 1)).toBe("chat.created");
    expect(events.syncEventType("chat", 2)).toBe("chat.updated");
    expect(events.syncEventType("chat", 9, { tombstone: true })).toBe("chat.deleted");
    expect(events.syncEventType("memory", 3, { applied: true })).toBe("memory.applied");
    // A future object type must not break the stream by being unknown here.
    expect(events.syncEventType("workspace-vault", 1)).toBe("workspace-vault.created");
  });
});

describe("what a receipt is", () => {
  it("is written for a real enqueue and never for a duplicate or a stale one", async () => {
    const a = await install();
    const seen: string[] = [];
    a.events.setSyncEventSink((event) => seen.push(`${event.type}:${event.rev}`));
    const input = (rev: number, checksum: string) => ({
      objectId: "chat:thread-a",
      objectType: "chat",
      rev,
      checksum,
    });
    expect(a.journal.enqueueSyncChange(a.db, input(1, sha256("one")), T0)).toBe("enqueued");
    expect(a.journal.enqueueSyncChange(a.db, input(1, sha256("one")), T0 + 1)).toBe("duplicate");
    expect(a.journal.enqueueSyncChange(a.db, input(1, sha256("other")), T0 + 2)).toBe("stale");
    expect(seen).toEqual(["chat.created:1"]);
  });

  it("carries identifiers only: a transcript write's text and secrets never reach the file", async () => {
    const a = await install();
    a.msgdb.appendMessage(
      "thread-a",
      message("m1", T0, "my password is hunter2 and mail is owner@example.com token sk-live-SECRET-123"),
    );
    // The whole stream, whatever day each receipt landed on: a local write
    // is stamped with the clock that made it, an applied object with the
    // timestamp the producing install put in the object.
    const dir = join(home, "events");
    const text = readdirSync(dir)
      .filter((name) => name.startsWith("sync-"))
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("");
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("owner@example.com");
    expect(text).not.toContain("sk-live-SECRET-123");
    const created = a.events.readSyncEvents({ dataDir: home }).find((event) => event.type === "chat.created");
    expect(created).toBeDefined();
    expect(Object.keys(created ?? {}).sort()).toEqual([
      "at",
      "deviceId",
      "objectId",
      "objectType",
      "rev",
      "type",
      "v",
    ]);
  });

  it("never fails the write it describes when the receipt cannot be written", async () => {
    const a = await install();
    a.events.setSyncEventSink(() => {
      throw new Error("disk on fire");
    });
    expect(
      a.journal.enqueueSyncChange(
        a.db,
        { objectId: "chat:thread-a", objectType: "chat", rev: 1, checksum: sha256("one") },
        T0,
      ),
    ).toBe("enqueued");
    const row = a.journal.syncChangeRows(a.db).find((entry) => entry.objectId === "chat:thread-a");
    expect(row?.rev).toBe(1);
  });

  it("skips a damaged line instead of blinding the whole read", async () => {
    const a = await install();
    a.events.recordSyncEvent({ objectId: "chat:t", objectType: "chat", rev: 1, at: T0 });
    const file = join(home, "events", `sync-${new Date(T0).toISOString().slice(0, 10)}.ndjson`);
    writeFileSync(file, `${readFileSync(file, "utf8")}{"v":1,"type":"garbage"}\nnot json at all\n`, {
      mode: 0o600,
    });
    const events = a.events.readSyncEvents({ dataDir: home });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("chat.created");
  });
});

describe("identity", () => {
  it("is stable within an install, different across installs, and shaped like an id", async () => {
    const a = await install();
    const first = a.events.syncInstallId(home);
    expect(a.events.syncInstallId(home)).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    const other = mkdtempSync(join(tmpdir(), "sync-events-other-"));
    expect(a.events.syncInstallId(other)).not.toBe(first);
    rmSync(other, { recursive: true, force: true });
  });
});

describe("retention", () => {
  it("keeps the stream bounded and drops the oldest days first", async () => {
    const a = await install();
    for (let dayIndex = 0; dayIndex < 40; dayIndex += 1) {
      a.events.recordSyncEvent({
        objectId: `chat:thread-${dayIndex}`,
        objectType: "chat",
        rev: 1,
        at: T0 + dayIndex * day,
      });
    }
    const files = readdirSync(join(home, "events")).filter((name) => name.startsWith("sync-"));
    expect(files.length).toBeLessThanOrEqual(a.events.EVENT_MAX_FILES);
    const remaining = a.events.readSyncEvents({ dataDir: home, limit: 1000 });
    expect(remaining).toHaveLength(a.events.EVENT_MAX_FILES);
    // The newest day survived; the oldest did not.
    expect(remaining.at(-1)?.objectId).toBe("chat:thread-39");
    expect(remaining.some((event) => event.objectId === "chat:thread-0")).toBe(false);
  });
});

describe("two installs, one owner (the P5 gate)", () => {
  it("writes on A, pushes, and B replays it with B's own device id", async () => {
    const remote = new Map<string, Buffer>();

    // Install A: the write, the receipt, and the push.
    const a = await install(remote);
    a.msgdb.appendMessage("thread-a", message("m1", T0, "from install A"));
    const aEvents = a.events.readSyncEvents({ dataDir: home });
    expect(aEvents.map((event) => event.type)).toEqual(["chat.created"]);
    const deviceA = a.events.syncInstallId(home);
    expect(aEvents[0]?.deviceId).toBe(deviceA);
    const push = await a.runPass();
    expect(push.pushed.map((entry) => entry.objectId)).toEqual(["chat:thread-a"]);
    expect(push.pushed[0]?.rev).toBe(1);
    expect(push.pushed[0]?.fileName).toContain("chat");
    expect(push.errors).toEqual([]);

    // Install B: a different data root, so a different device id AND its own
    // local manifest — sharing A's would make B believe it already applied
    // A's object, which is a reconciliation truth, not a test convenience.
    const homeB = mkdtempSync(join(tmpdir(), "sync-events-b-"));
    process.env.OMB_DATA_DIR = homeB;
    const b = await install(remote, homeB);
    const deviceB = b.events.syncInstallId(homeB);
    expect(deviceB).not.toBe(deviceA);
    const pull = await b.runPass();
    expect(pull.pullApplied).toEqual([{ objectId: "chat:thread-a", rev: 1 }]);
    expect(pull.pullProblems).toEqual([]);
    const installed = b.msgdb.readThreadRows("thread-a");
    expect(installed.messages.map((entry) => entry.text)).toEqual(["from install A"]);
    expect(installed.activeLeafId).toBe("m1");

    // B's own receipt says applied — under B's id, for A's object.
    const bEvents = b.events.readSyncEvents({ dataDir: homeB });
    expect(bEvents.map((event) => `${event.type}:${event.objectId}`)).toEqual([
      "chat.applied:chat:thread-a",
    ]);
    expect(bEvents[0]?.deviceId).toBe(deviceB);
    expect(bEvents[0]?.rev).toBe(1);

    // B applying A's object must not enqueue a push-back (no ping-pong).
    expect(journalCount(b.db)).toBe(0);
    rmSync(homeB, { recursive: true, force: true });
  });
});

describe("the Loop200 supersede regression", () => {
  it("keeps objectType intact so the second push of an object still routes", async () => {
    const remote = new Map<string, Buffer>();
    const a = await install(remote);
    a.msgdb.appendMessage("thread-a", message("m1", T0, "first"));
    a.msgdb.appendMessage("thread-a", message("m2", T0 + 1, "second"));

    // The journal keeps ONE row per object: the second write supersedes it.
    const row = a.journal.syncChangeRows(a.db).find((entry) => entry.objectId === "chat:thread-a");
    expect(row?.rev).toBe(2);
    // Before the fix this read "chat:thread-a" and the dispatcher below
    // routed it to the memory reader, which refused it until dead-letter.
    expect(row?.objectType).toBe("chat");

    const result = await a.runPass();
    expect(result.errors).toEqual([]);
    expect(result.pushed.map((entry) => `${entry.objectId}@${entry.rev}`)).toEqual(["chat:thread-a@2"]);
    expect(result.journal).toMatchObject({ claimed: 1, drained: 1, failed: 0, dead: 0 });
  });
});
