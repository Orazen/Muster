// FlowerBot — the app-icon mascot as a living teammate, drawn by `bot-avatars`
// through the shared AgentBotAvatar adapter (the only avatar system).
//
// `gaze` and `state` are accepted for call-site compatibility: shape/face come
// from bot-avatars' canvas (pointer gaze rides its `interactive` mode), and the
// legacy life-cycle states map onto default/working/sleeping in the adapter.
import type { CSSProperties } from "react";
import { AgentBotAvatar } from "../../components/AgentBotAvatar";

export interface FlowerBotProps {
  /** Stable seed so the same teammate always draws the same way. */
  seed?: string;
  state?: string;
  size?: number;
  color?: string;
  label?: string;
  /** Ambient motion; off renders a static frame. */
  animated?: boolean;
  /** Slow continuous rotation — the old star's idle spin, now the flower's. */
  spin?: boolean;
  /** Accepted and ignored: pointer gaze is bot-avatars' `interactive` canvas. */
  gaze?: { x?: number; y?: number };
  style?: CSSProperties;
  className?: string;
}

export function FlowerBot({
  seed,
  state,
  size = 44,
  color,
  label,
  animated = true,
  spin = false,
  style,
  className,
}: FlowerBotProps) {
  return (
    <AgentBotAvatar
      type="flower"
      seed={seed ?? label ?? "flower-bot"}
      state={state}
      size={size}
      fill={color}
      label={label}
      animated={animated}
      spin={spin}
      style={style}
      className={className}
    />
  );
}
