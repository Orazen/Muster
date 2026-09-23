// The replay ring (broadcast in server/index.ts) answers "what did I
// miss?" for a reconnecting SSE client. Every broadcast keeps its
// sequence slot so resume-gap detection stays honest — but a live desktop
// capture is a base64 picture, hundreds of kilobytes, stale the moment
// the next frame arrives. Its slot is therefore kept while its picture is
// not: `frame: null` makes the replay loop skip it (the client hydrates
// that gap the same way it does a frame it declined with ?screens=off),
// and the retained payload keeps only identity fields. Live delivery to
// connected clients is untouched — this shapes what the ring stores, not
// what subscribers see.

/** One retained entry of the replay ring. */
export interface ReplaySlot<P> {
  seq: number;
  kind: string;
  /** null = sequence slot only; the replay loop skips these. */
  frame: string | null;
  payload?: P;
}

/** Retain one broadcast for SSE resume. Screen frames become
 * identity-only slots; every other kind is kept verbatim. */
export function retainForReplay<P extends object>(
  seq: number,
  kind: string,
  frame: string,
  payload: P,
): ReplaySlot<P | Omit<P, "png" | "mime">> {
  if (kind !== "screen") return { seq, kind, frame, payload };
  // SAFETY: P is one broadcast payload; the two dropped keys are exactly
  // the picture fields the return type omits (Omit<P, "png" | "mime">), so
  // the rest object keeps every other member of P unchanged — same strip
  // server/index.ts's slimMessage performs on a concrete message.
  const { png: _png, mime: _mime, ...rest } = payload as P & { png?: unknown; mime?: unknown };
  return { seq, kind, frame: null, payload: rest };
}
