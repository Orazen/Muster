// Memory history: every distinct past version of MEMORY.md is recorded so a
// bad self-edit — the bot rewrites its own memory with file tools the server
// never sees — can be inspected and rolled back. These tests drive the
// workspace module directly against a throwaway DATA_DIR, including the
// "agent" capture path where the file is written behind the server's back
// exactly as a bot's file tools would.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let prevDataDir: string | undefined;

// The history store and the memory functions under test share one module,
// re-imported per test against an isolated OMB_DATA_DIR (config.ts resolves
// DATA_DIR at import time).
async function load() {
  vi.resetModules();
  return import("./workspace.ts");
}

const tick = () => new Promise((r) => setTimeout(r, 3));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "memory-history-"));
  prevDataDir = process.env.OMB_DATA_DIR;
  process.env.OMB_DATA_DIR = home;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = prevDataDir;
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

describe("memory history", () => {
  it("records nothing for a bot that has only the untouched seed", async () => {
    const ws = await load();
    ws.ensureWorkspace("bot-seed");
    ws.memorySystemPrompt("bot-seed");
    expect(ws.listMemoryHistory("bot-seed")).toEqual([]);
  });

  it("records the replaced content of an editor save and dedupes no-op writes", async () => {
    const ws = await load();
    ws.writeMemoryFile("bot-edit", "version one\n");
    // the seed baseline is not history: the first save replaced boilerplate
    expect(ws.listMemoryHistory("bot-edit")).toEqual([]);
    await tick();
    ws.writeMemoryFile("bot-edit", "version two\n");
    const versions = ws.listMemoryHistory("bot-edit");
    expect(versions).toHaveLength(1);
    expect(versions[0].origin).toBe("user-edit");
    expect(ws.readMemoryHistoryEntry("bot-edit", versions[0].id)?.text).toBe("version one\n");
    // a later prompt build sees no change and records nothing
    ws.memorySystemPrompt("bot-edit");
    expect(ws.listMemoryHistory("bot-edit")).toHaveLength(1);
    // rewriting the same content records nothing
    ws.writeMemoryFile("bot-edit", "version two\n");
    expect(ws.listMemoryHistory("bot-edit")).toHaveLength(1);
  });

  it("captures a self-write made behind the server's back at the next prompt build", async () => {
    const ws = await load();
    ws.writeMemoryFile("bot-agent", "before the bot meddled\n");
    const file = join(ws.workspaceDir("bot-agent"), "MEMORY.md");
    // what a bot's file tools do: write the file directly, no server route
    writeFileSync(file, "the bot rewrote its own beliefs\n", { mode: 0o600 });
    expect(ws.listMemoryHistory("bot-agent")).toHaveLength(0);
    ws.memorySystemPrompt("bot-agent");
    const versions = ws.listMemoryHistory("bot-agent");
    expect(versions).toHaveLength(1);
    expect(versions[0].origin).toBe("agent");
    const entry = ws.readMemoryHistoryEntry("bot-agent", versions[0].id);
    expect(entry?.text).toBe("before the bot meddled\n");
    expect(ws.readMemoryFile("bot-agent").text).toBe("the bot rewrote its own beliefs\n");
  });

  it("rolls back to a chosen version and rolls the rollback back", async () => {
    const ws = await load();
    ws.writeMemoryFile("bot-roll", "one\n");
    await tick();
    ws.writeMemoryFile("bot-roll", "two\n");
    await tick();
    ws.writeMemoryFile("bot-roll", "three\n");
    const versions = ws.listMemoryHistory("bot-roll");
    expect(versions.map((v) => v.origin)).toEqual(["user-edit", "user-edit"]);
    expect(versions[0].at >= versions[1].at).toBe(true);

    expect(ws.restoreMemoryHistory("bot-roll", versions[0].id)).toBe(true);
    expect(ws.readMemoryFile("bot-roll").text).toBe("two\n");
    // the displaced "three" became history, so the restore is reversible
    const displaced = ws.listMemoryHistory("bot-roll");
    expect(displaced[0].origin).toBe("rollback");
    expect(displaced).toHaveLength(3);
    expect(ws.restoreMemoryHistory("bot-roll", displaced[0].id)).toBe(true);
    expect(ws.readMemoryFile("bot-roll").text).toBe("three\n");

    // restoring the live content is a no-op, not a duplicate entry
    const stable = ws.listMemoryHistory("bot-roll");
    expect(ws.restoreMemoryHistory("bot-roll", stable[0].id)).toBe(true);
    expect(ws.listMemoryHistory("bot-roll")).toHaveLength(3);
  });

  it("keeps only the newest versions and prunes the oldest", async () => {
    const ws = await load();
    ws.writeMemoryFile("bot-cap", "seed replaced\n");
    for (let i = 0; i < 25; i++) {
      await tick();
      ws.writeMemoryFile("bot-cap", `generation ${i}\n`);
    }
    const versions = ws.listMemoryHistory("bot-cap");
    expect(versions).toHaveLength(20);
    // oldest recorded content is gone, newest survives: 25 snapshots
    // (seed-replaced + generations 0..23) prune to the newest 20
    const texts = versions.map((v) => ws.readMemoryHistoryEntry("bot-cap", v.id)?.text);
    expect(texts).not.toContain("seed replaced\n");
    expect(texts[texts.length - 1]).toBe("generation 4\n");
    expect(texts[0]).toBe("generation 23\n");
    expect(ws.readMemoryFile("bot-cap").text).toBe("generation 24\n");
  });

  it("refuses malformed version ids without reading anything", async () => {
    const ws = await load();
    ws.writeMemoryFile("bot-gate", "real content\n");
    await tick();
    ws.writeMemoryFile("bot-gate", "next\n");
    const good = ws.listMemoryHistory("bot-gate")[0].id;
    expect(ws.isMemoryHistoryId(good)).toBe(true);
    for (const bad of [
      "../MEMORY.md",
      "..\\MEMORY.md",
      "20260912T000000000-user-edit-ab.md", // short hex suffix
      "20260912T00000000-user-edit-ab12.md", // 16-digit stamp
      "20260912T000000000-agent-ab12.md/../../MEMORY.md",
      ".hidden-20260912T000000000-agent-ab12.md",
      "",
    ]) {
      expect(ws.isMemoryHistoryId(bad), bad).toBe(false);
      expect(ws.readMemoryHistoryEntry("bot-gate", bad), bad).toBeNull();
    }
    // a well-formed id that names no snapshot is null too
    expect(ws.readMemoryHistoryEntry("bot-gate", "20260912T000000000-agent-ab12.md")).toBeNull();
    // and the real one still reads
    expect(ws.readMemoryHistoryEntry("bot-gate", good)?.text).toBe("real content\n");
  });

  it("survives a deleted live file: restore recreates MEMORY.md", async () => {
    const ws = await load();
    ws.writeMemoryFile("bot-gone", "kept version\n");
    await tick();
    ws.writeMemoryFile("bot-gone", "lost version\n");
    const id = ws.listMemoryHistory("bot-gone")[0].id;
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(ws.workspaceDir("bot-gone"), "MEMORY.md"));
    expect(ws.restoreMemoryHistory("bot-gone", id)).toBe(true);
    expect(readFileSync(join(ws.workspaceDir("bot-gone"), "MEMORY.md"), "utf8")).toBe("kept version\n");
  });

  it("topic files and bundles are untouched by history bookkeeping", async () => {
    const ws = await load();
    ws.writeMemoryFile("bot-isolation", "memory body\n");
    const topicDir = join(ws.workspaceDir("bot-isolation"), "memory");
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(join(topicDir, "notes.md"), "topic body\n");
    ws.memorySystemPrompt("bot-isolation");
    expect(ws.listMemoryTopics("bot-isolation")).toEqual([{ name: "notes.md", bytes: 11 }]);
    expect(ws.readMemoryTopic("bot-isolation", "notes.md")).toBe("topic body\n");
  });

  it("retains and restores exact old bytes, including invalid UTF-8", async () => {
    const ws = await load();
    const bot = "bot-bytes";
    ws.ensureWorkspace(bot);
    const file = join(ws.workspaceDir(bot), "MEMORY.md");
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0x00, 0xc3, 0x28, 0x0d, 0x0a]);
    writeFileSync(file, original);
    ws.writeMemoryFile(bot, "replacement");
    const version = ws.listMemoryHistory(bot)[0];
    expect(readFileSync(join(ws.workspaceDir(bot), ".memory-history", version.id))).toEqual(original);
    expect(ws.restoreMemoryHistory(bot, version.id)).toBe(true);
    expect(readFileSync(file)).toEqual(original);
    expect(readFileSync(join(ws.workspaceDir(bot), ".memory-history", ".known"))).toEqual(original);
  });

  it("rejects linked history entries without reading or restoring another file", async () => {
    const ws = await load();
    const bot = "bot-linked-entry";
    ws.writeMemoryFile(bot, "keep current");
    const outside = join(home, "other-owner.txt");
    writeFileSync(outside, "synthetic private memory");
    const id = "20260912T010203004-agent-ab12.md";
    symlinkSync(outside, join(ws.workspaceDir(bot), ".memory-history", id));
    expect(ws.listMemoryHistory(bot)).toEqual([]);
    expect(ws.readMemoryHistoryEntry(bot, id)).toBeNull();
    expect(() => ws.restoreMemoryHistory(bot, id)).toThrow(/regular/);
    expect(ws.readMemoryFile(bot).text).toBe("keep current");
    expect(readFileSync(outside, "utf8")).toBe("synthetic private memory");
  });

  it("rejects linked history directories before read, write, restore or pruning", async () => {
    const ws = await load();
    const bot = "bot-linked-directory";
    ws.writeMemoryFile(bot, "keep current");
    const history = join(ws.workspaceDir(bot), ".memory-history");
    rmSync(history, { recursive: true });
    const outside = join(home, "other-history"); mkdirSync(outside);
    const id = "20260912T010203004-agent-ab12.md";
    writeFileSync(join(outside, id), "other version");
    symlinkSync(outside, history, "dir");
    expect(ws.listMemoryHistory(bot)).toEqual([]);
    expect(ws.readMemoryHistoryEntry(bot, id)).toBeNull();
    expect(() => ws.writeMemoryFile(bot, "unsafe write")).toThrow(/directories/);
    expect(() => ws.restoreMemoryHistory(bot, id)).toThrow(/directories/);
    expect(ws.readMemoryFile(bot).text).toBe("keep current");
    expect(readdirSync(outside)).toEqual([id]);
  });

  it("rejects linked workspace roots, live memory and baseline before writes", async () => {
    const ws = await load();
    const outside = join(home, "outside"); mkdirSync(outside);
    const sentinel = join(outside, "sentinel"); writeFileSync(sentinel, "unchanged");
    ws.writeMemoryFile("bot-root", "root current");
    symlinkSync(outside, ws.workspaceDir("bot-link"), "dir");
    expect(() => ws.writeMemoryFile("bot-link", "new")).toThrow(/directories/);
    expect(existsSync(join(outside, "MEMORY.md"))).toBe(false);
    for (const leaf of ["MEMORY.md", ".memory-history/.known"]) {
      const bot = leaf === "MEMORY.md" ? "bot-live-link" : "bot-baseline-link";
      ws.writeMemoryFile(bot, "keep current");
      const file = join(ws.workspaceDir(bot), leaf);
      rmSync(file); symlinkSync(sentinel, file);
      expect(() => ws.writeMemoryFile(bot, "new")).toThrow(/regular/);
      expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
      expect(ws.listMemoryHistory(bot)).toEqual([]);
    }
    rmSync(ws.WORKSPACES_DIR, { recursive: true });
    symlinkSync(outside, ws.WORKSPACES_DIR, "dir");
    expect(() => ws.writeMemoryFile("bot-root-link", "new")).toThrow(/directories/);
    expect(ws.listMemoryHistory("bot-root-link")).toEqual([]);
    expect(readdirSync(outside)).toEqual(["sentinel"]);
  });

  it("does not overwrite live memory when its history location is unusable", async () => {
    const ws = await load();
    const bot = "bot-retention-failure";
    ws.writeMemoryFile(bot, "sole old version");
    const history = join(ws.workspaceDir(bot), ".memory-history");
    rmSync(history, { recursive: true }); writeFileSync(history, "not a directory");
    expect(() => ws.writeMemoryFile(bot, "replacement")).toThrow();
    expect(ws.readMemoryFile(bot).text).toBe("sole old version");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("failed snapshot permissions leave rollback and editor bytes unchanged", async () => {
    const ws = await load();
    const bot = "bot-read-only-history";
    ws.writeMemoryFile(bot, "saved earlier"); ws.writeMemoryFile(bot, "keep current");
    const history = join(ws.workspaceDir(bot), ".memory-history");
    const id = ws.listMemoryHistory(bot)[0].id;
    const before = readdirSync(history).sort();
    chmodSync(history, 0o500);
    try {
      expect(() => ws.restoreMemoryHistory(bot, id)).toThrow();
      expect(() => ws.writeMemoryFile(bot, "replacement")).toThrow();
      expect(ws.readMemoryFile(bot).text).toBe("keep current");
      expect(readdirSync(history).sort()).toEqual(before);
    } finally { chmodSync(history, 0o700); }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("failed live replacement keeps old memory after a successful snapshot", async () => {
    const ws = await load();
    const bot = "bot-live-write-failure";
    ws.writeMemoryFile(bot, "keep current");
    const dir = ws.workspaceDir(bot); chmodSync(dir, 0o500);
    try {
      expect(() => ws.writeMemoryFile(bot, "replacement")).toThrow();
      expect(ws.readMemoryFile(bot).text).toBe("keep current");
      const history = ws.listMemoryHistory(bot);
      expect(history).toHaveLength(1);
      expect(ws.readMemoryHistoryEntry(bot, history[0].id)?.text).toBe("keep current");
      expect(readdirSync(join(dir, ".memory-history")).some(name => name.startsWith(".pending-") || name.endsWith(".tmp"))).toBe(false);
    } finally { chmodSync(dir, 0o700); }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("failed agent capture retains its baseline for a later successful retry", async () => {
    const ws = await load();
    const bot = "bot-agent-retry"; ws.writeMemoryFile(bot, "last known memory");
    const dir = ws.workspaceDir(bot); const history = join(dir, ".memory-history");
    writeFileSync(join(dir, "MEMORY.md"), "agent changed memory");
    chmodSync(history, 0o500);
    try {
      expect(ws.memorySystemPrompt(bot)).toContain("agent changed memory");
      expect(readFileSync(join(history, ".known"), "utf8")).toBe("last known memory");
      expect(ws.listMemoryHistory(bot)).toEqual([]);
    } finally { chmodSync(history, 0o700); }
    ws.memorySystemPrompt(bot);
    const entries = ws.listMemoryHistory(bot);
    expect(entries).toHaveLength(1); expect(entries[0].origin).toBe("agent");
    expect(ws.readMemoryHistoryEntry(bot, entries[0].id)?.text).toBe("last known memory");
    expect(readFileSync(join(history, ".known"), "utf8")).toBe("agent changed memory");
  });

  it("rejects oversized history and direct saves before replacing current memory", async () => {
    const ws = await load();
    const bot = "bot-byte-cap"; ws.writeMemoryFile(bot, "keep current");
    const history = join(ws.workspaceDir(bot), ".memory-history");
    const id = "20260912T010203004-agent-ab12.md";
    const tooLarge = "x".repeat(ws.MEMORY_FILE_MAX_BYTES + 1);
    writeFileSync(join(history, id), tooLarge);
    expect(ws.listMemoryHistory(bot)).toEqual([]);
    expect(ws.readMemoryHistoryEntry(bot, id)).toBeNull();
    expect(() => ws.restoreMemoryHistory(bot, id)).toThrow(/256KB/);
    expect(() => ws.writeMemoryFile(bot, tooLarge)).toThrow(/256KB/);
    expect(ws.readMemoryFile(bot).text).toBe("keep current");
    writeFileSync(join(history, id), "x".repeat(ws.MEMORY_FILE_MAX_BYTES));
    expect(ws.restoreMemoryHistory(bot, id)).toBe(true);
    expect(readFileSync(join(ws.workspaceDir(bot), "MEMORY.md")).length).toBe(ws.MEMORY_FILE_MAX_BYTES);
  });

  it("rejects non-file history entries and preserves the legacy missing-id result", async () => {
    const ws = await load();
    const bot = "bot-history-directory"; ws.writeMemoryFile(bot, "keep current");
    const id = "20260912T010203004-agent-ab12.md";
    mkdirSync(join(ws.workspaceDir(bot), ".memory-history", id));
    expect(ws.listMemoryHistory(bot)).toEqual([]);
    expect(ws.readMemoryHistoryEntry(bot, id)).toBeNull();
    expect(() => ws.restoreMemoryHistory(bot, id)).toThrow(/regular/);
    expect(ws.restoreMemoryHistory(bot, "20260912T010203004-agent-ffff.md")).toBe(false);
    expect(ws.readMemoryFile(bot).text).toBe("keep current");
  });

  it.each(["save", "rollback"])("%s preserves the displaced version when existing timestamps are all in the future", async (operation) => {
    const ws = await load();
    const bot = `bot-future-${operation}`;
    ws.writeMemoryFile(bot, "unique current bytes");
    const history = join(ws.workspaceDir(bot), ".memory-history");
    const ids = Array.from({ length: 20 }, (_, i) => `20991231T235959${String(i).padStart(3, "0")}-user-edit-ab12.md`);
    ids.forEach((id, i) => writeFileSync(join(history, id), `future version ${i}`));
    if (operation === "save") ws.writeMemoryFile(bot, "replacement");
    else expect(ws.restoreMemoryHistory(bot, ids[0])).toBe(true);
    const entries = ws.listMemoryHistory(bot);
    expect(entries).toHaveLength(20);
    const displaced = entries.find(entry => ws.readMemoryHistoryEntry(bot, entry.id)?.text === "unique current bytes");
    expect(displaced).toBeDefined();
    expect(ws.restoreMemoryHistory(bot, displaced!.id)).toBe(true);
    expect(ws.readMemoryFile(bot).text).toBe("unique current bytes");
  });

  it.each(["save", "rollback"])("%s retains both an uncaptured agent baseline and live bytes under the cap", async (operation) => {
    const ws = await load();
    const bot = `bot-uncaptured-${operation}`;
    ws.writeMemoryFile(bot, "baseline A");
    const dir = ws.workspaceDir(bot); const history = join(dir, ".memory-history");
    const ids = Array.from({ length: 20 }, (_, i) => `20991231T235959${String(i).padStart(3, "0")}-user-edit-ab12.md`);
    ids.forEach((id, i) => writeFileSync(join(history, id), `future version ${i}`));
    writeFileSync(join(dir, "MEMORY.md"), "agent B");
    if (operation === "save") ws.writeMemoryFile(bot, "editor C");
    else expect(ws.restoreMemoryHistory(bot, ids[0])).toBe(true);
    const entries = ws.listMemoryHistory(bot);
    expect(entries).toHaveLength(20);
    const records = entries.map(entry => ws.readMemoryHistoryEntry(bot, entry.id));
    expect(records.find(entry => entry?.text === "baseline A")?.origin).toBe("agent");
    expect(records.find(entry => entry?.text === "agent B")?.origin).toBe(operation === "save" ? "user-edit" : "rollback");
  });

  it("a no-op editor save still retains an uncaptured prior agent baseline", async () => {
    const ws = await load(); const bot = "bot-noop-agent";
    ws.writeMemoryFile(bot, "baseline A");
    writeFileSync(join(ws.workspaceDir(bot), "MEMORY.md"), "agent B");
    ws.writeMemoryFile(bot, "agent B");
    const entries = ws.listMemoryHistory(bot);
    expect(entries).toHaveLength(1);
    expect(ws.readMemoryHistoryEntry(bot, entries[0].id)?.text).toBe("baseline A");
    expect(entries[0].origin).toBe("agent");
    expect(ws.readMemoryFile(bot).text).toBe("agent B");
  });
});
