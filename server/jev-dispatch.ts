// Jev-style team dispatch for Muster — the Chief of Staff's decision engine.
//
// The pattern is borrowed from the open Jev stack (jev-mcp's pure helpers,
// jev-ultrafast's indexed candidate table, jev-review's one focused tool,
// openjev's "no JSON repair loop" stance): candidates are enumerated by
// software with unique ids, ranking is deterministic and explainable, and
// the model only chooses among indexed options. Nothing here calls a model
// and nothing here mutates config — bots own their models, so the "right
// model" output is an honest fit note, never a silent override.
//
// Pure module: no I/O, fully unit-testable.

/** Upper bound on candidates per call, mirroring jev-mcp's MAX_CANDIDATES. */
export const MAX_CANDIDATES = 250;

/** Default picks returned, ordered best-first. */
export const DEFAULT_MAX_PICKS = 2;
export const MAX_PICKS = 3;

export interface JevCandidate {
  id: string;
  name: string;
  title?: string;
  description?: string;
  /** The bot's own model id, as list_bots reports it. Advisory only. */
  model?: string;
  busy?: boolean;
}

export interface TeamPick {
  botId: string;
  name: string;
  /** One-line, evidence-citing reason (which words matched, or fallback). */
  reason: string;
  /** The bot's current model, echoed so the Chief can speak to fit. */
  model?: string;
  /** Present only when the task's complexity looks mismatched to the model. */
  modelFit?: string;
}

export interface JevDispatch {
  /** True when no teammate is a credible fit — the Chief should do it itself. */
  handleSelf: boolean;
  picks: TeamPick[];
  /** Short guidance for the Chief's own reply. */
  advisory: string;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto", "over",
  "under", "then", "than", "them", "they", "their", "there", "here", "have",
  "has", "had", "was", "were", "will", "would", "could", "should", "shall",
  "can", "may", "might", "must", "does", "did", "done", "doing", "been",
  "being", "are", "our", "your", "his", "her", "its", "about", "after",
  "before", "between", "both", "each", "few", "more", "most", "other",
  "some", "such", "only", "own", "same", "too", "very", "just", "also",
  "please", "need", "needs", "want", "make", "made", "take", "look",
  "get", "got", "give", "gave", "use", "used", "using", "work", "works",
  "fix", "write", "check", "help", "show", "tell", "send", "list", "add",
]);

/** Tokenize into meaningful lowercase words (deduped, stopwords dropped). */
export function taskTokens(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  )];
}

export type Complexity = "simple" | "standard" | "complex";

/** Deterministic complexity read: length + multi-step + code signals. */
export function taskComplexity(task: string): Complexity {
  const words = task.trim().split(/\s+/).length;
  const steps = (task.match(/^\s*\d+[.)]\s/gm) ?? []).length
    + (task.match(/\b(first|second|third|finally|then)\b/gi) ?? []).length;
  const code = /```|\bfunction\b|\bapi\b|\bendpoint\b|\bsql\b|\bmigration\b/i.test(task) ? 1 : 0;
  if (words > 120 || steps >= 3 || (code && words > 40)) return "complex";
  if (words <= 12 && steps === 0 && !code) return "simple";
  return "standard";
}

const SMALL_MODEL_HINTS = /haiku|mini|flash|nano|small|lite|8b|4b|3\.5|tiny/i;
const FRONTIER_MODEL_HINTS = /opus|gpt-5|gpt-4\.1|o[34]|claude-[45]|sonnet|gemini-2\.5-pro|grok-[34]|frontier|max/i;

function modelClassOf(model: string | undefined): "small" | "mid" | "frontier" {
  if (!model) return "mid";
  if (SMALL_MODEL_HINTS.test(model)) return "small";
  if (FRONTIER_MODEL_HINTS.test(model)) return "frontier";
  return "mid";
}

/** Weighted rank for the complexity read (one point per level). */
const COMPLEXITY_RANK = { simple: 1, standard: 2, complex: 3 } as const;
const CLASS_RANK = { small: 1, mid: 2, frontier: 3 } as const;

function fitNote(complexity: Complexity, model: string | undefined): string | undefined {
  const need = COMPLEXITY_RANK[complexity];
  const has = CLASS_RANK[modelClassOf(model)];
  if (need > has) {
    return `this looks ${complexity} work and ${model ?? "its model"} reads ${modelClassOf(model)}-class — consider a stronger teammate or handle it yourself`;
  }
  if (need < has - 1) {
    return `a frontier-class model on a ${complexity} task is overkill — fine to proceed`;
  }
  return undefined;
}

export interface CandidateScore {
  candidate: JevCandidate;
  relevance: number;
  matched: string[];
}

/** Weighted overlap: title matches count triple, name double, description single. */
export function scoreCandidate(task: string, candidate: JevCandidate): CandidateScore {
  const tokens = taskTokens(task);
  const hit = (source: string | undefined, weight: number) => {
    if (!source) return [];
    const hay = new Set(taskTokens(source));
    return tokens.filter((t) => hay.has(t)).map((t) => [t, weight] as const);
  };
  const scored = [
    ...hit(candidate.title, 3),
    ...hit(candidate.name, 2),
    ...hit(candidate.description, 1),
  ];
  const relevance = scored.reduce((sum, [, w]) => sum + w, 0);
  const matched = [...new Set(scored.map(([t]) => t))];
  return { candidate, relevance, matched };
}

/** Rank the roster for one task and return the dispatch recommendation. */
export function recommendTeam(
  task: string,
  candidates: JevCandidate[],
  options?: { maxPicks?: number },
): JevDispatch {
  const brief = task.trim();
  if (!brief || candidates.length === 0) {
    return {
      handleSelf: true,
      picks: [],
      advisory: "No teammates to rank — handle it yourself or ask the user to add bots.",
    };
  }
  const pool = candidates.slice(0, MAX_CANDIDATES);
  const complexity = taskComplexity(brief);
  const scored = pool
    .map((c) => scoreCandidate(brief, c))
    .sort((a, b) =>
      b.relevance - a.relevance
      || Number(a.candidate.busy ?? false) - Number(b.candidate.busy ?? false)
      || a.candidate.name.localeCompare(b.candidate.name));

  const maxPicks = Math.min(Math.max(options?.maxPicks ?? DEFAULT_MAX_PICKS, 1), MAX_PICKS);
  const credible = scored.filter((s) => s.relevance >= 3);
  const picks: TeamPick[] = [];
  for (const s of credible.slice(0, maxPicks)) {
    const pick: TeamPick = {
      botId: s.candidate.id,
      name: s.candidate.name,
      reason: s.matched.length
        ? `matched on ${s.matched.slice(0, 4).join(", ")} (${s.candidate.busy ? "busy now" : "available"})`
        : `${s.candidate.title ?? "general assistant"} (${s.candidate.busy ? "busy now" : "available"})`,
    };
    if (s.candidate.model !== undefined) pick.model = s.candidate.model;
    const fit = fitNote(complexity, s.candidate.model);
    if (fit) pick.modelFit = fit;
    picks.push(pick);
  }

  if (picks.length === 0) {
    return {
      handleSelf: true,
      picks: [],
      advisory: `No teammate's profile overlaps this ${complexity} task — handle it yourself or ask the user who should own it.`,
    };
  }
  const top = picks[0];
  const confidence = credible[0].relevance >= 8 ? "strong" : credible[0].relevance >= 5 ? "good" : "weak";
  const fit = top.modelFit ? ` Note: ${top.modelFit}.` : "";
  return {
    handleSelf: false,
    picks,
    advisory: `Best fit: ${top.name}${top.model ? ` (on ${top.model})` : ""} — ${confidence} match${picks.length > 1 ? `; ${picks[1].name} is the alternate` : ""}.${fit} Confirm with list_bots, then use ask_bot or delegate_bot.`,
  };
}
