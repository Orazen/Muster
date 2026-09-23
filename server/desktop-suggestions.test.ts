// Pins for the grounded suggested-action list: tool gating, candidate
// construction from detections (never invented), deterministic ranking, the
// protected-control product rule, the element-source fail-safe, and the
// "the card stays the only actuator" contract. Pure — no I/O.
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_SUGGESTIONS,
  actionKindFor,
  desktopElementsFor,
  groundDesktopSuggestions,
  isGroundableDesktopTool,
  isProtectedControl,
  proposedLabel,
  setDesktopElementSource,
  suggestionCardPatch,
  toCandidates,
  type DesktopElement,
} from "./desktop-suggestions.ts";

const elements: DesktopElement[] = [
  { ref: "b1", role: "button", name: "Save" },
  { ref: "b2", role: "button", name: "Cancel" },
  { ref: "b3", role: "link", name: "Save drafts" },
  { ref: "b4", role: "button", name: "Delete all", disabled: true },
  { ref: "b5", role: "button", name: "Enter password" },
];

afterEach(() => setDesktopElementSource(null));

describe("tool gating", () => {
  it("grounds pointer steps only, through the MCP prefix", () => {
    expect(isGroundableDesktopTool("click")).toBe(true);
    expect(isGroundableDesktopTool("mcp__ogb__computer_click")).toBe(true);
    expect(isGroundableDesktopTool("browser_click")).toBe(true);
    for (const tool of ["Bash", "computer_exec", "type_text", "scroll", "open_url", "browser_fill", ""]) {
      expect(isGroundableDesktopTool(tool)).toBe(false);
    }
  });

  it("grounds to nothing for a non-pointer ask so the card stays as it is today", () => {
    expect(groundDesktopSuggestions({ tool: "computer_exec", summary: 'run "rm -rf /tmp/x"', elements })).toEqual([]);
    expect(groundDesktopSuggestions({ tool: "click", summary: "click it", elements: [] })).toEqual([]);
  });
});

describe("actionKindFor", () => {
  it("takes the kind from the tool first, then the summary, then clicks", () => {
    expect(actionKindFor("right_click", "click the thing")).toBe("right_click");
    expect(actionKindFor("click", "right-click the row")).toBe("right_click");
    expect(actionKindFor("click", "double-click the folder")).toBe("double_click");
    expect(actionKindFor("mcp__ogb__browser_click", "open it")).toBe("click");
  });
});

describe("proposedLabel", () => {
  it("reads the quoted control the bot means", () => {
    expect(proposedLabel('click the "Save" button')).toBe("save");
    expect(proposedLabel("click the 'Save drafts' link")).toBe("save drafts");
    expect(proposedLabel("click at (412, 88)")).toBe("");
  });
});

describe("toCandidates", () => {
  it("drops blank ids and blank names, and labels the source honestly", () => {
    expect(toCandidates([
      { ref: "b1", name: "Save" },
      { name: "No id" },
      { ref: "b2", name: "   " },
      { id: "d1", name: "Dock item" },
    ])).toEqual([
      { id: "b1", label: "Save", source: "browser" },
      { id: "d1", label: "Dock item", source: "screen" },
    ]);
  });
});

describe("groundDesktopSuggestions", () => {
  it("ranks the exact named control first and never falls back to a nearby label", () => {
    const suggestions = groundDesktopSuggestions({
      tool: "click",
      summary: 'click the "Save" button',
      elements,
    });
    expect(suggestions[0]).toEqual({ id: "b1", label: "Save", source: "browser", actionKind: "click" });
    // "Save drafts" is a NEARBY label, not the exact one — behind, not instead
    expect(suggestions.findIndex((s) => s.id === "b3")).toBeGreaterThan(0);
  });

  it("matches a bot that names the exact target id instead of a label", () => {
    const suggestions = groundDesktopSuggestions({ tool: "click", summary: "click target b3", elements });
    expect(suggestions[0].id).toBe("b3");
  });

  it("never suggests protected or disabled controls", () => {
    const suggestions = groundDesktopSuggestions({ tool: "click", summary: "click anything", elements });
    const labels = suggestions.map((s) => s.label);
    expect(labels).not.toContain("Delete all");   // disabled
    expect(labels).not.toContain("Enter password"); // protected
    expect(suggestions.some((s) => s.id === "b5")).toBe(false);
    expect(isProtectedControl("Enter password")).toBe(true);
    expect(isProtectedControl("Payment details")).toBe(true);
    expect(isProtectedControl("I agree to the terms")).toBe(true);
    expect(isProtectedControl("Save")).toBe(false);
    expect(isProtectedControl("Reauthorize the app")).toBe(false);
  });

  it("offers a bounded, deterministic choice list", () => {
    const many: DesktopElement[] = Array.from({ length: 30 }, (_, i) => ({ ref: `b${i}`, name: `Item ${i}` }));
    const first = groundDesktopSuggestions({ tool: "click", summary: "click something", elements: many });
    const again = groundDesktopSuggestions({ tool: "click", summary: "click something", elements: many });
    expect(first).toHaveLength(MAX_SUGGESTIONS);
    expect(first).toEqual(again);
  });

  it("keeps only inert fields on every suggestion", () => {
    const suggestions = groundDesktopSuggestions({ tool: "click", summary: 'click "Save"', elements });
    for (const suggestion of suggestions) {
      expect(Object.keys(suggestion).sort()).toEqual(["actionKind", "id", "label", "source"]);
    }
  });
});

describe("element source", () => {
  it("answers empty when no producer is registered", () => {
    expect(desktopElementsFor("thread-1")).toEqual([]);
  });

  it("uses the registered producer", () => {
    setDesktopElementSource((threadId) => (threadId === "t1" ? elements : null));
    expect(desktopElementsFor("t1")).toHaveLength(elements.length);
    expect(desktopElementsFor("other")).toEqual([]);
  });

  it("never lets a failing producer block an ask", () => {
    setDesktopElementSource(() => { throw new Error("driver gone"); });
    expect(desktopElementsFor("t1")).toEqual([]);
  });
});

describe("suggestionCardPatch", () => {
  it("adds only `suggestions` — never an answer, never a changed option list", () => {
    const suggestions = groundDesktopSuggestions({ tool: "click", summary: 'click "Save"', elements });
    const card = { title: "Approval needed", subtitle: "click (412, 88)", options: ["Allow", "Deny"], ...suggestionCardPatch(suggestions) };
    expect(card.options).toEqual(["Allow", "Deny"]);
    expect("answered" in card).toBe(false);
    // exact "Save" first, then the nearby "Save drafts" as a clearly-labeled
    // second choice — a suggestion, never a silent substitution
    expect(card.suggestions).toHaveLength(2);
    expect(card.suggestions![0].label).toBe("Save");
  });

  it("adds nothing when there is nothing grounded", () => {
    expect(suggestionCardPatch([])).toEqual({});
  });
});
