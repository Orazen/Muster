// Desktop grounding core — turning a screen's detections into one bounded
// question, and an answer back into a grounded action proposal.
//
// Ported from tiptour-macos (github.com/milind-soni/tiptour-macos),
// MIT License — Copyright (c) 2026 Milind Soni, Portions Copyright (c) 2025
// Farza (Clicky). Adapted from `TipTour/Jev/JevGrounding.swift`,
// `TipTour/Perception/LocalTargetContinuity.swift` and the decode half of
// `TipTour/Jev/JevClient.swift`; the logic is translated Swift → TypeScript,
// and their provenance/citation lives in
// docs/plans/tiptour-integration-study.md. Their scripts/test-jev.sh
// isolation pattern is the reason this file imports NOTHING from Electron,
// Express, or any driver — npx vitest run server/desktop-grounding.test.ts
// is this repo's copy of that harness.
//
// House style follows server/jev-dispatch.ts (pure, no I/O, caps as named
// constants, unit tests alongside) with distinct type names: `JevCandidate`
// already exists there and means "a bot", so screen targets are
// `ScreenTargetCandidate` here. Muster's rule stands throughout: software
// enumerates candidates from real detections (never invented), ranking and
// validation are deterministic, and the model or the human only chooses.
// Nothing here executes anything, requests any permission, or talks to a
// network unless a caller supplies its own ranker.

/** The explicit escape hatch option. Measured in upstream: without it, when
 * the target is genuinely absent the ranker still picks a wrong element at
 * ~0.71 — high enough to look right and click. With it, true negatives score
 * ~0.96 and true positives are unaffected. */
export const NONE_KEY = "__none__";

/** Leave headroom under the hosted choice cap of 255 options. */
export const MAX_CANDIDATES = 200;

/** Upstream's "task is finished" stop threshold (JevPointerLoop). Kept as a
 * named constant so any caller thresholds in code, never on `confidence`. */
export const DONE_THRESHOLD = 0.7;

/** The only action kinds a grounding answer may name. */
export const ACTION_KINDS = ["click", "double_click", "right_click"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Narrow a ranker-supplied string to an action kind without asserting it:
 * the membership test IS the check, so the type follows the evidence. */
export function isActionKind(value: string | undefined): value is ActionKind {
  return !!value && ACTION_KINDS.some((kind) => kind === value);
}

/** One thing on screen the loop is allowed to act on. Built from a
 * detection — never invented — so a decision can only ever name something
 * real. `id` must be unique within a request; `source` is the detector that
 * produced it ("ax" | "browser" | "yolo" | "ocr" | anything else stable). */
export interface ScreenTargetCandidate {
  id: string;
  label: string;
  source: string;
  /** Detector confidence, carried for evidence chips only — decisions
   * threshold on top probability/margin, never on this. */
  confidence?: number;
  /** Global screen point, for the description only. Absent = no location. */
  centre?: { x: number; y: number };
}

/** How the ranker reads a candidate. It cannot see pixels, so this string is
 * the entire basis of the decision — label first, because the option key and
 * value are both read semantically. */
export function describeTarget(candidate: ScreenTargetCandidate): string {
  const centre = candidate.centre;
  const location = !centre || (centre.x === 0 && centre.y === 0)
    ? ""
    : ` at (${Math.trunc(centre.x)},${Math.trunc(centre.y)})`;
  return `${candidate.label || "unlabeled element"} [${candidate.source}]${location}`;
}

/** One question in a grounding ask. Only the shapes the pointer loop uses. */
export type GroundingQuestion =
  /** Probability a statement is true: the answer carries `noul` only. */
  | { type: "noul"; instructions: string; criteria?: Record<string, string> }
  /** Pick exactly one key; `criteria` maps option key → what it means. */
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export type GroundingQuestions = Record<string, GroundingQuestion>;

/** The state half of the ask. `state` and `criteria` must describe the same
 * world: upstream found answers became unstable between otherwise identical
 * runs when an element appeared in one but not the other. */
export interface GroundingState {
  task: string;
  /** 1-based step number (history length + 1). */
  step: number;
  already_done: string[];
  screen_elements: Array<{ id: string; describes: string }>;
}

export interface GroundingRequest {
  state: GroundingState;
  questions: GroundingQuestions;
  /** Deduped, excluded-filtered, capped candidate pool the ask refers to. */
  pool: ScreenTargetCandidate[];
}

/** One answer. Which fields are populated depends on the question type. */
export interface GroundingAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export type GroundingAnswers = Record<string, GroundingAnswer>;

/** What one call cost and how long it took, so the UI can show it honestly. */
export interface GroundingCallMetrics {
  milliseconds: number;
  inputTokens: number;
  model: string;
}

/** Malformed/incomplete answers and a missing ranker all fail closed. This
 * module has no hosted key of its own; a caller that wants a ranker supplies
 * one, and a missing one throws BEFORE any call it could have made. */
export class GroundingError extends Error {
  readonly kind: "malformed" | "ranker-missing";
  constructor(kind: GroundingError["kind"], detail: string) {
    super(detail);
    this.name = "GroundingError";
    this.kind = kind;
  }
}

/** Options sorted most-likely first. Hosted probabilities come back in
 * shuffled key order, so never read them positionally. */
export function rankedProbabilities(answer: GroundingAnswer): Array<{ key: string; probability: number }> {
  return Object.entries(answer.probabilities ?? {})
    .sort(([lhsKey, lhsValue], [rhsKey, rhsValue]) =>
      lhsValue === rhsValue ? lhsKey.localeCompare(rhsKey) : rhsValue - lhsValue)
    .map(([key, probability]) => ({ key, probability }));
}

/** The number to threshold on. `confidence` is chance-corrected and shifts
 * as the candidate count changes between steps; this does not. */
export function topProbability(answer: GroundingAnswer): number {
  return rankedProbabilities(answer)[0]?.probability ?? 0;
}

/** How far clear the winner is of the runner-up — a better "should I act"
 * signal than either probability alone when two candidates are close. */
export function margin(answer: GroundingAnswer): number {
  const sorted = rankedProbabilities(answer);
  if (sorted.length < 2) return sorted[0]?.probability ?? 0;
  return sorted[0].probability - sorted[1].probability;
}

/** What one grounding call decided about one screen. */
export interface GroundingDecision {
  /** Probability the task is already finished. */
  done: number;
  /** Probability that nothing on screen can advance the task. */
  absent: number;
  /** Candidates, most likely first. The `__none__` escape hatch is removed. */
  ranked: Array<{ candidate: ScreenTargetCandidate; probability: number }>;
  actionKind: ActionKind;
  /** True when the ranker's own top pick was the "none of these" option. */
  choseNone: boolean;
  metrics: GroundingCallMetrics;
}

/** Why the loop must stop instead of acting: `target_absent` (escape hatch),
 * `no_candidates` (nothing survived dedup/exclusions), plus the guardrail
 * vocabulary `step_budget` / `app_changed` / `cancelled` used by
 * server/desktop-guardrails.ts. */
export type StopReason = "target_absent" | "no_candidates" | "step_budget" | "app_changed" | "cancelled";

export function stopReasonOf(decision: GroundingDecision): StopReason | null {
  if (decision.choseNone) return "target_absent";
  if (!decision.ranked.length) return "no_candidates";
  return null;
}

/** The ranker's first pick, with `__none__` already dropped. When the stop
 * reason is `target_absent` this is the runner-up — for evidence only; the
 * loop must stop, NOT click it. */
export function bestTarget(decision: GroundingDecision): { candidate: ScreenTargetCandidate; probability: number } | null {
  return decision.ranked[0] ?? null;
}

/** Identical descriptions must be collapsed before asking: on a true tie the
 * hosted ranker does not report 50/50, it breaks toward the first key and
 * still reports high confidence — discrimination it did not do. Also drops
 * empty IDs and the reserved `__none__` ID, and repeats of an ID already
 * seen, so a duplicate can never crash or double-key the criteria map. */
export function deduplicateTargets(candidates: ScreenTargetCandidate[]): ScreenTargetCandidate[] {
  const seenIds = new Set<string>();
  const seenDescriptions = new Set<string>();
  const kept: ScreenTargetCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.id || candidate.id === NONE_KEY) continue;
    if (seenIds.has(candidate.id)) continue;
    if (seenDescriptions.has(describeTarget(candidate))) continue;
    seenIds.add(candidate.id);
    seenDescriptions.add(describeTarget(candidate));
    kept.push(candidate);
  }
  return kept;
}

/** The whole ask for one loop step: one `choice` over the candidates plus
 * three cheap companions, bundled into one call because the state is billed
 * once and latency scales with question count, not option count. Returns
 * null when nothing survives — a caller must never ask an empty question. */
export function buildGroundingRequest(input: {
  task: string;
  candidates: ScreenTargetCandidate[];
  history?: string[];
  excluding?: Iterable<string>;
}): GroundingRequest | null {
  const excluded = new Set(input.excluding ?? []);
  const pool = deduplicateTargets(input.candidates)
    .filter((candidate) => !excluded.has(candidate.id))
    .slice(0, MAX_CANDIDATES);
  if (!pool.length) return null;

  const criteria: Record<string, string> = {};
  for (const candidate of pool) criteria[candidate.id] = describeTarget(candidate);
  criteria[NONE_KEY] = "None of these would advance the task — the control needed is not on screen";

  const history = input.history ?? [];
  const state: GroundingState = {
    task: input.task,
    step: history.length + 1,
    already_done: history.length ? history : ["nothing yet"],
    screen_elements: pool.map((candidate) => ({ id: candidate.id, describes: describeTarget(candidate) })),
  };

  const questions = {
    done: {
      type: "noul",
      instructions: `Judging only by what is on screen now and the actions already taken, has this task been completed: "${input.task}"?`,
    },
    absent: {
      type: "noul",
      instructions: "Is the control needed to make the next bit of progress on the task missing from the elements on screen?",
    },
    pick: {
      type: "choice",
      instructions: `Which single element should be acted on next to make progress on the task: "${input.task}"? Consider what has already been done; do not repeat a step that already succeeded.`,
      criteria,
    },
    kind: {
      type: "choice",
      instructions: "How should that element be acted on?",
      criteria: {
        click: "A normal single left click — the default for buttons, menus, links, list rows",
        double_click: "Double click — opening a file or folder from a list",
        right_click: "Right click to open a context menu",
      },
    },
  } satisfies GroundingQuestions;
  return { state, questions, pool };
}

/** One probability read back off the wire. The value arrives as decoded
 * ranker JSON, so its declared type is only a claim until it is checked:
 * a missing field is rejected first, then `Number.isFinite` rejects every
 * non-number — strings, null, booleans — without coercing, and the range
 * check runs only on what it accepted. The parameter is typed the way its
 * callers hand it over (a field that may be missing), which is also what
 * makes it a usable type guard. */
const isFiniteProbability = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;

/** Read one ranker response back into a decision. Rejects anything
 * malformed: an unknown/invented target, an out-of-range or non-finite
 * probability, a chosen probability that is not the maximum, an invalid
 * action kind, or an incomplete response. Ties honor the reported choice. */
export function decodeDecision(input: {
  answers: GroundingAnswers;
  pool: ScreenTargetCandidate[];
  metrics: GroundingCallMetrics;
}): GroundingDecision {
  const { answers, pool, metrics } = input;
  const malformed = () => new GroundingError("malformed", "incomplete or invalid decision");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the ranker reply is untyped JSON; this check IS the boundary decode that routes a scalar/array answer to the malformed error before any field is read from it
  if (!answers || typeof answers !== "object") throw malformed();

  const pick = answers["pick"];
  const choice = pick?.choice;
  const inPool = (key: string | undefined): key is string =>
    !!key && (key === NONE_KEY || pool.some((candidate) => candidate.id === key));
  if (!inPool(choice)) throw malformed();

  const done = answers["done"]?.noul;
  if (!isFiniteProbability(done)) throw malformed();
  const absent = answers["absent"]?.noul;
  if (!isFiniteProbability(absent)) throw malformed();

  const actionKind = answers["kind"]?.choice;
  if (!isActionKind(actionKind)) throw malformed();

  const probabilities = pick?.probabilities;
  if (!probabilities || !Object.keys(probabilities).length) throw malformed();
  const values = Object.values(probabilities);
  if (!values.every(isFiniteProbability)) throw malformed();
  if (!Object.keys(probabilities).every((key) => inPool(key))) throw malformed();
  const chosenProbability = probabilities[choice!];
  const max = Math.max(...values);
  if (chosenProbability !== max) throw malformed();

  const byId = new Map(pool.map((candidate) => [candidate.id, candidate]));
  const ranked = rankedProbabilities(pick!)
    .sort((lhs, rhs) => {
      if (lhs.probability !== rhs.probability) return lhs.probability > rhs.probability ? -1 : 1;
      if (lhs.key === choice) return -1;
      if (rhs.key === choice) return 1;
      return lhs.key.localeCompare(rhs.key);
    })
    .flatMap((entry) => {
      const candidate = byId.get(entry.key); // drops __none__
      return candidate ? [{ candidate, probability: entry.probability }] : [];
    });

  return {
    done,
    absent,
    ranked,
    actionKind,
    choseNone: choice === NONE_KEY,
    metrics,
  };
}

/** A caller-supplied ranker. Muster's own model or a hosted one — this
 * module never holds a key, so wiring a hosted key to a user is an owner
 * decision, not something this file can do. */
export type GroundingRanker = (
  request: Pick<GroundingRequest, "state" | "questions">,
) => Promise<GroundingAnswers> | GroundingAnswers;

/** Build the ask, run it through the supplied ranker, decode strictly. The
 * missing-ranker case throws BEFORE the ranker could have been called, so a
 * missing key can never become a request (upstream's missing-key rule). */
export async function groundDecision(input: {
  task: string;
  candidates: ScreenTargetCandidate[];
  history?: string[];
  excluding?: Iterable<string>;
  ranker?: GroundingRanker | null;
  metrics?: GroundingCallMetrics;
}): Promise<GroundingDecision> {
  const request = buildGroundingRequest(input);
  if (!request) throw new GroundingError("malformed", "no candidates to ground against");
  const ranker = input.ranker;
  if (!ranker) throw new GroundingError("ranker-missing", "no grounding ranker supplied — failing before any call");
  const started = Date.now();
  const raw = await ranker({ state: request.state, questions: request.questions });
  const metrics = input.metrics ?? {
    milliseconds: Date.now() - started,
    inputTokens: 0,
    model: "caller-supplied",
  };
  return decodeDecision({ answers: raw, pool: request.pool, metrics });
}

// ── continuity ────────────────────────────────────────────────────────
// Adapted from tiptour-macos `Perception/LocalTargetContinuity.swift`
// (MIT, see header): the same control matched across small detector jitter,
// so a stale box can never become a different click.

/** Bounding box as [x1, y1, x2, y2]; the same shape upstream passes in. */
export type Box = [number, number, number, number] | number[];

const validBox = (box: Box | undefined): box is [number, number, number, number] =>
  !!box && box.length === 4 && box.every((value) => Number.isFinite(value));

/** Matches a previously selected control across small detector geometry
 * changes: same label, same source, same display, and box IoU ≥ 0.6. */
export function targetContinuityMatches(current: {
  label: string;
  source: string;
  box: Box;
  display: number[];
  previousLabel: string;
  previousSource: string;
  previousBox: Box;
  previousDisplay: number[];
}): boolean {
  const { label, source, box, display, previousLabel, previousSource, previousBox, previousDisplay } = current;
  if (label !== previousLabel || source !== previousSource) return false;
  if (display.length !== previousDisplay.length || display.some((v, i) => v !== previousDisplay[i])) return false;
  if (!validBox(box) || !validBox(previousBox)) return false;

  const width = (b: number[]) => b[2] - b[0];
  const height = (b: number[]) => b[3] - b[1];
  if (width(box) <= 0 || height(box) <= 0 || width(previousBox) <= 0 || height(previousBox) <= 0) return false;

  const x1 = Math.max(box[0], previousBox[0]);
  const y1 = Math.max(box[1], previousBox[1]);
  const x2 = Math.min(box[2], previousBox[2]);
  const y2 = Math.min(box[3], previousBox[3]);
  if (x2 <= x1 || y2 <= y1) return false;
  const intersectionArea = (x2 - x1) * (y2 - y1);
  const unionArea = width(box) * height(box) + width(previousBox) * height(previousBox) - intersectionArea;
  return unionArea > 0 && intersectionArea / unionArea >= 0.6;
}
