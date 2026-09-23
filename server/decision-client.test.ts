// Pins for the Slice 0 decision seam (both studies converged on this exact
// slice): env unset ⇒ zero network, zero spawn, rules returned by reference;
// malformed endpoint / bad request / network / http / malformed payload /
// low confidence ⇒ fail open to the caller's rules; a successful model
// answer is suggestion-grade evidence only and never a verdict-shaped
// object. No test here touches the real network — fetch is always injected.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  JEV_ENDPOINT,
  JEV_MODEL,
  MAX_OPTIONS_PER_QUESTION,
  buildDecisionRequest,
  decide,
  decisionTransport,
  parseDecisionAnswers,
  type DecisionQuestions,
} from "./decision-client.ts";

const state = { job: "triage inbox", detail: "note carrying sk-ant-abcdefghijklmnop inline" };

const questions: DecisionQuestions = {
  urgent: { type: "noul", instructions: "Does this request need attention today?" },
  lane: { type: "choice", instructions: "Which lane fits?", criteria: ["billing", "technical", "__none__"] },
  risk: { type: "score", instructions: "How risky is it?", criteria: ["routine", "elevated"] },
};

// TipTour/Jev-shaped fixture: probabilities deliberately in shuffled key
// order (providers return them shuffled — they must be read by key), one
// unrequested answer id (must be dropped, not trusted), usage block (must
// be ignored), and noul without a confidence field (Jev's shape).
const fixtureResponse = {
  answers: {
    urgent: { type: "noul", noul: 0.82 },
    lane: {
      type: "choice",
      choice: "billing",
      probabilities: { technical: 0.1, billing: 0.7, "__none__": 0.2 },
      confidence: 0.7,
    },
    risk: {
      type: "score",
      score: 1.4,
      probabilities: { elevated: 0.6, routine: 0.4 },
      confidence: 0.6,
    },
    unrequested: { type: "noul", noul: 0.11 },
  },
  model: "fixture-model",
  usage: { input_tokens: 12, output_tokens: 0 },
};

const rulesFixture = { action: "manual-review" };

/** A fetch stub that records what it was asked to send. No annotation on
 * the return type on purpose: an inline object-literal return type would
 * be a known-evidence flow the lint rules reject. */
function probeFetch(text: string, status = 200) {
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    urls.push(String(input));
    calls.push(init ?? {});
    return new Response(text, { status });
  };
  return { impl, calls, urls };
}

const failingFetch: typeof fetch = () => Promise.reject(new Error("connection refused"));

/** Never resolves; only the abort from decide's timeout can settle it. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
  });

describe("decisionTransport", () => {
  it("reports unset when no provider env is configured", () => {
    expect(decisionTransport({})).toEqual({ ok: false, reason: "unset" });
  });

  it("treats an empty endpoint value as unset, not broken", () => {
    expect(decisionTransport({ MUSTER_DECISION_URL: "   " })).toEqual({ ok: false, reason: "unset" });
  });

  it("reports bad-endpoint for values that are not usable http(s) urls", () => {
    for (const url of ["not a url", "ftp://127.0.0.1:9/x"]) {
      expect(decisionTransport({ MUSTER_DECISION_URL: url })).toEqual({ ok: false, reason: "bad-endpoint" });
    }
  });

  it("resolves a remote endpoint with its optional bearer", () => {
    const resolved = decisionTransport({
      MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide",
      MUSTER_DECISION_TOKEN: "unit-test-token",
    });
    if (!resolved.ok) throw new Error("expected a transport");
    expect(resolved.value.provider).toBe("remote");
    expect(resolved.value.url).toBe("http://127.0.0.1:9099/decide");
    expect(resolved.value.model).toBeUndefined();
    expect(resolved.value.headers.get("content-type")).toBe("application/json");
    expect(resolved.value.headers.get("authorization")).toBe("Bearer unit-test-token");
  });

  it("resolves the hosted Jev transport from TYPESAFE_API_KEY", () => {
    const resolved = decisionTransport({ TYPESAFE_API_KEY: "unit-test-jev-key" });
    if (!resolved.ok) throw new Error("expected a transport");
    expect(resolved.value.provider).toBe("jev");
    expect(resolved.value.url).toBe(JEV_ENDPOINT);
    expect(resolved.value.model).toBe(JEV_MODEL);
    expect(resolved.value.headers.get("authorization")).toBe("Bearer unit-test-jev-key");
  });

  it("prefers the remote endpoint when both providers are configured", () => {
    const resolved = decisionTransport({
      MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide",
      TYPESAFE_API_KEY: "unit-test-jev-key",
    });
    if (!resolved.ok) throw new Error("expected a transport");
    expect(resolved.value.provider).toBe("remote");
  });
});

describe("buildDecisionRequest", () => {
  it("builds the outbound bytes, dedupes duplicate options and hashes exactly what it sends", () => {
    const request = buildDecisionRequest(
      state,
      {
        lane: {
          type: "choice",
          instructions: "Which lane fits?",
          criteria: ["billing", "billing", "technical", "__none__"],
        },
      },
      "jev-latest",
    );
    const body = JSON.parse(request.text);
    expect(body.state.job).toBe("triage inbox");
    expect(body.questions.lane.criteria).toEqual(["billing", "technical", "__none__"]);
    expect(body.model).toBe("jev-latest");
    expect(request.requestHash).toBe(createHash("sha256").update(request.text).digest("hex"));
  });

  it("omits the model field when no transport model is given", () => {
    const request = buildDecisionRequest(state, questions);
    expect(JSON.parse(request.text).model).toBeUndefined();
    expect(request.questions.lane.type).toBe("choice");
  });

  it("redacts credential-shaped values on the wire without mutating the caller's state", () => {
    const request = buildDecisionRequest(state, questions);
    expect(request.text).toContain("«redacted");
    expect(request.text).not.toContain("sk-ant-abcdefghijklmnop");
    expect(state.detail).toContain("sk-ant-abcdefghijklmnop");
  });

  it("rejects caller-bad question maps", () => {
    expect(() => buildDecisionRequest(state, {})).toThrow(/at least one question/);
    expect(() =>
      buildDecisionRequest(state, { only: { type: "choice", instructions: "x", criteria: ["solo"] } }),
    ).toThrow(/distinct options/);
    expect(() => buildDecisionRequest(state, { "bad id!": { type: "noul", instructions: "x" } })).toThrow();
    const wide = Array.from({ length: MAX_OPTIONS_PER_QUESTION + 1 }, (_unused, index) => `o${index}`);
    expect(() =>
      buildDecisionRequest(state, { wide: { type: "choice", instructions: "x", criteria: wide } }),
    ).toThrow(/distinct options/);
  });
});

describe("parseDecisionAnswers", () => {
  it("parses a TipTour-shaped response, reading probabilities by key and dropping unknown ids", () => {
    const parsed = parseDecisionAnswers(fixtureResponse, questions);
    expect(Object.keys(parsed.answers)).toEqual(["urgent", "lane", "risk"]);
    // Whole-answer comparisons: DecisionAnswer is a discriminated union, so a
    // whole object proves both the discriminant and every field at once.
    expect(parsed.answers.urgent).toEqual({ type: "noul", noul: 0.82 });
    expect(parsed.answers.lane).toEqual({
      type: "choice",
      choice: "billing",
      probabilities: { technical: 0.1, billing: 0.7, "__none__": 0.2 },
      confidence: 0.7,
    });
    expect(parsed.answers.risk).toEqual({
      type: "score",
      score: 1.4,
      probabilities: { elevated: 0.6, routine: 0.4 },
      confidence: 0.6,
    });
    expect(parsed.model).toBe("fixture-model");
  });

  it("rejects a response that does not answer every requested question", () => {
    expect(() =>
      parseDecisionAnswers({ answers: { urgent: { type: "noul", noul: 0.9 } } }, questions),
    ).toThrow(/no answer for "lane"/);
  });

  it("rejects an answer whose type does not match its question", () => {
    expect(() =>
      parseDecisionAnswers(
        {
          answers: {
            urgent: { type: "noul", noul: 0.9 },
            lane: { type: "noul", noul: 0.4 },
            risk: { type: "score", score: 1, probabilities: { routine: 1 }, confidence: 0.9 },
          },
        },
        questions,
      ),
    ).toThrow(/is noul; the question asked choice/);
  });

  it("rejects a choice that names a value outside its criteria", () => {
    expect(() =>
      parseDecisionAnswers(
        {
          answers: {
            urgent: { type: "noul", noul: 0.9 },
            lane: {
              type: "choice",
              choice: "not-a-lane",
              probabilities: { "not-a-lane": 0.9, billing: 0.1 },
              confidence: 0.9,
            },
            risk: { type: "score", score: 1, probabilities: { routine: 1 }, confidence: 0.9 },
          },
        },
        questions,
      ),
    ).toThrow(/outside its criteria/);
  });

  it("rejects out-of-range probabilities and non-finite scores", () => {
    expect(() =>
      parseDecisionAnswers(
        {
          answers: {
            urgent: { type: "noul", noul: 1.4 },
            lane: { type: "choice", choice: "billing", probabilities: { billing: 1.5 }, confidence: 0.9 },
            risk: { type: "score", score: 1, probabilities: { routine: 1 }, confidence: 0.9 },
          },
        },
        questions,
      ),
    ).toThrow(/answers\.urgent\.noul/);
    expect(() =>
      parseDecisionAnswers(
        {
          answers: {
            urgent: { type: "noul", noul: 0.9 },
            lane: { type: "choice", choice: "billing", probabilities: { billing: 1 }, confidence: 0.9 },
            risk: { type: "score", score: Infinity, probabilities: { routine: 1 }, confidence: 0.9 },
          },
        },
        questions,
      ),
    ).toThrow(/answers\.risk\.score/);
  });

  it("rejects payloads that are not a decision response at all", () => {
    expect(() => parseDecisionAnswers({}, questions)).toThrow(/answers/);
    expect(() => parseDecisionAnswers({ answers: [] }, questions)).toThrow(/answers/);
  });
});

describe("decide", () => {
  it("returns the caller's rules untouched when no env is configured, with zero network", async () => {
    const rules = Object.freeze({ action: "manual-review" });
    const probe = probeFetch("{}");
    const outcome = await decide(state, questions, { rules, env: {}, fetch: probe.impl });
    expect(outcome).toEqual({ source: "rules", result: { action: "manual-review" }, reason: "unset" });
    expect(probe.calls.length).toBe(0);
    if (outcome.source === "rules") expect(outcome.result).toBe(rules);
  });

  it("never imports a spawner or an authority-bearing decision module", () => {
    const source = readFileSync(new URL("./decision-client.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process|\bspawnSync\b|\bexecSync\b/);
    expect(source).not.toMatch(/from "\.\/(auto-approve|memory-grants)/);
  });

  it("fails open to rules on a configured-but-unusable endpoint without touching the network", async () => {
    for (const url of ["not a url", "ftp://127.0.0.1:9/x"]) {
      const probe = probeFetch("{}");
      const outcome = await decide(state, questions, {
        rules: rulesFixture,
        env: { MUSTER_DECISION_URL: url },
        fetch: probe.impl,
      });
      expect(outcome).toEqual({ source: "rules", result: rulesFixture, reason: "bad-endpoint" });
      expect(probe.calls.length).toBe(0);
    }
  });

  it("returns a suggestion-grade model outcome on a valid, confident response", async () => {
    const probe = probeFetch(JSON.stringify(fixtureResponse));
    const outcome = await decide(state, questions, {
      rules: rulesFixture,
      env: { MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide", MUSTER_DECISION_TOKEN: "unit-test-token" },
      fetch: probe.impl,
    });
    if (outcome.source !== "model") throw new Error(`expected a suggestion, got ${outcome.reason}`);
    const suggestion = outcome.suggestion;
    expect(suggestion.kind).toBe("suggestion");
    expect(suggestion.answers.lane).toEqual({
      type: "choice",
      choice: "billing",
      probabilities: { technical: 0.1, billing: 0.7, "__none__": 0.2 },
      confidence: 0.7,
    });
    expect(suggestion.model).toBe("fixture-model");
    expect(suggestion.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(suggestion.latencyMs).toBeGreaterThanOrEqual(0);
    expect(probe.urls).toEqual(["http://127.0.0.1:9099/decide"]);
    expect(new Headers(probe.calls[0]?.headers).get("authorization")).toBe("Bearer unit-test-token");
    // The bearer never rides back out inside an outcome.
    expect(JSON.stringify(outcome)).not.toContain("unit-test-token");
  });

  it("keeps a model outcome suggestion-shaped: no verdict keys anywhere", async () => {
    const probe = probeFetch(JSON.stringify(fixtureResponse));
    const outcome = await decide(state, questions, {
      rules: rulesFixture,
      env: { MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide" },
      fetch: probe.impl,
    });
    if (outcome.source !== "model") throw new Error(`expected a suggestion, got ${outcome.reason}`);
    expect(Object.keys(outcome).sort()).toEqual(["source", "suggestion"]);
    expect(Object.keys(outcome.suggestion).sort()).toEqual(
      ["answers", "kind", "latencyMs", "model", "requestHash"].sort(),
    );
    expect(JSON.stringify(outcome)).not.toMatch(/"(verdict|decision|approved|allow|deny)"/);
  });

  it("posts the Jev body with the documented model id and never echoes the key", async () => {
    const probe = probeFetch(JSON.stringify(fixtureResponse));
    const outcome = await decide(state, questions, {
      rules: rulesFixture,
      env: { TYPESAFE_API_KEY: "unit-test-jev-key" },
      fetch: probe.impl,
    });
    if (outcome.source !== "model") throw new Error(`expected a suggestion, got ${outcome.reason}`);
    const body = JSON.parse(String(probe.calls[0]?.body));
    expect(probe.urls).toEqual([JEV_ENDPOINT]);
    expect(body.model).toBe(JEV_MODEL);
    expect(new Headers(probe.calls[0]?.headers).get("authorization")).toBe("Bearer unit-test-jev-key");
    expect(JSON.stringify(outcome)).not.toContain("unit-test-jev-key");
  });

  it("fails open to rules on a non-2xx response", async () => {
    const probe = probeFetch("boom", 500);
    const outcome = await decide(state, questions, {
      rules: rulesFixture,
      env: { MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide" },
      fetch: probe.impl,
    });
    expect(outcome).toEqual({ source: "rules", result: rulesFixture, reason: "http" });
  });

  it("fails open to rules when the request itself fails", async () => {
    const outcome = await decide(state, questions, {
      rules: rulesFixture,
      env: { MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide" },
      fetch: failingFetch,
    });
    expect(outcome).toEqual({ source: "rules", result: rulesFixture, reason: "network" });
  });

  it("fails open to rules when the provider exceeds the hard timeout", async () => {
    const outcome = await decide(state, questions, {
      rules: rulesFixture,
      env: { MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide" },
      fetch: hangingFetch,
      timeoutMs: 25,
    });
    expect(outcome).toEqual({ source: "rules", result: rulesFixture, reason: "network" });
  });

  it("fails open to rules when the response body is not JSON", async () => {
    const probe = probeFetch("<!doctype html>nope");
    const outcome = await decide(state, questions, {
      rules: rulesFixture,
      env: { MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide" },
      fetch: probe.impl,
    });
    expect(outcome).toEqual({ source: "rules", result: rulesFixture, reason: "malformed" });
  });

  it("fails open to rules when the response omits requested answers", async () => {
    const incomplete = JSON.stringify({ answers: { urgent: { type: "noul", noul: 0.9 } } });
    const probe = probeFetch(incomplete);
    const outcome = await decide(state, questions, {
      rules: rulesFixture,
      env: { MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide" },
      fetch: probe.impl,
    });
    expect(outcome).toEqual({ source: "rules", result: rulesFixture, reason: "malformed" });
  });

  it("fails open to rules with an uncertain note when any answer is under the floor", async () => {
    const shaky = JSON.stringify({
      answers: {
        urgent: { type: "noul", noul: 0.6 },
        lane: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.42, technical: 0.4, "__none__": 0.18 },
          confidence: 0.42,
        },
        risk: { type: "score", score: 1.2, probabilities: { routine: 0.7, elevated: 0.3 }, confidence: 0.8 },
      },
    });
    const probe = probeFetch(shaky);
    const outcome = await decide(state, questions, {
      rules: rulesFixture,
      env: { MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide" },
      fetch: probe.impl,
    });
    expect(outcome.source).toBe("rules");
    if (outcome.source === "rules") {
      expect(outcome.reason).toBe("low-confidence");
      expect(outcome.note).toContain("confidence floor");
    }
  });

  it("honors an explicit minConfidence override above the default floor", async () => {
    const probe = probeFetch(JSON.stringify(fixtureResponse));
    const outcome = await decide(state, questions, {
      rules: rulesFixture,
      env: { MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide" },
      fetch: probe.impl,
      minConfidence: 0.99,
    });
    expect(outcome).toEqual({
      source: "rules",
      result: rulesFixture,
      reason: "low-confidence",
      note: "model answers fell below the confidence floor",
    });
  });

  it("never mutates or replaces a deep-frozen rules value on a late fail-open", async () => {
    const frozen = Object.freeze({ action: "manual-review", detail: Object.freeze({ steps: 3 }) });
    const probe = probeFetch(JSON.stringify(fixtureResponse));
    const outcome = await decide(state, questions, {
      rules: frozen,
      env: { MUSTER_DECISION_URL: "http://127.0.0.1:9099/decide" },
      fetch: probe.impl,
      minConfidence: 0.99,
    });
    expect(outcome.source).toBe("rules");
    expect(Object.isFrozen(frozen)).toBe(true);
    if (outcome.source === "rules") expect(outcome.result).toBe(frozen);
  });

  it("falls back to process.env when no env option is given", async () => {
    const previous = process.env.MUSTER_DECISION_URL;
    process.env.MUSTER_DECISION_URL = "http://127.0.0.1:9099/decide";
    try {
      const probe = probeFetch(JSON.stringify(fixtureResponse));
      const outcome = await decide(state, questions, { rules: rulesFixture, fetch: probe.impl });
      expect(probe.urls).toEqual(["http://127.0.0.1:9099/decide"]);
      expect(outcome.source).toBe("model");
    } finally {
      if (previous === undefined) delete process.env.MUSTER_DECISION_URL;
      else process.env.MUSTER_DECISION_URL = previous;
    }
  });
});
