// M1 — the memory retrieval pipeline (DESIGN §38 M1–M2): deterministic
// lexical search over the two corpora a bot's "memory" actually is:
//
//   · facts   — the workspace brain's explicit facts (workspace-brain.ts),
//               provenance-carrying, withdrawal-aware;
//   · memory  — the bot's own MEMORY.md and memory/<topic>.md files
//               (workspace.ts), provenance = which file, when last written.
//
// BM25-style scoring — term frequency × inverse document frequency × field/
// length normalization — times a bounded recency factor, then a total order
// (score desc, createdAt desc, id asc) so two runs over the same bytes give
// byte-identical results. No new dependencies, no embeddings, no network:
// offline-deterministic the way server/role-eval.ts is. (The "BM25+vector"
// Second Brain in docs/plans/agi-os-eco-platform.md stays the future shape;
// this is the keyless keyword rung, same as the brain's own starting point.)
//
// Tokenization REUSES workspace-brain's tokenize() for term membership
// (same stopwords, same length gate) and only re-derives the raw split so
// term COUNTS survive — brain tokenize() dedupes, BM25 needs tf. The split
// regex below must stay identical to workspace-brain.ts TOKEN_SPLIT; the
// parity test in memory-retrieval.test.ts pins that.
//
// Access control is NOT decided here: searchMemory() takes an already-
// resolved owner flag plus the anchored bot's grants and simply refuses to
// build a corpus the requester may not read (server/memory-grants.ts is the
// single decision point). Prompt assembly does not call any of this yet —
// wiring retrieval into the 1:1/room system prompts is a deliberate
// follow-up slice; today the consumer is the HTTP route.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import { authorizeMemoryAccess, type MemoryGrant, type Requester } from "./memory-grants.ts";
import { listMemoryTopics, readMemoryFile, readMemoryTopic, workspaceDir } from "./workspace.ts";
import { tokenize } from "./workspace-brain.ts";

// ── limits ──────────────────────────────────────────────────────────────

/** Same window the brain's query route uses: a sane default, a hard cap. */
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 50;

// ── tokenization (counts preserved) ─────────────────────────────────────

// Mirrors workspace-brain.ts TOKEN_SPLIT exactly — see the parity test.
const TOKEN_SPLIT = /[^a-z0-9@._+-]+/;

/** The brain's token set, with multiplicity: membership comes from
 * tokenize() itself (one shared stopword/length policy), counting comes
 * from the raw split. */
export function tokensOf(text: string): string[] {
  const keep = new Set(tokenize(text));
  const counted: string[] = [];
  for (const word of text.toLowerCase().split(TOKEN_SPLIT)) {
    if (keep.has(word)) counted.push(word);
  }
  return counted;
}

// ── documents ───────────────────────────────────────────────────────────

export type MemoryDocKind = "fact" | "memory";

export interface FactProvenance {
  kind: "fact";
  factId: string;
  source?: string;
  origin?: string;
  ownerId?: string;
  createdAt: number;
}

export interface MemoryProvenance {
  kind: "memory";
  botId: string;
  file: string;
  bytes: number;
  updatedAt: number;
}

export type DocProvenance = FactProvenance | MemoryProvenance;

export interface MemoryDoc {
  /** Stable and collision-free across corpora: "fact:<id>" / "memory:<bot>:<file>". */
  id: string;
  kind: MemoryDocKind;
  /** Short header field, weighted above the body at scoring time. */
  title: string;
  text: string;
  /** Recency anchor (fact createdAt / file mtime), ms epoch. */
  createdAt: number;
  provenance: DocProvenance;
}

export interface ScoredHit {
  id: string;
  kind: MemoryDocKind;
  title: string;
  score: number;
  /** Which query words matched — the evidence line, like brain query hits. */
  matched: string[];
  components: { bm25: number; recency: number };
  createdAt: number;
  provenance: DocProvenance;
}

export interface SearchResult {
  mode: "search" | "browse";
  /** The effective limit after parsing and clamping — what was applied. */
  limit: number;
  hits: ScoredHit[];
}

// ── brain fact corpus ───────────────────────────────────────────────────

// Lockstep with workspace-brain.ts BRAIN_FILE: the brain module exposes no
// enumeration API (its query() only returns term matches, and browse needs
// everything), so retrieval reads the same persisted file it writes. The
// schema below is deliberately LENIENT (passthrough + optional fields) so a
// future brain field cannot strand this reader; anything unparseable
// degrades to zero fact docs, never a throw.
const BRAIN_FILE = join(DATA_DIR, "workspace-brain.json");

const brainDocSchema = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  text: z.string(),
  kind: z.string().optional(),
  source: z.string().optional(),
  origin: z.string().optional(),
  withdrawnAt: z.number().optional(),
  createdAt: z.number(),
}).passthrough();

const brainFileSchema = z.object({ facts: z.array(brainDocSchema) });

export type FactView = "owner" | "granted";

/** Non-withdrawn facts visible to a retrieval view:
 *   · "owner"   — WorkspaceBrain.visible() verbatim: an undefined owner
 *                 (desktop) sees everything, a resolved owner sees their own
 *                 plus the unowned desktop facts, matching /api/brain/*.
 *   · "granted" — STRICT: only facts whose ownerId equals the resource
 *                 owner's id (undefined === undefined keeps a desktop
 *                 install's own unowned facts). A granted non-owner never
 *                 inherits the "unowned = operator" widening above. */
export function brainFactDocs(options: { owner?: string; view: FactView }): MemoryDoc[] {
  let raw: string;
  try {
    raw = readFileSync(BRAIN_FILE, "utf8");
  } catch {
    return []; // absent brain → no fact docs, same as a fresh install
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return []; // corrupt brain file fails closed for retrieval
  }
  const parsed = brainFileSchema.safeParse(value);
  if (!parsed.success) return [];
  const docs: MemoryDoc[] = [];
  for (const fact of parsed.data.facts) {
    if (fact.withdrawnAt) continue; // withdrawn facts never answer queries
    const visible = options.view === "owner"
      ? !options.owner || !fact.ownerId || fact.ownerId === options.owner
      : fact.ownerId === options.owner;
    if (!visible) continue;
    const title = [fact.kind, fact.source].filter(Boolean).join(" ");
    docs.push({
      id: `fact:${fact.id}`,
      kind: "fact",
      title,
      text: fact.text,
      createdAt: fact.createdAt,
      provenance: {
        kind: "fact",
        factId: fact.id,
        source: fact.source,
        origin: fact.origin,
        ownerId: fact.ownerId,
        createdAt: fact.createdAt,
      },
    });
  }
  return docs;
}

// ── bot memory corpus ───────────────────────────────────────────────────

// Lockstep with workspace.ts — readMemoryFile's file name and the topics
// directory it lists.
const MEMORY_FILE = "MEMORY.md";

function fileMtime(path: string): number {
  try {
    return Math.trunc(statSync(path).mtimeMs);
  } catch {
    return 0; // no recency anchor rather than a lie: factor stays at base
  }
}

/** MEMORY.md plus every memory/<topic>.md as its own document. Seed-only or
 * empty files yield no document (readMemoryFile already treats the seed as
 * "no memory yet"). */
export function botMemoryDocs(botId: string): MemoryDoc[] {
  const docs: MemoryDoc[] = [];
  const dir = workspaceDir(botId);
  const memoryPath = join(dir, MEMORY_FILE);
  const memory = readMemoryFile(botId);
  if (memory.text.trim()) {
    const mtime = fileMtime(memoryPath);
    docs.push({
      id: `memory:${botId}:${MEMORY_FILE}`,
      kind: "memory",
      title: MEMORY_FILE,
      text: memory.text,
      createdAt: mtime,
      provenance: {
        kind: "memory",
        botId,
        file: MEMORY_FILE,
        bytes: Buffer.byteLength(memory.text, "utf8"),
        updatedAt: mtime,
      },
    });
  }
  for (const topic of listMemoryTopics(botId)) {
    const text = readMemoryTopic(botId, topic.name);
    if (!text || !text.trim()) continue;
    const rel = `memory/${topic.name}`;
    const mtime = fileMtime(join(dir, "memory", topic.name));
    docs.push({
      id: `memory:${botId}:${rel}`,
      kind: "memory",
      title: rel,
      text,
      createdAt: mtime,
      provenance: {
        kind: "memory",
        botId,
        file: rel,
        bytes: Buffer.byteLength(text, "utf8"),
        updatedAt: mtime,
      },
    });
  }
  return docs;
}

// ── scoring ─────────────────────────────────────────────────────────────

// BM25 constants (standard defaults) + the field/length/recency weights.
const K1 = 1.2;
const B = 0.75;
/** Header field (fact kind+source / file path) counts triple toward tf. */
const TITLE_WEIGHT = 3;
/** Recency multiplies the final score by at most 1 + BOOST (bounded, so a
 * fresh but irrelevant doc can never outrank a strongly matching old one
 * on recency alone… at BOOST ≤ 0.25 the boost is evidence-adjacent only). */
const RECENCY_BOOST = 0.25;
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

export function recencyFactor(createdAt: number, now: number): number {
  const age = Math.max(0, now - createdAt);
  return 1 + RECENCY_BOOST * Math.exp(-age / RECENCY_HALF_LIFE_MS);
}

interface ParsedDoc {
  doc: MemoryDoc;
  titleTokens: string[];
  bodyTokens: string[];
  termFreq: Map<string, number>;
  length: number;
}

function parseDoc(doc: MemoryDoc): ParsedDoc {
  const titleTokens = tokensOf(doc.title);
  const bodyTokens = tokensOf(doc.text);
  const termFreq = new Map<string, number>();
  for (const token of titleTokens) {
    termFreq.set(token, (termFreq.get(token) ?? 0) + TITLE_WEIGHT);
  }
  for (const token of bodyTokens) {
    termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
  }
  return { doc, titleTokens, bodyTokens, termFreq, length: titleTokens.length + bodyTokens.length };
}

/** Total order: score desc, then newest first, then id asc — deterministic
 * for every tie, so repeated runs and parallel agents see identical output. */
function orderHits(hits: ScoredHit[]): ScoredHit[] {
  return hits.sort((a, b) =>
    b.score - a.score ||
    b.createdAt - a.createdAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function hitFor(parsed: ParsedDoc, score: number, bm25: number, recency: number, matched: string[]): ScoredHit {
  return {
    id: parsed.doc.id,
    kind: parsed.doc.kind,
    title: parsed.doc.title,
    score: round6(score),
    matched,
    components: { bm25: round6(bm25), recency: round6(recency) },
    createdAt: parsed.doc.createdAt,
    provenance: parsed.doc.provenance,
  };
}

/**
 * BM25 over the given corpus.
 *   · empty/whitespace q → "browse": recent-first (createdAt desc, id asc),
 *     every doc eligible, score 0 — the defined empty-q behavior.
 *   · otherwise one pass of idf × (title-weighted tf, length-normalized)
 *     × recency; docs with no matching term never surface.
 * limit: non-integers fall back to DEFAULT_LIMIT, then clamp to [1, MAX_LIMIT].
 */
export function searchDocuments(
  docs: MemoryDoc[],
  query: string,
  options: { limit?: number; now: number },
): SearchResult {
  const requested = Number.isInteger(options.limit) ? options.limit! : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
  const parsed = docs.map(parseDoc);

  if (!query.trim()) {
    const browsable = [...parsed].sort((a, b) =>
      b.doc.createdAt - a.doc.createdAt ||
      (a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0));
    return {
      mode: "browse",
      limit,
      hits: browsable.slice(0, limit).map((entry) =>
        hitFor(entry, 0, 0, recencyFactor(entry.doc.createdAt, options.now), [])),
    };
  }

  const terms = [...new Set(tokensOf(query))];
  if (terms.length === 0 || parsed.length === 0) return { mode: "search", limit, hits: [] };

  const n = parsed.length;
  const avgLength = parsed.reduce((sum, entry) => sum + entry.length, 0) / n || 1;
  const docFrequency = new Map<string, number>();
  for (const entry of parsed) {
    for (const term of entry.termFreq.keys()) {
      docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1);
    }
  }

  const hits: ScoredHit[] = [];
  for (const entry of parsed) {
    let bm25 = 0;
    const matched: string[] = [];
    for (const term of terms) {
      const tf = entry.termFreq.get(term);
      if (!tf) continue;
      matched.push(term);
      const df = docFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const norm = tf + K1 * (1 - B + (B * entry.length) / avgLength);
      bm25 += (idf * tf * (K1 + 1)) / norm;
    }
    if (matched.length === 0) continue;
    const recency = recencyFactor(entry.doc.createdAt, options.now);
    const score = bm25 * recency;
    if (!(score > 0)) continue;
    hits.push(hitFor(entry, score, bm25, recency, matched));
  }
  return { mode: "search", limit, hits: orderHits(hits).slice(0, limit) };
}

// ── the pipeline entry point ────────────────────────────────────────────

export interface SearchMemoryInput {
  botId: string;
  /** The anchored bot's owner (store Bot.ownerId); undefined on desktop. */
  botOwnerId?: string;
  requester: Requester;
  /** From memory-grants.isResourceOwner — retrieval never re-derives it. */
  isOwner: boolean;
  grants: MemoryGrant[];
  q: string;
  limit?: number;
  now: number;
}

export interface MemorySearchResult extends SearchResult {
  /** How access was granted: the owner's own view, or named grant ids. */
  via: "owner" | "desktop" | "grant";
}

/**
 * Build only the corpora this requester may read, then score them.
 * Returns null — the default-deny signal the route renders as "no such
 * bot" — when neither resource kind admits the requester; a granted but
 * empty view still returns hits:[] (the grant exists, the corpus may not).
 * Resource granularity: a read grant on "memory" exposes only memory docs,
 * a "facts" grant only fact docs; the owner sees both.
 */
export function searchMemory(input: SearchMemoryInput): MemorySearchResult | null {
  const allowed = new Set<"memory" | "facts">();
  if (input.isOwner) {
    allowed.add("memory");
    allowed.add("facts");
  } else {
    for (const resource of ["memory", "facts"] as const) {
      const decision = authorizeMemoryAccess({
        botId: input.botId,
        isOwner: false,
        requester: input.requester,
        grants: input.grants,
        resource,
        permission: "read",
        now: input.now,
      });
      if (decision.allowed) allowed.add(resource);
    }
  }
  if (allowed.size === 0) return null;

  const docs: MemoryDoc[] = [];
  if (allowed.has("memory")) docs.push(...botMemoryDocs(input.botId));
  if (allowed.has("facts")) {
    // Owner view resolves through the requester (matches /api/brain/* for
    // the signed-in owner; the desktop session-less caller sees all). The
    // granted view is strictly the anchored bot OWNER's own fact set.
    const owner = input.isOwner
      ? input.botOwnerId ?? (input.requester.kind === "user" ? input.requester.id : undefined)
      : input.botOwnerId;
    docs.push(...brainFactDocs({
      owner,
      view: input.isOwner ? "owner" : "granted",
    }));
  }

  const result = searchDocuments(docs, input.q, { limit: input.limit, now: input.now });
  return {
    ...result,
    via: input.isOwner ? (input.requester.kind === "desktop" ? "desktop" : "owner") : "grant",
  };
}
