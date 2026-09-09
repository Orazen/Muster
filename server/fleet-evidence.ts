import { z } from "zod";
import type { JsonObject, JsonValue } from "./schema.ts";

const key = z.string().min(1).max(200);
const id = key.regex(/^[\w-]+$/);
const query = z.object({ botId: id, limit: z.number().int().min(1).max(100).default(10) }).strict();
export type EvidenceQuery = z.infer<typeof query>;
export function parseEvidenceQuery(args: JsonObject): EvidenceQuery {
  return query.parse(args);
}
const line = z.string().max(16000);
const timestamp = z.number().finite().nonnegative();
const why = z.object({
  runId: key, botId: key, threadId: key, at: timestamp,
  intent: line, decisions: z.array(line).max(100),
  outcome: z.enum(["done", "failed", "partial"]), hypothesis: line.optional(), findings: line.optional(),
});
const whyPage = z.object({ entries: z.array(why).max(1000) });
export interface WhyEvidence {
  botId: string;
  entries: z.infer<typeof why>[];
  limit: number;
}
export function parseWhyEvidence(payload: JsonValue, query: EvidenceQuery): WhyEvidence {
  const page = whyPage.parse(payload);
  return { botId: query.botId, limit: query.limit, entries: page.entries
    .filter((entry) => entry.botId === query.botId)
    .sort((a, b) => b.at - a.at).slice(0, query.limit) };
}
const run = z.object({
  id: key, botId: key, routineId: key, routineName: line, threadId: key.optional(), scheduledFor: timestamp,
  status: z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled", "missed"]),
  scorecard: z.array(z.object({ id: key, label: line, passed: z.boolean(), reason: line.optional() })).max(3).optional(),
});
const runsPage = z.object({ runs: z.array(run).max(10000) });
export interface ScorecardEvidence {
  botId: string;
  runs: z.infer<typeof run>[];
  limit: number;
  hasMore: boolean;
  note: string;
}
export function parseScorecardEvidence(payload: JsonValue, query: EvidenceQuery): ScorecardEvidence {
  const page = runsPage.parse(payload);
  const matching = page.runs.filter((entry) => entry.botId === query.botId).sort((a, b) => b.scheduledFor - a.scheduledFor);
  return {
    botId: query.botId, limit: query.limit, hasMore: matching.length > query.limit,
    runs: matching.slice(0, query.limit),
    note: "A missing scorecard means no recorded checks, not a pass. Run status and individual check results are separate evidence.",
  };
}
