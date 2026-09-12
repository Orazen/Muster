// Browser-safe character vocabulary shared by the picker and PATCH boundary.
// Keep this order stable: Flower is first, followed by the existing choices.
const characterNames = [
  "flower", "star", "blob", "cursor", "hexagon", "triangle", "egg", "drop", "heart",
  "pebble", "squircle", "capsule", "cloud", "ball", "sparkle", "circle",
] as const;

// Existing saved Lottie characters still render, but are not offered for new
// selection or accepted by the appearance PATCH endpoint.
export type AgentCharacter = (typeof characterNames)[number] | "lottie";
export const AGENT_CHARACTERS: readonly AgentCharacter[] = characterNames;
