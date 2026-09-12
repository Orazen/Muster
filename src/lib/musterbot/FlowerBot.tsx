// FlowerBot — the app-icon mascot as a living teammate.
// Body: MusterMascot's MUSTER_BODY (the exact artwork emitted to
// /app-icon.svg). Face: the flower.ts pose channels, transitioned with CSS
// so expression changes morph rather than cut. Motion is opt-in CSS only —
// no animation frames, listeners or timers.
import { memo } from "react";
import { MUSTER_BODY, MUSTER_EYES, MUSTER_ORANGE } from "@/components/MusterMascot";
import { FLOWER_POSES, poseFor, type FlowerPose } from "./flower";
import "./flower-bot.css";

const EYES = [
  { index: 0, x: -15, y: -2 },
  { index: 1, x: 38, y: -6 },
] as const;

function eyeTransform(pose: FlowerPose, index: 0 | 1, gazeX: number, gazeY: number): string {
  const wrap = index === 0 ? -1 : 1;
  const sel = index === 0 ? 0 : 1;
  const dx = (pose.edx ?? 0) * wrap + gazeX;
  const dy = (pose.edy ?? 0) + (pose.edy2 ?? 0) * sel + gazeY;
  const tilt = (pose.tilt ?? 0) * wrap + (pose.tilt2 ?? 0) * sel;
  const sx = (pose.esx ?? 1) * (1 + (pose.esx2 ?? 0) * sel);
  const sy = (pose.esy ?? 1) * (1 + (pose.esy2 ?? 0) * sel);
  return `translate(${round(dx)} ${round(dy)}) rotate(${round(tilt)}) scale(${round(sx)} ${round(sy)})`;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export interface FlowerBotProps {
  state?: string;
  size?: number;
  color?: string;
  label?: string;
  /** Blinking + gentle float. Off renders the state's resting pose. */
  animated?: boolean;
  /** Slow continuous rotation — the old star's idle spin, now the flower's. */
  spin?: boolean;
  /** Eye offset in [-1, 1] per axis. */
  gaze?: { x?: number; y?: number };
}

function FlowerBotComponent({
  state = "idle",
  size = 44,
  color = MUSTER_ORANGE,
  label,
  animated = true,
  spin = false,
  gaze,
}: FlowerBotProps) {
  const pose: FlowerPose = FLOWER_POSES[poseFor(state)];
  const gazeX = Math.max(-1, Math.min(1, gaze?.x ?? 0)) * 7;
  const gazeY = Math.max(-1, Math.min(1, gaze?.y ?? 0)) * 5;
  return (
    <svg
      width={size}
      height={size}
      viewBox="-112 -112 224 224"
      xmlns="http://www.w3.org/2000/svg"
      className="flower-bot"
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-animated={animated}
      data-spin={spin || undefined}
      data-pose={poseFor(state)}
    >
      <g className="flower-bot__body" style={{ transform: `translate(0 ${(pose.bdy ?? 0).toFixed(1)})` }}>
        <path d={MUSTER_BODY} fill={color} />
        {EYES.map((eye) => (
          <g key={eye.x} transform={`translate(${eye.x} ${eye.y}) rotate(-4)`}>
            <g className="flower-bot__eye" style={{ transform: eyeTransform(pose, eye.index, gazeX, gazeY) }}>
              <rect
                className="flower-bot__eyelid"
                x={-10.5}
                y={-22}
                width={21}
                height={44}
                rx={10.5}
                fill={MUSTER_EYES}
              />
            </g>
          </g>
        ))}
      </g>
    </svg>
  );
}

export const FlowerBot = memo(FlowerBotComponent);
