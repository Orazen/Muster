/**
 * Flower poses — the app-icon mascot's expression vocabulary.
 *
 * The flower body (MusterMascot's MUSTER_BODY, the artwork at /app-icon.svg)
 * carries two portrait capsule eyes. Following the blobatar (MIT) design
 * rule — a face is expressed purely through eye geometry and body offset,
 * never added marks — each pose is a small channel set applied about each
 * eye's own centre with a CSS transition. Channel semantics mirror
 * blobatar's: for a portrait capsule a positive tilt reads angry.
 *
 * Every pose must differ from idle on at least three channels so no pose
 * ever reads as "idle with a tint" (asserted in flower.test.ts).
 */

/** Eye-scale / eye-offset / tilt channels. The `2`-suffixed channels land
 * on the right eye only (asymmetry — e.g. wink closes one eye). */
export interface FlowerPose {
  esx?: number;
  esy?: number;
  tilt?: number;
  /** Eye-pair vertical offset, +=down, viewBox units (224-box). */
  edy?: number;
  /** Eye-pair horizontal spread, +=apart. */
  edx?: number;
  esx2?: number;
  esy2?: number;
  tilt2?: number;
  edy2?: number;
  /** Whole-body vertical translate, +=down. */
  bdy?: number;
}

/** Identity is omitted — an absent channel means "no change". */
export const FLOWER_POSES = {
  idle: {},
  happy: { esx: 1.72, esy: 0.3, tilt: 8, edy: -3.3, edx: 3.3, esx2: 0.08, esy2: 0.05, tilt2: -16, bdy: -4.8 },
  sad: { esx: 0.6, esy: 0.56, tilt: 26, edy: 7.9, edx: 4.2, esx2: -0.05, esy2: -0.07, tilt2: -7, bdy: 5.7 },
  mad: { esx: 1.85, esy: 0.26, tilt: -33, edy: 0.9, edx: 1.3, tilt2: 5, bdy: 1.8 },
  surprised: { esx: 1.34, esy: 1.2, tilt: -6, edy: -2.3, edx: 1.1, esx2: 0.05, esy2: 0.07, bdy: -3.1 },
  wink: { esx: 1.32, esy: 0.76, tilt: 5, edy: -1.3, edx: 1.8, esx2: 0.26, esy2: -0.56, tilt2: -11, bdy: -2.4 },
  sleepy: { esx: 1.14, esy: 0.22, tilt: 0, edy: 5.3, edx: 0.7, tilt2: 4, bdy: 2.6 },
  smug: { esx: 1.3, esy: 0.42, tilt: 18, edy: -1.1, edx: 1.1, tilt2: -36, bdy: -2.2 },
  unsure: { esx: 0.95, esy: 1.02, tilt: 4, edy: -0.4, edx: 0.7, esx2: 0.24, esy2: -0.44, tilt2: -18 },
  scared: { esx: 0.78, esy: 0.96, tilt: -12, edy: -3.3, edx: -1.8, tilt2: 4 },
  love: { esx: 0.86, esy: 1.28, tilt: -14, edy: -1.1, edx: -0.8, esy2: 0.06, bdy: -3.5 },
  shy: { esx: 0.62, esy: 0.5, tilt: 10, edy: 3.1, edx: -0.4, esy2: -0.04, bdy: 2.0 },
  sick: { esx: 1.25, esy: 0.34, tilt: 20, edy: 4.0, edx: 1.8, tilt2: -6, bdy: 3.1 },
  thinking: { esx: 1.15, esy: 0.62, tilt: 0, edy: 9.2, edx: 0.9, edy2: -18.5 },
  /** Determined focus — narrowed level eyes, slightly set jaw of a body. */
  focused: { esx: 1.45, esy: 0.5, tilt: -12, edy: 0.9, edx: 0.9, bdy: 1.1 },
} satisfies Record<string, FlowerPose>;

export type FlowerPoseName = keyof typeof FLOWER_POSES;

const POSE_NAMES = new Set(Object.keys(FLOWER_POSES));

/** True when every named pose resolves — guards typos in the mapping. */
export function isPoseName(name: string): name is FlowerPoseName {
  return POSE_NAMES.has(name);
}

/**
 * Maps any app state onto a pose, defaulting to idle. Keyword groups
 * deliberately overlap as little as possible so a bot's resting look stays
 * stable while its title/description are edited.
 */
export function poseFor(state: string | null | undefined): FlowerPoseName {
  const key = (state ?? "idle").toLowerCase();
  if (isPoseName(key)) return key;
  if (/(happy|excit|proud|playful|celebrat|laugh|love|success)/.test(key)) return "happy";
  if (/(sleep|drows|rest|night|bored|powering)/.test(key)) return "sleepy";
  if (/(think|search|load|plan|read|progress|orbit|confus|unsure)/.test(key)) return "thinking";
  if (/(work|writ|build|run|send|upload|dictat|focus|typing)/.test(key)) return "focused";
  if (/(angry|mad|fail|error|alert)/.test(key)) return "mad";
  if (/(surpris|curious|spawn|wake|listen|notif|wink)/.test(key)) return "surprised";
  if (/(suspicious|review|audit|wary|radar|smug)/.test(key)) return "smug";
  if (/(scared|shy|sad|drag)/.test(key)) return "scared";
  if (/(sick|hungover)/.test(key)) return "sick";
  return "idle";
}
