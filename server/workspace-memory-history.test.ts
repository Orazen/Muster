// Memory history: every distinct past version of MEMORY.md is recorded so a
// bad self-edit — the bot rewrites its own memory with file tools the server
// never sees — can be inspected and rolled back. These tests drive the
// workspace module directly against a throwaway DATA_DIR, including the
// "agent" capture path where the file is written behind the server's back
// exactly as a bot's file tools would.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
