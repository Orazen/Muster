/**
 * BlobBot — a deterministic blob avatar.
 *
 * Same seed in, same blob out: body silhouette, proportions and face
 * geometry all derive from the seed, while color, state and size come from
 * the caller. Pure SVG + CSS animation, no dependencies, no timers.
 */
import { useMemo } from "react";
import { gradientFor, hashSeed, layoutBlob } from "./blob";
import { faceFor, type Face } from "./face";

export interface BlobBotProps {
  /** Any string — bot id, name, email. Deterministic per value. */
  seed: string;
  /** Body base color; a three-stop gradient is derived from it. */
  color?: string;
  /** Behaviour state; unknown strings fall back by keyword, then idle. */
  state?: string;
  size?: number;
  label?: string;
  /** Idle blink + wobble. Off renders the resting face. */
  animated?: boolean;
  /** Gaze offsets, each clamped to -1..1. */
  gaze?: { x?: number; y?: number };
  className?: string;
}

export function BlobBot({
  seed,
  color = "#009957",
  state = "idle",
  size = 44,
  label,
  animated = true,
  gaze,
  className,
}: BlobBotProps) {
  const seedNum = hashSeed(seed);
  const layout = useMemo(() => layoutBlob(seedNum), [seedNum]);
  const face = faceFor(state);
  const gid = `bb-${seedNum.toString(36)}-${color.replace("#", "")}`;
  const { eyes: ge } = layout;

  const gx = Math.max(-1, Math.min(1, gaze?.x ?? 0)) * ge.r * 0.45;
  const gy = Math.max(-1, Math.min(1, gaze?.y ?? 0)) * ge.r * 0.4;
  const eyeCx = (dx: number) => 100 + dx + gx;
  const eyeCy = ge.cy + gy + (face.eyes === "happy" ? ge.r * 0.35 : 0);

  const bodyAnim = animated ? "musterbot-wobble 5.2s ease-in-out infinite" : undefined;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      className={className}
    >
      <defs>
        <linearGradient id={gid} x1="0.2" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor={gradientFor(color)[0]} />
          <stop offset="0.45" stopColor={gradientFor(color)[1]} />
          <stop offset="1" stopColor={gradientFor(color)[2]} />
        </linearGradient>
      </defs>
      <g style={{ animation: bodyAnim, transformOrigin: "100px 110px" }}>
        <path d={layout.path} fill={`url(#${gid})`} />
        <ellipse cx={100 - ge.gap * 1.6} cy={ge.cy - ge.r * 2.4} rx={ge.r * 2.6} ry={ge.r * 1.4}
          fill="#ffffff" opacity={0.16} transform={`rotate(-18 100 ${ge.cy - ge.r * 2.4})`} />
        {renderEyes(face, eyeCx(-ge.gap), eyeCx(ge.gap), eyeCy, ge.r, animated)}
        {renderMouth(face, 100 + gx, ge.cy + gy + ge.r * 2.2, ge.r)}
      </g>
    </svg>
  );
}

function renderEyes(face: Face, lx: number, rx: number, cy: number, r: number, animated: boolean) {
  const blinkStyle = animated ? { animation: "musterbot-blink 4.4s infinite" } : undefined;
  switch (face.eyes) {
    case "closed":
      return (
        <>
          <path d={`M ${lx - r} ${cy} q ${r} ${r * 0.9} ${r * 2} 0`} stroke="#f9f9f9" strokeWidth={r * 0.45} strokeLinecap="round" fill="none" />
          <path d={`M ${rx - r} ${cy} q ${r} ${r * 0.9} ${r * 2} 0`} stroke="#f9f9f9" strokeWidth={r * 0.45} strokeLinecap="round" fill="none" />
        </>
      );
    case "happy":
      return (
        <>
          <path d={`M ${lx - r} ${cy} q ${r} ${-r * 0.9} ${r * 2} 0`} stroke="#f9f9f9" strokeWidth={r * 0.45} strokeLinecap="round" fill="none" />
          <path d={`M ${rx - r} ${cy} q ${r} ${-r * 0.9} ${r * 2} 0`} stroke="#f9f9f9" strokeWidth={r * 0.45} strokeLinecap="round" fill="none" />
        </>
      );
    case "half":
      return (
        <g {...(blinkStyle ? { style: blinkStyle } : {})}>
          <ellipse cx={lx} cy={cy} rx={r * 0.72} ry={r * 0.42} fill="#f9f9f9" />
          <ellipse cx={rx} cy={cy} rx={r * 0.72} ry={r * 0.42} fill="#f9f9f9" />
        </g>
      );
    case "wide":
      return (
        <>
          <ellipse cx={lx} cy={cy} rx={r * 0.85} ry={r * 1.15} fill="#f9f9f9" />
          <ellipse cx={rx} cy={cy} rx={r * 0.85} ry={r * 1.15} fill="#f9f9f9" />
          <circle cx={lx} cy={cy + r * 0.15} r={r * 0.34} fill="#1c1c1c" />
          <circle cx={rx} cy={cy + r * 0.15} r={r * 0.34} fill="#1c1c1c" />
        </>
      );
    case "wary":
      return (
        <>
          <ellipse cx={lx} cy={cy} rx={r * 0.72} ry={r * 0.5} fill="#f9f9f9" />
          <ellipse cx={rx} cy={cy} rx={r * 0.72} ry={r * 0.5} fill="#f9f9f9" />
          <circle cx={lx} cy={cy + r * 0.05} r={r * 0.26} fill="#1c1c1c" />
          <circle cx={rx} cy={cy + r * 0.05} r={r * 0.26} fill="#1c1c1c" />
        </>
      );
    default:
      return (
        <g {...(blinkStyle ? { style: blinkStyle } : {})}>
          <ellipse cx={lx} cy={cy} rx={r * 0.72} ry={r} fill="#f9f9f9" />
          <ellipse cx={rx} cy={cy} rx={r * 0.72} ry={r} fill="#f9f9f9" />
          <circle cx={lx} cy={cy + r * 0.12} r={r * 0.3} fill="#1c1c1c" />
          <circle cx={rx} cy={cy + r * 0.12} r={r * 0.3} fill="#1c1c1c" />
        </g>
      );
  }
}

function renderMouth(face: Face, cx: number, cy: number, r: number) {
  const stroke = { stroke: "#f9f9f9", strokeWidth: r * 0.34, strokeLinecap: "round" as const, fill: "none" };
  switch (face.mouth) {
    case "smile":
      return <path d={`M ${cx - r} ${cy} q ${r} ${r * 0.85} ${r * 2} 0`} {...stroke} />;
    case "flat":
      return <path d={`M ${cx - r * 0.8} ${cy + r * 0.3} h ${r * 1.6}`} {...stroke} />;
    case "oh":
      return <ellipse cx={cx} cy={cy + r * 0.35} rx={r * 0.34} ry={r * 0.48} fill="#f9f9f9" />;
    case "grit":
      return (
        <>
          <rect x={cx - r * 0.9} y={cy} width={r * 1.8} height={r * 0.42} rx={r * 0.16} fill="#f9f9f9" />
          <path d={`M ${cx - r * 0.45} ${cy} v ${r * 0.42} M ${cx + r * 0.05} ${cy} v ${r * 0.42} M ${cx + r * 0.5} ${cy} v ${r * 0.42}`}
            stroke="#00000033" strokeWidth={1.1} />
        </>
      );
    default:
      return null;
  }
}
