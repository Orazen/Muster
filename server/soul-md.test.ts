// SOUL.md round-trip contracts: export composes the deterministic file,
// import parses it back (plus close-enough hand-written variants), and a
// Hermes-style SOUL.md with unknown sections imports without dying.
import { describe, expect, it } from "vitest";

import { exportSoulMd, parseSoulMd } from "./soul-md.ts";

const bot = {
  name: "Scout",
  title: "Research bot",
  description: "Reads every source, shortlists what matters.",
  autoApprove: false,
  tokenBudget: 1_000_000,
  dailyUsdCap: 5,
  browser: true,
};

describe("exportSoulMd", () => {
  it("composes the deterministic markdown with a guardrails table", () => {
    const md = exportSoulMd(bot);
    expect(md).toContain("# Scout");
    expect(md).toContain("**Role:** Research bot");
    expect(md).toContain("## Guardrails");
    expect(md).toContain("- token budget: 1,000,000 tokens");
    expect(md).toContain("- daily USD cap: $5.00");
    expect(md).toContain("- browser tools: enabled");
  });

  it("escapes nothing — it is plain markdown the human owns", () => {
    const md = exportSoulMd({ ...bot, name: "Q&A bot" });
    expect(md).toContain("# Q&A bot");
  });
});

describe("parseSoulMd", () => {
  it("round-trips a Muster export", () => {
    const parsed = parseSoulMd(exportSoulMd(bot));
    expect(parsed).toMatchObject({
      name: "Scout",
      title: "Research bot",
      description: "Reads every source, shortlists what matters.",
      guardrails: {
        autoApprove: false,
        tokenBudget: 1_000_000,
        dailyUsdCap: 5,
        browser: true,
      },
    });
  });

  it("parses a hand-written variant without guardrails", () => {
    const parsed = parseSoulMd("# Atlas\n\n**Role:** Ops bot\n\nKeeps the depot running.");
    expect(parsed).toMatchObject({
      name: "Atlas",
      title: "Ops bot",
      description: "Keeps the depot running.",
    });
    expect(parsed!.guardrails).toEqual({});
  });

  it("imports a Hermes-style SOUL.md with unknown sections", () => {
    const hermes = [
      "# Hermes Ops",
      "",
      "A meticulous operations agent.",
      "",
      "## Style",
      "",
      "- terse",
      "- no emoji",
      "",
      "## Guardrails",
      "",
      "- auto-approve: off",
      "- token budget: none",
    ].join("\n");
    const parsed = parseSoulMd(hermes);
    expect(parsed).toMatchObject({
      name: "Hermes Ops",
      description: "A meticulous operations agent.",
      guardrails: { autoApprove: false, tokenBudget: null },
    });
  });

  it("returns null for files with no H1 identity", () => {
    expect(parseSoulMd("just some notes\n\n- item")).toBeNull();
  });

  it("keeps curly quotes out of comparisons by normalizing to straight quotes", () => {
    const parsed = parseSoulMd("# Scout\n\nIt’s about the work.");
    expect(parsed!.description).toBe("It's about the work.");
  });
});
