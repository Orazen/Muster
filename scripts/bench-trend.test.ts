// Tests for the scorecard trend projection + JSONL store. The projection is
// the contract: everything a trend needs, nothing a trend would leak.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { projectScorecard, readTrend, renderTrend, mergeTrends, recordScorecard, collectTrendHistory, type TrendRecord } from "./bench-trend.ts";

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

describe("scheduled history boundaries", () => {
  const repository = "Orazen/Muster";
  const run = (id: number, overrides = {}) => ({ id, status: "completed", event: "schedule", head_branch: "main", head_repository: { full_name: repository }, ...overrides });
  const options = () => ({ repository, branch: "main", currentRunId: "103", directory: mkdtempSync(join(tmpdir(), "bench-history-")) });
  const artifact = (id: number, expired = false) => ({ name: `role-eval-trend-${id}`, expired });

  it("loads distinct earlier main runs by explicit run/repository/artifact identity", () => {
    const calls: string[][] = [];
    const opts = options();
    const result = collectTrendHistory(opts, (args) => {
      calls.push(args);
      if (args[0] === "api" && args[3]!.includes("workflows/bench.yml/runs")) return JSON.stringify([{ workflow_runs: [
        run(102), run(101), run(103), run(104, { event: "pull_request" }), run(105, { head_branch: "feature" }),
        run(106, { head_repository: { full_name: "someone/Fork" } }), run(107, { status: "in_progress" }),
      ] }]);
      if (args[0] === "api") {
        const id = Number(args[3]!.match(/runs\/(\d+)\//)![1]);
        return JSON.stringify([{ artifacts: [artifact(id), { name: "unrelated", expired: false }] }]);
      }
      const id = args[2]!;
      expect(args).toEqual(["run", "download", id, "--repo", repository, "--name", `role-eval-trend-${id}`, "--dir", join(opts.directory, id)]);
      mkdirSync(args[8]!, { recursive: true });
      recordScorecard(scorecard({ label: `run-${id}` }), join(args[8]!, "role-eval-trend.jsonl"), id);
      return "";
    });
    expect(result.files.map((file) => readTrend(file)[0]!.runId)).toEqual(["101", "102"]);
    expect(calls.filter((args) => args[0] === "run")).toHaveLength(2);
    expect(calls.filter((args) => args[0] === "api")).toHaveLength(3);
    expect(result.expired).toBe(0);
  });

  it("allows a genuine first capture with no retained artifacts", () => {
    const result = collectTrendHistory(options(), () => JSON.stringify([{ workflow_runs: [] }]));
    expect(result).toEqual({ files: [], expired: 0 });
  });

  it("does not convert API authorization failure into a new empty baseline", () => {
    expect(() => collectTrendHistory(options(), () => { throw new Error("403 forbidden"); })).toThrow("403 forbidden");
  });

  it("requires review if every existing history artifact has expired", () => {
    expect(() => collectTrendHistory(options(), (args) => JSON.stringify(args[3]!.includes("workflows/")
      ? [{ workflow_runs: [run(101)] }] : [{ artifacts: [artifact(101, true)] }]))).toThrow("explicit baseline restart");
  });

  it.each(["missing", "empty", "corrupt", "download-failed"])("does not silently replace %s retained history", (mode) => {
    const opts = options();
    expect(() => collectTrendHistory(opts, (args) => {
      if (args[0] === "api") return JSON.stringify(args[3]!.includes("workflows/")
        ? [{ workflow_runs: [run(101)] }] : [{ artifacts: [artifact(101)] }]);
      if (mode === "download-failed") throw new Error("download failed");
      mkdirSync(args[8]!, { recursive: true });
      if (mode !== "missing") writeFileSync(join(args[8]!, "role-eval-trend.jsonl"), mode === "corrupt" ? "broken JSON\n" : "");
      return "";
    })).toThrow(mode === "corrupt" ? "not valid JSONL" : mode === "download-failed" ? "download failed" : "no usable trend record");
  });

  it("persists the actual writer's CI identity and replaces a rerun", () => {
    const file = join(mkdtempSync(join(tmpdir(), "bench-writer-")), "trend.jsonl");
    recordScorecard(scorecard({ label: "first-attempt", status: "failed" }), file, "101", "1");
    recordScorecard(scorecard({ label: "other-run" }), file, "102", "1");
    recordScorecard(scorecard({ label: "retry" }), file, "101", "2");
    const records = mergeTrends([readTrend(file)]);
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.runId === "101")?.label).toBe("retry");
    expect(records.find((r) => r.runId === "101")?.status).toBe("passed");
    expect(records.find((r) => r.runId === "101")?.runAttempt).toBe(2);
    expect(() => recordScorecard(scorecard(), file, " ")).toThrow("numeric run identity");
    expect(() => recordScorecard(scorecard(), file, "101", "0")).toThrow("positive integer");
  });

  it("runs record, merge and report commands across two captures and a rerun", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-cli-"));
    const input = join(dir, "scorecard.json");
    const first = join(dir, "first.jsonl"), second = join(dir, "second.jsonl"), retry = join(dir, "retry.jsonl"), output = join(dir, "history.jsonl");
    writeFileSync(input, JSON.stringify(scorecard()));
    const cli = (args: string[], runId = "101", attempt = "1") => execFileSync(process.execPath, ["--experimental-strip-types", "scripts/bench-trend.ts", ...args], {
      encoding: "utf8", env: { ...process.env, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt },
    });
    cli(["record", input, "--file", first]);
    cli(["record", input, "--file", second], "102");
    expect(JSON.parse(cli(["merge", first, second, "--file", output])).records).toBe(2);
    cli(["record", input, "--file", retry], "101", "2");
    expect(JSON.parse(cli(["merge", output, retry, "--file", output])).records).toBe(2);
    expect(cli(["report", "--file", output])).toContain("records: 2");
    expect(readTrend(output).map((r) => r.runId).sort()).toEqual(["101", "102"]);
    expect(readTrend(output).find((r) => r.runId === "101")?.runAttempt).toBe(2);
  });

  it("emits boolean capture output and bases persistence on actual upload receipt", () => {
    const workflow = parse(readFileSync(".github/workflows/bench.yml", "utf8"));
    const steps = workflow.jobs["role-eval"].steps;
    const capture = steps.find((step) => step.id === "capture");
    const dir = mkdtempSync(join(tmpdir(), "bench-step-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "input.json"), JSON.stringify(scorecard()));
    // Substitute only the expensive capture command; run the workflow's actual
    // shell body, output guard and GITHUB_OUTPUT write against the real writer.
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\nexec "$BENCH_TEST_NODE" --experimental-strip-types "$BENCH_TEST_SCRIPT" record "$BENCH_TEST_INPUT" --file role-eval-trend.jsonl\n', { mode: 0o700 });
    execFileSync("/bin/bash", ["-c", capture.run], { cwd: dir, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_RUN_ID: "103", GITHUB_OUTPUT: join(dir, "outputs"),
      BENCH_TEST_NODE: process.execPath, BENCH_TEST_SCRIPT: resolve("scripts/bench-trend.ts"), BENCH_TEST_INPUT: join(dir, "input.json"),
    } });
    expect(readFileSync(join(dir, "outputs"), "utf8")).toBe("captured=true\n");
    expect(readTrend(join(dir, "role-eval-trend.jsonl"))[0]!.runId).toBe("103");
    for (const id of ["merge", "report", "upload"]) expect(steps.find((step) => step.id === id).if).toBeUndefined();
    const summary = steps.at(-1);
    expect(summary.env.PERSISTED).toBe("${{ steps.upload.outcome == 'success' && steps.upload.outputs.artifact-id != '' }}");
    expect(steps.find((step) => step.id === "upload").with.overwrite).toBe(true);
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
  });
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
  // SAFETY: every field TrendRecord requires is listed explicitly above, and
  // `over` is spread last so a caller may override any of them rather than
  // introduce a field the record does not declare.
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

  it("retains a corrected 101 after 102's stale accumulated copy and the next 103 capture", () => {
    const first = record({ runId: "101", label: "old-A", recordedAt: "2026-09-29T00:00:00.000Z", runAttempt: 1 });
    const second = record({ runId: "102", label: "B", recordedAt: "2026-09-29T01:00:00.000Z", runAttempt: 1 });
    const corrected = record({ runId: "101", label: "corrected-A", recordedAt: "2026-09-29T02:00:00.000Z", runAttempt: 2 });
    const third = record({ runId: "103", label: "C", recordedAt: "2026-09-29T03:00:00.000Z", runAttempt: 1 });
    const artifact102 = mergeTrends([[first], [second]]);
    const rerun101Artifact = mergeTrends([artifact102, [corrected]]);
    const next = mergeTrends([rerun101Artifact, artifact102, [third]]);
    expect(next.map((r) => r.label)).toEqual(["B", "corrected-A", "C"]);
    expect(mergeTrends([[third], artifact102, rerun101Artifact])).toEqual(next);
  });

  it("keeps the newer capture for legacy run identities without attempt metadata", () => {
    const old = record({ runId: "101", label: "old", recordedAt: "2026-09-29T00:00:00.000Z" });
    const updated = record({ runId: "101", label: "corrected", recordedAt: "2026-09-29T02:00:00.000Z" });
    expect(mergeTrends([[updated], [old]])).toEqual([updated]);
  });

  it("uses attempt provenance when capture timestamps are equal", () => {
    const old = record({ runId: "101", label: "old", runAttempt: 1 });
    const updated = record({ runId: "101", label: "corrected", runAttempt: 2 });
    expect(mergeTrends([[updated], [old]])).toEqual([updated]);
    expect(mergeTrends([[old], [updated]])).toEqual([updated]);
  });

  it("refuses invalid recency metadata instead of choosing an arbitrary winner", () => {
    expect(() => mergeTrends([[record({ recordedAt: "not a date" })]])).toThrow("capture timestamp");
    expect(() => mergeTrends([[record({ runAttempt: -1 })]])).toThrow("run attempt");
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
