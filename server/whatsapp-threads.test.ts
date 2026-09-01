import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeCustomerThread,
  CUSTOMER_THREADS_FILE,
  findCustomerThread,
  mapCustomerReply,
  markCustomerThreadSeen,
  MAX_CUSTOMER_THREADS,
  registerCustomerThread,
  resetCustomerThreadsForTest,
  resolveCustomerThread,
} from "./whatsapp-threads.ts";

const dirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "muster-wa-threads-"));
  dirs.push(dir);
  return dir;
}

const threadFile = (dataDir: string) => join(dataDir, CUSTOMER_THREADS_FILE);

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    resetCustomerThreadsForTest(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

const INPUT = { key: "wa:15551234567", threadId: "thread-abc", botId: "bot-1" };

/** Drop the module's in-memory cache so the next call reloads from disk. */
function dropCache(dataDir: string): void {
  resetCustomerThreadsForTest(dataDir);
}

describe("registerCustomerThread / findCustomerThread", () => {
  it("round-trips a thread through the JSON file (mode 0600) and reloads from disk", () => {
    const dataDir = makeDataDir();
    registerCustomerThread(dataDir, INPUT, 1000);
    // SAFETY: the file was just written by registerCustomerThread with the
    // StoredRegistry shape; the assert below only inspects that known shape.
    const raw = JSON.parse(readFileSync(threadFile(dataDir), "utf8")) as {
      version: number;
      threads: Array<{ key: string; threadId: string; botId: string; lastAt: number }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.threads).toEqual([{ ...INPUT, lastAt: 1000 }]);

    // Reload from disk: drop the in-memory cache and look up again.
    dropCache(dataDir);
    expect(findCustomerThread(dataDir, INPUT.key)).toEqual({ ...INPUT, lastAt: 1000 });
  });

  it("defaults lastAt to Date.now when now is omitted", () => {
    const dataDir = makeDataDir();
    const before = Date.now();
    const thread = registerCustomerThread(dataDir, INPUT);
    expect(thread.lastAt).toBeGreaterThanOrEqual(before);
    expect(thread.lastAt).toBeLessThanOrEqual(Date.now());
  });

  it("upserts: a later register replaces the earlier mapping", () => {
    const dataDir = makeDataDir();
    registerCustomerThread(dataDir, INPUT, 1000);
    registerCustomerThread(dataDir, { ...INPUT, threadId: "thread-xyz" }, 2000);
    expect(findCustomerThread(dataDir, INPUT.key)?.threadId).toBe("thread-xyz");
  });

  it("creates DATA_DIR when missing", () => {
    const dataDir = join(makeDataDir(), "nested", "data");
    registerCustomerThread(dataDir, INPUT, 1000);
    expect(findCustomerThread(dataDir, INPUT.key)?.threadId).toBe(INPUT.threadId);
  });
});

describe("resolveCustomerThread", () => {
  it("reports fresh when nothing is registered and nothing is open", () => {
    const dataDir = makeDataDir();
    const resolved = resolveCustomerThread(dataDir, INPUT.key, INPUT.botId, {
      findOpenThread: () => null,
    });
    expect(resolved).toEqual({ threadId: "", fresh: true });
  });

  it("reuses an existing open thread found via findOpenThread and self-heals the registry", () => {
    const dataDir = makeDataDir();
    const resolved = resolveCustomerThread(dataDir, INPUT.key, INPUT.botId, {
      findOpenThread: (botId, key) =>
        botId === INPUT.botId && key === INPUT.key ? "thread-open" : null,
    });
    expect(resolved).toEqual({ threadId: "thread-open", fresh: false });
    // The discovered thread was re-registered durably.
    expect(findCustomerThread(dataDir, INPUT.key)?.threadId).toBe("thread-open");
  });

  it("reuses a remembered thread when no findOpenThread is provided", () => {
    const dataDir = makeDataDir();
    registerCustomerThread(dataDir, INPUT, 1000);
    expect(resolveCustomerThread(dataDir, INPUT.key, INPUT.botId)).toEqual({
      threadId: INPUT.threadId,
      fresh: false,
    });
  });

  it("does not reuse a remembered thread belonging to a different bot", () => {
    const dataDir = makeDataDir();
    registerCustomerThread(dataDir, INPUT, 1000);
    expect(resolveCustomerThread(dataDir, INPUT.key, "bot-2")).toEqual({
      threadId: "",
      fresh: true,
    });
  });

  it("reports fresh when the remembered thread is no longer open in the store", () => {
    const dataDir = makeDataDir();
    registerCustomerThread(dataDir, INPUT, 1000);
    const resolved = resolveCustomerThread(dataDir, INPUT.key, INPUT.botId, {
      findOpenThread: () => null, // task was closed since
    });
    expect(resolved).toEqual({ threadId: "", fresh: true });
  });

  it("prefers the live store answer over a stale remembered threadId", () => {
    const dataDir = makeDataDir();
    registerCustomerThread(dataDir, INPUT, 1000);
    const resolved = resolveCustomerThread(dataDir, INPUT.key, INPUT.botId, {
      findOpenThread: () => "thread-live",
    });
    expect(resolved).toEqual({ threadId: "thread-live", fresh: false });
    expect(findCustomerThread(dataDir, INPUT.key)?.threadId).toBe("thread-live");
  });

  it("reuses across a restart: file is reloaded, not just cached", () => {
    const dataDir = makeDataDir();
    registerCustomerThread(dataDir, INPUT, 1000);
    dropCache(dataDir); // simulate process restart
    expect(resolveCustomerThread(dataDir, INPUT.key, INPUT.botId)).toEqual({
      threadId: INPUT.threadId,
      fresh: false,
    });
  });
});

describe("eviction", () => {
  it("evicts the oldest-lastAt entries beyond the bound", () => {
    const dataDir = makeDataDir();
    mkdirSync(dataDir, { recursive: true });
    // Seed the file directly at the bound + 5 (skips 2005 fsync-heavy
    // register writes) and let one register trigger the eviction.
    const total = MAX_CUSTOMER_THREADS + 5;
    const seeded = Array.from({ length: total }, (_, i) => ({
      key: `wa:${i}`,
      threadId: `t${i}`,
      botId: "b",
      lastAt: i,
    }));
    writeFileSync(
      threadFile(dataDir),
      JSON.stringify({ version: 1, threads: seeded }),
      { mode: 0o600 },
    );
    dropCache(dataDir);
    registerCustomerThread(dataDir, { key: "wa:fresh", threadId: "t-fresh", botId: "b" }, total);
    // SAFETY: the file was just written by registerCustomerThread with the
    // StoredRegistry shape; the assert below only inspects that known shape.
    const file = JSON.parse(readFileSync(threadFile(dataDir), "utf8")) as {
      threads: Array<{ key: string }>;
    };
    expect(file.threads.length).toBe(MAX_CUSTOMER_THREADS);
    // The six oldest (lastAt 0..5) are gone; the newest survive.
    expect(findCustomerThread(dataDir, "wa:0")).toBeNull();
    expect(findCustomerThread(dataDir, "wa:5")).toBeNull();
    expect(findCustomerThread(dataDir, "wa:6")?.threadId).toBe("t6");
    expect(findCustomerThread(dataDir, `wa:${total - 1}`)?.threadId).toBe(`t${total - 1}`);
    expect(findCustomerThread(dataDir, "wa:fresh")?.threadId).toBe("t-fresh");
  });
});

describe("corrupt file handling", () => {
  it("starts empty on unparseable JSON instead of throwing, then recovers", () => {
    const dataDir = makeDataDir();
    registerCustomerThread(dataDir, INPUT, 1000);
    dropCache(dataDir);
    rmSync(threadFile(dataDir));
    writeFileSync(threadFile(dataDir), "{not json", { mode: 0o600 });
    expect(findCustomerThread(dataDir, INPUT.key)).toBeNull();
    // The registry recovers: a new write replaces the garbage.
    registerCustomerThread(dataDir, INPUT, 2000);
    dropCache(dataDir);
    expect(findCustomerThread(dataDir, INPUT.key)).toEqual({ ...INPUT, lastAt: 2000 });
  });

  it("starts empty on schema-invalid JSON", () => {
    const dataDir = makeDataDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      threadFile(dataDir),
      JSON.stringify({
        version: 1,
        threads: [{ key: "", threadId: 42, botId: null, lastAt: "x" }],
      }),
      { mode: 0o600 },
    );
    expect(findCustomerThread(dataDir, INPUT.key)).toBeNull();
  });

  it("starts empty on a JSON array where an object is expected", () => {
    const dataDir = makeDataDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(threadFile(dataDir), "[1,2,3]", { mode: 0o600 });
    expect(findCustomerThread(dataDir, INPUT.key)).toBeNull();
  });
});

describe("closeCustomerThread / mapCustomerReply / markCustomerThreadSeen", () => {
  it("closeCustomerThread removes the mapping and persists the removal", () => {
    const dataDir = makeDataDir();
    registerCustomerThread(dataDir, INPUT, 1000);
    closeCustomerThread(dataDir, INPUT.key);
    expect(findCustomerThread(dataDir, INPUT.key)).toBeNull();
    dropCache(dataDir); // confirm the removal reached disk
    expect(findCustomerThread(dataDir, INPUT.key)).toBeNull();
  });

  it("closeCustomerThread is a no-op for unknown keys", () => {
    const dataDir = makeDataDir();
    expect(() => closeCustomerThread(dataDir, "wa:nobody")).not.toThrow();
  });

  it("mapCustomerReply routes a threadId back to its customer", () => {
    const dataDir = makeDataDir();
    registerCustomerThread(dataDir, INPUT, 1000);
    registerCustomerThread(
      dataDir,
      { key: "wa:25551112222", threadId: "thread-def", botId: "bot-1" },
      2000,
    );
    expect(mapCustomerReply(dataDir, "thread-def")?.key).toBe("wa:25551112222");
    expect(mapCustomerReply(dataDir, "thread-unknown")).toBeNull();
  });

  it("markCustomerThreadSeen is a deliberate no-op", () => {
    const dataDir = makeDataDir();
    registerCustomerThread(dataDir, INPUT, 1000);
    expect(() => markCustomerThreadSeen(dataDir, INPUT.key)).not.toThrow();
    expect(findCustomerThread(dataDir, INPUT.key)?.lastAt).toBe(1000);
  });
});
