// Tests for the scorecard trend projection + JSONL store. The projection is
// the contract: everything a trend needs, nothing a trend would leak.
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectScorecard, readTrend, renderTrend, mergeTrends, type TrendRecord } from "./bench-trend.ts";

const scorecard = (overrides = {}) => ({
  version: 1,
  label: "nightly",
  source: "simulated",
  status: "passed",
  roles: {
    assistant: { status: "passed", scenarios: [{ status: "passed", elapsedMs: 1200, tokens: 300, costUsd: 0.01 }] },
    coordinator: { status: "passed", scenarios: [{ status: "passed", elapsedMs: 2400, tokens: 900, costUsd: 0.03 }] },
    specialist: { status: "passed", scenarios: [{ status: "passed", elapsedMs: 800, tokens: 150, costUsd: 0.005 }] },
  },
  ...overrides,
});

describe("projectScorecard", () => {
  it("projects roles, status and numeric evidence", () => {
    const record = projectScorecard(scorecard(), "2026-09-22T00:00:00.000Z");
    expect(record.status).toBe("passed");
    expect(record.label).toBe("nightly");
    expect(record.source).toBe("simulated");
    expect(record.scenarios).toBe(3);
    expect(record.roles.assistant).toEqual({
      status: "passed", scenarios: 1, passed: 1, failed: 0, elapsedMs: 1200, tokens: 300, costUsd: 0.01,
    });
  });

  it("sums multiple scenarios per role and counts failures", () => {
    const card = scorecard({
      status: "failed",
      roles: {
        assistant: { status: "failed", scenarios: [
          { status: "passed", elapsedMs: 100, tokens: 10, costUsd: null },
          { status: "failed", elapsedMs: null, tokens: null, costUsd: null },
        ] },
        coordinator: { status: "passed", scenarios: [] },
        specialist: { status: "incomplete", scenarios: [] },
      },
    });
    const record = projectScorecard(card, "2026-09-22T00:00:00.000Z");
    expect(record.roles.assistant.passed).toBe(1);
    expect(record.roles.assistant.failed).toBe(1);
    expect(record.roles.assistant.elapsedMs).toBe(100);
    expect(record.status).toBe("failed");
  });

  it("rejects malformed scorecards loudly", () => {
    expect(() => projectScorecard(null)).toThrow();
    expect(() => projectScorecard({ version: 2 })).toThrow("unsupported scorecard version");
    expect(() => projectScorecard(scorecard({ label: "" }))).toThrow("label missing");
    expect(() => projectScorecard(scorecard({ source: "dreamed" }))).toThrow("live or simulated");
    const noSpecialist = scorecard();
    delete noSpecialist.roles.specialist;
    expect(() => projectScorecard(noSpecialist)).toThrow("missing the specialist role");
    expect(() => projectScorecard(scorecard({ roles: { assistant: { status: "passed", scenarios: [] }, coordinator: { status: "passed", scenarios: [] }, specialist: { status: "passed", scenarios: [] } } }))).toThrow("no scenarios");
  });
});

describe("trend store", () => {
  it("appends records as JSONL and reads them back oldest-first", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-trend-"));
    const file = join(dir, "trend.jsonl");
    const first = projectScorecard(scorecard({ label: "run-a" }), "2026-09-22T01:00:00.000Z");
    const second = projectScorecard(scorecard({ label: "run-b", status: "failed" }), "2026-09-22T02:00:00.000Z");
    appendLine(file, first);
    appendLine(file, second);
    const records = readTrend(file);
    expect(records).toHaveLength(2);
    expect(records[0].label).toBe("run-a");
    expect(records[1].label).toBe("run-b");
    expect(readTrend(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("rejects a corrupted trend file with the offending line number", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-trend-"));
    const file = join(dir, "trend.jsonl");
    writeFileSync(file, "{\"ok\":1}\nnot json\n");
    expect(() => readTrend(file)).toThrow("trend.jsonl:2 is not valid JSONL");
  });
});

describe("renderTrend", () => {
  it("renders a readable report with per-role lines", () => {
    const failedRole = (status, scenarios) => ({ status, scenarios });
    const records = [
      projectScorecard(scorecard({ label: "run-a" }), "2026-09-22T01:00:00.000Z"),
      projectScorecard(scorecard({
        label: "run-b",
        status: "failed",
        roles: {
          assistant: failedRole("passed", [{ status: "passed", elapsedMs: 1200, tokens: 300, costUsd: 0.01 }]),
          coordinator: failedRole("failed", [{ status: "failed", elapsedMs: null, tokens: null, costUsd: null }]),
          specialist: failedRole("passed", [{ status: "passed", elapsedMs: 800, tokens: 150, costUsd: 0.005 }]),
        },
      }), "2026-09-22T02:00:00.000Z"),
    ];
    const text = renderTrend(records);
    expect(text).toContain("run-a");
    expect(text).toContain("run-b");
    expect(text).toContain("assistant pass (1/1)");
    expect(text).toContain("coordinator FAIL");
    expect(text).toContain("records: 2");
  });

  it("handles an empty trend", () => {
    expect(renderTrend([])).toContain("no trend records");
  });
});

function appendLine(file, record) {
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

// B1: the workflow kept only today's record, so nothing accumulated. Merging
// retained history needs an identity first — without one, a rerun's record and
// the re-downloaded copy of it are indistinguishable and history double-counts.
describe("mergeTrends", () => {
  const record = (over: Partial<TrendRecord> = {}): TrendRecord => ({
    recordedAt: "2026-09-29T03:17:00.000Z",
    source: "simulated",
    label: "nightly",
    status: "passed",
    scenarios: 3,
    roles: {},
    ...over,
  } as TrendRecord);

  it("concatenates distinct runs", () => {
    const merged = mergeTrends([
      [record({ runId: "1001", recordedAt: "2026-09-28T03:17:00.000Z" })],
      [record({ runId: "1002", recordedAt: "2026-09-29T03:17:00.000Z" })],
    ]);
    expect(merged.map((r) => r.runId)).toEqual(["1001", "1002"]);
  });

  it("a rerun REPLACES its own earlier record rather than duplicating it", () => {
    const merged = mergeTrends([
      [record({ runId: "1001", status: "failed" })],
      [record({ runId: "1001", status: "passed" })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status, "the later capture of the same run must win").toBe("passed");
  });

  it("deduplicates the same record found in two history files", () => {
    // The exact shape of the bug: today's file and yesterday's artifact both
    // hold the record, because the artifact was re-downloaded.
    const shared = record({ runId: "1001" });
    const merged = mergeTrends([[shared], [shared], [record({ runId: "1002" })]]);
    expect(merged).toHaveLength(2);
  });

  it("orders the result oldest-first regardless of input order", () => {
    const merged = mergeTrends([
      [record({ runId: "b", recordedAt: "2026-09-30T00:00:00.000Z" })],
      [record({ runId: "a", recordedAt: "2026-09-28T00:00:00.000Z" })],
    ]);
    expect(merged.map((r) => r.recordedAt)).toEqual([
      "2026-09-28T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
    ]);
  });

  it("falls back to label+time when a local capture has no run id", () => {
    const local = record({ recordedAt: "2026-09-29T10:00:00.000Z" });
    const merged = mergeTrends([[local], [{ ...local }]]);
    expect(merged).toHaveLength(1);
    // Two genuinely different local captures are both kept.
    const other = record({ recordedAt: "2026-09-29T11:00:00.000Z" });
    expect(mergeTrends([[local], [other]])).toHaveLength(2);
  });

  it("treats a blank runId as absent rather than as an identity", () => {
    // Two records identical in every respect except the runId field, where one
    // is whitespace and one is empty. If a blank id were accepted as an
    // identity they'd be two DIFFERENT runs ("run:  " and "run:"), so a failed
    // interpolation would inflate history; treated as absent they fall back to
    // the same label+time key and collapse to one record, which is the honest
    // reading of "we do not know which run this was".
    //
    // The first version of this case gave the two records different timestamps,
    // which made them distinct under BOTH readings — it asserted nothing about
    // blank handling and survived the mutation that broke it.
    const blank = [record({ runId: "  " }), record({ runId: "" })];
    expect(mergeTrends([blank])).toHaveLength(1);
  });
});
