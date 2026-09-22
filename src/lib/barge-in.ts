/**
 * Barge-in guard — interruption by talking instead of by tapping (W4).
 *
 * The monitor keeps a getUserMedia stream open *through playback* — its
 * `echoCancellation` is the AEC that keeps the bot's own voice out of the
 * readings — and feeds this guard energy samples. Sustained speech past
 * the threshold trips the same interrupt as Space.
 *
 * Thresholds port the barge-in-guard numbers named in the voice plan:
 * 250ms sustained speech with 200ms gap tolerance (a word-gap is not the
 * end of the sentence). The energy gate is the first line: anything the
 * AEC already removed never reaches the sustain clock.
 *
 * Deliberately NOT ported from Vellum's server-side guard: the learned
 * echo EMA and duty-cycle cap. A naive duty cap cannot distinguish "the
 * bot's voice is bleeding through" from "a human is talking without
 * pausing" — and getting that wrong blocks the very interruption the
 * feature exists for. Echo defense here is the AEC'd capture path; proof
 * that the balance holds is real-device testing, which stays an owner
 * gate (headless has no audio).
 */

export interface BargeInThresholds {
  /** RMS at or above this counts as speech (energy gate). */
  energyGate: number;
  /** Speech sustained this long trips the interrupt. */
  sustainMs: number;
  /** A dip below the gate this long or shorter does not end the episode. */
  gapMs: number;
}

export const DEFAULT_BARGE_IN: BargeInThresholds = {
  // Time-domain RMS of room-tone/bleed sits well under this; conversational
  // speech lands an order of magnitude above it.
  energyGate: 0.02,
  sustainMs: 250,
  gapMs: 200,
};

export interface BargeInGuard {
  /** Feed one energy sample; returns true exactly once per speech episode
   *  when the user has talked long enough to interrupt. */
  feed(rms: number, nowMs: number): boolean;
  /** Drop any in-progress episode (call ended, toggle flipped). */
  reset(): void;
}

export function createBargeInGuard(thresholds: BargeInThresholds = DEFAULT_BARGE_IN): BargeInGuard {
  const { energyGate, sustainMs, gapMs } = thresholds;
  let episodeStart: number | null = null;
  let lastAbove: number | null = null;
  let fired = false;

  return {
    feed(rms: number, nowMs: number): boolean {
      if (rms >= energyGate) {
        if (episodeStart === null) episodeStart = nowMs;
        lastAbove = nowMs;
        if (!fired && nowMs - episodeStart >= sustainMs) {
          fired = true;
          return true;
        }
        return false;
      }
      // Below the gate. The episode survives a short dip; anything longer
      // than the gap tolerance means the sentence ended.
      if (episodeStart !== null && lastAbove !== null && nowMs - lastAbove > gapMs) {
        episodeStart = null;
        lastAbove = null;
        fired = false;
      }
      return false;
    },
    reset(): void {
      episodeStart = null;
      lastAbove = null;
      fired = false;
    },
  };
}
