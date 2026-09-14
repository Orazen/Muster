// FlowerBot — the app-icon mascot as a living teammate.
// Body: MusterMascot's MUSTER_BODY (the exact artwork emitted to
// /app-icon.svg). Face: the flower.ts pose channels, transitioned with CSS
// so expression changes morph rather than cut. Eyes follow the cursor via
// the shared gaze tracker (see gaze.ts) — CSS variables in, no per-instance
// listeners. Motion is opt-in CSS only: no animation frames, listeners or
// timers here.
import { memo, type CSSProperties } from "react";
import { MUSTER_BODY, MUSTER_EYES, MUSTER_ORANGE } from "@/components/MusterMascot";
import { FLOWER_POSES, poseFor, type FlowerPose } from "./flower";
import "./flower-bot.css";

const EYES = [
  { index: 0, x: -15, y: -2 },
  { index: 1, x: 38, y: -6 },
] as const;

function eyeTransform(pose: FlowerPose, index: 0 | 1): string {
  const wrap = index === 0 ? -1 : 1;
  const sel = index === 0 ? 0 : 1;
  const dx = (pose.edx ?? 0) * wrap;
  const dy = (pose.edy ?? 0) + (pose.edy2 ?? 0) * sel;
  const tilt = (pose.tilt ?? 0) * wrap + (pose.tilt2 ?? 0) * sel;
  const sx = (pose.esx ?? 1) * (1 + (pose.esx2 ?? 0) * sel);
  const sy = (pose.esy ?? 1) * (1 + (pose.esy2 ?? 0) * sel);
  return `translate(${round(dx)}px, ${round(dy)}px) rotate(${round(tilt)}deg) scale(${round(sx)}, ${round(sy)})`;
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
  /** Eye offset in [-1, 1] per axis. A PINNED gaze (e.g. a mascot mid-skill)
   * wins over the global cursor tracker by writing the same CSS variables
   * inline — inline beats the tracker's inherited pair in the cascade. */
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
  // Blink phase desync: a deterministic 0..1 hash shifts the shared CSS
  // keyframe per instance so a roster never blinks in army lockstep.
  const blinkSeed = hashSeed(`${label ?? ""}|${state}`);
  // SAFETY: CSS custom properties are not in React's style typings; every
  // value written here is a plain string number, and the object is consumed
  // only as an SVG style attribute.
  const style = {
    ...(gaze ? { "--mx": String(clampUnit(gaze.x ?? 0)), "--my": String(clampUnit(gaze.y ?? 0)) } : undefined),
    "--bot-blink-seed": String(blinkSeed),
    "--bot-gaze-range-x": String(size >= 24 ? 7 : 0),
    "--bot-gaze-range-y": String(size >= 24 ? 5 : 0),
  } as CSSProperties;
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
      data-gaze
      data-gaze-attenuate
      style={style}
    >
      <g className="flower-bot__pop">
        <g className="flower-bot__body" style={{ transform: `translate(0px, ${(pose.bdy ?? 0).toFixed(1)}px)` }}>
          <path d={MUSTER_BODY} fill={color} />
          {EYES.map((eye) => (
            <g key={eye.x} transform={`translate(${eye.x} ${eye.y}) rotate(-4)`}>
              <g className="flower-bot__gaze">
                <g className="flower-bot__eye" style={{ transform: eyeTransform(pose, eye.index) }}>
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
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}

const clampUnit = (n: number) => Math.max(-1, Math.min(1, n));

/** FNV-1a over the string, mapped to 0..1 — same spirit as BlobBot's seed. */
function hashSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

export const FlowerBot = memo(FlowerBotComponent);
