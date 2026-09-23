// Grounded suggested-action list for approval cards — the target-picker
// half of the tiptour-macos integration (study slice 2).
//
// Adapted from tiptour-macos (github.com/milind-soni/tiptour-macos),
// MIT License — Copyright (c) 2026 Milind Soni, Portions Copyright (c) 2025
// Farza (Clicky). Their JEV grounding semantics live in
// server/desktop-grounding.ts; this file adds the Muster-facing half:
// candidate elements → ranked, grounded, human-only suggestion options on
// the existing OptionCard. Their operator rule is adopted as product copy:
// never suggest password, 2FA, payment, consent, or credential-finalization
// controls — a product rule, not a security claim.
//
// THE CARD STAYS THE ONLY ACTUATOR: this module only ever returns data.
// Nothing here answers, dismisses, or executes anything, and no caller may
// run a suggested desktop action without a human tap on the existing
// respond path. `autoDecision` (server/auto-approve.ts) is untouched and
// still the only non-human answer, scoped to routine tool-permission cards.
//
// Pure module: no I/O, no Electron/Express imports — same isolation rule as
// server/desktop-grounding.ts and server/jev-dispatch.ts.

import {
  type ActionKind,
  type ScreenTargetCandidate,
  deduplicateTargets,
} from "./desktop-grounding.ts";

/** How many grounded options one card may offer — a choice list, not a
 * dump of the screen. */
export const MAX_SUGGESTIONS = 5;

/** One detected control, in the shape computer-proxy.ts's semantic snapshot
 * already uses (`ref`/`role`/`name`/`disabled`) plus the optional CUA
 * desktop-state spellings (`id`, `source`) so either producer fits. */
export interface DesktopElement {
  ref?: string;
  id?: string;
  role?: string;
  name: string;
  disabled?: boolean;
  /** Detector that produced it ("ax" | "browser" | "yolo" | "ocr" | …). */
  source?: string;
}

/** One grounded option on the card. Deliberately inert: an id for the exact
 * target, a human label, where it came from, and how to act — no execution
 * affordance of any kind. */
export interface GroundedDesktopSuggestion {
  id: string;
  label: string;
  source: string;
  actionKind: ActionKind;
}

/** Adopted from the tiptour-macos agent contract as a product rule: these
 * controls are never OFFERED as suggestions (the human can still act on
 * them themselves). Literal by design — a suggestion list is not the place
 * to be clever about what a payment or consent control is called. */
const PROTECTED_CONTROL =
  /password|passcode|passphrase|passwd|two[-\s]?factor|\b2fa\b|one[-\s]?time (code|password)|\botp\b|credential|recovery code|seed phrase|private key|cvv|card number|payment|billing details|consent|i agree|accept (the )?(terms|privacy|cookies)|sign in with|\bauthorize\b/i;

export function isProtectedControl(label: string): boolean {
  return PROTECTED_CONTROL.test(label);
}

/** Bare tool name, MCP prefix stripped — the same normalization
 * server/auto-approve.ts's approvalKey uses so `mcp__ogb__computer_click`
 * and `computer_click` are one tool. */
export function bareTool(tool: string): string {
  return tool.replace(/^mcp__[^_]+__/, "").toLowerCase();
}

/** Pointer-step tools a grounded target actually informs. Type/scroll/bash
 * asks have no single control to choose, so they ground to nothing and the
 * card looks exactly as it does today. */
const GROUNDABLE_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "mouse_click",
  "computer_click",
  "browser_click",
  "element_click",
]);

export function isGroundableDesktopTool(tool: string): boolean {
  return GROUNDABLE_TOOLS.has(bareTool(tool));
}

/** How the bot proposed to act: the tool names it when it can, then the
 * summary's own words, then a normal left click. */
export function actionKindFor(tool: string, summary: string): ActionKind {
  const bare = bareTool(tool);
  if (bare.includes("right_click") || bare === "rightclick") return "right_click";
  if (bare.includes("double_click") || bare === "doubleclick") return "double_click";
  if (/\bright[-\s]?click\b|\bcontext menu\b/i.test(summary)) return "right_click";
  if (/\bdouble[-\s]?click\b/i.test(summary)) return "double_click";
  return "click";
}

const elementId = (element: DesktopElement): string => element.ref ?? element.id ?? "";

/** Detected elements → the grounding module's candidates. Blank names and
 * blank/duplicate ids are dropped before they can reach a decision. */
export function toCandidates(elements: DesktopElement[]): ScreenTargetCandidate[] {
  return elements
    .filter((element) => elementId(element).trim() && element.name.trim())
    .map((element) => ({
      id: elementId(element).trim(),
      label: element.name.replace(/\s+/g, " ").trim(),
      // a CDP ref comes from the browser tree; anything else is an unlabeled
      // desktop detection — say so honestly rather than naming a detector
      source: element.source ?? (element.ref ? "browser" : "screen"),
    }));
}

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

const tokens = (value: string) => normalize(value)
  .split(/[^a-z0-9]+/)
  .filter((token) => token.length >= 3);

/** The label the summary says it wants, if it names one (quoted first —
 * bots quote the control they mean). */
export function proposedLabel(summary: string): string {
  const quoted = summary.match(/["“'‘]([^"”'’]{1,80})["”'’]/);
  if (quoted?.[1]) return normalize(quoted[1]);
  return "";
}

/** Deterministic relevance: an exact label match outranks containment,
 * which outranks word overlap; ties fall to the id so two runs can never
 * disagree. Confidence is evidence only — never a cutoff. */
function scoreElement(candidate: ScreenTargetCandidate, want: string, summary: string): number {
  const label = normalize(candidate.label);
  if (want && (label === want || normalize(candidate.id) === want)) return 1000;
  // the bot naming the exact target id (a ref) outranks any label reading
  if (candidate.id.length >= 2 && normalize(summary).includes(normalize(candidate.id))) return 900;
  if (want && (label.includes(want) || want.includes(label))) return 500;
  const summaryWords = new Set(tokens(summary));
  const overlap = tokens(label).filter((token) => summaryWords.has(token)).length;
  return overlap * 50;
}

/**
 * Ground one proposed desktop step against real detected controls and return
 * the ranked choice list for the card.
 *
 * Candidates are BUILT FROM DETECTIONS, NEVER INVENTED — an empty element
 * list yields an empty (→ absent) suggestion field, which is exactly today's
 * card. Protected and disabled controls are dropped. Pure: returns data the
 * human chooses between; never answers the ask.
 */
export function groundDesktopSuggestions(input: {
  tool: string;
  summary: string;
  elements: DesktopElement[];
  max?: number;
}): GroundedDesktopSuggestion[] {
  const { tool, summary } = input;
  if (!isGroundableDesktopTool(tool)) return [];
  const candidates = deduplicateTargets(toCandidates(input.elements ?? []));
  if (!candidates.length) return [];
  const want = proposedLabel(summary);
  const actionKind = actionKindFor(tool, summary);
  const disabled = new Set((input.elements ?? []).filter((e) => e.disabled).map((e) => elementId(e).trim()));

  return candidates
    .filter((candidate) => !disabled.has(candidate.id))
    .filter((candidate) => !isProtectedControl(candidate.label))
    .map((candidate) => ({ candidate, score: scoreElement(candidate, want, summary) }))
    .filter((entry) => entry.score > 0 || !want) // a named target must be matched to be offered first
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
    .slice(0, Math.min(input.max ?? MAX_SUGGESTIONS, MAX_SUGGESTIONS))
    .map(({ candidate }) => ({
      id: candidate.id,
      label: candidate.label,
      source: candidate.source,
      actionKind,
    }));
}

// ── element source ────────────────────────────────────────────────────
// Candidate lists reach the server through a registered producer. None is
// registered by default: for This Mac, the CUA desktop state is read by the
// driver's own stdio MCP child process (server/local-computer.ts only reads
// the spawn descriptor), so the server process cannot fetch elements at card
// build time today. Until a producer lands, `desktopElementsFor` returns []
// and every card is byte-identically today's card — the pipeline ships
// complete and dormant rather than guessing at detections.

export type DesktopElementSource = (threadId: string) => DesktopElement[] | null | undefined;

let elementSource: DesktopElementSource | null = null;

/** Register (or clear, with null) where detected elements come from. */
export function setDesktopElementSource(source: DesktopElementSource | null): void {
  elementSource = source;
}

/** Elements for this thread, or [] on any failure — grounding must never
 * block, delay, or fail an ask. */
export function desktopElementsFor(threadId: string): DesktopElement[] {
  if (!elementSource) return [];
  try {
    return elementSource(threadId) ?? [];
  } catch {
    return [];
  }
}

/** The card payload field. Kept as its own function so the "never
 * auto-answered" contract is testable in isolation: it can only ever add
 * `suggestions`, never `answered`, never flip `options`. */
export function suggestionCardPatch(
  suggestions: GroundedDesktopSuggestion[],
): { suggestions?: GroundedDesktopSuggestion[] } {
  return suggestions.length ? { suggestions } : {};
}
