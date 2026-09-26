// Trend across stored fleet scorecards, in the order the caller lists them.
// Read-only: nothing here grades captures, runs probes, contacts the fleet,
// or writes a file. What a trend can and cannot claim is stated in the
// output's limitation, and repeated in the playbook.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const check = z.object({ name: z.string(), passed: z.boolean() });
const probeScore = z.object({
  status: z.enum(["passed", "failed", "missing"]),
  checks: z.array(check),
  elapsedMs: z.number().nullable(),
  tokens: z.number().nullable(),
  costUsd: z.number().nullable(),
});
const scorecard = z.object({
  version: z.literal(1),
  label: z.string().min(1),
  source: z.enum(["live", "simulated"]),
  status: z.enum(["passed", "failed", "incomplete"]),
  probes: z.object({ completion: probeScore, escalation: probeScore, failure: probeScore }),
  limitation: z.string(),
});

export type Scorecard = z.infer<typeof scorecard>;

export interface TrendProbe {
  status: Scorecard["probes"]["completion"]["status"];
  elapsedMs: number | null;
  tokens: number | null;
  costUsd: number | null;
  /** The named checks that failed, so a regression says which check broke. */
  failedChecks: string[];
}
export interface TrendRun {
  file: string;
  label: string;
  source: Scorecard["source"];
  status: Scorecard["status"];
  probes: Record<"completion" | "escalation" | "failure", TrendProbe>;
}
export interface EvalTrend {
  version: 1;
  runs: TrendRun[];
  statuses: Array<Scorecard["status"]>;
  /** Distinct labels across the runs. The playbook requires like-for-like
   * task specifications; differing labels are reported, not judged. */
  labels: string[];
  limitation: string;
}

export function parseScorecard(file: string, json: string): Scorecard {
  try {
    return scorecard.parse(JSON.parse(json));
  } catch (error) {
    // Name the file and the first disagreement; never echo file contents.
    const detail = error instanceof z.ZodError
      ? error.issues[0]?.message ?? "schema mismatch"
      : error instanceof Error ? error.message : "not JSON";
    throw new Error(`${file} is not a fleet scorecard: ${detail}`);
  }
}

function probeTrend(p: Scorecard["probes"]["completion"]): TrendProbe {
  return {
    status: p.status, elapsedMs: p.elapsedMs, tokens: p.tokens, costUsd: p.costUsd,
    failedChecks: p.checks.filter((c) => !c.passed).map((c) => c.name),
  };
}

export function trendFromScorecards(entries: Array<{ file: string; scorecard: Scorecard }>): EvalTrend {
  const runs: TrendRun[] = entries.map(({ file, scorecard: s }) => ({
    file,
    label: s.label,
    source: s.source,
    status: s.status,
    probes: {
      completion: probeTrend(s.probes.completion),
      escalation: probeTrend(s.probes.escalation),
      failure: probeTrend(s.probes.failure),
    },
  }));
  return {
    version: 1,
    runs,
    statuses: runs.map((r) => r.status),
    labels: [...new Set(runs.map((r) => r.label))],
    limitation: "Order is exactly the caller's file order: a scorecard records no timestamp, so chronology is a naming convention, not data. Nulls pass through rather than being zero-filled. Receipt usage aggregates a task thread, so runs over reused threads are not per-task measurements. Distinct labels are listed so unlike task specifications are visible; this tool does not judge comparability, re-grade captures, or verify provenance — statuses are the scorecards' own claims.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [, , ...files] = process.argv;
    if (!files.length) throw new Error("Usage: node --experimental-strip-types server/eval-trend.ts scorecard1.json [scorecard2.json ...]");
    const entries = files.map((file) => {
      if (statSync(file).size > 2_000_000) throw new Error(`${file} exceeds 2 MB.`);
      return { file, scorecard: parseScorecard(file, readFileSync(file, "utf8")) };
    });
    console.log(JSON.stringify(trendFromScorecards(entries), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not build the trend.");
    process.exitCode = 2;
  }
}
