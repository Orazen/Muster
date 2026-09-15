// The caption word cursor — "which word is the voice on right now?"
//
// Neither audio path gives us a word timeline: ElevenLabs returns a flat
// clip with no alignment data, and the browser's speechSynthesis only
// reports boundary events on some engines. So the cursor is an estimate,
// and the estimator lives here as a pure function — testable without a
// single millisecond of audio.

/** Split a caption into words the same way the cursor counts them. */
export function cursorWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Rendered-clip path: assume the clip speaks its words evenly across its
 * duration, but never faster than a natural speaking rate. The min() of
 * the two bounds is what keeps the cursor from racing ahead of a clip
 * that opens with silence; the last-word hold covers a clip whose tail is.
 */
export function wordIndexFromProgress(
  elapsed: number,
  duration: number,
  wordCount: number,
  wpsCeiling = 3.2,
): number {
  if (wordCount <= 0) return 0;
  // duration is NaN until metadata loads, and can be Infinity on streams —
  // without a real length the only honest cursor is the first word.
  if (!Number.isFinite(duration) || duration <= 0 || !(elapsed >= 0)) return 0;
  const byFraction = Math.min(elapsed / duration, 1) * wordCount;
  const byRate = elapsed * wpsCeiling;
  return Math.min(wordCount - 1, Math.floor(Math.min(byFraction, byRate)));
}

/**
 * Native speechSynthesis path: a boundary event carries the charIndex of
 * the word it just started; the cursor is the number of whitespace-split
 * words before that index. Out-of-range indices clamp instead of throwing
 * — this is a UI nicety, never a reason to drop a caption.
 */
export function wordIndexFromCharIndex(text: string, charIndex: number): number {
  const end = Math.max(0, Math.min(charIndex, text.length));
  const total = cursorWords(text).length;
  if (!total) return 0;
  // A boundary at (or past) the final word's end must not point off the end
  // of the caption.
  return Math.min(cursorWords(text.slice(0, end)).length, total - 1);
}
