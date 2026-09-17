// The Muster workspace brain — explicit facts with provenance, withdrawal
// instead of deletion, a zero-LLM entity graph, and keyword retrieval that
// reports what the brain does NOT know (gap analysis).
//
// Shape borrowed from garrytan/gbrain: "stores explicit facts with their
// sources, supports corrections and withdrawal", every page write extracts
// entity refs and creates typed edges with zero LLM calls, and retrieval is
// honest about gaps. What is deliberately NOT taken: the hosted daemon, the
// 24/7 enrichment cron, and semantic vectors — Muster's brain starts keyless
// and local, exactly like gbrain's "start with keyless memory and keyword
// retrieval" rung.
//
// Per-user isolation is structural: every fact carries an ownerId (absent =
// the single desktop user), and every query passes an owner filter. The
// fuzz-test invariant gbrain advertises — "you only see what you're allowed
// to see" — is pinned in workspace-brain.test.ts.
//
// Pure module plus atomic file persistence; no LLM calls anywhere.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { parseJson } from "./schema.ts";

// ── schema ──────────────────────────────────────────────────────────────

export type FactKind = "person" | "company" | "project" | "decision" | "note";

export interface BrainFact {
  id: string;
  ownerId?: string;
  /** The explicit statement, one sentence, self-contained. */
  text: string;
  kind: FactKind;
  /** Where this came from — a bot, a task, a human note. Never empty. */
  source: string;
  /** Bot id or thread the fact was learned in, when known. */
  origin?: string;
  /** gbrain's correction chain: supersedes points at the fact this replaces. */
  supersedes?: string;
  /** Withdrawn facts stay forever (provenance), but never answer queries. */
  withdrawnAt?: number;
  createdAt: number;
}

/** Typed edge between entity refs — zero LLM calls, extracted on write. */
export interface BrainEdge {
  from: string;
  to: string;
  kind: "mentions" | "works_at" | "part_of" | "about" | "supersedes";
}

export interface BrainQueryHit {
  fact: BrainFact;
  /** Which query words matched, for evidence-citing output. */
  matched: string[];
  score: number;
}

export interface BrainQuery {
  hits: BrainQueryHit[];
  /** gbrain's gap analysis: what the brain does NOT know yet. */
  gaps: string[];
  /** Entity refs seen in the query that the brain has no facts about. */
  unknownEntities: string[];
}

// ── persistence ─────────────────────────────────────────────────────────

const BRAIN_FILE = join(DATA_DIR, "workspace-brain.json");
const MAX_FACTS = 10_000;

const factKindSchema = z.enum(["person", "company", "project", "decision", "note"]);
const brainFileSchema = z.object({
  facts: z.array(z.object({
    id: z.string(),
    ownerId: z.string().optional(),
    text: z.string().min(1),
    kind: factKindSchema,
    source: z.string().min(1),
    origin: z.string().optional(),
    supersedes: z.string().optional(),
    withdrawnAt: z.number().optional(),
    createdAt: z.number(),
  })),
});

// ── zero-LLM entity extraction ──────────────────────────────────────────

const KIND_PREFIX: Array<[RegExp, FactKind]> = [
  [/\b(?:ceo|cto|founder|engineer|designer|manager|president|intern)\b/i, "person"],
  [/\b(?:inc|llc|corp|labs|ai)\b\.?$/i, "company"],
  [/\b(?:project|repo|release|migration|deploy)\b/i, "project"],
  [/\b(?:decided|approved|chose|rejected|postponed)\b/i, "decision"],
];

/** Cheap, deterministic kind guess — overridden by the caller's explicit kind. */
function guessKind(text: string): FactKind {
  for (const [re, kind] of KIND_PREFIX) if (re.test(text)) return kind;
  return "note";
}

const TOKEN_SPLIT = /[^a-z0-9@._+-]+/;

/** Compact stopword set: function words that would otherwise dominate
 * single-token matches and bury the evidence. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over",
  "under", "then", "than", "them", "they", "their", "there", "here",
  "have", "has", "had", "was", "were", "will", "would", "could",
  "should", "shall", "can", "may", "might", "must", "does", "did",
  "done", "been", "being", "are", "our", "your", "his", "her", "its",
  "about", "after", "before", "between", "both", "each", "some", "such",
  "only", "own", "same", "too", "very", "just", "also", "who", "what",
  "when", "where", "why", "how", "did", "yet", "not", "but", "all",
  "any", "out", "off", "per", "via", "was",
]);

export function tokenize(text: string): string[] {
  return [...new Set(
    text.toLowerCase()
      .split(TOKEN_SPLIT)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  )];
}

/** Entity refs: capitalized multiword names, emails, and @handles.
 * Zero LLM — the same rung gbrain starts at. */
export function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)) entities.add(m[1]);
  for (const m of text.matchAll(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g)) entities.add(m[0]);
  for (const m of text.matchAll(/(?:^|\s)@([A-Za-z0-9_-]{2,})/g)) entities.add(`@${m[1]}`);
  return [...entities];
}

// ── the brain ───────────────────────────────────────────────────────────

export interface AddFactInput {
  text: string;
  kind?: FactKind;
  source: string;
  origin?: string;
  ownerId?: string;
  /** gbrain's correction chain: the fact this one replaces. */
  supersedes?: string;
}

export class WorkspaceBrain {
  private facts: BrainFact[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    if (!existsSync(BRAIN_FILE)) return;
    try {
      const parsed = brainFileSchema.safeParse(parseJson(readFileSync(BRAIN_FILE, "utf8")));
      if (parsed.success) this.facts = parsed.data.facts;
    } catch {
      // A corrupt brain file must not take the server down; it just starts
      // empty, like a fresh install. The file is left untouched for triage.
    }
  }

  private persist(): void {
    writeFileAtomic(BRAIN_FILE, JSON.stringify({ facts: this.facts }, null, 2));
  }

  private visible(ownerId: string | undefined): BrainFact[] {
    if (!ownerId) return this.facts; // desktop: one implicit user sees all
    return this.facts.filter((f) => !f.ownerId || f.ownerId === ownerId);
  }

  /** Record a fact. `supersedes` chains a correction; the old fact is kept
   * for provenance but stops answering queries. */
  add(input: AddFactInput): BrainFact {
    const text = input.text.trim();
    if (!text) throw new Error("Fact text is required.");
    if (!input.source.trim()) throw new Error("A fact needs a source (provenance).");
    const fact: BrainFact = {
      id: newId(),
      text,
      kind: input.kind ?? guessKind(text),
      source: input.source.trim(),
      createdAt: Date.now(),
    };
    if (input.ownerId) fact.ownerId = input.ownerId;
    if (input.origin) fact.origin = input.origin;
    if (input.supersedes) {
      fact.supersedes = input.supersedes;
      const old = this.facts.find((f) => f.id === input.supersedes);
      if (old) old.withdrawnAt = Date.now();
    }
    this.facts.push(fact);
    if (this.facts.length > MAX_FACTS) {
      this.facts = this.facts.slice(this.facts.length - MAX_FACTS);
    }
    this.persist();
    return fact;
  }

  /** Withdrawal, not deletion — provenance stays queryable via `includingWithdrawn`. */
  withdraw(factId: string, ownerId: string | undefined): boolean {
    const fact = this.facts.find((f) => f.id === factId);
    if (!fact || fact.ownerId !== ownerId || fact.withdrawnAt) return false;
    fact.withdrawnAt = Date.now();
    this.persist();
    return true;
  }

  get(factId: string, ownerId: string | undefined): BrainFact | undefined {
    return this.visible(ownerId).find((f) => f.id === factId);
  }

  /** Typed edges for a fact's entity refs. Built on read from the facts
   * themselves, so the graph can never disagree with the record. */
  edges(fact: BrainFact): BrainEdge[] {
    const refs = extractEntities(fact.text);
    const edges: BrainEdge[] = refs.map((r) => ({ from: fact.id, to: r, kind: "mentions" }));
    if (fact.kind === "person" && fact.ownerId) {
      for (const r of refs) if (r !== fact.source) edges.push({ from: fact.source, to: r, kind: "works_at" });
    }
    if (fact.supersedes) edges.push({ from: fact.id, to: fact.supersedes, kind: "supersedes" });
    return edges;
  }

  /** Keyword retrieval with evidence and gap analysis. Withdrawn facts
   * never hit unless explicitly asked for (provenance audits). */
  query(text: string, ownerId: string | undefined, opts?: { limit?: number; includingWithdrawn?: boolean }): BrainQuery {
    const qTokens = tokenize(text);
    const queryEntities = extractEntities(text);
    const pool = this.visible(ownerId)
      .filter((f) => (opts?.includingWithdrawn ? true : !f.withdrawnAt));
    const scored = pool
      .map((fact) => {
        const fTokens = new Set(tokenize(`${fact.text} ${fact.kind} ${fact.source}`));
        const matched = qTokens.filter((t) => fTokens.has(t));
        return { fact, matched, score: matched.length };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.fact.createdAt - a.fact.createdAt);

    const limit = Math.min(Math.max(opts?.limit ?? 8, 1), 50);
    const hits = scored.slice(0, limit);
    const knownEntities = new Set(pool.flatMap((f) => extractEntities(f.text)));
    const unknownEntities = queryEntities.filter((e) => !knownEntities.has(e));

    const gaps: string[] = [];
    if (!hits.length) {
      gaps.push(`Nothing in the brain matches "${text.trim()}". Record it with brain_write when you learn it.`);
    }
    for (const e of unknownEntities) {
      gaps.push(`No facts mention ${e} yet.`);
    }
    if (hits.length && hits[0].score <= 1) {
      gaps.push("Only weak matches found — consider confirming with the source before acting on this.");
    }
    return { hits, gaps, unknownEntities };
  }

  stats(ownerId: string | undefined) {
    const visible = this.visible(ownerId);
    const kinds = { person: 0, company: 0, project: 0, decision: 0, note: 0 };
    for (const f of visible) if (!f.withdrawnAt) kinds[f.kind] += 1;
    return {
      facts: visible.filter((f) => !f.withdrawnAt).length,
      withdrawn: visible.length - visible.filter((f) => !f.withdrawnAt).length,
      kinds,
    };
  }
}

/** Singleton: the brain is workspace-wide and file-backed, one owner. */
let singleton: WorkspaceBrain | undefined;
export function workspaceBrain(): WorkspaceBrain {
  if (!singleton) singleton = new WorkspaceBrain();
  return singleton;
}

/** Test seam: drop the singleton so a temp DATA_DIR is honored. */
export function resetWorkspaceBrain(): void {
  singleton = undefined;
}
