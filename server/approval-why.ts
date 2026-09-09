import type { WhyEntry } from "./why-journal.ts";
import { redactSecretsInText } from "./redact.ts";

/** Historical context only: the journal is written after a turn settles. */
export interface ApprovalWhy {
  source: "previous-run";
  runId: string;
  botId: string;
  threadId: string;
  at: number;
  intent: string;
  decisions: string[];
  outcome: "done" | "failed" | "partial";
  hypothesis?: string;
  findings?: string;
}
const boundedText = (value: string, limit = 300) => redactSecretsInText(value).slice(0, limit);

/** Also used on persisted card reads/writes so nested evidence cannot bypass
 * the transcript's bot-authored text redaction boundary. Copies all arrays. */
export function redactApprovalWhy(why: ApprovalWhy): ApprovalWhy {
  return {
    ...why,
    runId: boundedText(why.runId, 200), botId: boundedText(why.botId, 200), threadId: boundedText(why.threadId, 200),
    intent: boundedText(why.intent), decisions: why.decisions.slice(0, 3).map((decision) => boundedText(decision, 200)),
    hypothesis: why.hypothesis === undefined ? undefined : boundedText(why.hypothesis),
    findings: why.findings === undefined ? undefined : boundedText(why.findings),
  };
}

export function approvalWhy(entries: readonly WhyEntry[], botId: string, threadId: string, askedAt: number): ApprovalWhy | undefined {
  if (!Number.isFinite(askedAt)) return undefined;
  let latest: WhyEntry | undefined;
  for (const entry of entries) {
    if (entry.botId !== botId || entry.threadId !== threadId || !Number.isFinite(entry.at) || entry.at >= askedAt) continue;
    if (!latest || entry.at > latest.at) latest = entry;
  }
  return latest ? redactApprovalWhy({ ...latest, source: "previous-run" }) : undefined;
}
