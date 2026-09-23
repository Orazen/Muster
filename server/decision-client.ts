// The decision seam: rules-only by default, suggestion-grade model behind env.
//
// Both studies converged on this exact Slice 0 —
// docs/plans/jev-decision-model-study.md §5 S1 and
// docs/plans/laya-decision-engine-study.md §5 slice 1 — so a future provider
// (hosted Jev or a remote Laya endpoint) can be plugged in behind one env
// var later without touching any call site.
//
// The contract, restated from the studies:
//   - The model path may suggest, route, score, triage or flag — it never
//     decides. `DecisionSuggestion` carries the literal `kind: "suggestion"`
//     so a model outcome cannot be read as a verdict at the type level.
//   - Every failure — unset env, malformed endpoint, rejected request,
//     network error, non-2xx response, malformed payload, or any answer
//     under the confidence floor — fails OPEN to the caller's `rules`
//     value, returned by reference, byte-identical to what today's code
//     would use. With no env set, this module behaves exactly like today.
//   - Nothing here is wired anywhere: this slice ships the seam and its
//     tests only, and the module must stay out of auto-approve verdicts,
//     memory-grant paths and any other authority-bearing call site.
//   - Configuration is env only: MUSTER_DECISION_URL (a remote endpoint),
//     MUSTER_DECISION_TOKEN (its optional bearer) and TYPESAFE_API_KEY (the
//     hosted Jev equivalent). No credential literal ever appears here, and
//     an outcome never echoes a credential back.
//   - Outbound bytes are redacted through server/redact.ts first, and
//     `requestHash` anchors the audit log to exactly those bytes (state,
//     question schema and option order all travel inside them).
import { createHash } from "node:crypto";

import { z } from "zod";

import { redactSecrets } from "./redact.ts";
import { parseJson, schemaIssue, type JsonValue } from "./schema.ts";

/** Inline triage gets a hard budget well under a second (the Jev study's
 * rules-never-wait guidance): a slow provider must degrade to rules fast. */
export const DEFAULT_TIMEOUT_MS = 750;
/** Any answer whose effective confidence lands below this floor sends the
 * whole call back to the caller's rules (the studies' fail-open ladder). */
export const DEFAULT_MIN_CONFIDENCE = 0.5;
/** Jev documents a 255-option cap per choice question; Laya's own ceiling
 * guidance is lower still. Over the cap, fail open to rules rather than
 * silently truncating anyone's options. */
export const MAX_OPTIONS_PER_QUESTION = 255;
/** A one-option choice or two-level-less rubric is a caller bug; sending it
 * would only produce a confidently wrong pick. */
export const MIN_OPTIONS_PER_QUESTION = 2;

/** Hosted Jev System One endpoint (TypeSafe docs) — a URL, not a credential. */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** The model id the Jev study verified in the vendor's docs. */
export const JEV_MODEL = "jev-latest";

/** Why the caller's rules were used instead of a model suggestion. Only
 * produced here; never produced by a provider. */
export type RulesReason =
  | "unset"
  | "bad-endpoint"
  | "bad-request"
  | "network"
  | "http"
  | "malformed"
  | "low-confidence";

/** The failure half of a stage: the reason the caller's rules were used
 * instead of a model suggestion. A named contract so every return site
 * keeps that evidence rather than re-declaring it anonymously. */
export interface StageFailure {
  ok: false;
  reason: RulesReason;
}

/** Internal staging result: every step either yields its value or the
 * reason it fell back. `decide` never throws. */
export type Stage<T> = { ok: true; value: T } | StageFailure;

const questionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const labelList = z.array(z.string().min(1));

const questionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), instructions: z.string().min(1) }),
  z.object({
    type: z.literal("choice"),
    instructions: z.string().min(1),
    criteria: z.union([labelList, z.record(z.string().min(1), z.string().min(1))]),
  }),
  z.object({ type: z.literal("score"), instructions: z.string().min(1), criteria: labelList }),
]);

const questionsSchema = z
  .record(questionId, questionSchema)
  .refine((map) => Object.keys(map).length > 0, {
    message: "at least one question is required",
  });

const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability);

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability, confidence: probability.optional() }),
  z.object({
    type: z.literal("choice"),
    choice: z.string().min(1),
    probabilities,
    confidence: probability,
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities,
    confidence: probability,
  }),
]);

const responseSchema = z.object({
  answers: z.record(z.string(), answerSchema),
  model: z.string().optional(),
});

const stateSchema = z.json();

/** One typed question as callers write it (noul carries instructions only). */
export type DecisionQuestion = z.infer<typeof questionSchema>;
/** The question map sent in one round trip; all questions run independently. */
export type DecisionQuestions = z.infer<typeof questionsSchema>;
/** One provider answer, validated before a caller ever sees it. */
export type DecisionAnswer = z.infer<typeof answerSchema>;
/** Answers keyed by the caller's own question ids. */
export type DecisionAnswers = Record<string, DecisionAnswer>;

/** Validated response half: the answers plus the provider-reported model. */
export interface DecisionParse {
  answers: DecisionAnswers;
  model?: string;
}

/** Where a resolved transport sends questions — chosen ONLY by env. */
export interface DecisionTransport {
  provider: "remote" | "jev";
  url: string;
  headers: Headers;
  /** Body model id (Jev requires one; remote endpoints may omit it). */
  model?: string;
}

/** The exact outbound request: the bytes that leave the process and the
 * hash that anchors them in an audit log. */
export interface DecisionRequest {
  /** The questions as sent (normalized and redacted) — answers are
   * validated against these, not against the caller's original map. */
  questions: DecisionQuestions;
  /** Exactly the bytes POSTed. */
  text: string;
  /** sha-256 hex of `text`. */
  requestHash: string;
}

/** Suggestion-grade only: evidence a human or the caller's rules review —
 * never a decision. `kind` is a literal on purpose. */
export interface DecisionSuggestion {
  kind: "suggestion";
  answers: DecisionAnswers;
  requestHash: string;
  latencyMs: number;
  /** Provider-reported model id, falling back to the transport's. */
  model?: string;
}

/** The seam's result: either a suggestion to display beside the caller's
 * rules, or the caller's rules themselves (with the reason they were used). */
export type DecisionOutcome<T> =
  | { source: "model"; suggestion: DecisionSuggestion }
  | { source: "rules"; result: T; reason: RulesReason; note?: string };

export interface DecideOptions<T> {
  /** The caller's current deterministic result — returned untouched on
   * every fail-open path. This is what "byte-identical to today" means. */
  rules: T;
  /** Env to read; defaults to process.env. Tests inject a fixed map. */
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch — tests and the harness never touch the network. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  minConfidence?: number;
}

function stageFail(reason: RulesReason): StageFailure {
  return { ok: false, reason };
}

/** Run a synchronous stage, mapping any throw to its fail-open reason. */
function attempt<T>(run: () => T, reason: RulesReason): Stage<T> {
  try {
    return { ok: true, value: run() };
  } catch {
    return stageFail(reason);
  }
}

/** The async twin of `attempt`. */
async function attemptAsync<T>(run: () => Promise<T>, reason: RulesReason): Promise<Stage<T>> {
  try {
    return { ok: true, value: await run() };
  } catch {
    return stageFail(reason);
  }
}

/** Only http(s) URLs are usable as an endpoint; anything else is a
 * configured-but-broken endpoint, not an unset one. */
function parseHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Resolve the transport from env. Precedence: MUSTER_DECISION_URL (remote
 * endpoint, Laya study option b) over TYPESAFE_API_KEY (hosted Jev, Jev
 * study §3.2). Reasons are only "unset" (no env → today's behavior) or
 * "bad-endpoint" (env set but unusable → fail open to rules).
 */
export function decisionTransport(env: NodeJS.ProcessEnv): Stage<DecisionTransport> {
  const remote = env.MUSTER_DECISION_URL?.trim();
  if (remote !== undefined && remote !== "") {
    const url = parseHttpUrl(remote);
    if (url === null) return stageFail("bad-endpoint");
    const headers = new Headers({ "content-type": "application/json" });
    const token = env.MUSTER_DECISION_TOKEN?.trim();
    if (token !== undefined && token !== "") headers.set("authorization", `Bearer ${token}`);
    return { ok: true, value: { provider: "remote", url, headers } };
  }
  const key = env.TYPESAFE_API_KEY?.trim();
  if (key !== undefined && key !== "") {
    const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${key}` });
    return { ok: true, value: { provider: "jev", url: JEV_ENDPOINT, headers, model: JEV_MODEL } };
  }
  return stageFail("unset");
}

const dedupeLabels = (labels: string[]): string[] => [...new Set(labels)];

/** Distinct options: array items for list criteria, keys for map criteria. */
function optionCount(criteria: string[] | Record<string, string>): number {
  return Array.isArray(criteria) ? new Set(criteria).size : Object.keys(criteria).length;
}

/** Duplicate options make a first-key tie-break look like discrimination (a
 * measured field note in the Jev study) — send each label exactly once. */
function normalizeQuestions(questions: DecisionQuestions): DecisionQuestions {
  const normalized: DecisionQuestions = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      normalized[id] = question;
    } else if (question.type === "score") {
      normalized[id] = { ...question, criteria: dedupeLabels(question.criteria) };
    } else if (Array.isArray(question.criteria)) {
      normalized[id] = { ...question, criteria: dedupeLabels(question.criteria) };
    } else {
      normalized[id] = question;
    }
  }
  return normalized;
}

function assertOptionCounts(questions: DecisionQuestions): void {
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") continue;
    const count = optionCount(question.criteria);
    if (count < MIN_OPTIONS_PER_QUESTION || count > MAX_OPTIONS_PER_QUESTION) {
      throw new Error(
        `question "${id}" needs ${MIN_OPTIONS_PER_QUESTION}-${MAX_OPTIONS_PER_QUESTION} distinct options, got ${count}`,
      );
    }
  }
}

interface DecisionPayload {
  state: JsonValue;
  questions: DecisionQuestions;
  model?: string;
}

/**
 * Pure request builder (the Jev study's S1): validates the question map,
 * normalizes option lists, redacts everything outbound, and returns the
 * exact bytes plus their audit hash. Throws only on caller-bad input —
 * `decide` maps that to the "bad-request" fail-open reason.
 */
export function buildDecisionRequest(
  state: JsonValue,
  questions: DecisionQuestions,
  model?: string,
): DecisionRequest {
  const cleanState = stateSchema.parse(state);
  const cleanQuestions = questionsSchema.parse(questions);
  const normalized = normalizeQuestions(cleanQuestions);
  assertOptionCounts(normalized);
  // Everything outbound is redacted first: a remote provider sees the
  // shape of the state with credential values masked (server/redact.ts).
  const payload: DecisionPayload = {
    state: redactSecrets(cleanState),
    questions: redactSecrets(normalized),
  };
  if (model !== undefined) payload.model = model;
  const text = JSON.stringify(payload);
  return {
    questions: payload.questions,
    text,
    requestHash: createHash("sha256").update(text).digest("hex"),
  };
}

/**
 * Pure response validator (the Jev study's S1, TipTour's validator as the
 * reference): every requested question must be answered, the answer's type
 * must match the question, and a choice must name one of the criteria as
 * sent. Probabilities are read BY KEY (providers return them shuffled) and
 * range-checked by the schema. Extra ids are dropped, not trusted.
 * Throws on anything malformed — `decide` maps that to "malformed".
 */
export function parseDecisionAnswers(
  payload: JsonValue,
  questions: DecisionQuestions,
): DecisionParse {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "Malformed decision response"));
  const answers: DecisionAnswers = {};
  for (const [id, question] of Object.entries(questions)) {
    if (!Object.hasOwn(parsed.data.answers, id)) {
      throw new Error(`decision response has no answer for "${id}"`);
    }
    const answer = parsed.data.answers[id];
    if (answer.type !== question.type) {
      throw new Error(`answer "${id}" is ${answer.type}; the question asked ${question.type}`);
    }
    if (answer.type === "choice" && question.type === "choice") {
      const labels = Array.isArray(question.criteria) ? question.criteria : Object.keys(question.criteria);
      if (!labels.includes(answer.choice)) {
        throw new Error(`answer "${id}" names "${answer.choice}", outside its criteria`);
      }
    }
    answers[id] = answer;
  }
  const model = parsed.data.model;
  return model === undefined ? { answers } : { answers, model };
}

/** The confidence a floor check should read. Jev's noul carries no separate
 * confidence — for it, the peak probability IS the signal. */
function effectiveConfidence(answer: DecisionAnswer): number {
  if (answer.type !== "noul") return answer.confidence;
  return answer.confidence ?? Math.max(answer.noul, 1 - answer.noul);
}

async function requestPayload(
  transport: DecisionTransport,
  request: DecisionRequest,
  requestFetch: typeof fetch,
  timeoutMs: number,
): Promise<Stage<JsonValue>> {
  const sent = await attemptAsync(
    () =>
      requestFetch(transport.url, {
        method: "POST",
        headers: transport.headers,
        body: request.text,
        // Redirects are not expected for this POST; erroring keeps the
        // request on the endpoint that was configured.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      }),
    "network",
  );
  if (!sent.ok) return sent;
  if (!sent.value.ok) return stageFail("http");
  const text = await attemptAsync(() => sent.value.text(), "network");
  if (!text.ok) return text;
  return attempt(() => parseJson(text.value), "malformed");
}

/**
 * The seam itself: `decide(state, questions) → suggestion | rules-result`.
 *
 * Env unset (the shipped default) returns `options.rules` untouched without
 * touching the network. When a provider is configured, a valid, sufficiently
 * confident answer comes back as `kind: "suggestion"` evidence to display
 * BESIDE the caller's rules — never instead of them. Every failure path
 * returns the caller's rules by reference with a `RulesReason`.
 */
export async function decide<T>(
  state: JsonValue,
  questions: DecisionQuestions,
  options: DecideOptions<T>,
): Promise<DecisionOutcome<T>> {
  const startedAt = Date.now();
  const rules = options.rules;
  const transport = decisionTransport(options.env ?? process.env);
  if (!transport.ok) return { source: "rules", result: rules, reason: transport.reason };

  const request = attempt(
    () => buildDecisionRequest(state, questions, transport.value.model),
    "bad-request",
  );
  if (!request.ok) return { source: "rules", result: rules, reason: request.reason };

  const payload = await requestPayload(
    transport.value,
    request.value,
    options.fetch ?? globalThis.fetch,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!payload.ok) return { source: "rules", result: rules, reason: payload.reason };

  const parsed = attempt(
    () => parseDecisionAnswers(payload.value, request.value.questions),
    "malformed",
  );
  if (!parsed.ok) return { source: "rules", result: rules, reason: parsed.reason };

  const floor = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const uncertain = Object.values(parsed.value.answers).some(
    (answer) => effectiveConfidence(answer) < floor,
  );
  if (uncertain) {
    return {
      source: "rules",
      result: rules,
      reason: "low-confidence",
      note: "model answers fell below the confidence floor",
    };
  }

  const suggestion: DecisionSuggestion = {
    kind: "suggestion",
    answers: parsed.value.answers,
    requestHash: request.value.requestHash,
    latencyMs: Date.now() - startedAt,
  };
  const model = parsed.value.model ?? transport.value.model;
  if (model !== undefined) suggestion.model = model;
  return { source: "model", suggestion };
}
