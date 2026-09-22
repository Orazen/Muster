// S2c red/green — the memory producer and the pass's memory deps, driven
// against a throwaway DATA_DIR (config resolves DATA_DIR at import time,
// so both modules are re-imported per test like the history tests do).
// The invariants: the LOCAL manifest entry is the rev source (a write
// after a remote apply takes the next rev), byte-identical rewrites burn
// nothing, readObject recomputes and never lies about the row, and
// applyObject writes without firing the producer (no two-install
// ping-pong) while still refusing anything the file layer would refuse.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { manifestDocSchema, syncObjectFileName, type SyncManifestDoc, type SyncObject } from "./sync-objects.ts";
import type { LocalManifestStore } from "./sync-wiring.ts";

let home: string;
let prevDataDir: string | undefined;

const T0 = 1_760_000_000_000;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// SQL results go straight through zod — the house pattern, no casts
const journalRowSchema = z.object({
  objectId: z.string(),
  objectType: z.string(),
  rev: z.number().int(),
  checksum: z.string(),
  state: z.enum(["pending", "inflight", "dead"]),
  attempts: z.number().int(),
  enqueuedAt: z.number().int(),
  nextAttemptAt: z.number().int(),
  claimedAt: z.number().int().nullable(),
});
const revStateRow = z.object({ rev: z.number().int(), checksum: z.string(), state: z.string() });
const revOnlyRow = z.object({ rev: z.number().int() });

const entryFor = (botId: string, rev: number, text: string): SyncManifestDoc["entries"][number] => ({
  objectId: `memory:${botId}`,
  objectType: "memory",
  rev,
  checksum: sha256(text),
  fileName: syncObjectFileName(`memory:${botId}`, rev),
  updatedAt: T0,
  tombstone: false,
});

const docWith = (...entries: SyncManifestDoc["entries"]): SyncManifestDoc => ({
  schema: 1,
  updatedAt: T0,
  entries,
});

// The history tests' isolation pattern: resetModules per load so config's
// DATA_DIR and the sync-hooks registry both re-resolve against `home`.
async function load() {
  vi.resetModules();
  const [ws, mem, hooks] = await Promise.all([
    import("./workspace.ts"),
    import("./sync-memory.ts"),
    import("./sync-hooks.ts"),
  ]);
  return { ws, mem, hooks };
}

/** A plain-file local manifest with the same shape the real store has. */
function memoryStore(path: string): LocalManifestStore {
  return {
    load(): SyncManifestDoc | null {
      if (!existsSync(path)) return null;
      return manifestDocSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    },
    save(doc: SyncManifestDoc): void {
      manifestDocSchema.parse(doc);
      writeFileSync(path, JSON.stringify(doc), { mode: 0o600 });
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sync-memory-"));
  prevDataDir = process.env.OMB_DATA_DIR;
  process.env.OMB_DATA_DIR = home;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = prevDataDir;
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

describe("createMemoryProducer", () => {
  it("first write enqueues rev 1, saves the canonical local entry, and notifies", async () => {
    const { mem } = await load();
    const db = new DatabaseSync(":memory:");
    const notify = vi.fn();
    const local = memoryStore(join(home, "local.json"));
    const produce = mem.createMemoryProducer({ db, local, notify, now: () => T0 });
    produce("bot-1", "hello\n");
    const row = revStateRow.parse(db.prepare("SELECT rev, checksum, state FROM sync_journal").get());
    expect(row).toEqual({ rev: 1, checksum: sha256("hello\n"), state: "pending" });
    expect(local.load()?.entries[0]?.fileName).toBe("muster-memory%3Abot-1-1.enc");
    expect(notify).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("a second, different write supersedes to rev 2", async () => {
    const { mem } = await load();
    const db = new DatabaseSync(":memory:");
    const notify = vi.fn();
    const local = memoryStore(join(home, "local.json"));
    const produce = mem.createMemoryProducer({ db, local, notify, now: () => T0 });
    produce("bot-1", "one\n");
    produce("bot-1", "two\n");
    const row = revStateRow.parse(db.prepare("SELECT rev, checksum, state FROM sync_journal").get());
    expect(row).toEqual({ rev: 2, checksum: sha256("two\n"), state: "pending" });
    expect(local.load()?.entries[0]?.rev).toBe(2);
    expect(notify).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("a byte-identical rewrite burns no rev and does not notify", async () => {
    const { mem } = await load();
    const db = new DatabaseSync(":memory:");
    const notify = vi.fn();
    const local = memoryStore(join(home, "local.json"));
    const produce = mem.createMemoryProducer({ db, local, notify, now: () => T0 });
    produce("bot-1", "same\n");
    produce("bot-1", "same\n");
    const row = revOnlyRow.parse(db.prepare("SELECT rev FROM sync_journal").get());
    expect(row.rev).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("the next local write after a remote apply takes the applied rev plus one", async () => {
    const { mem } = await load();
    const db = new DatabaseSync(":memory:");
    const notify = vi.fn();
    const local = memoryStore(join(home, "local.json"));
    // simulate the pass committing an applied remote object at rev 5
    local.save(docWith(entryFor("bot-1", 5, "remote content\n")));
    const produce = mem.createMemoryProducer({ db, local, notify, now: () => T0 });
    produce("bot-1", "local after remote\n");
    const row = revOnlyRow.parse(db.prepare("SELECT rev FROM sync_journal").get());
    expect(row.rev).toBe(6);
    expect(local.load()?.entries[0]?.rev).toBe(6);
    db.close();
  });
});

describe("readMemoryObject", () => {
  const readRow = (db: DatabaseSync) => journalRowSchema.parse(db.prepare("SELECT * FROM sync_journal").get());

  it("agrees with its own journal row after a producer write", async () => {
    const { mem, ws, hooks } = await load();
    const db = new DatabaseSync(":memory:");
    const local = memoryStore(join(home, "local.json"));
    const produce = mem.createMemoryProducer({ db, local, notify: () => {}, now: () => T0 });
    // the real seam: the file write fires the hook that enqueues the row
    hooks.setMemoryWriteListener(produce);
    ws.writeMemoryFile("bot-read", "content to push\n");
    hooks.setMemoryWriteListener(null);
    const row = readRow(db);
    const object = await mem.readMemoryObject()(row);
    expect(object.rev).toBe(row.rev);
    expect(object.checksum).toBe(row.checksum);
    expect(object.payload).toBe("content to push\n");
    expect(object.tombstone).toBe(false);
    expect(object.ownerId).toBe("bot-read");
    expect(object.schemaVersion).toBe(1);
    expect(object.createdAt).toBeGreaterThan(0);
    expect(object.updatedAt).toBeGreaterThan(0);
    db.close();
  });

  it("recomputes from current bytes, so a silent file edit disagrees with the row", async () => {
    const { mem, ws, hooks } = await load();
    const db = new DatabaseSync(":memory:");
    const local = memoryStore(join(home, "local.json"));
    const produce = mem.createMemoryProducer({ db, local, notify: () => {}, now: () => T0 });
    hooks.setMemoryWriteListener(produce);
    ws.writeMemoryFile("bot-drift", "enqueued\n");
    hooks.setMemoryWriteListener(null);
    const row = readRow(db);
    // a write BEHIND the server's back, exactly like a bot's file tools
    writeFileSync(join(ws.workspaceDir("bot-drift"), "MEMORY.md"), "changed behind the back\n", { mode: 0o600 });
    const object = await mem.readMemoryObject()(row);
    expect(object.checksum).not.toBe(row.checksum);
    db.close();
  });

  it("refuses foreign and path-escaping object ids before touching the filesystem", async () => {
    const { mem } = await load();
    const row = journalRowSchema.parse({
      objectId: "settings:thing",
      objectType: "memory",
      rev: 1,
      checksum: sha256("x"),
      state: "pending",
      attempts: 0,
      enqueuedAt: T0,
      nextAttemptAt: T0,
      claimedAt: null,
    });
    expect(() => mem.readMemoryObject()(row)).toThrow(/not a memory object/);
    expect(() => mem.readMemoryObject()({ ...row, objectId: "memory:../evil" })).toThrow(/unsafe bot id/);
  });

  it("persists a random install id instead of deriving one from hardware", async () => {
    const { mem } = await load();
    const first = mem.syncInstallId();
    const second = mem.syncInstallId();
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    // garbage in the file regenerates rather than being trusted
    const garbage = "definitely-not-an-install-id".repeat(4);
    writeFileSync(join(home, "sync-install-id"), garbage, { mode: 0o600 });
    const third = mem.syncInstallId();
    expect(third).toMatch(/^[0-9a-f-]{36}$/u);
    expect(third).not.toBe(garbage);
  });
});

describe("applyMemoryObject", () => {
  const memoryObject = (objectId: string, payload: string): SyncObject => ({
    objectId,
    objectType: "memory",
    ownerId: "bot",
    rev: 3,
    createdAt: T0,
    updatedAt: T0,
    deviceId: "other-install",
    checksum: sha256(payload),
    tombstone: false,
    schemaVersion: 1,
    payload,
  });

  it("writes the payload so the next turn's prompt load sees it", async () => {
    const { mem, ws } = await load();
    ws.ensureWorkspace("bot-apply");
    mem.applyMemoryObject()(memoryObject("memory:bot-apply", "memory from the other install\n"));
    expect(ws.loadMemory("bot-apply")?.text).toBe("memory from the other install\n");
  });

  it("fires no producer hook and records no history — apply never pushes back", async () => {
    const { mem, ws, hooks } = await load();
    const listener = vi.fn();
    hooks.setMemoryWriteListener(listener);
    ws.ensureWorkspace("bot-quiet");
    mem.applyMemoryObject()(memoryObject("memory:bot-quiet", "applied\n"));
    expect(listener).not.toHaveBeenCalled();
    expect(ws.listMemoryHistory("bot-quiet")).toEqual([]);
    hooks.setMemoryWriteListener(null);
  });

  it("refuses payloads over the file cap and foreign or escaping object ids", async () => {
    const { mem, ws } = await load();
    ws.ensureWorkspace("bot-cap");
    expect(() => mem.applyMemoryObject()(memoryObject("memory:bot-cap", "x".repeat(257 * 1024)))).toThrow(/256KB/);
    expect(() => mem.applyMemoryObject()(memoryObject("secrets:thing", "x"))).toThrow(/not a memory object/);
    expect(() => mem.applyMemoryObject()(memoryObject("memory:../../escape", "x"))).toThrow(/unsafe bot id/);
  });
});

describe("the workspace hook seam", () => {
  it("writeMemoryFile fires the registered listener with the saved text", async () => {
    const { ws, hooks } = await load();
    const listener = vi.fn();
    hooks.setMemoryWriteListener(listener);
    ws.writeMemoryFile("bot-hook", "fired by the hook\n");
    expect(listener).toHaveBeenCalledWith("bot-hook", "fired by the hook\n");
    hooks.setMemoryWriteListener(null);
  });

  it("writes still succeed with no listener registered", async () => {
    const { ws } = await load();
    expect(() => ws.writeMemoryFile("bot-unwired", "no listener\n")).not.toThrow();
    expect(ws.readMemoryFile("bot-unwired").text).toBe("no listener\n");
  });
});
