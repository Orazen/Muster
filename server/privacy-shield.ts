// Privacy Shield — what leaves for a cloud model, reviewed before it goes.
//
// What.
// A deterministic, dependency-free scrubber that rewrites personally-
// identifying and credential-shaped spans of a prompt into stable,
// numbered placeholders ([EMAIL_1], [PHONE_2], [SECRET_1]) before the text
// is handed to a cloud-hosted model. V2 adds the reverse direction: PII
// pairs are remembered per session IN HARNESS MEMORY ONLY, so a bot reply
// that echoes "[EMAIL_1]" is un-scrubbed back to the real value before the
// message is persisted to the local transcript. The cloud model saw
// tokens; the human reads real values. Nothing reversible ever leaves the
// machine — the reverse map lives and dies in this process.
//
// Why.
// Osaurus made on-device PII filtering a headline feature; Muster's users
// have their prompts relayed through cloud providers where the prompt IS the
// product. The credential half of this problem already exists here —
// server/redact.ts keeps secrets out of transcripts and native logs — so
// this module reuses those exact patterns (one implementation, one set of
// false-positive lessons) and adds the PII classes a cloud round-trip
// actually exposes: emails and phone numbers. Deliberately conservative:
// a missed name is better than mangling code, and every finding is counted
// so the UI can say exactly what was masked.

import { redactSecretsInText } from "./redact.ts";

/** One placeholder↔original pair produced by a masking pass. Originals
 * exist ONLY to restore values in replies on the harness machine; callers
 * must keep them in memory (see rememberScrub) and never persist or send
 * them anywhere. */
export type ShieldMapping = {
  /** The exact bracket token written into the outbound text. */
  placeholder: string;
  /** The raw span that was replaced. Never logged, never stored. */
  original: string;
};

export type ShieldFinding = {
  /** Stable placeholder kind written into the prompt. */
  kind: "email" | "phone" | "secret";
  /** How many distinct spans of this kind were masked. */
  count: number;
};

export type ShieldResult = {
  /** The rewritten prompt — safe to hand to any cloud driver. */
  text: string;
  findings: ShieldFinding[];
  /** Placeholder→original pairs for the PII classes (emails, phones).
   * Deliberately EXCLUDES secrets: redactSecretsInText destroys the raw
   * value before the shield sees it, so [SECRET_n] is one-way by
   * construction — masked for the model AND for the transcript. */
  mappings?: ShieldMapping[];
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Phone shapes worth masking, as one alternation so numbering stays
 * sequential: international (+cc groups…), US paren display, and bare
 * US-style triples. Every branch needs enough digits that a date, version,
 * or issue number can never match — the digit-count floor below enforces
 * it a second time for international forms. */
const PHONE =
  /\+\d{1,3}[- .](?:\d{2,4}[- .]){1,3}\d{3,4}|\(\d{3}\)[- .]\d{3}[- .]\d{4}|\b\d{3}[- .]\d{3}[- .]\d{4}\b/g;

function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

/** One masking pass over a prompt: rewritten text plus how many spans the
 * pass actually masked (phone guards can reject matches), and the
 * placeholder→original pairs it produced for the reverse map. */
type MaskPass = { text: string; count: number; pairs: ShieldMapping[] };

/** Replace each match with kind_N, numbered in order of appearance. The
 * same input always produces the same numbering within one call. */
function maskMatches(text: string, regex: RegExp, kind: string): MaskPass {
  let n = 0;
  const pairs: ShieldMapping[] = [];
  const out = text.replace(regex, (match) => {
    // Phone guard: at least 10 digits, else it's a date/version/issue id.
    if (kind === "phone" && digitCount(match) < 10) return match;
    n += 1;
    const placeholder = `[${kind.toUpperCase()}_${n}]`;
    pairs.push({ placeholder, original: match });
    return placeholder;
  });
  const pass: MaskPass = { text: out, count: n, pairs };
  return pass;
}

/** Scrub one prompt (or transcript entry) for cloud delivery. Credential
 * shapes go first and land under SECRET_, then PII classes. Findings report
 * only kinds with at least one match, ordered secret-first (worst). */
export function scrubForCloud(text: string): ShieldResult {
  if (!text || text.length < 8) return { text, findings: [] };

  // Pass 1: credentials via the exact patterns transcripts already trust.
  // redactSecretsInText writes «redacted N chars» masks; renumber those
  // into the shield's bracket form so the model never sees non-ASCII noise.
  let secretCount = 0;
  const withSecrets = redactSecretsInText(text).replace(/«redacted (\d+) chars»/g, () => {
    secretCount += 1;
    return `[SECRET_${secretCount}]`;
  });

  const emailPass = maskMatches(withSecrets, EMAIL, "email");
  const phonePass = maskMatches(emailPass.text, PHONE, "phone");

  const findings: ShieldFinding[] = [];
  if (secretCount > 0) findings.push({ kind: "secret", count: secretCount });
  if (emailPass.count > 0) findings.push({ kind: "email", count: emailPass.count });
  if (phonePass.count > 0) findings.push({ kind: "phone", count: phonePass.count });
  return { text: phonePass.text, findings, mappings: [...emailPass.pairs, ...phonePass.pairs] };
}

// ── v2: un-scrub on reply (the session reverse map) ───────────────────
// What.
// While dispatching, every scrub result is recorded under a
// botId+threadId session key. When the bot's streamed reply comes back
// carrying placeholders, `unscrubText` restores the originals BEFORE the
// assistant message is appended to the local transcript. The map lives
// only in this process on the harness machine — never on disk, never in
// any payload — so the original privacy property holds: nothing
// reversible crosses the network boundary.
//
// Why bounded + LRU.
// Long-lived threads could otherwise grow the map forever. 200 pairs per
// session and 32 live sessions keep the footprint flat; the least
// recently touched entries (and whole sessions) fall off first. A pair
// that fell off simply stops restoring — the reply keeps its placeholder,
// which is exactly today's behavior.
//
// Known limitation, accepted deliberately: placeholder numbering restarts
// per scrub call, so [EMAIL_1] from turn 3 and [EMAIL_1] from turn 7 may
// name different people. Later recordings win (most recent mention), and
// the current turn is recorded last so its pairs win every tie — a reply
// almost always refers to what the latest prompt discussed.

/** Placeholder→original pairs kept per session, hard cap per the v2 spec. */
export const SHIELD_SESSION_LIMIT = 200;
/** Whole-session cap so dead threads cannot accumulate maps forever. */
const SHIELD_MAX_SESSIONS = 32;

/** sessionId → placeholder→original. Insertion order IS recency: Map
 * keys re-inserted after a delete move to the end, giving O(1) LRU
 * without bookkeeping objects. */
const sessions = new Map<string, Map<string, string>>();

/** Stable key joining a bot to one conversation thread. */
export function shieldSessionKey(botId: string, threadId: string): string {
  return `${botId}:${threadId}`;
}

/** Move an existing key to the tail of a Map-as-LRU (no-op if absent). */
function bumpRecency(map: Map<string, unknown>, key: string): void {
  const value = map.get(key);
  if (value === undefined) return;
  map.delete(key);
  map.set(key, value);
}

/** Record every pair a scrub produced into the session's reverse map.
 * Called from the dispatch path for the current turn (last — wins ties)
 * and for each replayed history entry. Pure metadata: no side effects
 * beyond the in-memory map. */
export function rememberScrub(sessionKey: string, scan: ShieldResult): void {
  if (!scan.mappings || scan.mappings.length === 0) return;
  let entries = sessions.get(sessionKey);
  if (!entries) {
    entries = new Map<string, string>();
    // whole-session LRU: the coldest session dies to make room
    while (sessions.size >= SHIELD_MAX_SESSIONS) {
      const oldest = sessions.keys().next();
      // SAFETY: size >= SHIELD_MAX_SESSIONS (> 0) guarantees a first key
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
    sessions.set(sessionKey, entries);
  } else {
    bumpRecency(sessions, sessionKey);
  }
  for (const pair of scan.mappings) {
    // delete+set both updates the value and bumps recency
    entries.delete(pair.placeholder);
    entries.set(pair.placeholder, pair.original);
  }
  while (entries.size > SHIELD_SESSION_LIMIT) {
    const oldest = entries.keys().next();
    // SAFETY: size > SHIELD_SESSION_LIMIT (> 0) guarantees a first key
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** Restore originals for any placeholder the session knows about. Unknown
 * tokens (hallucinated, evicted, or another session's) pass through
 * untouched; text with no hits is returned as the SAME string, so
 * unprotected bots are byte-for-byte unaffected. */
export function unscrubText(sessionKey: string, text: string): string {
  const entries = sessions.get(sessionKey);
  if (!entries || !text || !text.includes("[")) return text;
  let touched = false;
  const out = text.replace(/\[(?:EMAIL|PHONE|SECRET)_\d+\]/g, (token) => {
    const original = entries.get(token);
    if (original === undefined) return token;
    touched = true;
    return original;
  });
  return touched ? out : text;
}

/** Drop a session's reverse map. Called on thread rewind/edit-fork: the
 * abandoned branch's pairs belong to a dead conversation, and keeping
 * them would risk restoring stale values into a new fork. */
export function forgetShieldSession(sessionKey: string): void {
  sessions.delete(sessionKey);
}

// ── v2: classifier seam (layer 2 of a two-layer filter) ──────────────
// What.
// An optional second pass that runs AFTER the deterministic scrubber and
// may report additional spans to mask. No runtime caller wires one yet —
// this is the seam for a future ON-DEVICE classifier (an embedded model
// that catches shapes regexes cannot, like person names or unusual key
// formats). Osaurus ships exactly this two-layer filter — fast
// deterministic rules first, a learned filter second — as prior art.
//
// Why after the deterministic pass.
// Layer 1 is trusted and cheap; layer 2 is probabilistic and slower. The
// classifier therefore sees ALREADY-SCRUBBED text: it can never receive a
// raw span layer 1 caught, its findings can be deduped against layer 1's
// recorded originals by value, and a broken or hung classifier degrades
// to today's behavior without leaking anything extra.

export type ClassifierKind = "secret" | "email" | "phone";

export type ClassifierFinding = {
  /** Which placeholder class the value belongs under. */
  kind: ClassifierKind;
  /** The raw span to mask, matched literally. */
  value: string;
};

export type ShieldClassifier = (text: string) => Promise<ClassifierFinding[]>;

let activeClassifier: ShieldClassifier | undefined;

/** Install (fn) or remove (no argument) the layer-2 classifier. Default
 * is undefined — pure layer-1 behavior, byte-identical to v1. */
export function configureClassifier(fn?: ShieldClassifier): void {
  activeClassifier = fn;
}

/** Literal-safe RegExp source for a raw value. */
function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Findings are untrusted runtime data behind a typed seam: coerce the
 * value through a template so junk degrades to "" instead of throwing. */
function normalizedValue(finding: ClassifierFinding): string {
  return `${finding?.value ?? ""}`.trim();
}

function isValidKind(kind: ClassifierKind): boolean {
  return kind === "secret" || kind === "email" || kind === "phone";
}

function findingCount(findings: ShieldFinding[], kind: ClassifierKind): number {
  const hit = findings.find((f) => f.kind === kind);
  return hit ? hit.count : 0;
}

/** Dispatch-facing scrub: layer 1 always, layer 2 when configured. With
 * no classifier installed this returns scrubForCloud's result unchanged. */
export async function scrubOutbound(text: string): Promise<ShieldResult> {
  const base = scrubForCloud(text);
  const fn = activeClassifier;
  if (!fn) return base;

  let found: ClassifierFinding[] = [];
  try {
    const reported = await fn(base.text);
    if (Array.isArray(reported)) found = reported;
  } catch {
    found = []; // a failing classifier degrades to layer 1, never blocks the turn
  }

  // Dedupe by value: within layer 2's own output, and defensively against
  // anything layer 1 already masked (possible if a future classifier runs
  // on raw text).
  const covered = new Set<string>();
  for (const mapping of base.mappings ?? []) covered.add(mapping.original);
  const seenValues = new Set<string>();

  let working = base.text;
  const pairs: ShieldMapping[] = [];
  let addedSecrets = 0;
  let addedEmails = 0;
  let addedPhones = 0;

  for (const finding of found) {
    const value = normalizedValue(finding);
    if (!value) continue;
    const kind = finding?.kind;
    if (!isValidKind(kind)) continue;
    if (covered.has(value) || seenValues.has(value)) continue;
    seenValues.add(value);
    // Numbering CONTINUES layer 1's per-kind sequence so the reply-side
    // reverse map stays collision-free within one dispatch.
    const start = findingCount(base.findings, kind);
    let counter = start;
    const tag = kind.toUpperCase();
    const pattern = new RegExp(escapeRegExp(value), "g");
    working = working.replace(pattern, () => {
      counter += 1;
      const placeholder = `[${tag}_${counter}]`;
      pairs.push({ placeholder, original: value });
      return placeholder;
    });
    const added = counter - start;
    if (added === 0) continue; // value absent — stale echo, nothing merged
    if (kind === "secret") addedSecrets += added;
    else if (kind === "email") addedEmails += added;
    else addedPhones += added;
  }

  if (pairs.length === 0) return base;

  // Canonical secret-first order, matching scrubForCloud's findings shape.
  const mergedFindings: ShieldFinding[] = [];
  const totalSecrets = findingCount(base.findings, "secret") + addedSecrets;
  const totalEmails = findingCount(base.findings, "email") + addedEmails;
  const totalPhones = findingCount(base.findings, "phone") + addedPhones;
  if (totalSecrets > 0) mergedFindings.push({ kind: "secret", count: totalSecrets });
  if (totalEmails > 0) mergedFindings.push({ kind: "email", count: totalEmails });
  if (totalPhones > 0) mergedFindings.push({ kind: "phone", count: totalPhones });

  const merged: ShieldResult = {
    text: working,
    findings: mergedFindings,
    mappings: [...(base.mappings ?? []), ...pairs],
  };
  return merged;
}
