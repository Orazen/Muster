// Generated short titles for untitled tasks: after a turn completes on a
// task still named "New task", the harness asks the bot's own engine for a
// compact conversation title and uses it. Honest fallback: generation is
// best-effort — if the adapter has no generateText or the call fails, the
// mechanical first-message title already in place simply stays.
import { describe, expect, it } from "vitest";
import {
  GENERATED_TITLE_MAX,
  clampGeneratedTitle,
  GENERATED_TITLE_PROMPT,
} from "./generated-titles.ts";

describe("generated short titles", () => {
  it("keeps the prompt hard-bounded so a runaway reply cannot inflate the transcript", () => {
    expect(GENERATED_TITLE_PROMPT.length).toBeLessThanOrEqual(400);
  });

  it("accepts a clean short title", () => {
    expect(clampGeneratedTitle("Plan the offsite")).toBe("Plan the offsite");
  });

  it("strips wrapping quotes the model may add", () => {
    expect(clampGeneratedTitle('"Plan the offsite"')).toBe("Plan the offsite");
    expect(clampGeneratedTitle("'Plan the offsite'")).toBe("Plan the offsite");
  });

  it("collapses newlines and padding to a single line", () => {
    expect(clampGeneratedTitle("  Plan\nthe offsite\n\n")).toBe("Plan the offsite");
  });

  it("cuts at the 48-char budget and drops dangling punctuation", () => {
    const long = "A very long task title that keeps going well past the budget";
    const cut = clampGeneratedTitle(long)!;
    expect(cut.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX);
    expect(cut.endsWith("—") || cut.endsWith("–") || cut.endsWith("-")).toBe(false);
  });

  it("rejects junk a model may return instead of a title", () => {
    expect(clampGeneratedTitle("   ")).toBeUndefined();
    expect(clampGeneratedTitle('""')).toBeUndefined();
    expect(clampGeneratedTitle("''")).toBeUndefined();
    expect(clampGeneratedTitle("“ ”")).toBeUndefined();
  });

  it("truncates without splitting surrogate pairs", () => {
    // 𝒜 is a 2-code-unit character; cutting at 48 code units must not
    // leave a lone surrogate at the end.
    const emoji = "𝒜".repeat(30);
    const cut = clampGeneratedTitle(emoji)!;
    expect(cut.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX);
    expect(cut).toBeTypeOf("string");
    expect([...cut].length).toBeLessThan(30);
  });
});
