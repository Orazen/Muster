/**
 * Musterbot logo mark — the canonical brand mark, now drawn by `bot-avatars`
 * through the shared AgentBotAvatar adapter (the only avatar system).
 *
 * `eyes` keeps its historical variants so existing callers compile: "open" is
 * the canonical rest state, "happy" maps onto bot-avatars' `mouth` face, and
 * "closed" keeps the resting `eyes` face (bot-avatars owns its own blink).
 */
import { AgentBotAvatar } from "../../components/AgentBotAvatar";

export const MUSTERBOT_ORANGE = "#f08a24";

export function MusterBotMark({
  size = 44,
  color = MUSTERBOT_ORANGE,
  eyes = "open",
  label,
  animated = false,
  className,
}: {
  size?: number;
  color?: string;
  eyes?: "open" | "closed" | "happy";
  label?: string;
  animated?: boolean;
  className?: string;
}) {
  return (
    <AgentBotAvatar
      type="flower"
      fill={color}
      size={size}
      face={eyes === "happy" ? "mouth" : "eyes"}
      label={label}
      animated={animated}
      spin={animated}
      seed="muster-brand"
      className={className}
    />
  );
}
