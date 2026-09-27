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

/** The correction chain around one fact — the history/rollback surface. */
export interface BrainHistory {
  /** The facts this one corrected, oldest first. */
  ancestors: BrainFact[];
  /** The fact itself, or undefined when it is outside the owner's view. */
  fact: BrainFact | undefined;
  /** The facts that correct this one, in correction order. */
  descendants: BrainFact[];
}

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

/** The closed set of fact kinds, and the single source of truth for it: the
 * schema is built from this list, the writer validates against it, and stats
 * counts against it. Typed `readonly string[]` rather than the narrower union on
 * purpose — the checks that matter here are RUNTIME checks against whatever a
 * file or a request actually contains, and a `FactKind[]` would make the
 * compiler treat them as always-true. */
export const FACT_KINDS: readonly string[] = ["person", "company", "project", "decision", "note"];

const factKindSchema = z.enum(["person", "company", "project", "decision", "note"]);
const factRecordSchema = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  text: z.string().min(1),
  kind: factKindSchema,
  source: z.string().min(1),
  origin: z.string().optional(),
  supersedes: z.string().optional(),
  withdrawnAt: z.number().optional(),
  createdAt: z.number(),
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

/** Why a brain state change could not be made.
 *
 * `not_found` deliberately covers BOTH "no such id" and "not yours": the two
 * must be indistinguishable from outside, or the id becomes an existence
 * oracle across accounts. The state reasons are only ever returned for a fact
 * the caller has already proved they own. */
export type BrainWriteReason = "not_found" | "already_withdrawn" | "not_withdrawn";

export type BrainWriteOutcome = { ok: true } | { ok: false; reason: BrainWriteReason };

export class WorkspaceBrain {
  private facts: BrainFact[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    if (!existsSync(BRAIN_FILE)) return;
    let raw: unknown;
    try {
      raw = parseJson(readFileSync(BRAIN_FILE, "utf8"));
    } catch {
      // A brain file we cannot parse at all must not take the server down. It
      // starts empty, like a fresh install, and — critically — nothing is
      // written until a real fact is added, so the unreadable file survives for
      // triage instead of being replaced by an empty one.
      console.error("[brain] workspace-brain.json is not readable JSON; starting empty and leaving the file in place");
      return;
    }
    // Per-fact, NOT per-file. Validating the whole array at once meant a single
    // malformed record failed every record: `facts` came up empty, and the next
    // persist() overwrote the file with `{facts: []}`. One bad `kind` from one
    // account therefore erased every other account's memory, silently, with no
    // error anywhere. The bad record is dropped and reported; the good ones
    // load.
    const envelope = z.object({ facts: z.array(z.unknown()) }).safeParse(raw);
    if (!envelope.success) {
      console.error("[brain] workspace-brain.json is not a {facts: []} document; starting empty and leaving the file in place");
      return;
    }
    const kept: BrainFact[] = [];
    let dropped = 0;
    for (const candidate of envelope.data.facts) {
      const fact = factRecordSchema.safeParse(candidate);
      if (fact.success) kept.push(fact.data);
      else dropped += 1;
    }
    this.facts = kept;
    if (dropped > 0) {
      // Loud on purpose, and never destructive: the next write drops those
      // records for real, so the operator needs to know it happened.
      console.error(`[brain] dropped ${dropped} unreadable fact record(s) from workspace-brain.json; ${kept.length} kept`);
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
    // The kind is checked HERE, at the write, rather than only when the file is
    // read back. Validating on load alone is what let a bad kind in: the record
    // was accepted with 201, and the damage only appeared at the next restart.
    if (input.kind !== undefined && !FACT_KINDS.includes(input.kind)) {
      throw new Error(`kind must be one of: ${FACT_KINDS.join(", ")}`);
    }
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
      // A correction has to correct SOMETHING. A dangling id was accepted with
      // 201 before, so the caller was told its correction landed while the chain
      // pointed at nothing.
      const old = this.facts.find((f) => f.id === input.supersedes);
      if (!old) throw new Error("supersedes must name a fact that exists.");
      // The reference is kept either way: `history()` already refuses to walk
      // into another owner's chain, so recording it leaks nothing — that is the
      // behaviour server/workspace-brain.test.ts pins.
      fact.supersedes = input.supersedes;
      // But a FOREIGN fact is not retired. Marking it withdrawn was a write to
      // another account's data: Alice could supersede Bob's live fact and make
      // it stop answering his queries, silently, with nothing in his history to
      // explain it. Only the owner may retire their own fact — see withdraw().
      if (old.ownerId === input.ownerId) old.withdrawnAt = Date.now();
    }
    this.facts.push(fact);
    this.trimToCap(input.ownerId);
    this.persist();
    return fact;
  }

  /** Keep the file bounded WITHOUT letting one account delete another's
   * memory.
   *
   * The cap used to be applied to the whole array, so a single busy tenant
   * pushing past 10,000 facts evicted the oldest records in the FILE — which
   * belonged to whoever happened to write first, silently and permanently. The
   * limit is now per owner: the writing account gives up its own oldest records
   * and nobody else's.
   *
   * A desktop install's records carry no ownerId. They are the operator's, and
   * they are trimmed as their own bucket rather than being treated as
   * unowned-and-therefore-cheapest-to-drop. */
  private trimToCap(writingOwnerId: string | undefined): void {
    const owner = writingOwnerId ?? "";
    const own = this.facts.filter((f) => (f.ownerId ?? "") === owner);
    if (own.length <= MAX_FACTS) return;
    // Oldest first: `facts` is append-ordered, so the surplus is a prefix of
    // this owner's own records.
    const surplus = own.slice(0, own.length - MAX_FACTS);
    const drop = new Set(surplus.map((f) => f.id));
    this.facts = this.facts.filter((f) => !drop.has(f.id));
  }

  /** Withdrawal, not deletion — provenance stays queryable via `includingWithdrawn`. */
  /** Withdraw a fact, reporting WHY it could not be done.
   *
   * Three different failures used to collapse into one `false`, and the route
   * turned all three into 404 "no such fact" — so withdrawing a fact twice
   * told the user their own memory did not exist.
   *
   * `not_owner` and `not_found` are deliberately NOT separated: telling a
   * caller that an id exists in another account would make this an existence
   * oracle across accounts, and the route's 404 must not leak. Only the case
   * where the caller demonstrably owns the fact says more — and then it is
   * about the fact's STATE, which they are entitled to know. */
  withdrawOutcome(factId: string, ownerId: string | undefined): BrainWriteOutcome {
    const fact = this.facts.find((f) => f.id === factId);
    if (!fact || fact.ownerId !== ownerId) return { ok: false, reason: "not_found" };
    if (fact.withdrawnAt) return { ok: false, reason: "already_withdrawn" };
    fact.withdrawnAt = Date.now();
    this.persist();
    return { ok: true };
  }

  withdraw(factId: string, ownerId: string | undefined): boolean {
    return this.withdrawOutcome(factId, ownerId).ok;
  }

  /** Restore a withdrawn fact to live. Corrections are not undone by
   * restore: the fact becomes visible again alongside its correction, and
   * the user re-chains with `supersedes` if they truly want to reverse a
   * correction — reverting a chain silently would rewrite provenance. */
  restoreOutcome(factId: string, ownerId: string | undefined): BrainWriteOutcome {
    const fact = this.facts.find((f) => f.id === factId);
    if (!fact || fact.ownerId !== ownerId) return { ok: false, reason: "not_found" };
    if (!fact.withdrawnAt) return { ok: false, reason: "not_withdrawn" };
    delete fact.withdrawnAt;
    this.persist();
    return { ok: true };
  }

  restore(factId: string, ownerId: string | undefined): boolean {
    return this.restoreOutcome(factId, ownerId).ok;
  }

  /** The correction chain of a fact: its full lineage (ancestors, oldest
   * first) and descendants, including itself. Owner-scoped; an id outside
   * the owner's visibility yields an empty chain, never another account's
   * history. */
  history(factId: string, ownerId: string | undefined): BrainHistory {
    const own = (f: BrainFact | undefined): f is BrainFact =>
      !!f && (ownerId === undefined || !f.ownerId || f.ownerId === ownerId);
    const byId = new Map(this.facts.map((f) => [f.id, f]));
    const fact = byId.get(factId);
    if (!own(fact)) return { ancestors: [], fact: undefined, descendants: [] };
    const ancestors: BrainFact[] = [];
    let cursor = fact?.supersedes ? byId.get(fact.supersedes) : undefined;
    while (cursor && own(cursor) && ancestors.length < MAX_FACTS) {
      ancestors.unshift(cursor);
      cursor = cursor.supersedes ? byId.get(cursor.supersedes) : undefined;
    }
    const descendants: BrainFact[] = [];
    const walk = (id: string, depth: number) => {
      if (depth > MAX_FACTS) return;
      for (const f of this.facts) {
        if (f.supersedes === id && own(f)) {
          descendants.push(f);
          walk(f.id, depth + 1);
        }
      }
    };
    if (fact) walk(fact.id, 0);
    return { ancestors, fact, descendants };
  }

  get(factId: string, ownerId: string | undefined): BrainFact | undefined {
    return this.visible(ownerId).find((f) => f.id === factId);
  }

  /** Every fact this owner may see, withdrawn ones included — provenance
   * is the point of the browse surface. A copy: callers read the record,
   * they do not hold a reference into it. */
  list(ownerId: string | undefined): BrainFact[] {
    return [...this.visible(ownerId)];
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
    // Counted by membership, never by indexing with an arbitrary string:
    // `kinds[f.kind] += 1` on an unrecognised kind yields NaN, which serialises
    // to null and reads as a broken counter on the client. A record that slipped
    // past the writer's validation is counted in `facts` and in no bucket.
    for (const f of visible) {
      if (f.withdrawnAt) continue;
      if (FACT_KINDS.includes(f.kind)) kinds[f.kind] += 1;
    }
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
