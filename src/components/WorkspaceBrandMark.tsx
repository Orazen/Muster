import { MUSTER_BODY, MUSTER_ORANGE } from "./MusterMascot";

/** The approved flat workspace logo uses the authored app-icon geometry.
 * Saved teammate avatars keep their existing renderer and identity. */
export function WorkspaceBrandMark({ size = 32, label, happy = false }: { size?: number; label?: string; happy?: boolean }) {
  return <svg width={size} height={size} viewBox="-112 -112 224 224" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ flexShrink: 0 }}>
    <path d={MUSTER_BODY} fill={MUSTER_ORANGE} />
    <g transform="translate(-15 -2) rotate(-4)">{happy ? <path d="M-12 4 Q0-16 12 4" fill="none" stroke="#fff9ee" strokeWidth="9" strokeLinecap="round" /> : <rect x="-10.5" y="-22" width="21" height="44" rx="10.5" fill="#fff9ee" />}</g>
    <g transform="translate(38 -6) rotate(-4)">{happy ? <path d="M-12 4 Q0-16 12 4" fill="none" stroke="#fff9ee" strokeWidth="9" strokeLinecap="round" /> : <rect x="-10.5" y="-22" width="21" height="44" rx="10.5" fill="#fff9ee" />}</g>
  </svg>;
}
