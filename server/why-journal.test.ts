import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendWhy,
  DECISIONS_HEADER,
  extractWhyFromReply,
  listWhy,
  MAX_DECISION_CHARS,
  MAX_WHY_DECISIONS,
  MAX_WHY_ENTRIES,
  resetWhyJournalForTest,
  WHY_JOURNAL_FILE,
  WHY_MARKER,
  whyPromptSuffix,
  type WhyEntry,
} from "./why-journal.ts";

const dirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "muster-why-journal-"));
  dirs.push(dir);
  return dir;
}

const journalFile = (dataDir: string) => join(dataDir, WHY_JOURNAL_FILE);

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    resetWhyJournalForTest(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

let nextRun = 0;

function makeEntry(overrides: Partial<WhyEntry> = {}): WhyEntry {
  nextRun += 1;
  return {
    runId: `run-${nextRun}`,
    botId: "bot-1",
    threadId: `thread-${nextRun}`,
    at: 1_000_000 + nextRun * 1000,
    intent: `intent ${nextRun}`,
    decisions: [`decision ${nextRun}`],
    outcome: "done",
    ...overrides,
  };
}

describe("extractWhyFromReply", () => {
  it("reads a well-formed WHY block and its decision bullets", () => {
    const reply = [
      "The staging deploy was failing on a stale image.",
      "I checked the provider logs first.",
      "",
      "WHY: restore the staging deploy",
      "DECISIONS:",
      "- rolled back to the last green image",
      "- pinned the provider to its fallback",
      "",
      "Everything is green again.",
    ].join("\n");
    expect(extractWhyFromReply(reply)).toEqual({
      intent: "restore the staging deploy",
      decisions: ["rolled back to the last green image", "pinned the provider to its fallback"],
    });
  });

  it("keeps the first WHY line and stops the bullet block at prose", () => {
    const reply = [
      "WHY: first intent",
      "DECISIONS:",
      "- kept choice",
      "Prose resumes here.",
      "- this bullet is outside the block",
      "WHY: a later, ignored intent",
    ].join("\n");
    expect(extractWhyFromReply(reply)).toEqual({
      intent: "first intent",
      decisions: ["kept choice"],
    });
  });

  it("tolerates blank lines between bullets", () => {
    const reply = "WHY: ship the fix\nDECISIONS:\n\n- chose the small diff\n\n- skipped the refactor\n";
    expect(extractWhyFromReply(reply).decisions).toEqual(["chose the small diff", "skipped the refactor"]);
  });

  it("clips decisions to the bullet and character caps", () => {
    const bullets = Array.from({ length: MAX_WHY_DECISIONS + 5 }, (_, i) => `- choice number ${i}`);
    const long = `- ${"x".repeat(MAX_DECISION_CHARS + 50)}`;
    const reply = [WHY_MARKER, " intent", DECISIONS_HEADER, ...bullets, long].join("\n");
    const extracted = extractWhyFromReply(reply);
    expect(extracted.decisions).toHaveLength(MAX_WHY_DECISIONS);
    expect(extracted.decisions[0]).toBe("choice number 0");
    expect(extracted.decisions[MAX_WHY_DECISIONS - 1]).toBe("choice number 9");
    expect(extracted.decisions).not.toContain(expect.stringContaining("x".repeat(201)));
  });

  it("keeps the intent to its single line — later lines are prose", () => {
    expect(extractWhyFromReply("WHY:\t  spaced   out ")).toEqual({
      intent: "spaced out",
      decisions: [],
    });
    expect(extractWhyFromReply("WHY: first line\ncontinuation prose")).toEqual({
      intent: "first line",
      decisions: [],
    });
  });

  it("missing sections yield a null intent and no decisions", () => {
    expect(extractWhyFromReply("a plain reply with no journal")).toEqual({
      intent: null,
      decisions: [],
    });
    expect(extractWhyFromReply("")).toEqual({ intent: null, decisions: [] });
    expect(extractWhyFromReply("WHY:")).toEqual({ intent: null, decisions: [] });
    expect(extractWhyFromReply(`${DECISIONS_HEADER}\nno bullets here`)).toEqual({
      intent: null,
      decisions: [],
    });
  });

  it("ignores malformed bullets outside the header", () => {
    const reply = "- standalone bullet\nWHY: intent\n- another stray bullet";
    expect(extractWhyFromReply(reply)).toEqual({ intent: "intent", decisions: [] });
  });
});

describe("appendWhy and listWhy", () => {
  it("round-trips entries through the file, newest first", () => {
    const dir = makeDataDir();
    const first = makeEntry({ botId: "bot-a" });
    const second = makeEntry({ botId: "bot-b" });
    const third = makeEntry({ botId: "bot-a" });
    appendWhy(dir, first);
    appendWhy(dir, second);
    appendWhy(dir, third);
    expect(listWhy(dir).map((e) => e.runId)).toEqual([third.runId, second.runId, first.runId]);
    // survive a simulated restart
    resetWhyJournalForTest(dir);
    expect(listWhy(dir).map((e) => e.runId)).toEqual([third.runId, second.runId, first.runId]);
  });

  it("filters by botId, since, and limit", () => {
    const dir = makeDataDir();
    const early = makeEntry({ botId: "bot-a", at: 1000 });
    const middle = makeEntry({ botId: "bot-b", at: 2000 });
    const late = makeEntry({ botId: "bot-a", at: 3000 });
    appendWhy(dir, early);
    appendWhy(dir, middle);
    appendWhy(dir, late);
    expect(listWhy(dir, { botId: "bot-a" }).map((e) => e.runId)).toEqual([late.runId, early.runId]);
    expect(listWhy(dir, { since: 1500 }).map((e) => e.runId)).toEqual([late.runId, middle.runId]);
    expect(listWhy(dir, { botId: "bot-a", since: 1500 }).map((e) => e.runId)).toEqual([late.runId]);
    expect(listWhy(dir, { limit: 2 }).map((e) => e.runId)).toEqual([late.runId, middle.runId]);
    expect(listWhy(dir)).toHaveLength(3);
  });

  it("returns copies, so mutating a result never reaches the store", () => {
    const dir = makeDataDir();
    appendWhy(dir, makeEntry());
    const listed = listWhy(dir)[0];
    listed.decisions.push("smuggled");
    listed.intent = "mutated";
    expect(listWhy(dir)[0].decisions).not.toContain("smuggled");
    expect(listWhy(dir)[0].intent).not.toBe("mutated");
  });

  it("persists with 0600 permissions", { skip: process.platform === "win32" }, () => {
    const dir = makeDataDir();
    appendWhy(dir, makeEntry());
    expect(statSync(journalFile(dir)).mode & 0o777).toBe(0o600);
  });
});

describe("eviction", () => {
  it("evicts the oldest entry once the cap is exceeded", () => {
    const dir = makeDataDir();
    const base = 1_000_000;
    const seed = {
      version: 1,
      entries: Array.from({ length: MAX_WHY_ENTRIES }, (_, i) => ({
        runId: `run-${i}`,
        botId: "bot-1",
        threadId: `thread-${i}`,
        at: base + i,
        intent: `intent ${i}`,
        decisions: [],
        outcome: "done",
      })),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(journalFile(dir), JSON.stringify(seed));

    const fresh = makeEntry({ at: base + MAX_WHY_ENTRIES + 10_000 });
    appendWhy(dir, fresh);

    const listed = listWhy(dir);
    expect(listed).toHaveLength(MAX_WHY_ENTRIES);
    expect(listed.some((e) => e.runId === "run-0")).toBe(false); // oldest `at` evicted
    expect(listed.some((e) => e.runId === "run-1")).toBe(true);
    expect(listed.some((e) => e.runId === fresh.runId)).toBe(true);
    // SAFETY: the only writer is appendWhy, which always emits the
    // versioned { version: 1, entries } shape being asserted here.
    const onDisk = JSON.parse(readFileSync(journalFile(dir), "utf8")) as {
      entries: { runId: string }[];
    };
    expect(onDisk.entries).toHaveLength(MAX_WHY_ENTRIES);
  });
});

describe("corrupt journal files", () => {
  it("starts empty on unparseable JSON and recovers on the next append", () => {
    const dir = makeDataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(journalFile(dir), "{ definitely not json");
    expect(listWhy(dir)).toEqual([]);
    const entry = makeEntry();
    appendWhy(dir, entry);
    expect(listWhy(dir).map((e) => e.runId)).toEqual([entry.runId]);
  });

  it("rejects files with the wrong shape", () => {
    const dir = makeDataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(journalFile(dir), JSON.stringify({ version: 2, entries: [] }));
    expect(listWhy(dir)).toEqual([]);
    writeFileSync(
      journalFile(dir),
      JSON.stringify({ version: 1, entries: [{ runId: "r", botId: "b", threadId: "t", at: 1, intent: "", decisions: [], outcome: "exploded" }] }),
    );
    expect(listWhy(dir)).toEqual([]);
  });
});

describe("whyPromptSuffix", () => {
  it("teaches the exact block the extractor reads", () => {
    const suffix = whyPromptSuffix();
    expect(suffix).toContain(WHY_MARKER);
    expect(suffix).toContain(DECISIONS_HEADER);
    expect(suffix).toContain(`"- "`);
    expect(suffix).toContain(String(MAX_WHY_DECISIONS));
    expect(suffix).toContain(String(MAX_DECISION_CHARS));
  });
});
