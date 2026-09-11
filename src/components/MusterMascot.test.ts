import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AGENT_COLORS, type AgentState } from "@/lib/mascot";
import { AgentAvatar } from "./Avatar";
import { MusterBloom } from "./MusterBloom";
import { MusterMascot } from "./MusterMascot";
import { MusterbotMark } from "./MusterbotMark";
import { StarTeammate } from "./StarTeammate";

const render = (element: ReactElement) => renderToStaticMarkup(element);
const body = (markup: string) => {
  const match = /<path d="([^"]+)" fill="([^"]+)"/.exec(markup);
  expect(match).not.toBeNull();
  return { path: match![1], fill: match![2] };
};

describe("the shared Muster mascot", () => {
  it("keeps one authored flower across the flower-based surfaces", () => {
    const surfaces = [
      createElement(MusterMascot),
      createElement(StarTeammate, { color: "orange" }),
    ];
    const bodies = surfaces.map((surface) => body(render(surface)));
    expect(new Set(bodies.map((entry) => entry.path)).size).toBe(1);
    for (const entry of bodies) {
      expect(entry.path).toMatch(/^M92\.79 0\.33C91\.27/);
      expect(entry.fill).toBe("#f08a24");
    }
  });

  it("renders brand surfaces as the musterbot blob mark in brand orange", () => {
    for (const surface of [
      createElement(MusterBloom, { interactive: false }),
      createElement(MusterbotMark),
    ]) {
      const markup = render(surface);
      expect(markup).toContain('stop-color="#f08a24"');
      expect(markup).not.toMatch(/^M92\.79 0\.33C91\.27/);
      expect(markup).toContain("<ellipse");
    }
  });

  it("preserves the supplied eye proportions, placement, lean, and offwhite fill", () => {
    const markup = render(createElement(MusterMascot, { size: 96 }));
    expect(markup).toContain('width="96" height="96" viewBox="-112 -112 224 224"');
    expect(markup).toContain('transform="translate(-15 -2) rotate(-4)"');
    expect(markup).toContain('transform="translate(38 -6) rotate(-4)"');
    const eyes = markup.match(/<rect[^>]+>/g) ?? [];
    expect(eyes).toHaveLength(2);
    for (const eye of eyes) {
      expect(eye).toContain('x="-10.5" y="-22" width="21" height="44" rx="10.5" fill="#f9f9f9"');
    }
    expect(markup).not.toMatch(/<mask|<linearGradient/);
  });

  it("keeps customized teammate colors while normalizing the orange brand color", () => {
    for (const [color, fill] of Object.entries(AGENT_COLORS)) {
      // SAFETY: Object.entries enumerates this closed AgentColor palette.
      const paletteColor = color as keyof typeof AGENT_COLORS;
      const markup = render(createElement(StarTeammate, { color: paletteColor }));
      expect(body(markup).fill).toBe(color === "orange" ? "#f08a24" : fill);
    }
  });

  it.each([
    { expected: "closed", states: ["sleeping", "powering-down", "drowsy"] },
    { expected: "happy", states: ["happy", "excited", "celebrate", "playful", "laughing", "proud"] },
    { expected: "open", states: ["idle", "working", "thinking", "alerting"] },
  ] satisfies Array<{ expected: string; states: AgentState[] }>)("preserves the $expected expression family", ({ expected, states }) => {
    for (const state of states) {
      const markup = render(createElement(StarTeammate, { color: "orange", state }));
      expect(markup).toContain(`data-eyes="${expected}"`);
      if (expected === "open") expect(markup.match(/<rect /g)).toHaveLength(2);
      else {
        expect(markup).not.toContain("<rect");
        expect(markup.match(/stroke="#f9f9f9"/g)).toHaveLength(2);
      }
    }
  });

  it("keeps happy eyes on the blob mark for the happy mood", () => {
    // Happy eyes are stroked arcs; open eyes are ellipses.
    // Happy eyes are stroked arcs; open eyes are ellipses. The body keeps
    // one white highlight ellipse either way, so count them.
    const happy = render(createElement(MusterBloom, { mood: "happy", interactive: false }));
    expect(happy).not.toContain("<ellipse");
    expect(happy.match(/stroke="#f9f9f9"/g)).toHaveLength(3);
    const idle = render(createElement(MusterBloom, { mood: "idle", interactive: false }));
    expect(idle).toContain("<ellipse");
  });

  it("keeps blob avatars deterministic per seed and state-mapped", () => {
    const a = render(createElement(AgentAvatar, { color: "green", character: "blob", seed: "scout" }));
    const b = render(createElement(AgentAvatar, { color: "green", character: "blob", seed: "scout" }));
    expect(a).toBe(b);
    const other = render(createElement(AgentAvatar, { color: "green", character: "blob", seed: "pilot" }));
    expect(other).not.toBe(a);
    const happy = render(createElement(AgentAvatar, { color: "green", character: "blob", seed: "scout", state: "happy" }));
    // Highlight ellipse only — the happy eyes are stroked arcs.
    expect(happy.match(/<ellipse/g)).toHaveLength(1);
  });

  it("keeps noninteractive marks static unless motion is explicitly requested", () => {
    for (const surface of [
      createElement(MusterMascot),
      createElement(MusterbotMark),
      createElement(MusterBloom, { interactive: false }),
      createElement(StarTeammate, { color: "orange" }),
    ]) {
      const markup = render(surface);
      expect(markup).not.toContain("musterbot-wobble");
      expect(markup).not.toContain("data-wave");
      expect(markup).not.toContain("<button");
    }
    expect(render(createElement(MusterBloom, { interactive: false, animated: true }))).toContain("musterbot-wobble");
    expect(render(createElement(StarTeammate, { color: "orange", animated: true }))).toContain('data-animated="true"');
  });

  it("exposes interaction as one native keyboard-operable button with a decorative SVG", () => {
    const markup = render(createElement(MusterBloom));
    expect(markup.match(/<button /g)).toHaveLength(1);
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*aria-label="Wave to Muster"/);
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(markup).not.toContain('role="img"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("musterbot-wobble");
  });

  it("honors an explicit static setting on an interactive mascot", () => {
    const markup = render(createElement(MusterBloom, { interactive: true, animated: false }));
    expect(markup).toContain('aria-label="Wave to Muster"');
    expect(markup).not.toContain("musterbot-wobble");
  });

  it("names informative images and hides unlabeled teammate decoration", () => {
    const named = render(createElement(StarTeammate, { color: "blue", label: "Scout <reviewer>" }));
    expect(named).toContain('role="img" aria-label="Scout &lt;reviewer&gt;"');
    expect(named).not.toContain("<button");
    expect(named).not.toContain('aria-hidden="true"');
    const decoration = render(createElement(StarTeammate, { color: "blue" }));
    expect(decoration).toContain('aria-hidden="true"');
    expect(decoration).not.toContain('role="img"');
    const wordmark = render(createElement(MusterbotMark, { wordmark: true }));
    expect(wordmark).toContain('aria-label="Muster teammate"');
    expect(wordmark).toMatch(/<span aria-hidden="true"[^>]*>MUSTER<\/span>/);
  });

  it("leaves explicitly chosen non-star avatar silhouettes available", () => {
    const starBody = body(render(createElement(StarTeammate, { color: "orange" }))).path;
    for (const character of ["hexagon", "cursor"] as const) {
      const markup = render(createElement(AgentAvatar, { color: "orange", character, animated: false }));
      expect(markup).toContain("<svg");
      expect(markup).not.toContain(starBody);
    }
  });
});
