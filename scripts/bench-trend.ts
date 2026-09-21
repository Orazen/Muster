// bench-trend — the memory of role-eval scorecards. `muster bench` and the
// role-eval harness grade a capture into a scorecard and exit; nothing
// remembers them. This script appends each scorecard as one JSONL record
// (JSONL so concurrent writers and `git diff` both stay sane) and renders
// the accumulated trend. Dependency-free: it may run in CI before project
// packages are installed.
//
//   node scripts/bench-trend.ts record <scorecard.json> [--file trend.jsonl]
//   node scripts/bench-trend.ts report  [--file trend.jsonl] [--json]
//
// The record is a projection, not a copy: per-role status plus the numeric
// evidence a trend can act on (elapsed, tokens, cost). Labels and sources
// are preserved verbatim so a trend can distinguish live from simulated.
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TREND = "docs/benchmarks/role-eval-trend.jsonl";
const ROLE_NAMES = ["assistant", "coordinator", "specialist"];

/** Extract the trend projection from a scorecard. Pure. */
export function projectScorecard(scorecard, recordedAt = new Date().toISOString()) {
  if (!scorecard || Array.isArray(scorecard)) throw new Error("scorecard must be an object");
  if (scorecard.version !== 1) throw new Error("unsupported scorecard version");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON.parse boundary: no domain type exists yet
  if (typeof scorecard.label !== "string" || !scorecard.label) throw new Error("scorecard label missing");
  if (!["live", "simulated"].includes(scorecard.source)) throw new Error("scorecard source must be live or simulated");
  const roles = {};
  let scenarios = 0;
  for (const roleName of ROLE_NAMES) {
    const role = scorecard.roles?.[roleName];
    if (!role) throw new Error(`scorecard is missing the ${roleName} role`);
    const list = Array.isArray(role.scenarios) ? role.scenarios : [];
    scenarios += list.length;
    const sum = (pick) => list.reduce((acc, s) => (Number.isFinite(s?.[pick]) ? acc + s[pick] : acc), 0);
    roles[roleName] = {
      status: role.status,
      scenarios: list.length,
      passed: list.filter((s) => s.status === "passed").length,
      failed: list.filter((s) => s.status === "failed").length,
      elapsedMs: sum("elapsedMs"),
      tokens: sum("tokens"),
      costUsd: sum("costUsd"),
    };
  }
  if (scenarios === 0) throw new Error("scorecard carries no scenarios");
  return {
    recordedAt,
    label: scorecard.label,
    source: scorecard.source,
    status: scorecard.status,
    scenarios,
    roles,
  };
}

/** Parse a trend file into records. Tolerates a trailing blank line. */
export function readTrend(trendPath) {
  if (!existsSync(trendPath)) return [];
  const raw = readFileSync(trendPath, "utf8");
  const records = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`${trendPath}:${index + 1} is not valid JSONL`);
    }
  }
  return records;
}

/** One human-readable trend line per record, oldest first. */
export function renderTrend(records) {
  if (records.length === 0) return "no trend records yet";
  const lines = ["role-eval trend (oldest first)", ""];
  for (const r of records) {
    const roles = ROLE_NAMES.map((name) => {
      const role = r.roles?.[name] ?? {};
      const mark = role.status === "passed" ? "pass" : role.status === "failed" ? "FAIL" : "part";
      return `${name} ${mark} (${role.passed ?? 0}/${role.scenarios ?? 0})`;
    }).join(" · ");
    lines.push(`${r.recordedAt}  ${r.source.padEnd(9)} ${String(r.label).padEnd(24)} ${r.status.padEnd(11)} ${roles}`);
  }
  const last = records.at(-1);
  const first = records[0];
  if (records.length > 1 && last && first) {
    const drift = (pick) => last.roles && first.roles
      ? last.roles[pick] && first.roles[pick] ? last.roles[pick].elapsedMs - first.roles[pick].elapsedMs : null
      : null;
    lines.push("");
    lines.push(`records: ${records.length}; latest status ${last.status}.`);
    for (const roleName of ROLE_NAMES) {
      const delta = drift(roleName);
      if (Number.isFinite(delta) && last.roles[roleName].elapsedMs != null) {
        lines.push(`${roleName} elapsed change since first record: ${delta >= 0 ? "+" : ""}${delta}ms`);
      }
    }
  }
  return lines.join("\n");
}

function trendPath() {
  const flag = process.argv.indexOf("--file");
  return flag > -1 && process.argv[flag + 1] ? resolve(process.argv[flag + 1]) : resolve(DEFAULT_TREND);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  try {
    if (mode === "record") {
      const input = process.argv[3];
      if (!input) throw new Error("Usage: bench-trend.ts record <scorecard.json> [--file trend.jsonl]");
      if (statSync(input).size > 2_000_000) throw new Error("Scorecard exceeds 2 MB.");
      const record = projectScorecard(JSON.parse(readFileSync(input, "utf8")));
      appendFileSync(trendPath(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
      console.log(JSON.stringify({ recorded: record.recordedAt, status: record.status }));
    } else if (mode === "report") {
      const jsonFlag = process.argv.includes("--json");
      const records = readTrend(trendPath());
      if (jsonFlag) {
        console.log(JSON.stringify(records, null, 2));
      } else {
        console.log(renderTrend(records));
      }
    } else {
      throw new Error("Usage: bench-trend.ts record <scorecard.json> | report [--file trend.jsonl] [--json]");
    }
  } catch (error) {
    console.error(`[bench-trend] ${error.message}`);
    process.exitCode = 1;
  }
}
