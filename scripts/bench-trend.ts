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
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TREND = "docs/benchmarks/role-eval-trend.jsonl";
const ROLE_NAMES = ["assistant", "coordinator", "specialist"] as const;
type RoleName = (typeof ROLE_NAMES)[number];

/** Structural input: a parsed scorecard JSON before validation. */
interface ScorecardScenario {
  status?: unknown;
  elapsedMs?: number | null;
  tokens?: number | null;
  costUsd?: number | null;
}
interface ScorecardInput {
  version?: unknown;
  label?: unknown;
  source?: unknown;
  status?: unknown;
  roles?: Record<string, { status?: unknown; scenarios?: ScorecardScenario[] | undefined } | undefined>;
}

export interface RoleTrend {
  status: string;
  scenarios: number;
  passed: number;
  failed: number;
  elapsedMs: number;
  tokens: number;
  costUsd: number;
}
export interface TrendRecord {
  recordedAt: string;
  /** Identity of the capture that produced this record. Two records with the
   *  same runId are the same run seen twice, not two runs. Supplied by the
   *  workflow from GITHUB_RUN_ID; absent for local captures, which fall back
   *  to a timestamp+label key. */
  runId?: string;
  label: string;
  source: string;
  status: string;
  scenarios: number;
  roles: Record<RoleName, RoleTrend>;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON boundary: this guard ESTABLISHES the string domain type from parsed JSON
const isText = (value: unknown): value is string =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- boundary parser: typeof is how parsed JSON becomes a string here
  typeof value === "string";

const emptyRole = (): RoleTrend => ({ status: "unknown", scenarios: 0, passed: 0, failed: 0, elapsedMs: 0, tokens: 0, costUsd: 0 });

/** Extract the trend projection from a scorecard. Pure. */
export function projectScorecard(scorecard: ScorecardInput, recordedAt: string = new Date().toISOString()): TrendRecord {
  if (!scorecard || Array.isArray(scorecard)) throw new Error("scorecard must be an object");
  if (scorecard.version !== 1) throw new Error("unsupported scorecard version");
  if (!isText(scorecard.label) || !scorecard.label) throw new Error("scorecard label missing");
  if (!isText(scorecard.source) || !["live", "simulated"].includes(scorecard.source)) {
    throw new Error("scorecard source must be live or simulated");
  }
  const roles = { assistant: emptyRole(), coordinator: emptyRole(), specialist: emptyRole() };
  let scenarios = 0;
  for (const roleName of ROLE_NAMES) {
    const role = scorecard.roles?.[roleName];
    if (!role) throw new Error(`scorecard is missing the ${roleName} role`);
    const list = Array.isArray(role.scenarios) ? role.scenarios : [];
    scenarios += list.length;
    const sum = (pick: keyof ScorecardScenario): number =>
      // SAFETY: Number.isFinite guard proves the picked value is numeric.
      list.reduce((acc: number, s) => (Number.isFinite(s?.[pick]) ? acc + (s[pick] as number) : acc), 0);
    roles[roleName] = {
      status: isText(role.status) ? role.status : "unknown",
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
    status: isText(scorecard.status) ? scorecard.status : "unknown",
    scenarios,
    roles,
  };
}

/** Parse a trend file into records. Tolerates a trailing blank line. */
export function readTrend(trendPath: string): TrendRecord[] {
  if (!existsSync(trendPath)) return [];
  const raw = readFileSync(trendPath, "utf8");
  const records: TrendRecord[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      // SAFETY: a trend file only ever holds records this script wrote.
      records.push(JSON.parse(line) as TrendRecord);
    } catch {
      throw new Error(`${trendPath}:${index + 1} is not valid JSONL`);
    }
  }
  return records;
}

/** Stable identity for deduplication.
 *
 *  A workflow rerun of the same run re-captures the same record, and a
 *  re-downloaded history contains that record once already. Without a key there
 *  is no way to tell "the same run, twice" from "two runs", so history silently
 *  double-counts. A runId is authoritative when present; local captures have
 *  none, so they fall back to a label+timestamp key that is stable for a given
 *  file. */
export function trendRecordKey(record: TrendRecord): string {
  return record.runId && record.runId.trim() ? `run:${record.runId.trim()}` : `at:${record.recordedAt}|${record.label}`;
}

/** Merge trend files in order; a later group replaces an earlier record with
 *  the same identity, and the result is oldest-first by recordedAt.
 *
 *  Order matters and is the point: a rerun must be able to correct its own
 *  earlier record, so "first wins" would be wrong. Corrupt input is not
 *  swallowed here — readTrend throws with a line number, and a history that
 *  cannot be parsed must not be silently replaced by a shorter one. */
export function mergeTrends(groups: readonly (readonly TrendRecord[])[]): TrendRecord[] {
  const byKey = new Map<string, TrendRecord>();
  for (const group of groups) {
    for (const record of group) byKey.set(trendRecordKey(record), record);
  }
  return [...byKey.values()].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
}

/** One human-readable trend line per record, oldest first. */
export function renderTrend(records: TrendRecord[]): string {
  if (records.length === 0) return "no trend records yet";
  const lines: string[] = ["role-eval trend (oldest first)", ""];
  for (const r of records) {
    const roles = ROLE_NAMES.map((name) => {
      const role = r.roles?.[name];
      const mark = role?.status === "passed" ? "pass" : role?.status === "failed" ? "FAIL" : "part";
      return `${name} ${mark} (${role?.passed ?? 0}/${role?.scenarios ?? 0})`;
    }).join(" · ");
    lines.push(`${r.recordedAt}  ${r.source.padEnd(9)} ${String(r.label).padEnd(24)} ${r.status.padEnd(11)} ${roles}`);
  }
  const last = records.at(-1);
  const first = records[0];
  if (records.length > 1 && last && first) {
    lines.push("");
    lines.push(`records: ${records.length}; latest status ${last.status}.`);
    for (const roleName of ROLE_NAMES) {
      const latest = last.roles?.[roleName]?.elapsedMs;
      const earliest = first.roles?.[roleName]?.elapsedMs;
      if (typeof latest === "number" && typeof earliest === "number") { // oxlint-disable-line anti-slop/no-runtime-typeof -- narrowing number|undefined from the typed record
        const delta = latest - earliest;
        lines.push(`${roleName} elapsed change since first record: ${delta >= 0 ? "+" : ""}${delta}ms`);
      }
    }
  }
  return lines.join("\n");
}

function trendPath(): string {
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
      // SAFETY: projectScorecard re-validates every field before use.
      const record = projectScorecard(JSON.parse(readFileSync(input, "utf8")) as ScorecardInput);
      appendFileSync(trendPath(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
      console.log(JSON.stringify({ recorded: record.recordedAt, status: record.status }));
    } else if (mode === "merge") {
      // Accumulate history across runs. The workflow downloads the retained
      // artifacts into a directory and points this at every *.jsonl in it, so a
      // later run renders the whole series instead of only today's record.
      const out = trendPath();
      // Skip every flag AND its value. Filtering on a leading "--" alone let
      // the --file destination be read back as if it were an input, so the
      // first merge reported one more input than it was given and a second run
      // would have read its own output.
      const argv = process.argv.slice(3);
      const inputs: string[] = [];
      for (let index = 0; index < argv.length; index += 1) {
        if (argv[index]!.startsWith("--")) { index += 1; continue; }
        inputs.push(argv[index]!);
      }
      if (inputs.length === 0) throw new Error("Usage: bench-trend.ts merge <file.jsonl...> [--file out.jsonl]");
      const groups = inputs.map((file) => readTrend(resolve(file)));
      const merged = mergeTrends(groups);
      writeFileSync(out, merged.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
      console.log(JSON.stringify({ out, inputs: inputs.length, records: merged.length }));
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
    console.error(`[bench-trend] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
