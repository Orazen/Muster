// Privacy Shield — what leaves for a cloud model, reviewed before it goes.
//
// What.
// A deterministic, dependency-free scrubber that rewrites personally-
// identifying and credential-shaped spans of a prompt into stable,
 // numbered placeholders ([EMAIL_1], [PHONE_2], [SECRET_1]) before the text
// is handed to a cloud-hosted model. The mapping is NOT reversed: the model
// answers about "[EMAIL_1]" naturally, and nothing reversible ever leaves
// the machine.
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
 * pass actually masked (phone guards can reject matches). */
type MaskPass = { text: string; count: number };

/** Replace each match with kind_N, numbered in order of appearance. The
 * same input always produces the same numbering within one call. */
function maskMatches(text: string, regex: RegExp, kind: string): MaskPass {
  let n = 0;
  const out = text.replace(regex, (match) => {
    // Phone guard: at least 10 digits, else it's a date/version/issue id.
    if (kind === "phone" && digitCount(match) < 10) return match;
    n += 1;
    return `[${kind.toUpperCase()}_${n}]`;
  });
  const pass: MaskPass = { text: out, count: n };
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
  return { text: phonePass.text, findings };
}
