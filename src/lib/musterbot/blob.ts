/**
 * Blob geometry — deterministic organic blob bodies.
 *
 * Inspired by the blob-avatar genre (see the Blobatar project, MIT), rebuilt
 * from scratch for Musterbot: a seeded RNG perturbs a superellipse outline
 * with low-frequency harmonics so every seed yields a soft, wobbly body that
 * still reads as the same mascot family.
 */

export type BlobPoint = { x: number; y: number };

/** Small deterministic PRNG (mulberry32). Same seed -> same blob, forever. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Body silhouettes a seed can land on. The first harmonic weights pick the
 * family; callers may also pin one explicitly.
 */
export type BlobSilhouette = "round" | "organic" | "droplet" | "cloud" | "capsule";

const SILHOUETTE_HARMONICS = {
  // relative weight of harmonic 2 / 3 / 4
  round: [0.02, 0.015, 0.01],
  organic: [0.09, 0.05, 0.03],
  droplet: [0.12, 0.03, 0.02],
  cloud: [0.06, 0.1, 0.04],
  capsule: [0.04, 0.02, 0.015],
} satisfies Record<BlobSilhouette, [number, number, number]>;

export interface BlobLayout {
  /** SVG path for the body, in a 200x200 viewBox centered at (100, 100). */
  path: string;
  /** Preserve the existing serialized layout field for library callers. */
  "shape": BlobSilhouette;
  /** Eye centre offset from (100, 100) and eye radius — geometry-aware. */
  eyes: { cx: number; cy: number; gap: number; r: number };
}

export function layoutBlob(seed: number, pinned?: BlobSilhouette): BlobLayout {
  const rand = rng(seed);
  // SAFETY: Object.keys enumerates the own keys of this closed, module-local
  // table, whose complete silhouette vocabulary is checked by satisfies.
  const silhouettes = Object.keys(SILHOUETTE_HARMONICS) as BlobSilhouette[];
  const silhouette = pinned ?? silhouettes[Math.floor(rand() * silhouettes.length)];
  const [w2, w3, w4] = SILHOUETTE_HARMONICS[silhouette];

  const stretch = 0.94 + rand() * 0.14; // vertical squash
  const tilt = silhouette === "capsule" ? Math.PI / 2 : rand() * Math.PI;
  const p2 = rand() * Math.PI * 2;
  const p3 = rand() * Math.PI * 2;
  const p4 = rand() * Math.PI * 2;

  const N = 48;
  const points: BlobPoint[] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    // superellipse-ish base radius, then harmonic wobble
    const base = 78;
    const wob =
      1 +
      w2 * Math.sin(2 * t + p2) +
      w3 * Math.sin(3 * t + p3) +
      w4 * Math.sin(4 * t + p4);
    const vertical = Math.abs(Math.sin(t)) * stretch + Math.abs(Math.cos(t)) * (2 - stretch);
    const r = base * wob * (0.72 + 0.28 * vertical);
    const ct = Math.cos(t + tilt * 0.15);
    const st = Math.sin(t + tilt * 0.15);
    points.push({ x: 100 + r * ct, y: 100 + r * st * (silhouette === "capsule" ? 1 : stretch) });
  }

  // Catmull-Rom -> bezier smooth closed path
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < N; i++) {
    const p0 = points[(i - 1 + N) % N];
    const p1 = points[i];
    const p2p = points[(i + 1) % N];
    const p3p = points[(i + 2) % N];
    const c1x = p1.x + (p2p.x - p0.x) / 6;
    const c1y = p1.y + (p2p.y - p0.y) / 6;
    const c2x = p2p.x - (p3p.x - p1.x) / 6;
    const c2y = p2p.y - (p3p.y - p1.y) / 6;
    path += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2p.x.toFixed(2)} ${p2p.y.toFixed(2)}`;
  }
  path += " Z";

  // Face placement: upper-centre, sized by the local body width.
  const eyeGap = 16 + rand() * 8;
  const eyeR = silhouette === "round" ? 10 : 8.5 + rand() * 2;
  return {
    path,
    "shape": silhouette,
    eyes: { cx: 100, cy: 92, gap: eyeGap, r: eyeR },
  };
}

/** Body gradient stops (highlight, base, shadow) from one hex color. */
export function gradientFor(hex: string): [string, string, string] {
  const c = Number.parseInt(hex.replace("#", ""), 16);
  const mix = (toward: number, t: number) => {
    const ch = (shift: number) => {
      const a = (c >> shift) & 0xff;
      const b = (toward >> shift) & 0xff;
      return Math.round(a + (b - a) * t);
    };
    return `#${[ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  };
  return [mix(0xffffff, 0.5), hex, mix(0x000000, 0.38)];
}
