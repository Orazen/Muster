// Privacy Shield unit tests: masking correctness, false-positive restraint,
// and the property that matters most — no raw span survives into the output.
// V2 adds the reverse direction (un-scrub on reply), the session LRU bound,
// and the classifier seam's merge/dedupe/fallback contract.
import { afterEach, describe, expect, it } from "vitest";

import {
  SHIELD_SESSION_LIMIT,
  configureClassifier,
  forgetShieldSession,
  rememberScrub,
  scrubForCloud,
  scrubOutbound,
  shieldSessionKey,
  unscrubText,
  type ClassifierFinding,
} from "./privacy-shield.ts";

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

// ── v2: un-scrub on reply ─────────────────────────────────────────────
describe("v2 un-scrub", () => {
  afterEach(() => {
    configureClassifier(undefined);
  });

  it("restores originals in a model reply before it would be persisted", () => {
    // The dispatch→persist round trip, exactly as index.ts wires it:
    // mask the turn, remember the pairs, then un-scrub what came back.
    const key = shieldSessionKey("bot-1", "thread-1");
    try {
      const scan = scrubForCloud("ship it to tarun@orazen.online or call +1 415 555 1234");
      expect(scan.text).toContain("[EMAIL_1]");
      expect(scan.text).toContain("[PHONE_1]");
      rememberScrub(key, scan);
      const modelReply = "Done — wrote to [EMAIL_1] and texted [PHONE_1] twice.";
      const persisted = unscrubText(key, modelReply);
      expect(persisted).toContain("tarun@orazen.online");
      expect(persisted).toContain("+1 415 555 1234");
      expect(persisted).not.toContain("[EMAIL_1]");
      expect(persisted).not.toContain("[PHONE_1]");
    } finally {
      forgetShieldSession(key);
    }
  });

  it("keeps [SECRET_n] one-way even locally — no reverse pair exists", () => {
    // Built by joining fragments so GitHub push protection never sees a
    // live-token-shaped literal in this file (see the credentials test).
    const slackLike = ["xoxb-", "123456789012-", "abcdefghijklmnop"].join("");
    const key = shieldSessionKey("bot-secret", "thread-secret");
    try {
      const scan = scrubForCloud(`token ${slackLike}`);
      rememberScrub(key, scan);
      expect(scan.mappings ?? []).toEqual([]);
      expect(unscrubText(key, "stored under [SECRET_1]")).toBe("stored under [SECRET_1]");
    } finally {
      forgetShieldSession(key);
    }
  });

  it("leaves unknown placeholders and session-less text byte-identical", () => {
    // no session recorded at all → same string object semantics as v1
    expect(unscrubText("nobody:nothing", "hi [EMAIL_1]")).toBe("hi [EMAIL_1]");
    const key = shieldSessionKey("bot-2", "thread-2");
    try {
      rememberScrub(key, { text: "", findings: [], mappings: [{ placeholder: "[EMAIL_1]", original: "a@b.co" }] });
      // hallucinated token never recorded → untouched; real one restored
      expect(unscrubText(key, "see [EMAIL_9] and [EMAIL_1]")).toBe("see [EMAIL_9] and a@b.co");
      // plain prose with brackets but no shield tokens → unchanged
      expect(unscrubText(key, "array[0] is fine")).toBe("array[0] is fine");
    } finally {
      forgetShieldSession(key);
    }
  });
});

// ── v2: session LRU bound ─────────────────────────────────────────────
describe("v2 session LRU", () => {
  it("evicts the oldest pairs once the per-session bound is exceeded", () => {
    const key = shieldSessionKey("bot-lru", "thread-lru");
    try {
      // One scan with more distinct emails than the cap: EMAIL_1..EMAIL_N,
      // inserted in order, so the LOWEST numbers are the coldest entries.
      const total = SHIELD_SESSION_LIMIT + 25;
      const emails = Array.from({ length: total }, (_, i) => `user${i}@example.com`);
      const scan = scrubForCloud(emails.join(", "));
      rememberScrub(key, scan);
      // coldest 25 evicted: EMAIL_25 gone…
      expect(unscrubText(key, "[EMAIL_25]")).toBe("[EMAIL_25]");
      // …EMAIL_26 survives at the boundary, newest all survive
      expect(unscrubText(key, "[EMAIL_26]")).toBe("user25@example.com");
      expect(unscrubText(key, `[EMAIL_${total}]`)).toBe(`user${total - 1}@example.com`);
    } finally {
      forgetShieldSession(key);
    }
  });

  it("forgetShieldSession drops everything for that conversation", () => {
    const key = shieldSessionKey("bot-gone", "thread-gone");
    rememberScrub(key, { text: "", findings: [], mappings: [{ placeholder: "[PHONE_1]", original: "+1 415 555 1234" }] });
    expect(unscrubText(key, "call [PHONE_1]")).toBe("call +1 415 555 1234");
    forgetShieldSession(key);
    expect(unscrubText(key, "call [PHONE_1]")).toBe("call [PHONE_1]");
  });
});

// ── v2: classifier seam ───────────────────────────────────────────────
describe("v2 classifier seam", () => {
  afterEach(() => {
    // every test installs its own classifier or none — never leak one
    configureClassifier(undefined);
  });

  it("with no classifier configured, scrubOutbound is byte-identical to scrubForCloud", async () => {
    const samples = [
      "",
      "plain prose about issue #455 and v1.2.3",
      "mail ada@example.com, call +44 20 7946 0958",
    ];
    for (const sample of samples) {
      const viaSeam = await scrubOutbound(sample);
      const direct = scrubForCloud(sample);
      expect(viaSeam).toEqual(direct); // text, findings, AND mappings match
    }
  });

  it("merges layer-2 findings after layer 1 and dedupes by value", async () => {
    const classifier = async (text: string): Promise<ClassifierFinding[]> => {
      expect(text).not.toContain("ada@example.com"); // sees POST-layer-1 output only
      return [
        { kind: "secret", value: "ACCT-4455" },
        { kind: "secret", value: "ACCT-4455" }, // duplicate value → dropped
        { kind: "email", value: "ada@example.com" }, // layer 1 already covered → dropped
        { kind: "phone", value: "" }, // empty junk → dropped
      ];
    };
    configureClassifier(classifier);
    const merged = await scrubOutbound("pay ada@example.com from account ACCT-4455 today");
    expect(merged.text).toContain("[EMAIL_1]");
    expect(merged.text).toContain("[SECRET_1]");
    expect(merged.text).not.toContain("ACCT-4455");
    // canonical secret-first ordering, counts merged per kind
    expect(merged.findings).toEqual([
      { kind: "secret", count: 1 },
      { kind: "email", count: 1 },
    ]);
    // reverse map carries BOTH layers' pairs for un-scrub on reply
    const originals = (merged.mappings ?? []).map((m) => m.original);
    expect(originals).toContain("ada@example.com");
    expect(originals).toContain("ACCT-4455");
  });

  it("zero findings from a classifier means zero changes — no receipt-worthy result", async () => {
    configureClassifier(async (): Promise<ClassifierFinding[]> => []);
    const sample = "mail ada@example.com tomorrow";
    const merged = await scrubOutbound(sample);
    expect(merged).toEqual(scrubForCloud(sample)); // identical output → receipt logic sees nothing new
  });

  it("a throwing or lying classifier degrades to layer-1 behavior", async () => {
    configureClassifier(async (): Promise<ClassifierFinding[]> => {
      throw new Error("model exploded");
    });
    const sample = "mail ada@example.com tomorrow";
    expect(await scrubOutbound(sample)).toEqual(scrubForCloud(sample));
    // runtime junk that violates the type contract must not crash either
    const liar = async (): Promise<ClassifierFinding[]> =>
      // SAFETY: JSON.parse yields any — asserted once to hand the seam a
      // classifier that lies about its contract (returns null), which the
      // dispatch path must survive without crashing
      JSON.parse("null") as ClassifierFinding[];
    configureClassifier(liar);
    expect(await scrubOutbound(sample)).toEqual(scrubForCloud(sample));
  });
});
