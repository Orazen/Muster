import { describe, expect, it } from "vitest";
import { cursorWords, wordIndexFromCharIndex, wordIndexFromProgress } from "./word-cursor";

describe("cursorWords", () => {
  it("splits on any run of whitespace and drops empties", () => {
    expect(cursorWords("  hello\t\nworld  ")).toEqual(["hello", "world"]);
    expect(cursorWords("")).toEqual([]);
  });
});

describe("wordIndexFromProgress", () => {
  const five = 5; // "one two three four five"

  it("starts at the first word and ends on the last", () => {
    expect(wordIndexFromProgress(0, 10, five)).toBe(0);
    expect(wordIndexFromProgress(10, 10, five)).toBe(4);
  });

  it("tracks progress evenly across the clip", () => {
    expect(wordIndexFromProgress(2, 10, five)).toBe(1);
    expect(wordIndexFromProgress(5, 10, five)).toBe(2);
    expect(wordIndexFromProgress(8, 10, five)).toBe(4);
  });

  it("holds at the last word past the end", () => {
    expect(wordIndexFromProgress(99, 10, five)).toBe(4);
  });

  it("never outruns a natural speaking rate", () => {
    // A 2s clip of 20 words would put the fraction at word 10 by t=1s;
    // the ceiling (3.2 wps) caps the cursor at word 3 instead.
    expect(wordIndexFromProgress(1, 2, 20)).toBe(3);
  });

  it("falls back to the first word when duration is unusable", () => {
    expect(wordIndexFromProgress(1, NaN, five)).toBe(0);
    expect(wordIndexFromProgress(1, Infinity, five)).toBe(0);
    expect(wordIndexFromProgress(1, 0, five)).toBe(0);
    expect(wordIndexFromProgress(-1, 10, five)).toBe(0);
  });

  it("handles empty and single-word captions", () => {
    expect(wordIndexFromProgress(5, 10, 0)).toBe(0);
    expect(wordIndexFromProgress(5, 10, 1)).toBe(0);
  });
});

describe("wordIndexFromCharIndex", () => {
  const text = "hello world foo";

  it("maps a word-start charIndex to that word", () => {
    expect(wordIndexFromCharIndex(text, 0)).toBe(0);
    expect(wordIndexFromCharIndex(text, 6)).toBe(1);
    expect(wordIndexFromCharIndex(text, 12)).toBe(2);
  });

  it("clamps out-of-range indices instead of pointing off the caption", () => {
    expect(wordIndexFromCharIndex(text, -5)).toBe(0);
    expect(wordIndexFromCharIndex(text, 999)).toBe(2);
    expect(wordIndexFromCharIndex("", 0)).toBe(0);
  });
});
