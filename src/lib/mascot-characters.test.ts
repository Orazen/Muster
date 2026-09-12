import { describe, expect, it } from "vitest";
import { AGENT_CHARACTERS } from "./mascot";
import { AGENT_CHARACTERS as SHARED_CHARACTERS, type AgentCharacter } from "../../server/agent-character";

describe("shared mascot characters", () => {
  it("uses the server's browser-safe vocabulary without changing picker ordering", () => {
    expect(AGENT_CHARACTERS).toBe(SHARED_CHARACTERS);
    expect(AGENT_CHARACTERS).toEqual([
      "flower", "star", "blob", "cursor", "hexagon", "triangle", "egg", "drop", "heart",
      "pebble", "squircle", "capsule", "cloud", "ball", "sparkle", "circle",
    ]);
    expect(new Set(AGENT_CHARACTERS).size).toBe(AGENT_CHARACTERS.length);
  });

  it("keeps legacy Lottie typed but hidden from new selection", () => {
    const legacy: AgentCharacter = "lottie";
    expect(AGENT_CHARACTERS.includes(legacy)).toBe(false);
  });
});
