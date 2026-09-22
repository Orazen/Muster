import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AGENT_COLORS } from "@/lib/mascot";
import { AgentAvatar } from "./Avatar";
import { AgentBotAvatar } from "./AgentBotAvatar";
import { MusterBloom } from "./MusterBloom";
import { MusterMascot, MUSTER_BODY, MUSTER_EYES, MUSTER_ORANGE } from "./MusterMascot";
import { MusterbotMark } from "./MusterbotMark";

const render = (element: ReactElement) => renderToStaticMarkup(element);

const attr = (markup: string, name: string) =>
  markup.match(new RegExp(`${name}="([^"]*)"`))?.[1];

describe("the brand export contract", () => {
  // scripts/make-brand-icons.mjs reads these three lines with the same regex —
  // if it stops matching, brand icons silently stop building.
  const source = readFileSync(new URL("./MusterMascot.tsx", import.meta.url), "utf8");
  const grab = (name: string) => source.match(new RegExp(`export const ${name} = "([^"]+)"`))?.[1];

  it("keeps the three script-readable exports on one line each", () => {
    expect(grab("MUSTER_BODY")).toBe(MUSTER_BODY);
    expect(grab("MUSTER_ORANGE")).toBe(MUSTER_ORANGE);
    expect(grab("MUSTER_EYES")).toBe(MUSTER_EYES);
    expect(MUSTER_ORANGE).toBe("#f08a24");
    expect(MUSTER_EYES).toBe("#f9f9f9");
    expect(MUSTER_BODY).toMatch(/^M92\.79 0\.33C91\.27/);
  });
});

describe("MusterMascot", () => {
  it("draws the flower through the shared bot-avatars adapter", () => {
    const markup = render(createElement(MusterMascot, { size: 96, label: "Muster" }));
    expect(markup).toContain('data-bot-avatar="flower"');
    expect(markup).toContain('data-bot-color="#f08a24"');
    expect(markup).toContain('aria-label="Muster"');
    // the library pads its canvas by its overscan span (1.5× the size prop)
    expect(markup).toContain(`width:${96 * 1.5}px`);
    expect(markup).not.toContain("<svg");
  });

  it("maps its moods onto the library's two faces", () => {
    expect(attr(render(createElement(MusterMascot)), "data-face")).toBe("eyes");
    expect(attr(render(createElement(MusterMascot, { eyes: "happy" })), "data-face")).toBe("mouth");
    expect(attr(render(createElement(MusterMascot, { eyes: "closed" })), "data-state")).toBe("sleeping");
  });

  it("renders static by default and pauses under reduced motion", () => {
    const still = render(createElement(MusterMascot));
    expect(still).toContain('data-bot-paused="true"');

    // SAFETY: prefersReducedMotion only reads window.matchMedia, so a minimal
    // stub is enough — torn down immediately so no other test can see it.
    Object.assign(globalThis, { window: { matchMedia: () => ({ matches: true }) } });
    try {
      const reduced = render(createElement(MusterMascot, { animated: true }));
      expect(reduced).toContain('data-bot-paused="true"');
    } finally {
      Reflect.deleteProperty(globalThis, "window");
    }

    const moving = render(createElement(MusterMascot, { animated: true }));
    expect(moving).not.toContain("data-bot-paused");
  });

  it("hides the unlabelled mark as decoration and names the labelled one", () => {
    const decoration = render(createElement(MusterMascot, { color: "blue" }));
    expect(decoration).toContain('aria-hidden="true"');
    expect(attr(decoration, "aria-label")).not.toBe("Muster");
    const named = render(createElement(MusterMascot, { label: "Scout <reviewer>" }));
    expect(named).not.toContain("aria-hidden");
    expect(named).toContain('aria-label="Scout &lt;reviewer&gt;"');
  });
});

describe("brand surfaces", () => {
  it("renders MusterBloom and MusterbotMark as the canonical flower in brand orange", () => {
    for (const surface of [
      createElement(MusterBloom, { interactive: false }),
      createElement(MusterbotMark),
    ]) {
      const markup = render(surface);
      expect(markup).toContain('data-bot-avatar="flower"');
      expect(markup).toContain('data-bot-color="#f08a24"');
      expect(attr(markup, "data-face")).toBe("eyes");
    }
  });

  it("flips the bloom to its mouth face while happy", () => {
    const happy = render(createElement(MusterBloom, { mood: "happy", interactive: false }));
    expect(attr(happy, "data-face")).toBe("mouth");
    const idle = render(createElement(MusterBloom, { mood: "idle", interactive: false }));
    expect(attr(idle, "data-face")).toBe("eyes");
  });

  it("exposes interaction as one native keyboard-operable button with a live region", () => {
    const markup = render(createElement(MusterBloom));
    expect(markup.match(/<button /g)).toHaveLength(1);
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*aria-label="Wave to Muster"/);
    expect(markup).toContain('role="status"');
    // the avatar inside the button is decoration — the button names it
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toMatch(/class="muster-bloom[ "]/);
  });

  it("names a noninteractive mark and keeps the wordmark decorative", () => {
    const markup = render(createElement(MusterbotMark, { wordmark: true }));
    expect(markup).toContain('aria-label="Muster teammate"');
    expect(markup).not.toContain("<button");
    expect(markup).toContain("MUSTER");
    expect(markup).toContain('data-bot-paused="true"');
  });
});

describe("the AgentAvatar funnel", () => {
  it("keeps avatars deterministic per seed and state-mapped", () => {
    const props = { color: "green", character: "blob", seed: "scout" } as const;
    expect(render(createElement(AgentAvatar, props))).toBe(render(createElement(AgentAvatar, props)));
    // a different seed picks a different body for an unmapped character
    const scout = attr(render(createElement(AgentBotAvatar, { seed: "scout" })), "data-bot-avatar");
    const pilot = attr(render(createElement(AgentBotAvatar, { seed: "pilot" })), "data-bot-avatar");
    expect(scout).toBeDefined();
    expect(pilot).toBeDefined();
    const happy = render(createElement(AgentAvatar, { ...props, state: "happy" as const }));
    expect(attr(happy, "data-state")).toBe("default");
    const busy = render(createElement(AgentAvatar, { ...props, state: "working" }));
    expect(attr(busy, "data-state")).toBe("working");
    const asleep = render(createElement(AgentAvatar, { ...props, state: "sleeping" }));
    expect(attr(asleep, "data-state")).toBe("sleeping");
  });

  it("resolves palette names to the library's colours", () => {
    // SAFETY: Object.keys returns strings, and every AGENT_COLORS value is a
    // valid CSS colour the library accepts — the loop only needs the key type.
    for (const name of Object.keys(AGENT_COLORS) as (keyof typeof AGENT_COLORS)[]) {
      const markup = render(createElement(AgentAvatar, { color: name, seed: "scout" }));
      expect(attr(markup, "data-bot-color")).toBe(AGENT_COLORS[name]);
    }
  });

  it("keeps non-flower characters available as distinct bodies", () => {
    const flower = render(createElement(AgentAvatar, { color: "orange", character: "flower", animated: false }));
    const flowerType = attr(flower, "data-bot-avatar");
    for (const character of ["hexagon", "cursor", "star"] as const) {
      const markup = render(createElement(AgentAvatar, { color: "orange", character, animated: false }));
      expect(markup).toContain("<canvas");
      expect(attr(markup, "data-bot-avatar")).not.toBe(flowerType);
    }
    expect(flowerType).toBe("flower");
    expect(attr(render(createElement(AgentAvatar, { color: "orange", character: "cursor" })), "data-bot-avatar")).toBe("circle");
  });

  it("marks a frozen avatar as paused and a live one as running", () => {
    expect(render(createElement(AgentAvatar, { color: "green", animated: false }))).toContain(
      'data-bot-paused="true"',
    );
    expect(render(createElement(AgentAvatar, { color: "green", animated: true }))).not.toContain(
      "data-bot-paused",
    );
  });
});

describe("AgentBotAvatar", () => {
  it("draws exactly one canvas per call", () => {
    const markup = render(createElement(AgentBotAvatar, { color: "green", size: 32 }));
    expect(markup.match(/<canvas/g)).toHaveLength(1);
    expect(markup).toContain('class="inline-flex shrink-0"');
  });
});
