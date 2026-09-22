// AgentAvatar — the app's historical avatar API, now a thin funnel over the
// one renderer: bot-avatars, through AgentBotAvatar. Call sites keep passing
// color, character, state, motion, pointer and animation preferences exactly
// as before; the hand-built body/face engines behind this file are gone.
//
// The legacy face-placement knobs (expression, turn, gaze, spring, the FACE_*
// geometry) stay on the props type so old call sites keep compiling, but
// nothing renders them — bot-avatars owns the face now.
import { memo, useEffect, useState, type CSSProperties } from "react";
import type { AgentCharacter, AgentColor, AgentMotion, AgentState } from "@/lib/mascot";
import { AgentBotAvatar } from "./AgentBotAvatar";

/**
 * The one-shot motions that borrow the `working` state for a beat, so a poke,
 * a launch or a celebration is visible on the body. `blink` and `failure` are
 * deliberately absent: the library blinks on its own and has no sad state, so
 * forcing one would only invent a mood the renderer cannot draw.
 */
const MOTION_BEATS: ReadonlySet<Exclude<AgentMotion, "none">> = new Set([
  "arrive",
  "switch",
  "customize",
  "alert",
  "thinking",
  "working",
  "launch",
  "success",
  "celebrate",
  "surprise",
]);

/** How long a one-shot motion holds `working` before the bot's own state returns. */
const MOTION_BEAT_MS = 1400;

export type AgentAvatarProps = {
  color: AgentColor;
  /** Which body the picker chose; the brand flower is the default. */
  character?: AgentCharacter;
  /** Named behaviour — mapped onto the library's three states. */
  state?: AgentState;
  size?: number;
  label?: string;
  /** Identity for the body choice and blink phase — any string, stable per value. */
  seed?: string;
  /** One-shot beat. Activity motions borrow `working` for a moment. */
  motion?: AgentMotion;
  /** Bump to replay the same motion. */
  motionKey?: number;
  /** Let the eyes and head follow a pointer that comes near. */
  trackPointer?: boolean;
  /** Run the animation. Off renders the resting frame. */
  animated?: boolean;
  // Legacy face-placement knobs from the hand-built engines — accepted and
  // ignored, so call sites written against them keep compiling unchanged.
  /** @ignored The library picks the face; pinned expressions no longer apply. */
  expression?: number;
  /** @ignored Head turn is drawn by the library's own motion. */
  turn?: number;
  /** @ignored Pointer gaze rides `trackPointer` instead. */
  gaze?: { x?: number; y?: number };
  /** @ignored Spring tuning belonged to the retired body engine. */
  spring?: number;
  /** @ignored Legacy face geometry — accepted, ignored. */
  eyeScale?: number;
  /** @ignored Legacy mouth toggle — accepted, ignored. */
  showMouth?: boolean;
  /** @ignored Legacy mouth weight — accepted, ignored. */
  mouthStroke?: number;
  /** @ignored Authored gaze direction — accepted, ignored. */
  forward?: boolean;
  /** @ignored Legacy face geometry — accepted, ignored. */
  eyeSpacing?: number;
  /** @ignored Legacy face geometry — accepted, ignored. */
  faceX?: number;
  /** @ignored Legacy face geometry — accepted, ignored. */
  faceY?: number;
  /** @ignored Legacy face geometry — accepted, ignored. */
  faceScale?: number;
};

function AgentAvatarComponent({
  color,
  // The app-icon flower is the default teammate body — every bot wears the
  // brand mark unless the user picks another character in settings.
  character = "flower",
  state = "idle",
  size = 44,
  label,
  seed,
  motion = "none",
  motionKey = 0,
  trackPointer = true,
  animated = true,
}: AgentAvatarProps) {
  // A one-shot motion borrows `working` for a beat, then hands the state back.
  const [beating, setBeating] = useState(false);
  useEffect(() => {
    if (motion === "none" || !animated || !MOTION_BEATS.has(motion)) return;
    setBeating(true);
    const timer = setTimeout(() => setBeating(false), MOTION_BEAT_MS);
    return () => clearTimeout(timer);
  }, [motion, motionKey, animated]);

  // SAFETY: CSS custom properties are outside React's style typings; the
  // value is a 0|1 number consumed only as a CSS variable.
  const hostStyle = {
    "--bot-gaze-on": trackPointer && animated ? 1 : 0,
  } as CSSProperties;

  /** Every avatar lives inside a .bot-host: the gaze kill-switch (who may
   * track the cursor at all) and the CSS hook for the poke squash hang here,
   * so the ~20 render sites stay untouched. */
  return (
    <span className="bot-host inline-flex shrink-0" style={hostStyle}>
      <AgentBotAvatar
        color={color}
        character={character}
        state={beating ? "working" : state}
        size={size}
        label={label}
        seed={seed}
        animated={animated}
        interactive={trackPointer && animated}
      />
    </span>
  );
}

export const AgentAvatar = memo(AgentAvatarComponent);

export function InitialsAvatar({
  initials,
  size = 32,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}
