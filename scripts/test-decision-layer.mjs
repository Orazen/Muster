#!/usr/bin/env node
// Slice 0 decision-layer harness — the end-to-end proof both studies ask
// for: docs/plans/laya-decision-engine-study.md §5 ("fixture states, golden
// outputs, zero network unless MUSTER_DECISION_URL is set") and
// docs/plans/jev-decision-model-study.md §5 S1 (fail-open ladder).
//
// What it does:
//   - copies server/decision-client.ts plus its two runtime dependencies
//     (redact.ts, schema.ts) and the zod package into a throwaway temp dir,
//   - imports the seam FROM that temp dir, so the run exercises the shipped
//     files as a consumer would load them rather than a re-exported bundle,
//   - drives it with fixture states and golden outputs against injected
//     fetch doubles — this script opens no socket and spawns no child
//     process, and the rules-only paths fail the run if fetch is reached,
//   - removes the temp dir in a finally block.
//
//   node scripts/test-decision-layer.mjs
//
// Reports JSON on stdout and exits non-zero if any check fails. The unit
// counterpart is server/decision-client.test.ts; a slice is only verified
// when both this harness and that suite pass.
import { createHash } from "node:crypto";
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const copiedModules = ["decision-client.ts", "redact.ts", "schema.ts"];

/** Any quoted verdict token means a model outcome leaked decision-shaped
 * keys — the hard rule is suggest, never decide. */
const verdictToken = /"(verdict|decision|approved|allow|deny)"/;

const checks = [];

function record(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: pass ? "" : String(detail ?? "check failed") });
}

function golden(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) {
    record(name, true);
    return;
  }
  record(
    name,
    false,
    `actual  ${JSON.stringify(actual)}\nexpected ${JSON.stringify(expected)}`,
  );
}

/** fetch double: answers with a fixed Response and records the POST. */
function servedFetch(body, status) {
  const calls = [];
  const impl = async (input, init) => {
    calls.push({ url: String(input), headers: init.headers, body: init.body });
    return new Response(body, { status });
  };
  return { impl, calls };
}

/** fetch double: behaves like a refused connection. */
const refusingFetch = async () => {
  throw new Error("connection refused");
};

/** fetch double: never answers, so only the caller's hard budget settles it.
 * It carries its own REF'd timer because AbortSignal.timeout's internal
 * timer is unref'd — a harness with nothing else pending would otherwise
 * drain its event loop and exit before the abort ever landed. Whichever of
 * the two fires first, `decide` must still fail open to rules. */
const hangingFetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const budget = setTimeout(() => reject(new Error("provider exceeded the budget")), 120);
    init.signal.addEventListener("abort", () => {
      clearTimeout(budget);
      reject(new Error("aborted by timeout"));
    });
  });

const fixtureState = {
  job: "triage inbox",
  detail: "note carrying sk-ant-abcdefghijklmnop inline",
};

const fixtureQuestions = {
  urgent: { type: "noul", instructions: "Does this request need attention today?" },
  lane: { type: "choice", instructions: "Which lane fits?", criteria: ["billing", "technical", "__none__"] },
  risk: { type: "score", instructions: "How risky is it?", criteria: ["routine", "elevated"] },
};

/** Probabilities in shuffled key order (providers return them shuffled), one
 * unrequested id (must be dropped), a usage block (must be ignored), and a
 * noul without its own confidence field — Jev's documented shape. */
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

/** Golden answers: the three requested ids only, probabilities kept as sent. */
const goldenAnswers = {
  urgent: { type: "noul", noul: 0.82 },
  lane: fixtureResponse.answers.lane,
  risk: fixtureResponse.answers.risk,
};

const rulesFixture = { action: "manual-review" };
const remoteEnv = { MUSTER_DECISION_URL: "http://127.0.0.1:9/decide" };
const outcomes = [];

/** Runs every check against an already-imported seam module. */
async function runChecks(seam) {
  const { buildDecisionRequest, decide, decisionTransport } = seam;

  // ── rules-only paths: no provider env ⇒ today's behavior, zero network ──
  {
    let calls = 0;
    const unreachable = async () => {
      calls += 1;
      throw new Error("the rules-only path must not reach the network");
    };
    const outcome = await decide(fixtureState, fixtureQuestions, {
      rules: rulesFixture,
      env: {},
      fetch: unreachable,
    });
    outcomes.push(outcome);
    golden("no provider env falls back to the golden rules outcome", outcome, {
      source: "rules",
      result: rulesFixture,
      reason: "unset",
    });
    record("no provider env makes zero network calls", calls === 0, `fetch reached ${calls} time(s)`);
    record(
      "the rules result is handed back by reference",
      outcome.source === "rules" && outcome.result === rulesFixture,
      "rules were copied or replaced",
    );
  }

  {
    let calls = 0;
    const unreachable = async () => {
      calls += 1;
      throw new Error("blank env must not reach the network");
    };
    const outcome = await decide(fixtureState, fixtureQuestions, {
      rules: rulesFixture,
      env: { MUSTER_DECISION_URL: "", TYPESAFE_API_KEY: "   " },
      fetch: unreachable,
    });
    outcomes.push(outcome);
    golden("blank provider env counts as unset, not broken", outcome, {
      source: "rules",
      result: rulesFixture,
      reason: "unset",
    });
    record("blank provider env makes zero network calls", calls === 0, `fetch reached ${calls} time(s)`);
  }

  {
    let calls = 0;
    const unreachable = async () => {
      calls += 1;
      throw new Error("an unusable endpoint must not reach the network");
    };
    for (const url of ["not a url", "ftp://127.0.0.1:9/x"]) {
      const outcome = await decide(fixtureState, fixtureQuestions, {
        rules: rulesFixture,
        env: { MUSTER_DECISION_URL: url },
        fetch: unreachable,
      });
      outcomes.push(outcome);
      golden(`unusable endpoint "${url}" fails open to rules`, outcome, {
        source: "rules",
        result: rulesFixture,
        reason: "bad-endpoint",
      });
    }
    record("an unusable endpoint makes zero network calls", calls === 0, `fetch reached ${calls} time(s)`);
  }

  // ── caller-bad input fails open before any request is built ──
  {
    let calls = 0;
    const unreachable = async () => {
      calls += 1;
      throw new Error("a bad request must not reach the network");
    };
    const outcome = await decide(fixtureState, { only: { type: "choice", instructions: "x", criteria: ["solo"] } }, {
      rules: rulesFixture,
      env: remoteEnv,
      fetch: unreachable,
    });
    outcomes.push(outcome);
    golden("a caller-bad question map fails open to rules", outcome, {
      source: "rules",
      result: rulesFixture,
      reason: "bad-request",
    });
    record("a caller-bad question map makes zero network calls", calls === 0, `fetch reached ${calls} time(s)`);
  }

  // ── request builder: golden outbound bytes and their audit hash ──
  {
    const built = buildDecisionRequest(
      fixtureState,
      {
        lane: {
          type: "choice",
          instructions: "Which lane fits?",
          criteria: ["billing", "billing", "technical", "__none__"],
        },
      },
      "jev-latest",
    );
    golden("duplicate options are deduped to the golden criteria before send", built.questions.lane.criteria, [
      "billing",
      "technical",
      "__none__",
    ]);
    const expectedHash = createHash("sha256").update(built.text).digest("hex");
    record(
      "requestHash is the sha-256 of the exact bytes built for sending",
      built.requestHash === expectedHash,
      `got ${built.requestHash}, want ${expectedHash}`,
    );
    record(
      "the builder leaves the caller's state untouched",
      fixtureState.detail === "note carrying sk-ant-abcdefghijklmnop inline",
      "the caller's state was mutated in place",
    );
    record(
      "credential-shaped text never reaches the wire",
      !built.text.includes("sk-ant-abcdefghijklmnop") && built.text.includes("«redacted"),
      "the outbound body still carries the raw credential",
    );
    const sentModel = JSON.parse(built.text).model;
    golden("the hosted transport model id rides in the body", sentModel, "jev-latest");
  }

  // ── model path: a valid, confident answer comes back as a suggestion ──
  {
    const bearer = "harness-remote-bearer";
    const probe = servedFetch(JSON.stringify(fixtureResponse), 200);
    const outcome = await decide(fixtureState, fixtureQuestions, {
      rules: rulesFixture,
      env: { ...remoteEnv, MUSTER_DECISION_TOKEN: bearer },
      fetch: probe.impl,
    });
    outcomes.push(outcome);
    record("a valid confident answer selects the model source", outcome.source === "model", JSON.stringify(outcome));
    if (outcome.source === "model") {
      const suggestion = outcome.suggestion;
      golden("the model outcome carries the golden answers", suggestion.answers, goldenAnswers);
      golden("the suggestion is suggestion-grade by literal kind", suggestion.kind, "suggestion");
      golden("the provider-reported model id is preserved", suggestion.model, "fixture-model");
      record(
        "the request hash is a 64-hex digest",
        /^[0-9a-f]{64}$/.test(suggestion.requestHash),
        suggestion.requestHash,
      );
      record(
        "the measured latency is a non-negative number",
        Number.isFinite(suggestion.latencyMs) && suggestion.latencyMs >= 0,
        String(suggestion.latencyMs),
      );
      const sentBody = probe.calls[0]?.body;
      const expectedHash = createHash("sha256").update(String(sentBody)).digest("hex");
      record(
        "requestHash anchors the exact bytes that were posted",
        suggestion.requestHash === expectedHash,
        `outcome ${suggestion.requestHash}, posted ${expectedHash}`,
      );
      golden(
        "the seam posts to the configured endpoint only",
        probe.calls.map((entry) => entry.url),
        [remoteEnv.MUSTER_DECISION_URL],
      );
      const sentHeaders = new Headers(probe.calls[0]?.headers);
      golden("the configured bearer is sent outbound", sentHeaders.get("authorization"), `Bearer ${bearer}`);
      const serialized = JSON.stringify(outcome);
      record("the bearer never rides back out inside an outcome", !serialized.includes(bearer), serialized);
      record(
        "a model outcome carries no verdict-shaped keys",
        !verdictToken.test(serialized),
        serialized,
      );
      const outbound = JSON.parse(String(sentBody));
      record(
        "the outbound state is redacted, not raw",
        !JSON.stringify(outbound.state).includes("sk-ant-abcdefghijklmnop") &&
          JSON.stringify(outbound.state).includes("«redacted"),
        JSON.stringify(outbound.state),
      );
      golden("the outbound questions match the requested map", outbound.questions, fixtureQuestions);
    }
  }

  // ── hosted Jev: TYPESAFE_API_KEY alone selects the documented endpoint ──
  {
    const key = "harness-jev-key";
    const probe = servedFetch(JSON.stringify(fixtureResponse), 200);
    const transport = decisionTransport({ TYPESAFE_API_KEY: key });
    record("TYPESAFE_API_KEY resolves a transport", transport.ok, JSON.stringify(transport));
    const outcome = await decide(fixtureState, fixtureQuestions, {
      rules: rulesFixture,
      env: { TYPESAFE_API_KEY: key },
      fetch: probe.impl,
    });
    outcomes.push(outcome);
    if (transport.ok) {
      golden("the hosted endpoint is the documented System One url", transport.value.url, seam.JEV_ENDPOINT);
      golden("the hosted transport carries the documented model id", transport.value.model, seam.JEV_MODEL);
    }
    golden("the hosted request targets that endpoint", probe.calls.map((entry) => entry.url), [seam.JEV_ENDPOINT]);
    const sentBody = JSON.parse(String(probe.calls[0]?.body));
    golden("the hosted body carries the documented model id", sentBody.model, seam.JEV_MODEL);
    const sentHeaders = new Headers(probe.calls[0]?.headers);
    golden("the hosted key is sent as a bearer", sentHeaders.get("authorization"), `Bearer ${key}`);
    record(
      "the hosted key never rides back out inside an outcome",
      !JSON.stringify(outcome).includes(key),
      JSON.stringify(outcome),
    );
  }

  // ── the fail-open ladder: every provider failure ⇒ the caller's rules ──
  const ladder = [
    { name: "a non-2xx response", body: "boom", status: 500, reason: "http" },
    { name: "a non-JSON body", body: "<!doctype html>nope", status: 200, reason: "malformed" },
    {
      name: "a response that omits a requested answer",
      body: JSON.stringify({ answers: { urgent: { type: "noul", noul: 0.9 } } }),
      status: 200,
      reason: "malformed",
    },
    {
      name: "an answer naming a value outside its criteria",
      body: JSON.stringify({
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
      }),
      status: 200,
      reason: "malformed",
    },
  ];
  for (const step of ladder) {
    const probe = servedFetch(step.body, step.status);
    const outcome = await decide(fixtureState, fixtureQuestions, {
      rules: rulesFixture,
      env: remoteEnv,
      fetch: probe.impl,
    });
    outcomes.push(outcome);
    golden(`${step.name} fails open to the golden rules outcome`, outcome, {
      source: "rules",
      result: rulesFixture,
      reason: step.reason,
    });
  }

  {
    const outcome = await decide(fixtureState, fixtureQuestions, {
      rules: rulesFixture,
      env: remoteEnv,
      fetch: refusingFetch,
    });
    outcomes.push(outcome);
    golden("a refused connection fails open to the golden rules outcome", outcome, {
      source: "rules",
      result: rulesFixture,
      reason: "network",
    });
  }

  {
    const outcome = await decide(fixtureState, fixtureQuestions, {
      rules: rulesFixture,
      env: remoteEnv,
      fetch: hangingFetch,
      timeoutMs: 25,
    });
    outcomes.push(outcome);
    golden("a provider that exceeds the hard timeout fails open to rules", outcome, {
      source: "rules",
      result: rulesFixture,
      reason: "network",
    });
  }

  {
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
    const probe = servedFetch(shaky, 200);
    const outcome = await decide(fixtureState, fixtureQuestions, {
      rules: rulesFixture,
      env: remoteEnv,
      fetch: probe.impl,
    });
    outcomes.push(outcome);
    golden("answers under the confidence floor fail open with the golden note", outcome, {
      source: "rules",
      result: rulesFixture,
      reason: "low-confidence",
      note: "model answers fell below the confidence floor",
    });
  }

  // ── hygiene: what this module is not allowed to reach ──
  for (const file of copiedModules) {
    const source = readFileSync(join(repoRoot, "server", file), "utf8");
    record(
      `${file} imports no child-process spawner`,
      !/child_process|\bspawnSync\b|\bexecSync\b/.test(source),
      `${file} references a process spawner`,
    );
  }
  const seamSource = readFileSync(join(repoRoot, "server", "decision-client.ts"), "utf8");
  record(
    "the seam imports no authority-bearing decision module",
    !/from "\.\/(auto-approve|memory-grants)/.test(seamSource),
    "the seam reaches into an authority-bearing module",
  );

  const verdictLeaks = outcomes.filter((outcome) => verdictToken.test(JSON.stringify(outcome)));
  record(
    `all ${outcomes.length} outcomes are free of verdict-shaped keys`,
    verdictLeaks.length === 0,
    JSON.stringify(verdictLeaks),
  );
}

// ── run: temp dir in, temp dir out ──
/** JSON report on stdout; returns the failure count. */
function writeReport() {
  const failedCount = checks.filter((entry) => !entry.pass).length;
  const report = {
    harness: "test-decision-layer",
    total: checks.length,
    passed: checks.length - failedCount,
    failed: failedCount,
    checks,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return failedCount;
}

// A watchdog so a deadlock reports a failure instead of hanging the runner.
// It is cleared the moment the run finishes below.
const watchdog = setTimeout(() => {
  record("the harness finished inside its time budget", false, "timed out after 20000 ms");
  writeReport();
  process.exit(1);
}, 20_000);

let tempRoot = null;
try {
  // The harness is a deterministic run: provider env in the shell must not
  // steer it, so the seam's default process.env read is scrubbed first.
  delete process.env.MUSTER_DECISION_URL;
  delete process.env.MUSTER_DECISION_TOKEN;
  delete process.env.TYPESAFE_API_KEY;

  tempRoot = mkdtempSync(join(tmpdir(), "muster-decision-layer-"));
  mkdirSync(join(tempRoot, "server"), { recursive: true });
  mkdirSync(join(tempRoot, "node_modules"), { recursive: true });
  for (const file of copiedModules) {
    copyFileSync(join(repoRoot, "server", file), join(tempRoot, "server", file));
  }
  cpSync(join(repoRoot, "node_modules", "zod"), join(tempRoot, "node_modules", "zod"), {
    recursive: true,
    dereference: true,
  });

  const seam = await import(pathToFileURL(join(tempRoot, "server", "decision-client.ts")).href);
  await runChecks(seam);
} catch (error) {
  record("harness ran to completion", false, error instanceof Error ? error.stack : String(error));
} finally {
  if (tempRoot !== null) rmSync(tempRoot, { recursive: true, force: true });
}

clearTimeout(watchdog);
if (writeReport() > 0) process.exitCode = 1;