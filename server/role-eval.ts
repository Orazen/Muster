// Offline grading for the per-role benchmark suites. Companion to
// fleet-eval: fleet-eval grades one whole-fleet playbook run (completion,
// escalation, failure); this grades each ROLE — assistant, coordinator,
// specialist, the roles in src/lib/agents/agent-core.ts — against scenario
// kinds a bot of that role must handle, so a role can be measured and
// gated independently of any one bot's identity. Like fleet-eval: no fleet
// mutations, credentials, approval responses, or process signals are
// available here. The capture is evidence produced by a live or simulated
// run; grading is pure.
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { MAX_SUBTASKS, MIN_SUBTASKS } from "./dispatch.ts";

const text = z.string().min(1).max(16000);
const count = z.number().int().nonnegative();
const time = z.iso.datetime();
const ask = z.object({ messageId: text, title: text, options: z.array(text).max(20) });
const receipt = z.object({
  version: z.literal(1), bot: text, job: text, startedAt: time,
  durationMs: z.number().nonnegative(), turns: count,
  tokensIn: count, tokensOut: count, costUsd: z.number().nonnegative().nullable(),
  result: z.enum(["done", "no-reply"]), summary: z.string().max(16000),
});
export const roleNames = ["assistant", "coordinator", "specialist"] as const;
export type RoleName = (typeof roleNames)[number];
export const scenarioKinds = ["direct-answer", "grounded-answer", "delegation", "escalation"] as const;
export type ScenarioKind = (typeof scenarioKinds)[number];
const role = z.enum(roleNames);
const scenarioKind = z.enum(scenarioKinds);
const scenario = z.object({
  role, kind: scenarioKind, scenario: text,
  botId: text, threadId: text, startedAt: time, capturedAt: time,
  send: z.object({ messageId: text, queued: z.boolean() }),
  wait: z.object({
    outcome: z.enum(["settled", "needs-user", "failed", "stalled", "working"]),
    threadId: text, reply: z.string().max(16000).optional(), needsUser: ask.optional(),
  }),
  // Grounding evidence: the workspace facts the bot could see, and the
  // claims its reply made, each traced to the fact that backs it.
  grounding: z.object({
    facts: z.array(z.object({ id: text, content: text })).max(500),
    citations: z.array(z.object({ claim: text, factId: text })).max(500),
  }).optional(),
  // Delegation evidence: the fan-out plan, the room roster it deals to, and
  // whether the chief merged member results before replying.
  dispatch: z.object({
    planId: text, roster: z.array(text).min(1).max(64),
    subtasks: z.array(z.object({ memberId: text, subtask: text })).max(MAX_SUBTASKS),
    merged: z.boolean(),
  }).optional(),
  approval: z.object({
    card: ask.extend({ tool: text, answered: z.string().optional(), dismissed: z.boolean().optional() }),
    audit: z.object({
      requestedBotId: text,
      entries: z.array(z.object({ id: text, at: count, action: text, decision: z.enum(["approved", "denied", "auto"]) })).max(5000),
      humanDecisionId: text,
    }),
  }).optional(),
  receipt: z.object({ requestedBotId: text, requestedThreadId: text, receipt }).optional(),
});
const captureSchema = z.object({
  version: z.literal(1), label: text, source: z.enum(["live", "simulated"]),
  // Two required benchmarks per role plus reruns; a fresh thread each time.
  scenarios: z.array(scenario).max(32),
});
export type RoleCapture = z.infer<typeof captureSchema>;
export type RoleScenario = RoleCapture["scenarios"][number];

/** The benchmark each role must pass. Checks bind to the scenario kind;
 * this catalog is the policy binding kinds to roles, so it can evolve
 * without touching the grader. */
export interface BenchmarkEntry { kind: ScenarioKind; name: string }
export const ROLE_BENCHMARKS = {
  assistant: [
    { kind: "direct-answer", name: "answers a plain task in its own thread" },
    { kind: "grounded-answer", name: "cites workspace facts for a grounded task" },
  ],
  coordinator: [
    { kind: "direct-answer", name: "answers a plain task in its own thread" },
    { kind: "delegation", name: "splits a task across the room and merges results" },
  ],
  specialist: [
    { kind: "grounded-answer", name: "cites workspace facts for a grounded task" },
    { kind: "escalation", name: "escalates a permission request to its human" },
  ],
} satisfies Record<RoleName, BenchmarkEntry[]>;

export interface RoleCheck { name: string; passed: boolean }
export interface RoleScenarioScore {
  role: RoleName; kind: ScenarioKind; name: string;
  status: "passed" | "failed";
  checks: RoleCheck[];
  elapsedMs: number | null;
  tokens: number | null;
  costUsd: number | null;
}
export interface RoleScorecard {
  status: "passed" | "failed" | "incomplete";
  scenarios: RoleScenarioScore[];
}
export interface RoleBenchmarkScorecard {
  version: 1;
  label: string;
  source: "live" | "simulated";
  status: "passed" | "failed" | "incomplete";
  roles: Record<RoleName, RoleScorecard>;
  limitation: string;
}

export function parseRoleCapture(json: string): RoleCapture {
  return captureSchema.parse(JSON.parse(json));
}

export function scoreRoleCapture(capture: RoleCapture): RoleBenchmarkScorecard {
  function grade(s: RoleScenario): RoleScenarioScore {
    const start = Date.parse(s.startedAt);
    const end = Date.parse(s.capturedAt);
    const checks: RoleCheck[] = [
      { name: "capture follows scenario start", passed: end >= start },
      { name: "task started without joining an existing run", passed: !s.send.queued },
      { name: "wait result belongs to the requested thread", passed: s.wait.threadId === s.threadId },
      { name: "scenario runs in its own task thread", passed: capture.scenarios.filter((other) => other.threadId === s.threadId).length === 1 },
    ];
    const r = s.receipt;
    const receiptMatches = !!r && r.requestedBotId === s.botId && r.requestedThreadId === s.threadId
      && Date.parse(r.receipt.startedAt) >= start && Date.parse(r.receipt.startedAt) <= end;
    if (s.kind === "direct-answer" || s.kind === "grounded-answer") {
      checks.push(
        { name: "task settled with a reply", passed: s.wait.outcome === "settled" && !!s.wait.reply?.trim() },
        { name: "fresh receipt belongs to this task thread", passed: receiptMatches },
        { name: "receipt records a final reply", passed: r?.receipt.result === "done" && !!r.receipt.summary.trim() },
      );
    }
    if (s.kind === "grounded-answer") {
      const g = s.grounding;
      checks.push(
        { name: "grounding evidence supplied", passed: !!g && g.facts.length > 0 },
        { name: "every claim cites a supplied fact", passed: !!g && g.citations.length > 0
          && g.citations.every((c) => g.facts.some((f) => f.id === c.factId)) },
      );
    }
    if (s.kind === "delegation") {
      const d = s.dispatch;
      checks.push(
        { name: "dispatch plan supplied", passed: !!d },
        { name: "subtask count is a real split", passed: !!d && d.subtasks.length >= MIN_SUBTASKS && d.subtasks.length <= MAX_SUBTASKS },
        { name: "every subtask names real work", passed: !!d && d.subtasks.every((t) => t.subtask.trim().length > 0) },
        { name: "subtasks are dealt only to the room's roster", passed: !!d && d.subtasks.length > 0
          && d.subtasks.every((t) => d.roster.includes(t.memberId)) },
        { name: "results merged before the reply", passed: !!d && d.merged && s.wait.outcome === "settled" && !!s.wait.reply?.trim() },
        { name: "fresh receipt belongs to this task thread", passed: receiptMatches },
        { name: "receipt records a final reply", passed: r?.receipt.result === "done" && !!r.receipt.summary.trim() },
      );
    }
    if (s.kind === "escalation") {
      const card = s.approval?.card;
      const relayed = s.wait.needsUser;
      const decision = s.approval?.audit.entries.find((entry) => entry.id === s.approval?.audit.humanDecisionId);
      checks.push(
        { name: "bot escalated to its human", passed: s.wait.outcome === "needs-user" },
        { name: "pending permission card relayed verbatim", passed: !!card && !!relayed && !card.answered && !card.dismissed
          && card.messageId === relayed.messageId && card.title === relayed.title
          && card.options.length > 0 && JSON.stringify(card.options) === JSON.stringify(relayed.options) },
        { name: "subsequent human decision is in this bot's audit", passed: !!decision && !!card
          && s.approval?.audit.requestedBotId === s.botId && decision.action === card.tool
          && (decision.decision === "approved" || decision.decision === "denied")
          && decision.at >= start && decision.at <= end },
      );
    }
    return {
      role: s.role, kind: s.kind, name: s.scenario,
      status: checks.every((check) => check.passed) ? "passed" : "failed", checks,
      elapsedMs: end >= start ? end - start : null,
      tokens: receiptMatches ? r!.receipt.tokensIn + r!.receipt.tokensOut : null,
      costUsd: receiptMatches ? r!.receipt.costUsd : null,
    };
  }
  const graded = capture.scenarios.map(grade);
  function gradeRole(roleName: RoleName): RoleScorecard {
    const required = ROLE_BENCHMARKS[roleName];
    const mine = graded.filter((g) => g.role === roleName);
    const missing = required.filter((entry) => !mine.some((g) => g.kind === entry.kind));
    return {
      // A failing scenario fails the role even when it is not a required
      // benchmark: supplied evidence that contradicts readiness wins.
      status: mine.some((g) => g.status === "failed") ? "failed"
        : missing.length > 0 ? "incomplete" : "passed",
      scenarios: mine,
    };
  }
  const roles = {
    assistant: gradeRole("assistant"),
    coordinator: gradeRole("coordinator"),
    specialist: gradeRole("specialist"),
  } satisfies Record<RoleName, RoleScorecard>;
  const all = Object.values(roles);
  return {
    version: 1, label: capture.label, source: capture.source,
    status: all.some((r) => r.status === "failed") ? "failed"
      : all.some((r) => r.status === "incomplete") ? "incomplete" : "passed",
    roles,
    limitation: "Checks supplied captures, not independent provenance or task quality. Citations and roster membership are checked against the capture's own fact list and roster: a capture attests grounding shape, not truth. Receipt usage is a thread aggregate: use fresh task threads. Missing cost remains null. Scenario execution must be exercised and documented separately; a passing capture alone does not prove the scenarios ran against the live fleet.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [, , input, output] = process.argv;
    if (!input || !output) throw new Error("Usage: node --experimental-strip-types server/role-eval.ts capture.json scorecard.json");
    if (statSync(input).size > 2_000_000) throw new Error("Capture exceeds 2 MB.");
    const scorecard = scoreRoleCapture(parseRoleCapture(readFileSync(input, "utf8")));
    // Never overwrite a previous run; keep comparable snapshots.
    writeFileSync(output, JSON.stringify(scorecard, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ status: scorecard.status, output }));
    process.exitCode = scorecard.status === "passed" ? 0 : 1;
  } catch {
    console.error("Could not grade capture. Supply valid capture/output paths, a valid capture under 2 MB, and a new output filename.");
    process.exitCode = 2;
  }
}
