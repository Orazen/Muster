// Privacy Shield unit tests: masking correctness, false-positive restraint,
// and the property that matters most — no raw span survives into the output.
import { describe, expect, it } from "vitest";

import { scrubForCloud } from "./privacy-shield.ts";

describe("scrubForCloud", () => {
  it("masks emails with stable numbered placeholders", () => {
    const r = scrubForCloud("mail tarun@orazen.online and also ramagiritharun@gmail.com tomorrow");
    expect(r.text).toContain("[EMAIL_1]");
    expect(r.text).toContain("[EMAIL_2]");
    expect(r.text).not.toContain("orazen.online");
    expect(r.findings).toContainEqual({ kind: "email", count: 2 });
  });

  it("masks phone numbers but leaves dates, versions, and issue ids alone", () => {
    const r = scrubForCloud("call +1 415 555 1234 or (212) 555-0199, shipped v1.2.3 fixed #455, due 2026-08-23");
    expect(r.text).toContain("[PHONE_1]");
    expect(r.text).toContain("[PHONE_2]");
    expect(r.text).toContain("v1.2.3");
    expect(r.text).toContain("#455");
    expect(r.text).toContain("2026-08-23"); // date: only 8 digits, under the floor
  });

  it("masks credentials via the same shapes transcripts already trust", () => {
    // Built by joining fragments: the finished strings match the redaction
    // patterns under test, but GitHub push protection must never see a
    // live-token-shaped literal in this file.
    const anthropicLike = ["sk-ant-", "api03-abcdefghijklmnopqrstuvwx"].join("");
    const slackLike = ["xoxb-", "123456789012-", "abcdefghijklmnop"].join("");
    const r = scrubForCloud(`use key ${anthropicLike} and ${slackLike}`);
    expect(r.text).not.toContain(anthropicLike);
    expect(r.text).not.toContain(slackLike);
    expect(r.text).toContain("[SECRET_");
    expect(r.findings[0]).toEqual({ kind: "secret", count: 2 });
  });

  it("leaves ordinary prose and code untouched", () => {
    const code = "const x = f(a, b); // TODO fix in v2 — see issue #123";
    const r = scrubForCloud(code);
    expect(r.text).toBe(code);
    expect(r.findings).toEqual([]);
  });

  it("never returns a raw finding span for a mixed prompt", () => {
    // Fragments joined at runtime so push protection never sees a
    // live-token-shaped literal (see the credentials test above).
    const slackLike = ["xoxb-", "123456789012-", "abcdefghijklmnop"].join("");
    const dirty =
      `hi I'm ada@example.com, +44 20 7946 0958, token ${slackLike}, bye`;
    const r = scrubForCloud(dirty);
    for (const raw of ["ada@example.com", "7946 0958", slackLike]) {
      expect(r.text).not.toContain(raw);
    }
  });
});
