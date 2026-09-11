/**
 * Musterbot logo mark — the brand blob.
 *
 * A single soft blob in Muster orange with the white oval eyes of the
 * brand mascot; the same geometry system as BlobBot, pinned to one
 * authored seed so the mark is stable everywhere.
 */
import { layoutBlob } from "./blob";

export const MUSTERBOT_ORANGE = "#f08a24";

const MARK_SEED = 0x0a57b3; // authored: picked from the showcase, frozen here
const mark = layoutBlob(MARK_SEED, "organic");

export function MusterBotMark({
  size = 44,
  color = MUSTERBOT_ORANGE,
  eyes = "open" as "open" | "closed" | "happy",
  label,
  /** 0..1 animates a gentle idle wobble via CSS. */
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
  const gid = `musterbot-mark-${color.replace("#", "")}`;
  const { path, eyes: ge } = mark;
  const eyeY = eyes === "happy" ? ge.cy + ge.r * 0.18 : ge.cy;
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
      style={animated ? { animation: "musterbot-wobble 3.6s ease-in-out infinite" } : undefined}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#ffb259" />
          <stop offset="0.45" stopColor={color} />
          <stop offset="1" stopColor="#c05f0e" />
        </linearGradient>
      </defs>
      <path d={path} fill={`url(#${gid})`} />
      {eyes === "closed" ? (
        <>
          <path d={`M ${100 - ge.gap - ge.r} ${eyeY} q ${ge.r} ${ge.r * 0.9} ${ge.r * 2} 0`} stroke="#f9f9f9" strokeWidth={ge.r * 0.5} strokeLinecap="round" fill="none" />
          <path d={`M ${100 + ge.gap - ge.r} ${eyeY} q ${ge.r} ${ge.r * 0.9} ${ge.r * 2} 0`} stroke="#f9f9f9" strokeWidth={ge.r * 0.5} strokeLinecap="round" fill="none" />
        </>
      ) : eyes === "happy" ? (
        <>
          <path d={`M ${100 - ge.gap - ge.r} ${eyeY + ge.r * 0.4} q ${ge.r} ${-ge.r * 0.9} ${ge.r * 2} 0`} stroke="#f9f9f9" strokeWidth={ge.r * 0.5} strokeLinecap="round" fill="none" />
          <path d={`M ${100 + ge.gap - ge.r} ${eyeY + ge.r * 0.4} q ${ge.r} ${-ge.r * 0.9} ${ge.r * 2} 0`} stroke="#f9f9f9" strokeWidth={ge.r * 0.5} strokeLinecap="round" fill="none" />
        </>
      ) : (
        <>
          <ellipse cx={100 - ge.gap} cy={eyeY} rx={ge.r * 0.72} ry={ge.r} fill="#f9f9f9" />
          <ellipse cx={100 + ge.gap} cy={eyeY} rx={ge.r * 0.72} ry={ge.r} fill="#f9f9f9" />
        </>
      )}
      <path
        d={`M ${100 - ge.r * 0.9} ${ge.cy + ge.r * 1.9} q ${ge.r * 0.9} ${ge.r * 0.7} ${ge.r * 1.8} 0`}
        stroke="#f9f9f9"
        strokeWidth={ge.r * 0.42}
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
