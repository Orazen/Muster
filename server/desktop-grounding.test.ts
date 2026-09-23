// Pins for the pure desktop-grounding core: continuity, the 200 cap and
// `__none__` escape hatch, duplicate/reserved-ID crash-safety, strict
// decision decoding (no confidence cutoff, invented/invalid/incomplete
// rejected, ties honored), and the missing-ranker rule. Ported case-for-case
// from tiptour-macos `TipTourTests/JevTests.swift` (MIT — see the module
// header). No I/O anywhere.
import { describe, expect, it, vi } from "vitest";

import {
  ACTION_KINDS,
  DONE_THRESHOLD,
  GroundingError,
  MAX_CANDIDATES,
  NONE_KEY,
  bestTarget,
  buildGroundingRequest,
  deduplicateTargets,
  describeTarget,
  decodeDecision,
  groundDecision,
  margin,
  rankedProbabilities,
  stopReasonOf,
  targetContinuityMatches,
  topProbability,
  type GroundingAnswer,
  type GroundingAnswers,
  type GroundingCallMetrics,
  type ScreenTargetCandidate,
} from "./desktop-grounding.ts";

const metrics: GroundingCallMetrics = { milliseconds: 1, inputTokens: 100, model: "jev-latest" };

const candidate = (id = "save", label = "Save"): ScreenTargetCandidate =>
  ({ id, label, source: "ocr", confidence: 1 });

/** The four questions the ask always bundles, answered validly by default. */
const answers = (
  choice = "save",
  absent = 0.1,
  probability = 0.9,
  kind = "click",
): GroundingAnswers => ({
  pick: { choice, probabilities: { [choice]: probability } },
  done: { noul: 0.1 },
  absent: { noul: absent },
  kind: { choice: kind },
});

const pickAnswers = (pick: GroundingAnswer, rest: GroundingAnswers = answers()): GroundingAnswers => ({
  ...rest,
  pick,
});

describe("describeTarget", () => {
  it("reads label first, then source, then the global location", () => {
    expect(describeTarget(candidate())).toBe("Save [ocr]");
    expect(describeTarget({ id: "x", label: "", source: "ax" })).toBe("unlabeled element [ax]");
    expect(describeTarget({ id: "x", label: "Save", source: "ocr", centre: { x: 10.7, y: 20.2 } }))
      .toBe("Save [ocr] at (10,20)");
    // a zero centre is upstream's "no location" sentinel, not "(0, 0)"
    expect(describeTarget({ id: "x", label: "Save", source: "ocr", centre: { x: 0, y: 0 } }))
      .toBe("Save [ocr]");
  });
});

describe("constants", () => {
  it("keeps the measured escape-hatch name, the 200 cap and the action kinds", () => {
    expect(NONE_KEY).toBe("__none__");
    expect(MAX_CANDIDATES).toBe(200);
    expect(MAX_CANDIDATES).toBeLessThan(255); // headroom under the hosted cap
    expect([...ACTION_KINDS]).toEqual(["click", "double_click", "right_click"]);
    expect(DONE_THRESHOLD).toBe(0.7);
  });
});

describe("targetContinuity", () => {
  const matches = (
    box: number[],
    over: Partial<{ label: string; source: string; display: number[] }> = {},
  ) => targetContinuityMatches({
    label: over.label ?? "New Tab",
    source: over.source ?? "ocr",
    box,
    display: over.display ?? [0, 0, 1512, 982],
    previousLabel: "New Tab",
    previousSource: "ocr",
    previousBox: [100, 50, 160, 65],
    previousDisplay: [0, 0, 1512, 982],
  });

  it("allows detector jitter but rejects a different control", () => {
    expect(matches([101, 49, 161, 66])).toBe(true);      // ~0.72 IoU — jitter
    expect(matches([500, 50, 560, 65])).toBe(false);      // elsewhere on screen
    expect(matches([100, 50, 160, 65], { label: "Close Tab" })).toBe(false);
    expect(matches([100, 50, 160, 65], { display: [1512, 0, 1512, 982] })).toBe(false);
    expect(matches([100, 50, 160, 65], { source: "yolo" })).toBe(false);
    expect(matches([100, 50])).toBe(false);               // not a box
  });

  it("rejects non-finite, degenerate and merely-touching boxes", () => {
    expect(matches([Number.NaN, 50, 160, 65])).toBe(false);
    expect(matches([100, 50, 100, 65])).toBe(false);      // zero width
    expect(matches([160, 65, 220, 80])).toBe(false);      // edge-touching, IoU 0
    expect(matches([100, 50, 160, 65, 9])).toBe(false);   // five-element box
  });
});

describe("deduplicateTargets", () => {
  it("drops empty IDs, the reserved ID, duplicate IDs and duplicate descriptions", () => {
    expect(deduplicateTargets([
      candidate(),
      candidate("other", "Save"),        // same description as `save`
      candidate("save", "Different label"), // same ID as `save`
      candidate("save-2", "Different label"),
      candidate(NONE_KEY),
      candidate(""),
    ]).map((c) => c.id)).toEqual(["save", "save-2"]);
  });
});

describe("buildGroundingRequest", () => {
  it("stays under the API's option limit and keeps the `__none__` option", () => {
    const candidates = Array.from({ length: 300 }, (_, i) => candidate(`id-${i}`, `Button ${i}`));
    const request = buildGroundingRequest({ task: "Save", candidates });
    expect(request?.pool).toHaveLength(200);
    const pick = request?.questions["pick"];
    expect(pick?.type).toBe("choice");
    if (pick?.type !== "choice") throw new Error("missing bounded choice question");
    expect(Object.keys(pick.criteria)).toHaveLength(201);
    expect(pick.criteria[NONE_KEY]).toContain("None of these");
    expect(request?.state.screen_elements).toHaveLength(200);
    expect(request?.state.step).toBe(1);
  });

  it("never asks an empty question", () => {
    expect(buildGroundingRequest({ task: "Save", candidates: [] })).toBeNull();
    expect(buildGroundingRequest({ task: "Save", candidates: [candidate()], excluding: ["save"] })).toBeNull();
  });

  it("keeps state and criteria describing the same world", () => {
    const request = buildGroundingRequest({ task: "Save", candidates: [candidate(), candidate("cancel", "Cancel")] });
    const pick = request?.questions["pick"];
    if (pick?.type !== "choice") throw new Error("missing choice question");
    const ids = request!.state.screen_elements.map((element) => element.id).sort();
    expect(ids).toEqual(["cancel", "save"]);
    expect(Object.keys(pick.criteria).filter((key) => key !== NONE_KEY).sort()).toEqual(ids);
  });

  it("counts prior history into the step and already-done list", () => {
    const request = buildGroundingRequest({ task: "Save", candidates: [candidate()], history: ["clicked toolbar"] });
    expect(request?.state.step).toBe(2);
    expect(request?.state.already_done).toEqual(["clicked toolbar"]);
  });

  it("excludes previously used targets before capping", () => {
    const candidates = Array.from({ length: 250 }, (_, i) => candidate(`id-${i}`, `Button ${i}`));
    const request = buildGroundingRequest({ task: "Save", candidates, excluding: ["id-0", "id-1"] });
    expect(request?.pool).toHaveLength(200);
    expect(request?.pool.some((c) => c.id === "id-0")).toBe(false);
  });
});

describe("decodeDecision", () => {
  it("uses the supplied target for a valid click", () => {
    const decision = decodeDecision({ answers: answers(), pool: [candidate()], metrics });
    expect(bestTarget(decision)?.candidate.id).toBe("save");
    expect(decision.actionKind).toBe("click");
    expect(stopReasonOf(decision)).toBeNull();
    expect(decision.metrics).toEqual(metrics);
  });

  it("stops on `__none__` instead of clicking the runner-up", () => {
    const decision = decodeDecision({
      answers: pickAnswers({ choice: NONE_KEY, probabilities: { [NONE_KEY]: 0.9, save: 0.1 } }),
      pool: [candidate()],
      metrics,
    });
    expect(bestTarget(decision)?.candidate.id).toBe("save"); // evidence only
    expect(stopReasonOf(decision)).toBe("target_absent");
    expect(decision.choseNone).toBe(true);
  });

  it("applies no confidence or probability cutoff", () => {
    const absent = decodeDecision({ answers: answers("save", 0.9), pool: [candidate()], metrics });
    const weak = decodeDecision({ answers: answers("save", 0.1, 0.2), pool: [candidate()], metrics });
    expect(stopReasonOf(absent)).toBeNull();
    expect(bestTarget(absent)?.candidate.id).toBe("save");
    expect(stopReasonOf(weak)).toBeNull();
    expect(bestTarget(weak)?.candidate.id).toBe("save");
    expect(topProbability({ probabilities: { save: 0.2 } })).toBe(0.2);
    expect(margin({ probabilities: { save: 0.5, cancel: 0.5 } })).toBe(0);
  });

  it("rejects an invented target, an invalid action kind and incomplete responses", () => {
    const run = (a: GroundingAnswers) => () => decodeDecision({ answers: a, pool: [candidate()], metrics });
    expect(run(answers("invented"))).toThrow(GroundingError);
    expect(run(answers("save", 0.1, 0.9, "type"))).toThrow(GroundingError);
    expect(run({})).toThrow(GroundingError);
    expect(run(pickAnswers({ choice: "save" }))).toThrow(GroundingError); // no probabilities
    expect(run(pickAnswers({ choice: "save", probabilities: {} }))).toThrow(GroundingError);
    const noAbsent = answers();
    // SAFETY: this widens THIS test's own freshly-built answers object to the
    // documented open map so one field can be removed; decodeDecision is what
    // must reject the incomplete shape, asserted on the next line.
    delete (noAbsent as Record<string, GroundingAnswer>).absent;
    expect(run(noAbsent)).toThrow(GroundingError); // incomplete: `absent` missing
  });

  it("rejects out-of-range, non-finite and out-of-pool probabilities", () => {
    const run = (a: GroundingAnswers) => () => decodeDecision({ answers: a, pool: [candidate()], metrics });
    expect(run(pickAnswers({ choice: "save", probabilities: { save: 1.4 } }))).toThrow(GroundingError);
    expect(run(pickAnswers({ choice: "save", probabilities: { save: -0.1 } }))).toThrow(GroundingError);
    expect(run(pickAnswers({ choice: "save", probabilities: { save: Number.NaN } }))).toThrow(GroundingError);
    expect(run(pickAnswers({ choice: "save", probabilities: { save: 0.9, invented: 0.1 } }))).toThrow(GroundingError);
    expect(run({ ...answers(), done: { noul: 2 } })).toThrow(GroundingError);
    expect(run({ ...answers(), absent: { noul: Number.POSITIVE_INFINITY } })).toThrow(GroundingError);
  });

  it("rejects a chosen probability that is not the maximum", () => {
    expect(() => decodeDecision({
      answers: pickAnswers({ choice: "save", probabilities: { save: 0.4, cancel: 0.6 } }),
      pool: [candidate(), candidate("cancel", "Cancel")],
      metrics,
    })).toThrow(GroundingError);
  });

  it("honors the reported choice on a rounded tie", () => {
    const decision = decodeDecision({
      answers: pickAnswers({ choice: "save", probabilities: { cancel: 0.5, save: 0.5 } }),
      pool: [candidate(), candidate("cancel", "Cancel")],
      metrics,
    });
    expect(bestTarget(decision)?.candidate.id).toBe("save");
  });

  it("ranks every real candidate most-likely-first and drops `__none__`", () => {
    const decision = decodeDecision({
      answers: pickAnswers({ choice: "save", probabilities: { save: 0.5, cancel: 0.3, [NONE_KEY]: 0.2 } }),
      pool: [candidate(), candidate("cancel", "Cancel")],
      metrics,
    });
    expect(decision.ranked.map((entry) => entry.candidate.id)).toEqual(["save", "cancel"]);
    expect(stopReasonOf(decision)).toBeNull();
  });
});

describe("groundDecision", () => {
  it("fails before any ranker call when the ranker is missing", async () => {
    // No ranker, or an explicitly-null one: the rejection happens before a
    // ranker could exist to be called (upstream's missing-key rule).
    await expect(groundDecision({ task: "Save", candidates: [candidate()] }))
      .rejects.toMatchObject({ kind: "ranker-missing" });
    await expect(groundDecision({ task: "Save", candidates: [candidate()], ranker: null }))
      .rejects.toBeInstanceOf(GroundingError);
  });

  it("builds, asks and decodes through a caller-supplied ranker", async () => {
    const ranker = vi.fn(async ({ questions }) => {
      expect(questions["pick"]).toBeDefined();
      return answers();
    });
    const decision = await groundDecision({ task: "Save", candidates: [candidate()], ranker });
    expect(decision.actionKind).toBe("click");
    expect(ranker).toHaveBeenCalledTimes(1);
    expect(decision.metrics.model).toBe("caller-supplied");
  });

  it("fails closed when nothing survives dedup instead of asking", async () => {
    const ranker = vi.fn();
    await expect(groundDecision({ task: "Save", candidates: [candidate("")], ranker }))
      .rejects.toMatchObject({ kind: "malformed" });
    expect(ranker).not.toHaveBeenCalled();
  });

  it("propagates a malformed ranker reply as a rejection", async () => {
    await expect(groundDecision({
      task: "Save",
      candidates: [candidate()],
      ranker: () => answers("invented"),
    })).rejects.toBeInstanceOf(GroundingError);
  });
});

describe("probability helpers", () => {
  it("never reads probabilities positionally", () => {
    expect(rankedProbabilities({ probabilities: { b: 0.2, a: 0.9, c: 0.5 } }).map((e) => e.key))
      .toEqual(["a", "c", "b"]);
    expect(topProbability({})).toBe(0);
    expect(margin({ probabilities: { save: 0.9 } })).toBe(0.9);
  });
});
