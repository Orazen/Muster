// The why-journal — the second layer of Muster's two-layer bot memory.
//
// Receipts (server/receipts.ts) record WHAT a bot did: who ran, how long,
// what it cost, and its final word. That is proof of work, but no receipt
// can answer the question every audit actually starts with: WHY did the bot
// do that? This module is the WHY layer — a per-run decision journal where
// a bot states the intent of its run and the key choices it made along the
// way, in a fixed line format the journal can parse mechanically.
//
// The contract mirrors the sentry digest (server/sentry.ts): the prompt
// asks the bot to END its reply with structured lines, and extraction reads
// exactly those lines — nothing smarter. A bot that never learned the
// suffix produces no entries, and a reply that forgot them produces a
// null intent with no decisions: an absent journal entry is data, never a
// crash or a guess.
//
// Storage follows the house pattern for per-data-dir state (see
// whatsapp-threads.ts): one JSON file per data dir, written through
// writeFileAtomic with mode 0600 (journal text is user content), zod
// validation on load, a corrupt or unrecognized file starts empty rather
// than wedging the server, and the journal is bounded at MAX_WHY_ENTRIES
// with the oldest entry (by `at`) evicted.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { parseJson } from "./schema.ts";

/** Hard cap on journal entries per data dir; oldest-`at` eviction. */
export const MAX_WHY_ENTRIES = 1000;

/** File name (inside DATA_DIR) of the persisted journal. */
export const WHY_JOURNAL_FILE = "why-journal.json";

/** The marker a why-enabled prompt asks the bot to state its intent with. */
export const WHY_MARKER = "WHY:";

/** The header a why-enabled prompt puts above its decision bullets. */
export const DECISIONS_HEADER = "DECISIONS:";

/** Max decision bullets kept per reply. */
export const MAX_WHY_DECISIONS = 10;

/** Max characters kept per decision bullet. */
export const MAX_DECISION_CHARS = 200;

/** How a journaled run settled — the same shape as a receipt's result,
 * widened with `partial` for runs that finished but did not fully succeed. */
export type WhyOutcome = "done" | "failed" | "partial";

/** One settled run: what the bot was trying to do, and the choices it made. */
export interface WhyEntry {
  runId: string;
  botId: string;
  threadId: string;
  /** ms epoch — also the ordering and eviction key. */
  at: number;
  intent: string;
  decisions: string[];
  outcome: WhyOutcome;
}

export interface WhyQuery {
  /** Only entries for this bot. */
  botId?: string;
  /** Only entries with `at >= since` (ms epoch). */
  since?: number;
  /** Cap on returned entries, applied newest-first. */
  limit?: number;
}

/** What a reply declared about itself. A missing section is a valid
 * answer: `null` intent, no decisions. */
export interface ExtractedWhy {
  intent: string | null;
  decisions: string[];
}

const entrySchema = z.object({
  runId: z.string().min(1),
  botId: z.string().min(1),
  threadId: z.string().min(1),
  at: z.number().finite().nonnegative(),
  intent: z.string(),
  decisions: z.array(z.string()),
  outcome: z.enum(["done", "failed", "partial"]),
});

const journalFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema),
});

interface WhyJournalFile {
  version: 1;
  entries: WhyEntry[];
}

const journalPath = (dataDir: string) => join(dataDir, WHY_JOURNAL_FILE);

// In-memory cache of the persisted journal, keyed by file path so tests can
// use throwaway data dirs. Loaded lazily on first access.
const journals = new Map<string, WhyEntry[]>();

function loadJournal(path: string): WhyEntry[] {
  const cached = journals.get(path);
  if (cached) return cached;
  let entries: WhyEntry[] = [];
  if (existsSync(path)) {
    try {
      const parsed = journalFileSchema.safeParse(
        // SAFETY: parseJson returns JSON-compatible values by contract; the
        // Zod journalFileSchema above is the actual validation step.
        parseJson(readFileSync(path, "utf8")),
      );
      if (parsed.success) entries = parsed.data.entries;
      // A corrupt or unrecognized file starts empty rather than throwing —
      // the journal is an audit surface, not a source of truth.
    } catch {
      // Same posture for unreadable files: start empty.
    }
  }
  journals.set(path, entries);
  return entries;
}

function persist(path: string, entries: WhyEntry[]): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/") || path.length), { recursive: true });
  const file: WhyJournalFile = { version: 1, entries };
  writeFileAtomic(path, JSON.stringify(file, null, 2), { mode: 0o600 });
}

/** Evict down to the cap, oldest `at` first. Ties evict in append order. */
function evictOldest(entries: WhyEntry[]): void {
  while (entries.length > MAX_WHY_ENTRIES) {
    let oldestIndex = 0;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].at < entries[oldestIndex].at) oldestIndex = i;
    }
    entries.splice(oldestIndex, 1);
  }
}

const copyEntry = (entry: WhyEntry): WhyEntry => ({ ...entry, decisions: [...entry.decisions] });

/** Append one settled run to the journal and persist it immediately — a
 * decision recorded only in memory is exactly the hole this layer exists
 * to close. */
export function appendWhy(dataDir: string, entry: WhyEntry): void {
  const path = journalPath(dataDir);
  const entries = loadJournal(path);
  entries.push(copyEntry(entry));
  evictOldest(entries);
  persist(path, entries);
}

/** Read the journal, newest first. Filters compose; `limit` truncates the
 * filtered, ordered list. Every returned entry is a copy — mutating a
 * result never reaches the store. */
export function listWhy(dataDir: string, query: WhyQuery = {}): WhyEntry[] {
  const entries = loadJournal(journalPath(dataDir));
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.at - a.entry.at || b.index - a.index);
  const matching = ordered.filter(({ entry }) => {
    if (query.botId !== undefined && entry.botId !== query.botId) return false;
    if (query.since !== undefined && entry.at < query.since) return false;
    return true;
  });
  const cap = query.limit ?? matching.length;
  return matching.slice(0, Math.max(0, cap)).map(({ entry }) => copyEntry(entry));
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Extract the decision journal a why-enabled bot declared at the end of
 * its reply. Deliberately mechanical, like the sentry digest: the FIRST
 * `WHY:` line is the intent (a later one is ignored, max 1), and `- `
 * bullets after a `DECISIONS:` header are the decisions — until prose
 * resumes (blank lines are tolerated mid-block). Bullets outside the
 * header are not decisions. Each decision is flattened to one line and
 * clipped to MAX_DECISION_CHARS; more than MAX_WHY_DECISIONS bullets keep
 * the first ones. Missing sections are a valid answer, not an error. */
export function extractWhyFromReply(reply: string): ExtractedWhy {
  let intent: string | null = null;
  let decisions: string[] = [];
  let inDecisions = false;
  for (const raw of reply.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(WHY_MARKER)) {
      if (intent === null) {
        intent = oneLine(line.slice(WHY_MARKER.length)) || null;
      }
      continue;
    }
    if (line.startsWith(DECISIONS_HEADER)) {
      inDecisions = true;
      continue;
    }
    if (line.startsWith("- ") && inDecisions) {
      const decision = oneLine(line.slice(2)).slice(0, MAX_DECISION_CHARS);
      if (decision && decisions.length < MAX_WHY_DECISIONS) decisions.push(decision);
      continue;
    }
    if (line) inDecisions = false; // prose resumes; blank lines don't end the block
  }
  return { intent, decisions };
}

/** The prompt suffix appended to every why-enabled run. Tells the bot
 * exactly what the extractor reads, so a well-behaved model produces a
 * journal the audit surface can pin to the receipt of the same run. */
export function whyPromptSuffix(): string {
  return (
    `\n\nEnd your reply with a short decision journal so your work can be audited later. ` +
    `First a line starting with ${WHY_MARKER} followed by a ONE-line statement of what this run was ` +
    `trying to accomplish (max ~120 chars). Then a ${DECISIONS_HEADER} line followed by up to ` +
    `${MAX_WHY_DECISIONS} bullet lines starting with "- " (each under ${MAX_DECISION_CHARS} chars) naming the ` +
    "key choices you made and why you made them. Keep these the last lines of the reply — " +
    "the journal reads exactly that block, and nothing else."
  );
}

/** Test helper: drop the in-memory journal for a path so the next access
 * reloads from disk. Does not touch the backing file. Not used by
 * production code paths. */
export function resetWhyJournalForTest(dataDir: string): void {
  journals.delete(journalPath(dataDir));
}
