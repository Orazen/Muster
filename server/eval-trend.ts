// Trend across stored scorecards, in the order the caller lists them.
// Both graders' scorecards are understood — fleet (muster eval) and per-role
// (muster bench) — and one invocation trends exactly one kind: their
// statuses measure different things, so a mixed trend would compare unlike
// with unlike. Read-only: nothing here grades captures, runs probes,
// contacts the fleet, or writes a file. What a trend can and cannot claim
// is stated in the output's limitation, and repeated in the playbooks.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
// Shared vocabulary, not the grader entry: importing role-eval.ts here would
// inline role-eval's own CLI guard into this bundle (the defect this split
// exists to prevent).
import { roleNames, scenarioKinds, type RoleName } from "./role-eval-kinds.ts";

const check = z.object({ name: z.string(), passed: z.boolean() });
const status = z.enum(["passed", "failed", "incomplete"]);
const identity = {
  version: z.literal(1),
  label: z.string().min(1),
  source: z.enum(["live", "simulated"]),
  status,
  limitation: z.string(),
};
// Metrics a grader can actually emit: never negative, never NaN/Infinity
// (JSON cannot encode those, but a hand-edited scorecard can carry them and
// the trend would render nonsense like "-5.0s").
const metric = z.number().finite().nonnegative().nullable();
const probeScore = z.object({
  status: z.enum(["passed", "failed", "missing"]),
  checks: z.array(check),
  elapsedMs: metric,
  tokens: metric,
  costUsd: metric,
});
const fleetSchema = z.object({
  ...identity,
  probes: z.object({ completion: probeScore, escalation: probeScore, failure: probeScore }),
});
const roleScenarioScore = z.object({
  role: z.enum(roleNames), kind: z.enum(scenarioKinds), name: z.string(),
  status: z.enum(["passed", "failed"]),
  checks: z.array(check),
  elapsedMs: metric,
  tokens: metric,
  costUsd: metric,
});
const roleStatus = z.object({ status, scenarios: z.array(roleScenarioScore) });
const roleSchema = z.object({
  ...identity,
  roles: z.object({
    assistant: roleStatus,
    coordinator: roleStatus,
    specialist: roleStatus,
  }),
});

export type ScorecardKind = "fleet" | "role";
export type FleetScorecard = z.infer<typeof fleetSchema>;
export type RoleScorecard = z.infer<typeof roleSchema>;
export type ParsedScorecard =
  | { kind: "fleet"; scorecard: FleetScorecard }
  | { kind: "role"; scorecard: RoleScorecard };

export interface TrendProbe {
  status: FleetScorecard["probes"]["completion"]["status"];
  elapsedMs: number | null;
  tokens: number | null;
  costUsd: number | null;
  /** The named checks that failed, so a regression says which check broke. */
  failedChecks: string[];
}
export interface FleetTrendRun {
  kind: "fleet";
  file: string;
  label: string;
  source: FleetScorecard["source"];
  status: FleetScorecard["status"];
  probes: Record<"completion" | "escalation" | "failure", TrendProbe>;
}
/** Per-role status plus the failed scenarios' own names; per-scenario
 * metrics ride the JSON, not the at-a-glance line. */
export interface RoleTrendRole {
  status: RoleScorecard["roles"]["assistant"]["status"];
  failedScenarios: string[];
}
export interface RoleTrendRun {
  kind: "role";
  file: string;
  label: string;
  source: RoleScorecard["source"];
  status: RoleScorecard["status"];
  roles: Record<RoleName, RoleTrendRole>;
}
export type TrendRun = FleetTrendRun | RoleTrendRun;
export interface EvalTrend {
  version: 1;
  kind: ScorecardKind;
  runs: TrendRun[];
  statuses: Array<EvalTrend["runs"][number]["status"]>;
  /** Distinct labels across the runs. The playbooks require like-for-like
   * task specifications; differing labels are reported, not judged. */
  labels: string[];
  limitation: string;
}

export function parseScorecard(file: string, json: string): ParsedScorecard {
  let body: unknown;
  try {
    body = JSON.parse(json);
  } catch {
    throw new Error(`${file} is not a fleet or role scorecard: not JSON`);
  }
  const hasKey = (key: string) => body instanceof Object && !Array.isArray(body) && key in body;
  // A body carrying both shapes is ambiguous by construction: whichever
  // schema parsed first would silently discard the other half.
  if (hasKey("probes") && hasKey("roles")) {
    throw new Error(`${file} carries both fleet probes and role sections — it is not a scorecard either grader wrote.`);
  }
  const fleet = fleetSchema.safeParse(body);
  if (fleet.success) return { kind: "fleet", scorecard: fleet.data };
  const role = roleSchema.safeParse(body);
  if (role.success) return { kind: "role", scorecard: role.data };
  // Name the file and each schema's first disagreement — the reader has no
  // way to know which shape they intended, so both get a voice.
  const fleetDetail = fleet.error.issues[0]?.message ?? "schema mismatch";
  const roleDetail = role.error.issues[0]?.message ?? "schema mismatch";
  throw new Error(`${file} is not a fleet or role scorecard (fleet: ${fleetDetail}; role: ${roleDetail})`);
}

function probeTrend(p: FleetScorecard["probes"]["completion"]): TrendProbe {
  return {
    status: p.status, elapsedMs: p.elapsedMs, tokens: p.tokens, costUsd: p.costUsd,
    failedChecks: p.checks.filter((c) => !c.passed).map((c) => c.name),
  };
}

function failedScenarios(r: RoleScorecard["roles"]["assistant"]): string[] {
  return r.scenarios.filter((s) => s.status === "failed").map((s) => s.name);
}

export function trendFromScorecards(entries: Array<{ file: string; scorecard: ParsedScorecard }>): EvalTrend {
  const kinds = new Set(entries.map((e) => e.scorecard.kind));
  if (kinds.size > 1) {
    throw new Error("A trend must be one kind: fleet and role scorecards measure different things. Trend like against like.");
  }
  const kind: ScorecardKind = kinds.values().next().value ?? "fleet";
  const runs: TrendRun[] = entries.map(({ file, scorecard }) => {
    if (scorecard.kind === "fleet") {
      const s = scorecard.scorecard;
      return {
        kind: "fleet" as const, file, label: s.label, source: s.source, status: s.status,
        probes: {
          completion: probeTrend(s.probes.completion),
          escalation: probeTrend(s.probes.escalation),
          failure: probeTrend(s.probes.failure),
        },
      };
    }
    const s = scorecard.scorecard;
    return {
      kind: "role" as const, file, label: s.label, source: s.source, status: s.status,
      roles: {
        assistant: { status: s.roles.assistant.status, failedScenarios: failedScenarios(s.roles.assistant) },
        coordinator: { status: s.roles.coordinator.status, failedScenarios: failedScenarios(s.roles.coordinator) },
        specialist: { status: s.roles.specialist.status, failedScenarios: failedScenarios(s.roles.specialist) },
      },
    };
  });
  return {
    version: 1,
    kind,
    runs,
    statuses: runs.map((r) => r.status),
    labels: [...new Set(runs.map((r) => r.label))],
    limitation: "Order is exactly the caller's file order: a scorecard records no timestamp, so chronology is a naming convention, not data. Nulls pass through rather than being zero-filled. Receipt usage aggregates a task thread, so runs over reused threads are not per-task measurements. Distinct labels are listed so unlike task specifications are visible; this tool does not judge comparability, re-grade captures, or verify provenance — statuses are the scorecards' own claims.",
  };
}

function roleLetter(name: RoleName): string {
  return name === "assistant" ? "a" : name === "coordinator" ? "c" : "s";
}
function statusLetter(s: "passed" | "failed" | "incomplete"): string {
  return s === "passed" ? "P" : s === "failed" ? "F" : "I";
}

function fleetLine(run: FleetTrendRun): string {
  const completion = run.probes.completion;
  const usage = completion.tokens === null ? "—" : `${completion.tokens} tok`;
  const elapsed = completion.elapsedMs === null ? "—" : `${(completion.elapsedMs / 1000).toFixed(1)}s`;
  const failed = completion.failedChecks;
  const reasons = failed.length === 0 ? "" : failed.length <= 2
    ? `  ${failed.join("; ")}`
    : `  ${failed.slice(0, 2).join("; ")} (+${failed.length - 2} more)`;
  return `${fileName(run.file)}  ${run.status.padEnd(10)} ${usage.padStart(8)}  ${elapsed.padStart(6)}${reasons}`;
}

function roleLine(run: RoleTrendRun): string {
  const letters = roleNames
    .map((name) => `${roleLetter(name)}:${statusLetter(run.roles[name].status)}`)
    .join(" ");
  const failed = Object.entries(run.roles).flatMap(([name, role]) =>
    role.failedScenarios.map((scenario) => `${name}/${scenario}`));
  const reasons = failed.length === 0 ? "" : failed.length <= 2
    ? `  ${failed.map(short).join("; ")}`
    : `  ${failed.slice(0, 2).map(short).join("; ")} (+${failed.length - 2} more)`;
  return `${fileName(run.file)}  ${run.status.padEnd(10)} ${letters}${reasons}`;
}

function fileName(file: string): string {
  return file.split("/").pop() ?? file;
}

/** Scenario names are the capture's own task text and can be long; the
 * at-a-glance line keeps enough to recognize the scenario, the JSON keeps
 * the whole name. */
function short(scenario: string): string {
  return scenario.length <= 48 ? scenario : `${scenario.slice(0, 47)}…`;
}

/** The human view: one line per run, then the verdict. Full detail stays in
 * the JSON (`--json`); this is the at-a-glance sequence the trend is for. */
export function formatTrend(trend: EvalTrend): string {
  const lines = trend.runs.map((run) => (run.kind === "fleet" ? fleetLine(run) : roleLine(run)));
  const passed = trend.statuses.filter((s) => s === "passed").length;
  const verdict = `${passed} of ${trend.statuses.length} run${trend.statuses.length === 1 ? "" : "s"} passed.`;
  const labels = trend.labels.length > 1
    ? ` Labels differ across runs: ${trend.labels.join("; ")}.`
    : "";
  return [...lines, "", verdict + labels, trend.limitation].join("\n");
}

/** The command-line body, run by `server/eval-trend-cli.ts` — and by nothing
 * else. It lives OUT of this module on purpose: when esbuild bundles an
 * entry, every inlined module shares the bundle's `import.meta.url`, so a
 * `import.meta.url === argv[1]` guard here fired inside EVERY sibling
 * bundle that inlined this file — `muster eval-trend` ran role-eval's CLI
 * block as an import side effect and exited 2 with the grader's error text.
 * Importing the trend logic (CLI, test, another bundle) must never start a
 * CLI; the returned number is the process exit code. */
export function runTrendCli(argv: string[]): number {
  const asJson = argv.includes("--json");
  const files = argv.filter((arg) => arg !== "--json");
  if (!files.length) {
    console.error("Usage: node --experimental-strip-types server/eval-trend-cli.ts [--json] scorecard1.json [scorecard2.json ...]");
    return 2;
  }
  try {
    const entries = files.map((file) => {
      if (statSync(file).size > 2_000_000) throw new Error(`${file} exceeds 2 MB.`);
      return { file, scorecard: parseScorecard(file, readFileSync(file, "utf8")) };
    });
    const trend = trendFromScorecards(entries);
    console.log(asJson ? JSON.stringify(trend, null, 2) : formatTrend(trend));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not build the trend.");
    return 2;
  }
}

/** Direct invocation only. The guard is SOUND here because this module is a
 * leaf again: nothing else imports it (the CLI spawns it, tests import
 * nothing but its exported functions, and the shared vocabulary lives in
 * role-eval-kinds.ts), so bundling cannot smear this guard into another
 * entry's module scope. Every other grader keeps this same invariant. */
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = runTrendCli(process.argv.slice(2));
}
