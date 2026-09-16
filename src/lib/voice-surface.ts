// The voice room's paint — Vellum's avatar-tone math, ported (MIT).
//
// The room is a full-bleed surface painted with the speaking bot's own color,
// so chrome drawn on it cannot use theme tokens: `text-ink` is as likely to
// vanish on a pale fill as to read on a saturated one. This module derives the
// foreground tones once from the fill's perceived brightness, and the call
// rooms wear them through CSS variables (--room-fg, --room-wash, …) set by
// voiceRoomVars(). A bot with no palette color falls back to the deep ambient
// dark, which is also a foreground-friendly surface.

import type { CSSProperties } from "react";
import { AGENT_COLORS, type AgentColor } from "./mascot";

export interface RoomTone {
  /** The fill: the bot's palette color, or the ambient dark. */
  bg: string;
  /** True when the fill is light enough to need dark ink. */
  isLight: boolean;
  /** Primary ink: near-black on light fills, white otherwise. */
  fg: string;
  /** Secondary ink at the matching polarity. */
  fgMuted: string;
  /** Subtle hover/active wash over the fill. */
  wash: string;
  /** Soft raised bubble for captions — a translucent lift, not an opaque chip. */
  bubble: string;
  /** Ink for the bubble, chosen for WCAG AA against the BLENDED bubble pixel. */
  bubbleFg: string;
  /** Ink for an "off" control (muted mic) — a red that never merges with the fill. */
  mutedInk: string;
}

const FG_DARK = "#1A1A1A";
const FG_LIGHT = "#FFFFFF";
/** Deep full-bleed dark for rooms with no bot color to borrow. */
export const ROOM_DARK = "#151515";

/** The six hex digits of a #rrggbb color, or null. */
function hexDigits(value: string): string | null {
  const m = value.match(/^#?([0-9a-f]{6})$/i);
  return m ? m[1] : null;
}

/** Perceived brightness (YIQ), 0–1. */
function brightness(hex: string): number {
  const digits = hexDigits(hex);
  if (!digits) return 0;
  const n = parseInt(digits, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (r * 299 + g * 587 + b * 114) / 1000 / 255;
}

/** Composite `overlay` at `alpha` over the solid `base`, as opaque #rrggbb. */
export function blendHex(base: string, overlay: string, alpha: number): string {
  const b = hexDigits(base);
  const o = hexDigits(overlay);
  if (!b || !o) return base;
  const a = Math.max(0, Math.min(1, alpha));
  const bn = parseInt(b, 16);
  const on = parseInt(o, 16);
  const mix = (shift: number) =>
    Math.round(((bn >> shift) & 0xff) * (1 - a) + ((on >> shift) & 0xff) * a);
  return `#${((1 << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).slice(1)}`;
}

/** WCAG relative luminance (sRGB-linearized), 0–1. */
function relativeLuminance(hex: string): number {
  const digits = hexDigits(hex);
  if (!digits) return 0;
  const n = parseInt(digits, 16);
  const ch = (shift: number) => {
    const c = ((n >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
}

function contrastRatio(a: string, b: string): number {
  const sorted = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((sorted[0] ?? 0) + 0.05) / ((sorted[1] ?? 0) + 0.05);
}

/** FG_DARK or FG_LIGHT, whichever contrasts harder against `bg`. */
export function contrastForeground(bg: string): string {
  return contrastRatio(FG_DARK, bg) > contrastRatio(FG_LIGHT, bg) ? FG_DARK : FG_LIGHT;
}

export function toneForBg(bg: string): RoomTone {
  const isLight = brightness(bg) > 0.6;
  return {
    bg,
    isLight,
    fg: isLight ? FG_DARK : FG_LIGHT,
    fgMuted: isLight ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.65)",
    wash: isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.12)",
    // The bubble ink is measured against the BLENDED pixel (lift over fill),
    // so a mid-tone saturated bot still gets readable caption text.
    bubble: isLight ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.16)",
    bubbleFg: isLight
      ? contrastForeground(blendHex(bg, "#000000", 0.1))
      : contrastForeground(blendHex(bg, "#ffffff", 0.16)),
    // A pale red on dark fills, a deep one on light — the muted-mic state must
    // read as "off" on every palette color, not merge with a red bot's fill.
    mutedInk: isLight ? "#991B1B" : "#FCA5A5",
  };
}

/** The room paint for a bot's palette color (or the ambient dark). */
export function roomToneForColor(color: AgentColor | undefined): RoomTone {
  const hex = color ? AGENT_COLORS[color] : undefined;
  return toneForBg(hex ?? ROOM_DARK);
}

/** The style's full shape: React's CSSProperties plus the --room-* custom
 * properties, which CSSProperties cannot name. */
export interface RoomVars extends CSSProperties {
  "--room-fg": string;
  "--room-fg-muted": string;
  "--room-wash": string;
  "--room-bubble": string;
  "--room-bubble-fg": string;
  "--room-muted-ink": string;
}

/** Inline style: the fill plus the --room-* contract the call chrome reads. */
export function voiceRoomVars(tone: RoomTone): RoomVars {
  return {
    backgroundColor: tone.bg,
    "--room-fg": tone.fg,
    "--room-fg-muted": tone.fgMuted,
    "--room-wash": tone.wash,
    "--room-bubble": tone.bubble,
    "--room-bubble-fg": tone.bubbleFg,
    "--room-muted-ink": tone.mutedInk,
  };
}
