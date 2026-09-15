// The Agent Hub catalog is data with a contract: ids unique, every field
// present, souls importable by the real server parser's shape, honest
// metadata, and — enforced hard — no credential literals anywhere.
import { describe, expect, it } from "vitest";

import { AGENT_TEMPLATES, soulMdFor, templateById } from "./agent-templates";

const KNOWN_COLORS = new Set([
  "orange", "green", "blue", "red", "purple", "cyan", "pink", "yellow", "teal", "coral",
]);

describe("agent templates", () => {
  it("has unique ids and resolves through templateById", () => {
    const ids = AGENT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of AGENT_TEMPLATES) expect(templateById(t.id)).toBe(t);
    expect(templateById("nope")).toBeUndefined();
  });

  it("every template carries the full honest shape", () => {
    for (const t of AGENT_TEMPLATES) {
      expect(t.name.length, t.id).toBeGreaterThan(1);
      expect(t.title.length, t.id).toBeGreaterThan(1);
      expect(t.tagline.length, t.id).toBeGreaterThan(20);
      expect(t.role.length, t.id).toBeGreaterThan(80);
      expect(t.reason.length, t.id).toBeGreaterThan(20);
      expect(t.provenance.length, t.id).toBeGreaterThan(5);
      expect(t.skills.length, t.id).toBeGreaterThanOrEqual(3);
      expect(t.sources.length, t.id).toBeGreaterThanOrEqual(1);
      expect(t.firstTask.length, t.id).toBeGreaterThan(10);
      expect(KNOWN_COLORS.has(t.color), `${t.id} color`).toBe(true);
      for (const peer of t.bestWith) {
        expect(templateById(peer), `${t.id} bestWith ${peer}`).toBeDefined();
      }
    }
  });

  it("souls match the server SOUL.md shape (# name, **Role:**, prose, guardrails off)", () => {
    for (const t of AGENT_TEMPLATES) {
      const soul = soulMdFor(t);
      expect(soul.startsWith(`# ${t.name}\n`), t.id).toBe(true);
      expect(soul, t.id).toContain(`**Role:** ${t.title}`);
      expect(soul, t.id).toContain("## Guardrails");
      // conservative defaults — a template never pre-grants itself anything
      expect(soul, t.id).toMatch(/^- auto-approve: off$/m);
      expect(soul, t.id).toMatch(/^- token budget: none$/m);
      expect(soul, t.id).toMatch(/^- daily USD cap: none$/m);
      expect(soul, t.id).toMatch(/^- browser tools: disabled$/m);
    }
  });

  it("no credential literals — keys, tokens, passwords never appear in the catalog", () => {
    const blob = JSON.stringify(AGENT_TEMPLATES);
    expect(blob).not.toMatch(/\b(api[_ -]?key|secret|token|password|passwd)\s*[:=]/i);
    expect(blob).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(blob).not.toMatch(/ghp_[A-Za-z0-9]{10,}/);
  });

  it("templates needing extra setup say so", () => {
    const needsSetup = AGENT_TEMPLATES.filter((t) => t.setupNote);
    expect(needsSetup.length).toBeGreaterThanOrEqual(3);
    for (const t of needsSetup) expect(t.setupNote!.length).toBeGreaterThan(10);
  });

  it("stays inside the server's field budgets (name 100, title 200, description 4000)", () => {
    for (const t of AGENT_TEMPLATES) {
      expect(t.name.length, t.id).toBeLessThanOrEqual(100);
      expect(t.title.length, t.id).toBeLessThanOrEqual(200);
      expect(t.role.length, t.id).toBeLessThanOrEqual(4_000);
    }
  });

  it("is a real lineup: the orchestration pair exists and cross-references", () => {
    expect(templateById("chief-of-staff")?.bestWith).toContain("planner");
    expect(templateById("planner")?.bestWith).toContain("chief-of-staff");
  });
});
