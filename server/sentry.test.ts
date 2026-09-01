import { describe, expect, it } from "vitest";

import {
  evaluateSentryRun,
  extractDigest,
  sentryPromptSuffix,
  shouldSentryNotify,
  SENTRY_MARKER,
} from "./sentry.ts";

describe("extractDigest", () => {
  it("reads the text after the last marker", () => {
    expect(extractDigest("Some long report.\nMore prose.\nSENTRY: 3 new listings under $200")).toBe(
      "3 new listings under $200",
    );
  });

  it("prefers the last marker when the reply mentions it twice", () => {
    expect(extractDigest("SENTRY: draft line\nrevised\nSENTRY: final line")).toBe("final line");
  });

  it("flattens code fences and newlines out of the digest", () => {
    expect(extractDigest("report\n```\nnoise\n```\nSENTRY:  port\n congestion  cleared")).toBe(
      "port congestion cleared",
    );
  });

  it("returns null without the marker, or with an empty digest", () => {
    expect(extractDigest("forgot the marker entirely")).toBeNull();
    expect(extractDigest("report\nSENTRY:   ")).toBeNull();
    expect(extractDigest(null)).toBeNull();
    expect(extractDigest(undefined)).toBeNull();
  });
});

describe("evaluateSentryRun", () => {
  it("first run is the baseline — never news", () => {
    const v = evaluateSentryRun(null, "report\nSENTRY: baseline state");
    expect(v.changed).toBe(false);
    expect(v.digest).toBe("baseline state");
  });

  it("same digest is quiet, different digest is news", () => {
    expect(evaluateSentryRun("state A", "report\nSENTRY: state A").changed).toBe(false);
    expect(evaluateSentryRun("state A", "report\nSENTRY: state B").changed).toBe(true);
  });

  it("a malformed reply keeps the old memory instead of firing", () => {
    const v = evaluateSentryRun("state A", "reply forgot the marker");
    expect(v.changed).toBe(false);
    expect(v.digest).toBe("state A");
  });

  it("an empty reply keeps the old memory", () => {
    const v = evaluateSentryRun("state A", null);
    expect(v.changed).toBe(false);
    expect(v.digest).toBe("state A");
  });
});

describe("shouldSentryNotify", () => {
  it("fires on change and on failure, stays quiet otherwise", () => {
    expect(shouldSentryNotify({ changed: true, digest: "x" }, true)).toBe(true);
    expect(shouldSentryNotify({ changed: false, digest: "x" }, true)).toBe(false);
    // a sentry that cannot watch is itself news
    expect(shouldSentryNotify({ changed: false, digest: "x" }, false)).toBe(true);
  });
});

describe("sentryPromptSuffix", () => {
  it("teaches the marker the policy reads", () => {
    expect(sentryPromptSuffix()).toContain(SENTRY_MARKER);
  });
});
