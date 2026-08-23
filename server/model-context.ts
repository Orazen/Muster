// What.
// Portable context (v2 plan 2.2 / v1 item 7): size-bounded, faithful rebuilds
// of a thread for any model-facing driver, plus the compaction records that
// make repeated rebuilds cheap.
//
// Why.
// Every path that hands history to an API-style engine (transcript replay,
// engine switching, post-branch replay) used "last 40 text messages" — tool
// work invisible, long threads amputated. The governing rule of this module
// is pi's: there are two transcripts and only one shrinks. The display path
// grows without bound and nothing is ever deleted from the record; only the
// MODEL-FACING rebuild is bounded here.
//
// Correctness rules baked in:
// - a cut may only land immediately BEFORE a user text message, so a turn is
//   never split from its reply;
// - summarizing feeds the previous summary forward (chained compaction);
// - oversized overflow is summarized in chunks and merged;
// - an existing compaction record is a cache hit — no re-summarizing until
//   the kept range itself outgrows the target window.

import type { Message } from "./store.ts";

/** Wire payload carried on kind:"compaction" messages. */
export interface CompactionData {
  summary: string;
  /** Kept messages start at the first message AFTER this id at compaction time. */
  firstKeptId: string;
  tokensBefore: number;
  at: number;
}

export interface ModelTurn {
  role: "user" | "assistant";
  text: string;
}

export interface BuiltContext {
  transcript: ModelTurn[];
  /** Summary covering everything cut, or null when nothing was cut. */
  summary: string | null;
  /** Set when this build produced a NEW summary worth persisting as a
   * compaction record. The caller appends it; this module never writes. */
  pending: CompactionData | null;
  windowTokens: number;
}

/** Conservative stand-in for engines whose catalog does not declare a window:
 * small enough that we under-fill rather than overflow. */
export const DEFAULT_CONTEXT_WINDOW = 32_000;

/** Reply headroom scales with the window (pi's flat 16384 would permanently
 * starve an 8k local model), clamped to sane floors and ceilings. */
export function reserveForReply(windowTokens: number): number {
  return Math.min(32_768, Math.max(2_048, Math.floor(windowTokens * 0.25)));
}

/** ~4 characters per token: wrong per-model, right on average, and only ever
 * used where provider-reported usage is unavailable. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TOOL_LINE_OVERHEAD = 12;

/** What one stored message costs in the rebuilt context. */
export function messageTokens(m: Message): number {
  switch (m.kind) {
    case "text":
      return m.text ? estimateTokens(m.text) + 8 : 0;
    case "activity":
      return m.tool ? estimateTokens(m.tool.name) + TOOL_LINE_OVERHEAD : 0;
    case "screen":
      return estimateTokens("[sent a screenshot]") + TOOL_LINE_OVERHEAD;
    default:
      // options cards / connector cards are UI affordances, not context
      return 0;
  }
}

/** Render a stored message into model-facing turns. Returns null for kinds
 * that carry no context (UI affordances) — they cost no tokens either. */
export function renderForModel(m: Message): ModelTurn | null {
  if (m.kind === "text" && m.text) {
    return { role: m.role === "user" ? "user" : "assistant", text: m.text };
  }
  const who = m.role === "user" ? "User" : "Assistant";
  if (m.kind === "activity" && m.tool) {
    return {
      role: "assistant",
      text: `[${who === "User" ? "user ran" : "used"} tool: ${m.tool.name}${m.tool.ok === false ? " (failed)" : ""}]`,
    };
  }
  if (m.kind === "screen") {
    return { role: m.role === "user" ? "user" : "assistant", text: "[screenshot captured]" };
  }
  return null;
}

function indexAfterId(messages: Message[], id: string | undefined): number | null {
  if (!id) return null;
  const idx = messages.findIndex((m) => m.id === id);
  return idx === -1 ? null : idx + 1;
}

/** The newest compaction record in the path, if any. */
export function latestCompaction(messages: Message[]): { message: Message; data: CompactionData } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "compaction" && m.compaction) return { message: m, data: m.compaction };
  }
  return null;
}

/** A cut may only sit immediately before a user text message: the summary
 * then covers whole exchanges, never splitting a turn from its reply. */
function adjustToBoundary(messages: Message[], cut: number): number {
  // Keeping everything is always safe — there is no cut to misplace.
  if (cut === 0) return 0;
  let i = cut;
  while (i < messages.length && !(messages[i].role === "user" && messages[i].kind === "text" && messages[i].text)) {
    i++;
  }
  return i;
}

/** Summarize a rendered range. Oversized ranges go through in chunks, the
 * running summary fed into each next chunk (pi's merge rule), so a single
 * huge turn still ends up covered instead of silently dropped. */
async function summarizeRange(
  rendered: ModelTurn[],
  priorSummary: string | null,
  summarize: (prompt: string) => Promise<string>,
): Promise<string> {
  const lines = rendered.map((t) => `${t.role}: ${t.text}`);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  const CHUNK_BUDGET = 16_000;
  for (const line of lines) {
    const t = estimateTokens(line);
    if (current.length && currentTokens + t > CHUNK_BUDGET) {
      chunks.push(current.join("\n"));
      current = [];
      currentTokens = 0;
    }
    current.push(line);
    currentTokens += t;
  }
  if (current.length) chunks.push(current.join("\n"));

  let summary = priorSummary ?? "";
  for (const chunk of chunks) {
    const prior = summary ? `Previous summary of earlier parts:\n${summary}\n\n` : "";
    summary = await summarize(
      `${prior}Summarize this conversation excerpt for a teammate who must continue the work without reading it. Keep: what was asked, what was done (tools used and outcomes), decisions made, files or systems touched, and anything unresolved.\n\n${chunk}`,
    );
  }
  return summary.trim();
}

export async function buildModelContext(opts: {
  messages: Message[];
  /** The target engine's declared context window, when known. */
  targetWindow?: number | null;
  /** Absent (engine cannot generate text) → bounded truncation, no summary. */
  summarize?: (prompt: string) => Promise<string>;
}): Promise<BuiltContext> {
  const messages = opts.messages;
  const windowTokens = opts.targetWindow && opts.targetWindow > 0 ? opts.targetWindow : DEFAULT_CONTEXT_WINDOW;
  const budget = windowTokens - reserveForReply(windowTokens);

  // Cache hit: a recent compaction whose kept range still fits serves every
  // rebuild until the kept range itself outgrows the window.
  const cached = latestCompaction(messages);
  if (cached) {
    const start = indexAfterId(messages, cached.data.firstKeptId);
    if (start !== null) {
      const kept = messages.slice(start);
      const keptTokens = kept.reduce((sum, m) => sum + messageTokens(m), 0);
      if (keptTokens <= budget) {
        const transcript = kept.map(renderForModel).filter((t): t is ModelTurn => t !== null);
        return { transcript, summary: cached.data.summary, pending: null, windowTokens };
      }
    }
  }

  // Fresh sizing: newest-first walk to find what fits, then slide the cut
  // forward to a user-turn boundary.
  let used = 0;
  let cut = messages.length;
  while (cut > 0) {
    const cost = messageTokens(messages[cut - 1]);
    if (used + cost > budget) break;
    used += cost;
    cut--;
  }
  cut = adjustToBoundary(messages, cut);

  const overflow = messages.slice(0, cut);
  const keptMessages = messages.slice(cut);
  const transcript = keptMessages.map(renderForModel).filter((t): t is ModelTurn => t !== null);

  if (overflow.length === 0) {
    return { transcript, summary: null, pending: null, windowTokens };
  }

  // An older compaction inside the overflow region chains into the new one.
  const prior = latestCompaction(overflow);
  if (!opts.summarize) {
    // No summarizer (engine lacks generateText): stay bounded, lose fidelity,
    // and say so in the summary slot so the model knows history existed.
    return {
      transcript,
      summary: `[Earlier conversation omitted: ${overflow.length} messages]`,
      pending: null,
      windowTokens,
    };
  }
  const priorSummary =
    prior && indexAfterId(overflow, prior.data.firstKeptId) !== null ? prior.data.summary : null;
  const rendered = overflow.map(renderForModel).filter((t): t is ModelTurn => t !== null);
  const summary = await summarizeRange(rendered, priorSummary, opts.summarize);

  const firstKept = keptMessages[0]?.id ?? "";
  return {
    transcript,
    summary,
    pending: {
      summary,
      firstKeptId: firstKept || (overflow.at(-1)?.id ?? ""),
      tokensBefore: overflow.reduce((sum, m) => sum + messageTokens(m), 0),
      at: Date.now(),
    },
    windowTokens,
  };
}
