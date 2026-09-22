import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentBotAvatar,
  CHARACTER_TYPES,
  SLEEPING_STATES,
  WORKING_STATES,
  botAvatarSeed,
  botAvatarState,
  botAvatarTypeForSeed,
} from "./AgentBotAvatar";
import { AGENT_STATES } from "@/lib/mascot";
import { CURSOR_STATES } from "./CursorAvatar";

const render = (element: ReactElement) => renderToStaticMarkup(element);

describe("botAvatarState", () => {
  it("maps every state in the mascot vocabulary onto one of the library's three", () => {
    const buckets = new Set<string>();
    for (const state of AGENT_STATES) buckets.add(botAvatarState(state));
    expect([...buckets].sort()).toEqual(["default", "sleeping", "working"]);
  });

  it("sends the asleep states to sleeping and the active ones to working", () => {
    for (const state of SLEEPING_STATES) expect(botAvatarState(state)).toBe("sleeping");
    for (const state of WORKING_STATES) expect(botAvatarState(state)).toBe("working");
  });

  it("rests reactions and unknown values at default instead of guessing", () => {
    expect(botAvatarState("happy")).toBe("default");
    expect(botAvatarState("alerting")).toBe("working");
    expect(botAvatarState("celebrate")).toBe("default");
    expect(botAvatarState(null)).toBe("default");
    expect(botAvatarState(undefined)).toBe("default");
    expect(botAvatarState("not a state")).toBe("default");
  });

  it("keeps the two buckets disjoint — a state never means two things", () => {
    for (const state of SLEEPING_STATES) expect(WORKING_STATES).not.toContain(state);
    expect(SLEEPING_STATES.length + WORKING_STATES.length).toBeLessThan(AGENT_STATES.length);
  });
});

describe("body choice", () => {
  it("gives every picker character a real body from the library", () => {
    const types = new Set(Object.values(CHARACTER_TYPES));
    expect(types.size).toBeGreaterThanOrEqual(10);
    for (const type of types) {
      expect([
        "clover", "flower", "triangle", "square", "blob", "ghost", "circle", "drop",
        "star", "droid", "mech", "alien", "hexagon", "cat", "cloud", "pill", "pebble", "puddle",
      ]).toContain(type);
    }
    expect(CHARACTER_TYPES.flower).toBe("flower");
    expect(CHARACTER_TYPES.lottie).toBe("flower");
  });

  it("hashes an identity to a stable body and phase", () => {
    expect(botAvatarTypeForSeed("scout")).toBe(botAvatarTypeForSeed("scout"));
    expect(botAvatarSeed("scout")).toBe(botAvatarSeed("scout"));
    expect(botAvatarSeed("scout")).not.toBe(botAvatarSeed("pilot"));
    expect(botAvatarSeed("scout")).toBeGreaterThanOrEqual(0);
    expect(botAvatarSeed("scout")).toBeLessThan(1);
  });
});

describe("the state vocabulary", () => {
  it("carries exactly 39 unique states — the union and the list agree", () => {
    expect(AGENT_STATES).toHaveLength(39);
    expect(new Set(AGENT_STATES).size).toBe(39);
    expect(CURSOR_STATES).toHaveLength(39);
    // SAFETY: membership in AGENT_STATES is exactly what defines AgentState.
    const asStates = AGENT_STATES as readonly string[];
    for (const state of [
      "idle", "working", "thinking", "sleeping", "happy", "alerting",
      "powering-down", "celebrate", "orbit", "dictating",
    ]) {
      expect(asStates).toContain(state);
    }
  });

  it("renders one canvas per state, bucketed into the library's three", () => {
    const buckets = new Set<string>();
    for (const state of AGENT_STATES) {
      const markup = render(createElement(AgentBotAvatar, { state, size: 24 }));
      expect(markup.match(/<canvas/g)).toHaveLength(1);
      const drawn = markup.match(/data-state="([^"]+)"/)?.[1];
      expect(["default", "working", "sleeping"]).toContain(drawn);
      buckets.add(drawn!);
    }
    expect([...buckets].sort()).toEqual(["default", "sleeping", "working"]);
  });
});

describe("AgentBotAvatar markup", () => {
  it("renders the library's canvas with an accessible name when labelled", () => {
    const markup = render(createElement(AgentBotAvatar, { color: "green", state: "working", size: 64, label: "Scout" }));
    expect(markup).toContain("<canvas");
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Scout"');
    expect(markup).not.toContain("aria-hidden");
  });

  it("hides an unlabelled avatar as decoration, as the old marks did", () => {
    const markup = render(createElement(AgentBotAvatar, { color: "blue", state: "idle" }));
    expect(markup).toContain('class="inline-flex shrink-0"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("<canvas");
  });

  it("pins the brand flower and exposes its colour and pause state", () => {
    const markup = render(
      createElement(AgentBotAvatar, { type: "flower", fill: "#f08a24", label: "Muster" }),
    );
    expect(markup).toContain('data-bot-avatar="flower"');
    expect(markup).toContain('aria-label="Muster"');
    expect(markup).toContain('data-bot-color="#f08a24"');
    expect(markup).not.toContain("data-bot-paused");
  });

  it("marks a frozen avatar as paused — animated off or reduced motion", () => {
    const still = render(createElement(AgentBotAvatar, { character: "blob", animated: false }));
    expect(still).toContain('data-bot-paused="true"');
    const moving = render(createElement(AgentBotAvatar, { character: "blob", animated: true }));
    expect(moving).not.toContain("data-bot-paused");
  });

  it("is byte-identical for identical inputs", () => {
    const props = { color: "orange" as const, character: "blob" as const, seed: "scout", size: 40 };
    expect(render(createElement(AgentBotAvatar, props))).toBe(render(createElement(AgentBotAvatar, props)));
  });
});
