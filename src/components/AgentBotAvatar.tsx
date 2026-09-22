// Adapter for `bot-avatars` (https://libraries.dev/bots) — the project's single
// avatar system. Everything else in the app renders through this component, so
// the 39-state vocabulary, the character picker and the palette map in one place.
//
// SAFETY: `bot-avatars` draws to a canvas at runtime; SSR and tests see only a
// <canvas data-bot-avatar> inside a small wrapper span (class/aria/data attrs).
import { memo, type CSSProperties } from "react";
import {
  BotAvatar,
  type BotAvatarFace,
  type BotAvatarProps,
  type BotAvatarState,
  type BotAvatarType,
} from "bot-avatars";

import { AGENT_COLORS } from "../lib/mascot";

export type { BotAvatarFace, BotAvatarState, BotAvatarType };

/** Every avatar `bot-avatars` ships — the preview gallery iterates this. */
export const BOT_AVATAR_TYPES: readonly BotAvatarType[] = [
  "clover",
  "flower",
  "triangle",
  "square",
  "blob",
  "ghost",
  "circle",
  "drop",
  "star",
  "droid",
  "mech",
  "alien",
  "hexagon",
  "cat",
  "cloud",
  "pill",
  "pebble",
  "puddle",
] as const;

/** Legacy Muster `character` → `bot-avatars` shape, for the picker's bodies. */
export const CHARACTER_TYPES = {
  flower: "flower",
  star: "star",
  blob: "blob",
  cursor: "circle",
  ball: "circle",
  circle: "circle",
  hexagon: "hexagon",
  triangle: "triangle",
  egg: "pill",
  capsule: "pill",
  drop: "drop",
  heart: "clover",
  pebble: "pebble",
  squircle: "square",
  cloud: "cloud",
  sparkle: "star",
  lottie: "flower",
} as const satisfies Record<string, BotAvatarType>;

/** Life-cycle states that read as asleep. */
export const SLEEPING_STATES = ["sleeping", "drowsy", "powering-down"] as const;

/** Life-cycle states that read as busy — `working` is the library's only busy draw. */
export const WORKING_STATES = [
  "waking",
  "listening",
  "thinking",
  "searching",
  "working",
  "loading",
  "dictating",
  "writing",
  "sending",
  "receiving",
  "uploading",
  "notifying",
  "alerting",
  "spawning",
  "orbit",
  "radar",
  "humming",
  "progress",
] as const;

/** FNV-1a — deterministic 0..1 so an identity keeps the same shape and phase. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

/**
 * Map a legacy `character` onto a `bot-avatars` shape; identities without a
 * direct mapping get a stable FNV-1a pick so a bot never changes body under you.
 */
export function botAvatarTypeForSeed(seed: string, character?: string): BotAvatarType {
  // SAFETY: CHARACTER_TYPES is a closed record keyed by legacy character name;
  // a non-key lookup yields undefined and falls through to the FNV-1a pick.
  const mapped = character
    ? CHARACTER_TYPES[character as keyof typeof CHARACTER_TYPES]
    : undefined;
  if (mapped) return mapped;
  const types = BOT_AVATAR_TYPES;
  return types[Math.floor(fnv1a(seed) * types.length) % types.length];
}

/** Legacy Muster life-cycle states → the library's three draw states. */
export function botAvatarState(state?: string | null): BotAvatarState {
  switch (state) {
    case "sleeping":
    case "drowsy":
    case "powering-down":
      return "sleeping";
    case "waking":
    case "listening":
    case "thinking":
    case "searching":
    case "working":
    case "loading":
    case "dictating":
    case "writing":
    case "sending":
    case "receiving":
    case "uploading":
    case "notifying":
    case "alerting":
    case "spawning":
    case "orbit":
    case "radar":
    case "humming":
    case "progress":
      return "working";
    default:
      return "default";
  }
}

/** Stable 0..1 draw seed for an identity string. */
export function botAvatarSeed(seed?: string): number {
  if (!seed) return 0;
  return fnv1a(seed);
}

/** Reduced motion: one static frame, never an animation loop. */
function prefersReducedMotion(): boolean {
  const view = globalThis.window;
  if (!view?.matchMedia) return false;
  return view.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface AgentBotAvatarProps {
  /** Bare `character` for call sites holding a Bot rather than a full identity. */
  character?: string;
  /** Explicit shape — wins over `identity.character`. */
  type?: BotAvatarType;
  /** Life-cycle state, mapped to `default` | `working` | `sleeping`. */
  state?: string;
  /** Eye/mouth face: `eyes` blinks (library default), `mouth` draws the smile. */
  face?: BotAvatarFace;
  /** Body color: a palette name (`green`) or a literal (`#f08a24`). */
  color?: string;
  fill?: string;
  size?: number;
  /** Spin the shape continuously — MusterBotMark's brand wobble. */
  spin?: boolean;
  /** Accessible name; omit for decoration (the wrapper becomes aria-hidden). */
  label?: string;
  /** Force decorative regardless of `label`. */
  decorative?: boolean;
  /** Stable identity string for shape + phase. */
  seed?: string;
  /** Animate; off renders one static frame. */
  animated?: boolean;
  interactive?: boolean;
  trackPointer?: boolean;
  className?: string;
  style?: CSSProperties;
}

function AgentBotAvatarImpl({
  character,
  type,
  state,
  face = "eyes",
  color,
  fill,
  size = 96,
  spin = false,
  label,
  decorative,
  seed,
  animated = true,
  interactive = false,
  trackPointer = false,
  className,
  style,
}: AgentBotAvatarProps) {
  // SAFETY: palette names come from AgentColor, literals from brand callers;
  // both live in this closed lookup plus arbitrary CSS colours the library owns.
  const botColor = color ?? fill;
  // SAFETY: `botColor` is either a palette name that is a key of AGENT_COLORS or
  // a CSS colour literal; the lookup is total and a miss falls back to `botColor`.
  const resolvedColor = botColor ? AGENT_COLORS[botColor as keyof typeof AGENT_COLORS] ?? botColor : undefined;
  const botType = type ?? botAvatarTypeForSeed(seed ?? "", character);
  const botState = botAvatarState(state);
  const isAnimated = animated && !prefersReducedMotion();
  const isDecorative = decorative ?? !label;
  // SAFETY: plain layout styles from FlowerBot — spread onto the wrapper span.
  const wrapperStyle = style ?? {};
  const botProps: BotAvatarProps = {
    type: botType,
    state: botState,
    face,
    size,
    seed: botAvatarSeed(seed),
    whirl: spin ? 1 : 0,
    paused: !isAnimated,
    interactive: interactive || trackPointer,
  };
  // SAFETY: palette name or CSS colour literal — both accepted by the library.
  if (resolvedColor) botProps.color = resolvedColor;
  // SAFETY: `aria-label` is a plain React DOM prop — BotAvatar forwards it
  // straight onto its canvas, where it replaces the preset's default label.
  if (label) botProps["aria-label"] = label;
  return (
    <span
      className={["inline-flex shrink-0", className].filter(Boolean).join(" ")}
      style={wrapperStyle}
      data-bot-color={resolvedColor}
      data-bot-paused={!isAnimated || undefined}
      {...(isDecorative ? { "aria-hidden": true as const } : {})}
    >
      <BotAvatar {...botProps} />
    </span>
  );
}

export const AgentBotAvatar = memo(AgentBotAvatarImpl);
AgentBotAvatar.displayName = "AgentBotAvatar";
