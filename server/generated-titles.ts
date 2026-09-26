// Generated short titles: the harness's OMB-parity seam. A task starts as
// "New task" and gets a mechanical first-message title for free; this
// module upgrades that to a compact LLM-generated title after the first
// completed turn. Everything here is pure and dependency-free so the
// clamp is unit-testable without a store, and the caller owns the
// best-effort semantics (never throw, never block the fold).

/** Titles live in the same 48-char budget the mechanical title uses. */
export const GENERATED_TITLE_MAX = 48;

/** Hard-bounded prompt (≤400 chars): the reply is clamped to a slice of
 * the user's message, so a huge first message cannot inflate the call. */
export const GENERATED_TITLE_PROMPT =
  "Give a title of at most six words for this request. " +
  "Reply with the title only: no quotes, no punctuation at the end.";

export function generatedTitlePrompt(firstMessage: string): string {
  return `${GENERATED_TITLE_PROMPT}\n\n${firstMessage.slice(0, 400)}`;
}

/** Turn raw model output into a usable title, or undefined to keep the
 * existing one. Guards: whitespace-only, quote-only, newline collapse,
 * trailing punctuation, 48-char cut without splitting surrogate pairs. */
export function clampGeneratedTitle(raw: string): string | undefined {
  let text = raw.replace(/\s+/g, " ").trim();
  text = text.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
  if (!text) return undefined;
  if (text.length > GENERATED_TITLE_MAX) {
    // Budget by UTF-16 code units, matching titleFromMessage's convention.
    // A unit cut can split an astral character — drop the orphaned high
    // surrogate rather than persisting a broken tail.
    text = text.slice(0, GENERATED_TITLE_MAX);
    const tail = text.charCodeAt(text.length - 1);
    if (tail >= 0xd800 && tail <= 0xdbff) text = text.slice(0, -1);
    text = text.trimEnd().replace(/[—–-]+\s*$/, "").trimEnd();
  }
  return text || undefined;
}
