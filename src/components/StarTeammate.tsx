// Star teammates wear the brand flower with the full pose vocabulary — the
// flower IS the star now: every agent state maps onto a real expression
// (flower.ts's poseFor chain, 16 poses), and `spin` restores the old star's
// slow idle rotation. The flat three-eye-state mascot remains available
// directly via MusterMascot.
import { memo } from "react";
import { AGENT_COLORS, type AgentColor } from "@/lib/mascot";
import { FlowerBot, MUSTERBOT_ORANGE } from "@/lib/musterbot";

interface StarTeammateProps {
  color: AgentColor;
  state?: string;
  size?: number;
  label?: string;
  animated?: boolean;
  /** Slow idle rotation. Off by default; motion rules apply. */
  spin?: boolean;
}

export const StarTeammate = memo(function StarTeammate({
  color,
  state = "idle",
  size = 44,
  label,
  animated = false,
  spin = false,
}: StarTeammateProps) {
  return (
    <span className="inline-flex shrink-0">
      <FlowerBot
        size={size}
        state={state}
        color={color === "orange" ? MUSTERBOT_ORANGE : AGENT_COLORS[color] ?? MUSTERBOT_ORANGE}
        label={label}
        animated={animated}
        spin={spin}
      />
    </span>
  );
});
