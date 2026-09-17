// Pins for the pure Jev dispatch engine: tokenization, complexity read,
// weighted scoring, and every recommendTeam branch. No I/O anywhere.
import { describe, expect, it } from "vitest";

import {
  MAX_CANDIDATES,
  MAX_PICKS,
  recommendTeam,
  scoreCandidate,
  taskComplexity,
  taskTokens,
  type JevCandidate,
} from "./jev-dispatch.ts";

const bot = (over: Partial<JevCandidate> & { id: string; name: string }): JevCandidate => ({
  title: "General assistant",
  description: "Handles everyday questions.",
  model: "claude-sonnet-4",
  busy: false,
  ...over,
});

describe("taskTokens", () => {
  it("lowercases, dedupes, drops stopwords and short fragments", () => {
    const tokens = taskTokens("Fix the Login bug and then fix the API timeout!! fix");
    expect(tokens).toEqual(["login", "bug", "api", "timeout"]);
  });
  it("keeps technical fragments like c++ or node.js intact", () => {
    expect(taskTokens("upgrade our node.js service")).toContain("node.js");
  });
});

describe("taskComplexity", () => {
  it("reads short plain asks as simple", () => {
    expect(taskComplexity("What is my timezone?")).toBe("simple");
  });
  it("reads multi-step briefs as complex", () => {
    expect(taskComplexity(
      "1. Audit the repo\n2. Write the report\n3. Finally, email the team",
    )).toBe("complex");
  });
  it("reads long code-bearing briefs as complex", () => {
    expect(taskComplexity(`${"word ".repeat(50)}write a sql migration`)).toBe("complex");
  });
});

describe("scoreCandidate", () => {
  it("weights title hits over name hits over description hits", () => {
    const strong = scoreCandidate("fix the login bug", bot({
      id: "a", name: "Login Bot", title: "Auth and login specialist",
    }));
    const weak = scoreCandidate("fix the login bug", bot({
      id: "b", name: "Misc Bot", description: "sometimes talks about login",
    }));
    expect(strong.relevance).toBeGreaterThan(weak.relevance);
    expect(strong.matched).toContain("login");
  });
});

describe("recommendTeam", () => {
  it("says handle itself when there are no candidates", () => {
    const d = recommendTeam("fix the login bug", []);
    expect(d.handleSelf).toBe(true);
    expect(d.picks).toEqual([]);
  });
  it("says handle itself when nothing overlaps", () => {
    const d = recommendTeam("design a logo", [
      bot({ id: "x", name: "Finance", title: "invoices", description: "spreadsheets" }),
    ]);
    expect(d.handleSelf).toBe(true);
  });
  it("ranks the true specialist first with a reason citing the match", () => {
    const d = recommendTeam("our login page throws an api error", [
      bot({ id: "m", name: "Misc", title: "general helper" }),
      bot({ id: "s", name: "Authy", title: "authentication and login security" }),
    ]);
    expect(d.handleSelf).toBe(false);
    expect(d.picks[0].botId).toBe("s");
    expect(d.picks[0].reason).toContain("login");
  });
  it("prefers an available bot over an equally-matching busy one", () => {
    const candidates = [
      bot({ id: "busy", name: "Authy One", title: "login security", busy: true }),
      bot({ id: "free", name: "Authy Two", title: "login security", busy: false }),
    ];
    const d = recommendTeam("login broken", candidates);
    expect(d.picks[0].botId).toBe("free");
  });
  it("clamps maxPicks to MAX_PICKS", () => {
    const candidates = [1, 2, 3, 4, 5].map((i) =>
      bot({ id: `b${i}`, name: `Authy ${i}`, title: "login security" }));
    const d = recommendTeam("login broken", candidates, { maxPicks: 99 });
    expect(d.picks.length).toBe(MAX_PICKS);
  });
  it("never returns more picks than credible candidates", () => {
    const d = recommendTeam("login broken", [
      bot({ id: "only", name: "Authy", title: "login security" }),
    ], { maxPicks: 3 });
    expect(d.picks.length).toBe(1);
  });
  it("advises a model fit note for small models on complex work", () => {
    const d = recommendTeam(
      `${"step ".repeat(60)}\n1. plan\n2. implement\n3. finally ship the api migration`,
      [bot({ id: "s", name: "Speedy", title: "api migration expert", model: "haiku-mini" })],
    );
    expect(d.picks[0].modelFit).toMatch(/complex/);
  });
  it("caps candidates at MAX_CANDIDATES", () => {
    const many = Array.from({ length: MAX_CANDIDATES + 10 }, (_, i) =>
      bot({ id: `c${i}`, name: `Authy ${i}`, title: "login security" }));
    const d = recommendTeam("login broken", many);
    expect(d.handleSelf).toBe(false);
  });

  it("boosts a bot the workspace brain cites for this exact work", () => {
    // Without brain facts, the calendar bot has no overlap — nobody credible.
    const candidates = [
      bot({ id: "gen", name: "Helper", title: "calendar scheduling" }),
      bot({ id: "db", name: "Data Bot", title: "database pipelines" }),
    ];
    const plain = recommendTeam("database migration review", candidates);
    expect(plain.picks[0].botId).toBe("db"); // weak profile match only
    // With brain facts recording Helper doing database work, it overtakes
    // on institutional memory: brain-cited evidence outranks weak keywords.
    const d = recommendTeam("database migration review", candidates, {
      brainFacts: [
        { text: "database migration review for the billing service", source: "Helper standup 2026-09-10" },
        { text: "database migration runbook written", source: "Helper" },
      ],
    });
    expect(d.picks[0].botId).toBe("gen");
    expect(d.picks[0].reason).toContain("workspace brain cites");
  });

  it("ignores brain facts that name no candidate or share no words", () => {
    const candidates = [bot({ id: "a", name: "Authy", title: "login security" })];
    const d = recommendTeam("login broken", candidates, {
      brainFacts: [
        { text: "completely unrelated gardening notes about roses", source: "Authy" },
        { text: "login security overhaul done", source: "Somebody Else entirely" },
      ],
    });
    expect(d.picks[0].botId).toBe("a");
    expect(d.picks[0].reason).not.toContain("workspace brain cites");
  });

  it("caps the brain bonus so one prolific bot cannot buy the top slot", () => {
    // Same title keyword (security=3), but Spec also owns login+security in
    // its description and name: base 7. Spam matches only the title (3) and
    // brings 12 brain citations — capped at +4 → 7. The tie falls to the
    // profile-stronger bot, so citations cannot buy the top slot.
    const candidates = [
      bot({ id: "spec", name: "Login Spec", title: "security", description: "owns login and security for the platform" }),
      bot({ id: "spam", name: "Spam", title: "security", description: "misc notes" }),
    ];
    const facts = Array.from({ length: 12 }, (_, i) => ({
      text: "login work item",
      source: `Spam log ${i}`,
    }));
    const d = recommendTeam("login security", candidates, { brainFacts: facts });
    expect(d.picks[0].botId).toBe("spec");
    expect(d.picks[0].reason).not.toContain("workspace brain cites");
  });
});
