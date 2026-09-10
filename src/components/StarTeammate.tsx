// Star teammates use the same flat flower mark as Muster's brand surfaces.
import { memo } from "react";
import { AGENT_COLORS, type AgentColor, type AgentState } from "@/lib/mascot";
import { MusterMascot, MUSTER_ORANGE, type MusterEyeState } from "./MusterMascot";

function eyeVariant(state: AgentState): MusterEyeState {
  switch (state) {
    case "sleeping":
    case "powering-down":
    case "drowsy":
      return "closed";
    case "happy":
    case "excited":
    case "celebrate":
    case "playful":
    case "laughing":
    case "proud":
      return "happy";
    default:
      return "open";
  }
}

interface StarTeammateProps {
  color: AgentColor;
  state?: AgentState;
  size?: number;
  label?: string;
  animated?: boolean;
}

export const StarTeammate = memo(function StarTeammate({
  color,
  state = "idle",
  size = 44,
  label,
  animated = false,
}: StarTeammateProps) {
  return (
    <span className="inline-flex shrink-0">
      <MusterMascot
        size={size}
        color={color === "orange" ? MUSTER_ORANGE : AGENT_COLORS[color] ?? MUSTER_ORANGE}
        eyes={eyeVariant(state)}
        label={label}
        animated={animated}
      />
    </span>
  );
});
