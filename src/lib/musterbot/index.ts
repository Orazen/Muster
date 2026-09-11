/**
 * Musterbot — the Muster blob mascot library.
 *
 * Canonical source lives in the Orazen/musterbot repository; this vendored
 * copy is kept in sync by hand. Geometry and rendering are an independent
 * implementation of the blob-avatar aesthetic inspired by the MIT-licensed
 * Blobatar project.
 */
export { BlobBot, type BlobBotProps } from "./BlobBot";
export { MusterBotMark, MUSTERBOT_ORANGE } from "./MusterBotMark";
export { layoutBlob, gradientFor, hashSeed, rng, type BlobShape, type BlobLayout } from "./blob";
export { faceFor, STATE_FACES, type BlobState, type Face, type EyeShape, type Mouth } from "./face";
import "./motion.css";
