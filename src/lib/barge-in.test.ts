import { describe, expect, it } from "vitest";

import { createBargeInGuard, DEFAULT_BARGE_IN } from "./barge-in";

/** Above the gate = the user is talking; below = room tone or the bot's
 *  own voice after AEC. Samples advance on a 50ms cadence like the
 *  monitor's interval. */
const TALK = 0.2;
const QUIET = 0.001;

describe("barge-in guard", () => {
  it("never trips on sustained quiet", () => {
    const guard = createBargeInGuard();
    for (let t = 0; t <= 5000; t += 50) {
      expect(guard.feed(QUIET, t)).toBe(false);
    }
  });

  it("trips at 250ms of sustained speech, edge-triggered once", () => {
    const guard = createBargeInGuard();
    for (let t = 0; t < DEFAULT_BARGE_IN.sustainMs; t += 50) {
      expect(guard.feed(TALK, t)).toBe(false);
    }
    // exactly at the threshold
    expect(guard.feed(TALK, DEFAULT_BARGE_IN.sustainMs)).toBe(true);
    // still talking — no second trip
    expect(guard.feed(TALK, DEFAULT_BARGE_IN.sustainMs + 50)).toBe(false);
    expect(guard.feed(TALK, DEFAULT_BARGE_IN.sustainMs + 100)).toBe(false);
  });

  it("a blip shorter than the sustain window never trips", () => {
    const guard = createBargeInGuard();
    expect(guard.feed(TALK, 0)).toBe(false);
    expect(guard.feed(TALK, 50)).toBe(false);
    expect(guard.feed(TALK, 100)).toBe(false);
    // quiet long enough to end the episode
    expect(guard.feed(QUIET, 400)).toBe(false);
    expect(guard.feed(QUIET, 700)).toBe(false);
    // a fresh blip starts over, not resumes
    expect(guard.feed(TALK, 750)).toBe(false);
    expect(guard.feed(TALK, 950)).toBe(false);
  });

  it("a dip inside the 200ms gap tolerance keeps one sentence alive", () => {
    const guard = createBargeInGuard();
    guard.feed(TALK, 0);
    guard.feed(TALK, 100);
    // 150ms dip — a word boundary, not the end of the turn
    guard.feed(QUIET, 250);
    // wall-clock since the episode began now clears the threshold
    expect(guard.feed(TALK, 300)).toBe(true);
  });

  it("a dip longer than the gap tolerance resets the clock", () => {
    const guard = createBargeInGuard();
    guard.feed(TALK, 0);
    guard.feed(TALK, 100);
    // 250ms quiet > 200ms tolerance: the episode is over
    expect(guard.feed(QUIET, 350)).toBe(false);
    // a new sentence must earn its own 250ms
    expect(guard.feed(TALK, 400)).toBe(false);
    expect(guard.feed(TALK, 600)).toBe(false);
    expect(guard.feed(TALK, 650)).toBe(true);
  });

  it("a dip of exactly the gap tolerance still counts as one sentence", () => {
    const guard = createBargeInGuard();
    guard.feed(TALK, 0);
    guard.feed(TALK, 100);
    // last above at 100; at 300 the gap is exactly 200ms — not longer
    expect(guard.feed(QUIET, 300)).toBe(false);
    // episode survived, so the next word trips it
    expect(guard.feed(TALK, 350)).toBe(true);
  });

  it("re-arms after a fully-ended episode", () => {
    const guard = createBargeInGuard();
    guard.feed(TALK, 0);
    expect(guard.feed(TALK, 250)).toBe(true);
    // long quiet resets and re-arms
    for (let t = 300; t <= 1300; t += 50) guard.feed(QUIET, t);
    expect(guard.feed(TALK, 1350)).toBe(false);
    expect(guard.feed(TALK, 1550)).toBe(false);
    expect(guard.feed(TALK, 1600)).toBe(true);
  });

  it("honours a custom sustain window", () => {
    const guard = createBargeInGuard({ ...DEFAULT_BARGE_IN, sustainMs: 100 });
    expect(guard.feed(TALK, 0)).toBe(false);
    expect(guard.feed(TALK, 50)).toBe(false);
    expect(guard.feed(TALK, 100)).toBe(true);
  });

  it("reset clears an in-progress episode", () => {
    const guard = createBargeInGuard();
    guard.feed(TALK, 0);
    guard.feed(TALK, 100);
    guard.reset();
    expect(guard.feed(TALK, 150)).toBe(false);
    expect(guard.feed(TALK, 400)).toBe(true);
  });
});
