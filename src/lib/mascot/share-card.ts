// Share card — the mascot as a postcard (plan slice G, the LaoA delight
// idea, original implementation): a 1080×1440 PNG of your bot's current
// face, its narrated line and the Muster mark. Pure data here; the canvas
// render is a thin client of this shape so the card can be previewed in
// tests and re-rendered on any surface.
import { resolveCharacter, statusForBotActivity, type CharacterState } from "./character";

export const SHARE_CARD_WIDTH = 1080;
export const SHARE_CARD_HEIGHT = 1440;

export interface ShareCardData {
  /** The bot's display name, huge, at the top. */
  name: string;
  /** The face to render (a mascot state string — same vocabulary everywhere). */
  face: string;
  /** The bot's color name (AGENT_COLORS key). */
  color: string;
  /** The narrated status line ("" when idle). */
  line: string;
  /** Hex colors resolved for the renderer. */
  bodyHex: string;
  eyeHex: string;
}

const HEXES = {
  green: "#3FAE6E", blue: "#4A90D9", red: "#D9534F", orange: "#f08a24",
  purple: "#8E6FD8", cyan: "#3FB8C4", pink: "#D96BA8",
} as const satisfies Record<string, string>;

export function buildShareCard(input: {
  name: string;
  color: string;
  /** The bot's own face state string. */
  face: string;
  busy?: boolean;
  unread?: boolean;
  lastToolFailed?: boolean;
  streaming?: boolean;
  task?: string;
}): ShareCardData {
  const status = statusForBotActivity(input, input.streaming);
  const resolved: CharacterState = resolveCharacter({
    status,
    face: input.face,
    task: input.task ?? input.name,
  });
  return {
    name: input.name,
    face: resolved.face,
    color: input.color,
    line: resolved.label,
    // SAFETY: the input color is an AGENT_COLORS name (string) from the
    // bot record; unknown names fall back to the brand orange, matching
    // AgentAvatar's own fallback behavior.
    bodyHex: HEXES[input.color as keyof typeof HEXES] ?? "#f08a24",
    eyeHex: "#f9f9f9",
  };
}

export interface ShareCardLayout {
  nameAt: { x: number; y: number; size: number };
  lineAt: { x: number; y: number; size: number };
  faceRect: { x: number; y: number; size: number };
  markAt: { x: number; y: number; size: number };
}

/** The card's text layout, in card coordinates — shared by the canvas
 * renderer and any future native renderer so both compose identically. */
export function shareCardLayout(_card: ShareCardData): ShareCardLayout {
  return {
    nameAt: { x: SHARE_CARD_WIDTH / 2, y: 120, size: 64 },
    faceRect: { x: SHARE_CARD_WIDTH / 2 - 260, y: 320, size: 520 },
    lineAt: { x: SHARE_CARD_WIDTH / 2, y: 1020, size: 40 },
    markAt: { x: SHARE_CARD_WIDTH / 2, y: 1320, size: 48 },
  };
}


