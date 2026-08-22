import type { CursorSilhouette } from "@/components/CursorAvatar";
import type { AgentCharacter } from "./mascot";

/**
 * Additional teammate body shapes, rendered through the same CursorAvatar
 * engine as the default cursor mascot — so every new shape inherits all 14
 * morph states, blinking, gaze, motions and effects for free.
 *
 * Radial profiles r(θ) sampled at 64 points (θ=0 → +x, clockwise, y-down,
 * unit = body radius) follow musterbot's measured-profile format (MIT).
 */

const SAMPLES = 64;

/** Smooth closed SVG path through the radial samples (Catmull-Rom → Bézier). */
function profilePath(profile: ArrayLike<number>, centre: [number, number], radius: number): string {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const r = profile[i] * radius;
    pts.push([centre[0] + Math.cos(t) * r, centre[1] + Math.sin(t) * r]);
  }
  const n = pts.length;
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d + "Z";
}

function silhouette(name: string, path: string): CursorSilhouette {
  const markup = `<path xmlns="http://www.w3.org/2000/svg" d="${path}" fill="{{GRADIENT}}"/>`;
  return {
    name,
    fit: "",
    body: `\n${markup}\n`,
    clip: `<path xmlns="http://www.w3.org/2000/svg" d="${path}"/>`,
    anchor: { x: 105, y: 100, scale: 0.74 },
  };
}

/** Measured profiles from musterbot's tools/extract-profiles.py (MIT). */
const HEXAGON_PROFILE = [0.9210,0.9282,0.9441,0.9706,0.9984,1.0059,0.9896,0.9562,0.9290,0.9124,0.9047,0.9058,0.9157,0.9349,0.9641,0.9873,0.9882,0.9665,0.9336,0.9105,0.8968,0.8918,0.8955,0.9080,0.9293,0.9611,0.9820,0.9812,0.9590,0.9282,0.9089,0.8978,0.8964,0.9026,0.9189,0.9439,0.9778,0.9990,0.9964,0.9713,0.9439,0.9274,0.9196,0.9206,0.9308,0.9502,0.9799,1.0121,1.0226,1.0071,0.9752,0.9510,0.9366,0.9316,0.9351,0.9485,0.9711,1.0026,1.0215,1.0155,0.9863,0.9547,0.9347,0.9230];
const TRIANGLE_PROFILE = [0.7819,0.8211,0.8747,0.9440,1.0223,1.0960,1.1401,1.1340,1.0808,1.0047,0.9265,0.8603,0.8104,0.7730,0.7450,0.7273,0.7151,0.7118,0.7148,0.7245,0.7427,0.7680,0.8037,0.8518,0.9148,0.9876,1.0583,1.1073,1.1109,1.0667,0.9940,0.9164,0.8482,0.7948,0.7555,0.7261,0.7056,0.6925,0.6859,0.6869,0.6938,0.7084,0.7305,0.7615,0.8040,0.8595,0.9315,1.0092,1.0791,1.1171,1.1054,1.0501,0.9779,0.9050,0.8450,0.7990,0.7656,0.7413,0.7258,0.7160,0.7146,0.7204,0.7330,0.7528];
const EGG_PROFILE = [0.8369,0.8424,0.8497,0.8585,0.8674,0.8775,0.8878,0.8983,0.9089,0.9185,0.9288,0.9374,0.9445,0.9504,0.9543,0.9559,0.9555,0.9519,0.9465,0.9389,0.9302,0.9193,0.9085,0.8969,0.8852,0.8734,0.8625,0.8513,0.8411,0.8325,0.8243,0.8179,0.8137,0.8112,0.8102,0.8128,0.8178,0.8262,0.8374,0.8518,0.8702,0.8922,0.9169,0.9446,0.9741,1.0023,1.0267,1.0433,1.0481,1.0395,1.0216,0.9970,0.9697,0.9418,0.9169,0.8949,0.8760,0.8604,0.8490,0.8394,0.8337,0.8314,0.8305,0.8326];


/** Pebble: gently irregular round stone. */
const PEBBLE_PROFILE = (() => {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    out.push(0.92 + 0.06 * Math.sin(t * 2 + 0.7) + 0.03 * Math.cos(t * 3 - 1.1));
  }
  return out;
})();

/** Squircle: superellipse n≈4. */
const SQUIRCLE_PROFILE = (() => {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const c = Math.abs(Math.cos(t)), si = Math.abs(Math.sin(t));
    out.push(Math.pow(Math.pow(c, 4) + Math.pow(si, 4), -0.25));
  }
  return out;
})();

/** Capsule: vertical pill. */
const CAPSULE_PROFILE = (() => {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const y = Math.sin(t);
    out.push(y >= 0 ? 0.72 / Math.max(0.35, Math.cos(t > Math.PI ? t - Math.PI : t)) : 0.72 / Math.max(0.35, -Math.cos(t)));
  }
  return out;
})();

/** Cloud: bumpy top, flat-ish bottom. */
const CLOUD_PROFILE = (() => {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const bump = 0.12 * Math.sin(t * 3) * Math.max(0, Math.sin(t));
    out.push(0.85 + bump + 0.05 * Math.sin(t * 5 + 2));
  }
  return out;
})();

/** Sparkle: 4-point star with concave sides. */
const SPARKLE_PROFILE = (() => {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    out.push(0.55 + 0.45 * Math.pow(Math.abs(Math.cos(2 * t)), 1.6));
  }
  return out;
})();

/** Drop: teardrop pointing up — sharp top, round bottom. */
const DROP_PROFILE = (() => {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    // y-up lobe: narrow near θ=-90° (top), full circle below
    const s = Math.sin(t - Math.PI / 2); // -1 at top … 1 at bottom
    const taper = 0.42 + 0.58 * ((s + 1) / 2) ** 0.7;
    out.push(0.72 + 0.28 * taper);
  }
  return out;
})();

/** Heart: two lobes up, point down. */
const HEART_PROFILE = (() => {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    out.push(Math.hypot(x, y) / 17);
  }
  return out;
})();

const CENTRE: [number, number] = [105, 104];
const RADIUS = 118;

/** Extra teammate bodies by character id — the same ids AgentCharacter uses. */
export const TEAMMATE_BODY_SILHOUETTES = {
  hexagon: silhouette("hexagon", profilePath(HEXAGON_PROFILE, CENTRE, RADIUS)),
  triangle: silhouette("triangle", profilePath(TRIANGLE_PROFILE, CENTRE, RADIUS)),
  egg: silhouette("egg", profilePath(EGG_PROFILE, CENTRE, RADIUS)),
  drop: silhouette("drop", profilePath(DROP_PROFILE, CENTRE, RADIUS)),
  heart: silhouette("heart", profilePath(HEART_PROFILE, CENTRE, RADIUS)),
  pebble: silhouette("pebble", profilePath(PEBBLE_PROFILE, CENTRE, RADIUS)),
  squircle: silhouette("squircle", profilePath(SQUIRCLE_PROFILE, CENTRE, RADIUS)),
  capsule: silhouette("capsule", profilePath(CAPSULE_PROFILE, CENTRE, RADIUS)),
  cloud: silhouette("cloud", profilePath(CLOUD_PROFILE, CENTRE, RADIUS)),
  ball: silhouette("ball", profilePath(Array.from({ length: SAMPLES }, () => 0.98), CENTRE, RADIUS)),
  sparkle: silhouette("sparkle", profilePath(SPARKLE_PROFILE, CENTRE, RADIUS)),
} satisfies Record<Exclude<AgentCharacter, "cursor" | "lottie" | "star">, CursorSilhouette>;
