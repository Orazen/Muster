// Approval history — the certify-lite layer of the ARC patterns
// (docs/plans/task-harness-arc-patterns.md §1.2 v1). Before a human answers
// an approval card, the card shows how THIS bot's past went with THIS tool:
// how many times it was allowed, denied, or auto-settled, and when the last
// one was. Evidence, not a verdict — a passed history checks only what it
// counts, and the human still decides.
import type { DecisionLog } from "./decision-log.ts";

export interface ApprovalHistory {
  /** total settled requests for this exact tool on this bot */
  total: number;
  approved: number;
  denied: number;
  auto: number;
  /** ms epoch of the most recent settled request, or null if none */
  lastAt: number | null;
  /** the last decision, for a one-word chip */
  lastDecision: "approved" | "denied" | "auto" | null;
  /** human sentence rendered server-side so every client says it the same way */
  summary: string | null;
}

const TOOL_PREFIX = /^mcp__[^_]+__/;

/** Narrow the history to the tool family: command tools are keyed
 * "Tool:program" ("Bash:git"), and the family — the bare tool ("Bash") —
 * is what informs an ask. `git` history is evidence about an `npm` ask
 * because both are "this bot running shell commands". Exact matches on
 * non-command tools (Write, browser_click) count as the same family. */
export function approvalHistory(log: DecisionLog, botId: string, tool: string, limit = 200): ApprovalHistory {
  const bare = tool.replace(TOOL_PREFIX, "").toLowerCase();
  const family = bare.split(":")[0];
  const page = log.page(botId, { limit });
  const mine = page.entries.filter((e) => {
    const entryBare = e.action.replace(TOOL_PREFIX, "").toLowerCase();
    // family = the bare tool without the program suffix — "Bash:git" and
    // "Bash:npm" are the same family ("Bash"); exact names also match.
    const entryFamily = entryBare.split(":")[0];
    return entryFamily === family || entryBare === bare || e.action === tool;
  });
  const approved = mine.filter((e) => e.decision === "approved").length;
  const denied = mine.filter((e) => e.decision === "denied").length;
  const auto = mine.filter((e) => e.decision === "auto").length;
  const last = mine[0] ?? null;
  const total = mine.length;
  let summary: string | null = null;
  if (total > 0) {
    const when = last?.at ? timeAgo(last.at) : "before";
    const label = botToolLabel(family);
    if (denied === 0 && last?.decision !== "denied") {
      summary = `${label} was allowed ${approved + auto}× before (last ${when}) — never denied.`;
    } else {
      summary = `${label} history: ${approved + auto} allowed, ${denied} denied (last ${when}).`;
    }
  }
  return { total, approved, denied, auto, lastAt: last?.at ?? null, lastDecision: last?.decision ?? null, summary };
}

function botToolLabel(tool: string): string {
  const bare = tool.replace(TOOL_PREFIX, "");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

function timeAgo(at: number): string {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
