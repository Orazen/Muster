import { mkdtempSync, writeFileSync, utimesSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deleteStaleArchivedLogs, listEventLogFiles, trimAllEventLogs, trimEventLog } from "./event-log-cleanup.ts";

const DAY = 24 * 60 * 60 * 1000;

function makeEventsDir(): string {
  return mkdtempSync(join(tmpdir(), "omb-cleanup-"));
}

function makeLog(dir: string, threadId: string, lines: string[], ageMs = 0): string {
  const path = join(dir, `${threadId}.ndjson`);
  writeFileSync(path, lines.join("\n") + "\n");
  if (ageMs !== 0) utimesSync(path, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  return path;
}

const jsonLine = (i: number) => JSON.stringify({ seq: i, type: "item.completed", text: `event-${i}` });

describe("listEventLogFiles", () => {
  it("lists only thread logs, excluding the sync journal by prefix", () => {
    const dir = makeEventsDir();
    writeFileSync(join(dir, "thread-a.ndjson"), "");
    writeFileSync(join(dir, "sync-2026-09-25.ndjson"), "");
    writeFileSync(join(dir, "notes.txt"), "");
    expect(listEventLogFiles(dir)).toEqual([join(dir, "thread-a.ndjson")]);
  });

  it("returns an empty list for a missing directory", () => {
    expect(listEventLogFiles(join(tmpdir(), "omb-missing-xyz"))).toEqual([]);
  });
});

describe("deleteStaleArchivedLogs", () => {
  it("deletes archived threads' logs past the threshold and keeps fresh or active ones", () => {
    const dir = makeEventsDir();
    const stale = makeLog(dir, "stale-thread", [jsonLine(1)], 10 * DAY);
    const fresh = makeLog(dir, "fresh-archived", [jsonLine(2)], 1 * DAY);
    // an ACTIVE thread's log is freshly written by the bus on every event
    const active = makeLog(dir, "active-thread", [jsonLine(3)], 0);
    const result = deleteStaleArchivedLogs({
      eventsDir: dir,
      archivedThreadIds: new Set(["stale-thread", "fresh-archived", "active-thread"]),
      days: 7,
    });
    expect(result).toEqual({ deleted: 1, trimmed: 0 });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(active)).toBe(true);
  });

  it("never deletes a log whose thread is not archived, however old", () => {
    const dir = makeEventsDir();
    const oldButLive = makeLog(dir, "live-thread", [jsonLine(1)], 90 * DAY);
    const result = deleteStaleArchivedLogs({ eventsDir: dir, archivedThreadIds: new Set(), days: 30 });
    expect(result.deleted).toBe(0);
    expect(existsSync(oldButLive)).toBe(true);
  });

  it("treats the file's mtime as the age signal, not its content", () => {
    const dir = makeEventsDir();
    makeLog(dir, "t", [`{"at":"${new Date(Date.now() - 400 * DAY).toISOString()}"}`], 1);
    const result = deleteStaleArchivedLogs({ eventsDir: dir, archivedThreadIds: new Set(["t"]), days: 30 });
    expect(result.deleted).toBe(0);
  });

  it("ignores nonsense thresholds", () => {
    const dir = makeEventsDir();
    makeLog(dir, "t", [jsonLine(1)], 10 * DAY);
    expect(deleteStaleArchivedLogs({ eventsDir: dir, archivedThreadIds: new Set(["t"]), days: 0 }).deleted).toBe(0);
    expect(deleteStaleArchivedLogs({ eventsDir: dir, archivedThreadIds: new Set(["t"]), days: Number.NaN }).deleted).toBe(0);
  });
});

describe("trimEventLog", () => {
  it("keeps the newest tail under the cap, cut at a newline boundary", () => {
    const dir = makeEventsDir();
    const lines = Array.from({ length: 42000 }, (_, i) => jsonLine(i));
    const path = join(dir, "big.ndjson");
    writeFileSync(path, lines.join("\n") + "\n");
    const before = statSync(path).size;
    expect(before).toBeGreaterThan(2 * 1024 * 1024);

    expect(trimEventLog(path, 1)).toBe(true);
    const after = statSync(path).size;
    expect(after).toBeLessThanOrEqual(1024 * 1024);
    const kept = readFileSync(path, "utf8");
    // every kept line is whole
    expect(kept.startsWith("{")).toBe(true);
    expect(kept.endsWith("\n")).toBe(true);
    // every kept line parses as the event shape this test wrote
    const parsed = kept
      .trim()
      .split("\n")
      .map((l) => z.object({ seq: z.number() }).parse(JSON.parse(l)).seq);
    // newest events survived, oldest were dropped
    expect(parsed[0]).toBeGreaterThan(0);
    expect(parsed[parsed.length - 1]).toBe(41999);
  });

  it("is a no-op under the cap and rejects nonsense caps", () => {
    const dir = makeEventsDir();
    const path = makeLog(dir, "small", [jsonLine(1)]);
    expect(trimEventLog(path, 5)).toBe(false);
    expect(trimEventLog(path, 0)).toBe(false);
    expect(trimEventLog(join(dir, "missing.ndjson"), 5)).toBe(false);
  });

  it("trims every oversized log across the directory", () => {
    const dir = makeEventsDir();
    const big1 = join(dir, "a.ndjson");
    const big2 = join(dir, "b.ndjson");
    // ~55 bytes/line → 21k lines clears the 1 MiB cap
    writeFileSync(big1, Array.from({ length: 21000 }, (_, i) => jsonLine(i)).join("\n") + "\n");
    writeFileSync(big2, Array.from({ length: 21000 }, (_, i) => jsonLine(i)).join("\n") + "\n");
    writeFileSync(join(dir, "small.ndjson"), jsonLine(0) + "\n");
    expect(trimAllEventLogs(dir, 1)).toBe(2);
  });
});
