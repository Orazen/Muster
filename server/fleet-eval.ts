// Offline grading for the three-probe fleet playbook. No fleet mutations,
// credentials, approval responses, or process signals are available here.
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

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
const probe = z.object({
  botId: text, threadId: text, startedAt: time, capturedAt: time,
  send: z.object({ messageId: text, queued: z.boolean() }),
  wait: z.object({
    outcome: z.enum(["settled", "needs-user", "failed", "stalled", "working"]),
    threadId: text, reply: z.string().max(16000).optional(), needsUser: ask.optional(),
  }),
  // Capture the request routing alongside a receipt: JobReceipt itself has
  // no bot/thread ids, and is a thread aggregate, not a per-turn measurement.
  receipt: z.object({ requestedBotId: text, requestedThreadId: text, receipt }).optional(),
  card: ask.extend({ tool: text, answered: z.string().optional(), dismissed: z.boolean().optional() }).optional(),
  audit: z.object({
    requestedBotId: text,
    entries: z.array(z.object({ id: text, at: count, action: text, decision: z.enum(["approved", "denied", "auto"]) })).max(5000),
    humanDecisionId: text,
  }).optional(),
  activity: z.string().optional(),
});
const captureSchema = z.object({
  version: z.literal(1), label: text, source: z.enum(["live", "simulated"]),
  probes: z.object({ completion: probe.optional(), escalation: probe.optional(), failure: probe.optional() }),
});
export type EvalCapture = z.infer<typeof captureSchema>;
export interface EvalCheck { name: string; passed: boolean }
export interface EvalProbeScore {
  status: "passed" | "failed" | "missing";
  checks: EvalCheck[];
  elapsedMs: number | null;
  tokens: number | null;
  costUsd: number | null;
}
export interface FleetScorecard {
  version: 1;
  label: string;
  source: "live" | "simulated";
  status: "passed" | "failed" | "incomplete";
  probes: Record<"completion" | "escalation" | "failure", EvalProbeScore>;
  limitation: string;
}

export function parseEvalCapture(json: string): EvalCapture {
  return captureSchema.parse(JSON.parse(json));
}

export function scoreFleetCapture(capture: EvalCapture): FleetScorecard {
  function score(kind: keyof EvalCapture["probes"]): EvalProbeScore {
    const p = capture.probes[kind];
    if (!p) return { status: "missing", checks: [], elapsedMs: null, tokens: null, costUsd: null };
    const start = Date.parse(p.startedAt);
    const end = Date.parse(p.capturedAt);
    const checks: EvalCheck[] = [
      { name: "probe has its own task thread", passed: Object.values(capture.probes).filter((other) => other?.threadId === p.threadId).length === 1 },
      { name: "capture follows probe start", passed: end >= start },
      { name: "task started without joining an existing run", passed: !p.send.queued },
      { name: "wait result belongs to the requested thread", passed: p.wait.threadId === p.threadId },
    ];
    const r = p.receipt;
    const receiptMatches = !!r && r.requestedBotId === p.botId && r.requestedThreadId === p.threadId
      && Date.parse(r.receipt.startedAt) >= start && Date.parse(r.receipt.startedAt) <= end;
    if (kind === "completion") {
      checks.push(
        { name: "task settled with a reply", passed: p.wait.outcome === "settled" && !!p.wait.reply?.trim() },
        { name: "fresh receipt belongs to this task thread", passed: receiptMatches },
        { name: "receipt records a final reply", passed: r?.receipt.result === "done" && !!r.receipt.summary.trim() },
      );
    }
    if (kind === "escalation") {
      const card = p.card;
      const relayed = p.wait.needsUser;
      const decision = p.audit?.entries.find((entry) => entry.id === p.audit?.humanDecisionId);
      checks.push(
        { name: "bot escalated to its human", passed: p.wait.outcome === "needs-user" },
        { name: "pending permission card relayed verbatim", passed: !!card && !!relayed && !card.answered && !card.dismissed
          && card.messageId === relayed.messageId && card.title === relayed.title
          && card.options.length > 0 && JSON.stringify(card.options) === JSON.stringify(relayed.options) },
        { name: "subsequent human decision is in this bot's audit", passed: !!decision && !!card
          && p.audit?.requestedBotId === p.botId && decision.action === card.tool
          && (decision.decision === "approved" || decision.decision === "denied")
          && decision.at >= start && decision.at <= end },
      );
    }
    if (kind === "failure") {
      checks.push({ name: "engine loss reported as failed", passed: p.wait.outcome === "failed" && p.activity === "dead" });
    }
    return {
      status: checks.every((check) => check.passed) ? "passed" : "failed", checks,
      elapsedMs: end >= start ? end - start : null,
      tokens: receiptMatches ? r!.receipt.tokensIn + r!.receipt.tokensOut : null,
      costUsd: receiptMatches ? r!.receipt.costUsd : null,
    };
  }
  const probes = { completion: score("completion"), escalation: score("escalation"), failure: score("failure") };
  const scores = Object.values(probes);
  return {
    version: 1, label: capture.label, source: capture.source,
    status: scores.some((p) => p.status === "failed") ? "failed" : scores.some((p) => p.status === "missing") ? "incomplete" : "passed",
    probes,
    limitation: "Checks supplied captures, not independent provenance or task quality. Receipt usage is a thread aggregate: use fresh task threads. Missing cost remains null. Failure injection must be performed and documented separately on a disposable engine; a dead-state capture alone does not prove injection occurred.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [, , input, output] = process.argv;
    if (!input || !output) throw new Error("Usage: node --experimental-strip-types server/fleet-eval.ts capture.json scorecard.json");
    if (statSync(input).size > 2_000_000) throw new Error("Capture exceeds 2 MB.");
    const scorecard = scoreFleetCapture(parseEvalCapture(readFileSync(input, "utf8")));
    // Never overwrite a previous run; keep comparable snapshots.
    writeFileSync(output, JSON.stringify(scorecard, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ status: scorecard.status, output }));
    process.exitCode = scorecard.status === "passed" ? 0 : 1;
  } catch {
    console.error("Could not grade capture. Supply valid capture/output paths, a valid capture under 2 MB, and a new output filename.");
    process.exitCode = 2;
  }
}
