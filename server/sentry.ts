// Sentries — watcher-type agents with a memory of what they saw.
//
// TinyFish's unclaimed territory: every mainstream agent app treats agents
// as one-shot invocations. A sentry is the opposite shape — a persistent
// roster member that re-runs the same watching prompt on a cadence,
// remembers its last finding, and only speaks when the picture CHANGES.
//
// The intelligence lives in a pure diff policy, separate from routines
// (which do the scheduling) and notify (which does delivery): the same
// watching prompt returns pages of prose, and only the digest line is
// compared run-over-run. Digest extraction is deliberately mechanical —
// the prompt asks the bot to END its reply with `SENTRY: <one line>`, and
// the policy reads exactly that.

/** The marker a sentry prompt asks the bot to end its reply with. */
export const SENTRY_MARKER = "SENTRY:";

/** Extract the digest line from a sentry reply: text after the LAST
 * `SENTRY:` marker, flattened to one line. Null when the reply forgot the
 * marker — a malformed reply is treated as "no digest", never as a diff. */
export function extractDigest(reply: string | null | undefined): string | null {
  if (!reply) return null;
  const idx = reply.lastIndexOf(SENTRY_MARKER);
  if (idx < 0) return null;
  const line = reply
    .slice(idx + SENTRY_MARKER.length)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line || null;
}

/** First-run semantics: a sentry with no memory records what it saw and
 * stays quiet — the first observation is the baseline, not news. */
export interface SentryVerdict {
  /** True only when the digest differs from the previous one AND neither
   * side is null. */
  changed: boolean;
  digest: string | null;
}

export function evaluateSentryRun(
  previousDigest: string | null | undefined,
  reply: string | null | undefined,
): SentryVerdict {
  const digest = extractDigest(reply);
  if (previousDigest === null || previousDigest === undefined) {
    return { changed: false, digest }; // baseline run — store, stay quiet
  }
  if (digest === null) {
    return { changed: false, digest: previousDigest }; // keep old memory
  }
  return { changed: digest !== previousDigest, digest };
}

/** The watching prompt appended to every sentry run. Tells the bot exactly
 * what the diff policy reads, so a well-behaved model produces stable
 * digests and a changed picture reliably changes the line. */
export function sentryPromptSuffix(): string {
  return (
    `\n\nThis is a recurring watch. End your reply with a final line starting with ${SENTRY_MARKER} ` +
    "followed by a ONE-line summary of the current state (max ~120 chars). " +
    "If nothing material changed since a routine watch would have shown, repeat your previous summary line as closely as you can — " +
    "you will only interrupt the user when that line changes."
  );
}

/** Whether a run should notify the user: changed picture, or a failed run
 * (a sentry that cannot watch is itself news). */
export function shouldSentryNotify(verdict: SentryVerdict, runOk: boolean): boolean {
  return verdict.changed || !runOk;
}
