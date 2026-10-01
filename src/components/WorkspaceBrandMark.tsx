import { MUSTER_BODY, MUSTER_ORANGE } from "./MusterMascot";

/** The approved flat workspace logo uses the authored app-icon geometry.
 * Saved teammate avatars keep their existing renderer and identity. */
export function WorkspaceBrandMark({ size = 32, label }: { size?: number; label?: string }) {
  return <svg width={size} height={size} viewBox="-112 -112 224 224" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ flexShrink: 0 }}>
    <path d={MUSTER_BODY} fill={MUSTER_ORANGE} />
    <g transform="translate(-15 -2) rotate(-4)"><rect x="-10.5" y="-22" width="21" height="44" rx="10.5" fill="#fff9ee" /></g>
    <g transform="translate(38 -6) rotate(-4)"><rect x="-10.5" y="-22" width="21" height="44" rx="10.5" fill="#fff9ee" /></g>
  </svg>;
}
