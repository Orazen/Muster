/**
 * Blob faces — expression mapping for the mascot's behaviour vocabulary.
 *
 * Musterbot models a compact face: eye shape (open / half / closed / happy /
 * wide / wary) plus an optional mouth. Host apps map their richer state
 * vocabularies onto these.
 */

export type EyeShape = "open" | "half" | "closed" | "happy" | "wide" | "wary";
export type Mouth = "none" | "smile" | "flat" | "oh" | "grit";

export interface Face {
  eyes: EyeShape;
  mouth: Mouth;
}

/** The states every host should map. */
export type BlobState =
  | "idle" | "happy" | "sad" | "thinking" | "working" | "sleeping"
  | "surprised" | "suspicious" | "excited" | "listening";

export const STATE_FACES: Record<BlobState, Face> = {
  idle: { eyes: "open", mouth: "none" },
  happy: { eyes: "happy", mouth: "smile" },
  sad: { eyes: "half", mouth: "flat" },
  thinking: { eyes: "half", mouth: "flat" },
  working: { eyes: "open", mouth: "grit" },
  sleeping: { eyes: "closed", mouth: "none" },
  surprised: { eyes: "wide", mouth: "oh" },
  suspicious: { eyes: "wary", mouth: "flat" },
  excited: { eyes: "happy", mouth: "oh" },
  listening: { eyes: "wide", mouth: "none" },
};

/** Maps any string state onto a Face, defaulting to idle. */
export function faceFor(state: string | null | undefined): Face {
  const key = (state ?? "idle").toLowerCase();
  if (key in STATE_FACES) return STATE_FACES[key as BlobState];
  if (/(happy|excit|proud|playful|celebrat|love)/.test(key)) return STATE_FACES.happy;
  if (/(sleep|drows|rest|night)/.test(key)) return STATE_FACES.sleeping;
  if (/(think|load|plan|search|read)/.test(key)) return STATE_FACES.thinking;
  if (/(work|write|build|run|send|upload|dictat)/.test(key)) return STATE_FACES.working;
  if (/(sad|alert|angry|scared|fail|error)/.test(key)) return STATE_FACES.sad;
  if (/(surpris|curious|spawn|wake)/.test(key)) return STATE_FACES.surprised;
  if (/(suspicious|review|audit|wary)/.test(key)) return STATE_FACES.suspicious;
  if (/(listen|radar|notify|watch)/.test(key)) return STATE_FACES.listening;
  return STATE_FACES.idle;
}
