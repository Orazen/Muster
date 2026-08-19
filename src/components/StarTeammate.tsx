// StarTeammate — the musterbot star: every teammate is a star.
// Renders a smooth 5-pointed star (star5 profile from musterbot's skins)
// filled with the bot's color gradient, with two capsule eyes that follow
// a few resting beats. Eyes are mask holes through the body.
import { memo, useEffect, useId, useState } from "react";
import { AGENT_COLORS, type AgentColor, type AgentState } from "@/lib/mascot";

// ── Geometry ──────────────────────────────────────────────────────────
const STEPS = 128;
const TAU = Math.PI * 2;

/** Musterbot star5 radial function: 5-point star with soft tips. */
function starRadius(theta: number): number {
  const c = Math.abs(Math.cos(2.5 * theta + Math.PI / 4));
  return 0.62 + 0.38 * c ** 0.6;
}

/** Compute and normalize the star outline. */
function computeStarPath(): string {
  const raw = Array.from({ length: STEPS }, (_, i) => {
    const a = (i / STEPS) * TAU;
    return { x: Math.cos(a) * starRadius(a), y: Math.sin(a) * starRadius(a) };
  });
  const maxR = Math.max(...raw.map((p) => Math.hypot(p.x, p.y)));
  const pts = raw.map((p) => ({ x: (p.x / maxR) * 44, y: (p.y / maxR) * 44 }));

  // Catmull-Rom → cubic Bézier (tension 1/6)
  const tension = 1 / 6;
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < STEPS; i++) {
    const p0 = pts[(i - 1 + STEPS) % STEPS];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % STEPS];
    const p3 = pts[(i + 2) % STEPS];
    d += ` C ${(p1.x + (p2.x - p0.x) * tension).toFixed(2)} ${(p1.y + (p2.y - p0.y) * tension).toFixed(2)}, ${(p2.x - (p3.x - p1.x) * tension).toFixed(2)} ${(p2.y - (p3.y - p1.y) * tension).toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d + " Z";
}

const STAR_PATH = computeStarPath();

// ── Eyes ──────────────────────────────────────────────────────────────
// Capsule eye (musterbot style): two vertical capsules as mask holes.
const EYE_HW = 2.6; // half-width
const EYE_HH = 4.2; // half-height
const EYE_GAP = 7.5; // distance from center to each eye

// Eye variant paths (in eye-local coords centered at 0,0)
function eyePathOpen(): string {
  // Vertical capsule: two semicircles + straight sides
  return `M ${-EYE_HW} ${-EYE_HH + EYE_HW} A ${EYE_HW} ${EYE_HW} 0 0 1 ${EYE_HW} ${-EYE_HH + EYE_HW} L ${EYE_HW} ${EYE_HH - EYE_HW} A ${EYE_HW} ${EYE_HW} 0 0 1 ${-EYE_HW} ${EYE_HH - EYE_HW} Z`;
}

function eyePathClosed(): string {
  // Thin horizontal line — sleeping/closed
  return `M ${-EYE_HW} 0 L ${EYE_HW} 0`;
}

function eyePathHappy(): string {
  // Arc — happy/celebrate
  return `M ${-EYE_HW} ${EYE_HH * 0.3} A ${EYE_HW * 1.4} ${EYE_HH * 0.6} 0 0 1 ${EYE_HW} ${EYE_HH * 0.3}`;
}

// ── Gradient ──────────────────────────────────────────────────────────
function mix(hex: string, toward: string, t: number): string {
  const a = Number.parseInt(hex.slice(1), 16);
  const b = Number.parseInt(toward.slice(1), 16);
  const ch = (shift: number) => Math.round(((a >> shift) & 0xff) + (((b >> shift) & 0xff) - ((a >> shift) & 0xff)) * t);
  return `#${[ch(16), ch(8), ch(0)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function gradientStops(color: AgentColor): [string, string, string] {
  const fill = AGENT_COLORS[color] ?? AGENT_COLORS.green;
  return [mix(fill, "#ffffff", 0.55), fill, mix(fill, "#000000", 0.42)];
}

// ── State → eye shape mapping ─────────────────────────────────────────
function eyeVariant(state: AgentState): "open" | "closed" | "happy" {
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

const EYE_VARIANTS = {
  open: eyePathOpen,
  closed: eyePathClosed,
  happy: eyePathHappy,
};

// ── Component ─────────────────────────────────────────────────────────
interface StarTeammateProps {
  color: AgentColor;
  state?: AgentState;
  size?: number;
  label?: string;
  animated?: boolean;
}

function StarTeammateComponent({
  color,
  state = "idle",
  size = 44,
  label,
  animated = true,
}: StarTeammateProps) {
  const maskId = useId();
  const [blinking, setBlinking] = useState(false);

  // Auto-blink
  useEffect(() => {
    if (!animated) return;
    const blink = () => {
      setBlinking(true);
      setTimeout(() => setBlinking(false), 120);
    };
    const interval = setInterval(blink, 2000 + Math.random() * 3000);
    return () => clearInterval(interval);
  }, [animated]);

  const variant = blinking ? "closed" : eyeVariant(state);
  const stops = gradientStops(color);
  const eyePath = EYE_VARIANTS[variant]();
  const isHappy = variant === "happy";

  return (
    <span className="inline-flex shrink-0" role={label ? "img" : undefined} aria-label={label ?? undefined}>
      <svg
        width={size}
        height={size}
        viewBox="-48 -48 96 96"
        xmlns="http://www.w3.org/2000/svg"
        className="block"
      >
        <defs>
          <linearGradient id={`${maskId}-body`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0" stopColor={stops[0]} />
            <stop offset="0.5" stopColor={stops[1]} />
            <stop offset="1" stopColor={stops[2]} />
          </linearGradient>
          <mask id={`${maskId}-eyes`}>
            <rect x="-48" y="-48" width="96" height="96" fill="white" />
            {/* Left eye */}
            <g transform={`translate(${-EYE_GAP}, 0)`}>
              {isHappy ? (
                <path d={eyePath} fill="none" stroke="black" strokeWidth="2.5" strokeLinecap="round" />
              ) : variant === "closed" ? (
                <path d={eyePath} fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" />
              ) : (
                <path d={eyePath} fill="black" />
              )}
            </g>
            {/* Right eye */}
            <g transform={`translate(${EYE_GAP}, 0)`}>
              {isHappy ? (
                <path d={eyePath} fill="none" stroke="black" strokeWidth="2.5" strokeLinecap="round" />
              ) : variant === "closed" ? (
                <path d={eyePath} fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" />
              ) : (
                <path d={eyePath} fill="black" />
              )}
            </g>
          </mask>
        </defs>

        {/* Star body with eye mask holes */}
        <path d={STAR_PATH} fill={`url(#${maskId}-body)`} mask={`url(#${maskId}-eyes)`} />
      </svg>
    </span>
  );
}

export const StarTeammate = memo(StarTeammateComponent);
