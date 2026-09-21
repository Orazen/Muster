// Pins for the workspace brain: persistence, per-user isolation, withdrawal
// provenance, zero-LLM entity extraction, and gap-aware retrieval.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];

beforeEach(() => {
  dirs.push(mkdtempSync(join(tmpdir(), "muster-brain-")));
  vi.stubEnv("OMB_DATA_DIR", dirs[dirs.length - 1]);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function brain(): Promise<import("./workspace-brain.ts").WorkspaceBrain> {
  const mod = await import("./workspace-brain.ts");
  return mod.workspaceBrain();
}

describe("WorkspaceBrain", () => {
  it("stores a fact and answers a keyword query with matched evidence", async () => {
    const b = await brain();
    b.add({ text: "Alice runs engineering at Acme AI", kind: "person", source: "meeting-notes", ownerId: "u1" });
    const q = b.query("who runs engineering at Acme?", "u1");
    expect(q.hits.length).toBe(1);
    expect(q.hits[0].matched).toContain("engineering");
    expect(q.hits[0].fact.text).toContain("Alice");
  });

  it("keeps facts isolated per owner — the gbrain company-brain invariant", async () => {
    const b = await brain();
    b.add({ text: "Project Falcon ships in October", source: "standup", ownerId: "u1" });
    b.add({ text: "Project Heron is on hold", source: "standup", ownerId: "u2" });
    const u1 = b.query("project", "u1");
    const u2 = b.query("project", "u2");
    expect(u1.hits.map((h) => h.fact.text)).toEqual(["Project Falcon ships in October"]);
    expect(u2.hits.map((h) => h.fact.text)).toEqual(["Project Heron is on hold"]);
  });

  it("gives the desktop's implicit user full visibility, matching ownsRecord", async () => {
    const b = await brain();
    b.add({ text: "Shared onboarding runbook lives in Notion", source: "ops" });
    b.add({ text: "Priya's private hiring rubric", source: "1:1", ownerId: "u2" });
    const desktop = b.query("runbook rubric", undefined);
    // No owner filter = the one desktop user, who sees everything (same
    // semantics as the harness's ownsRecord on desktop installs).
    expect(desktop.hits.length).toBe(2);
  });

  it("withdrawal keeps provenance but removes the fact from queries", async () => {
    const b = await brain();
    const f = b.add({ text: "The launch date is March 1", source: "kickoff", ownerId: "u1" });
    expect(b.query("launch date", "u1").hits.length).toBe(1);
    expect(b.withdraw(f.id, "u1")).toBe(true);
    expect(b.query("launch date", "u1").hits.length).toBe(0);
    // provenance audit: withdrawn facts reachable only when asked for
    const audit = b.query("launch date", "u1", { includingWithdrawn: true });
    expect(audit.hits.length).toBe(1);
    expect(audit.hits[0].fact.withdrawnAt).toBeTypeOf("number");
  });

  it("refuses withdrawal by a non-owner", async () => {
    const b = await brain();
    const f = b.add({ text: "Board meets quarterly", source: "ops", ownerId: "u1" });
    expect(b.withdraw(f.id, "u2")).toBe(false);
    expect(b.query("board", "u1").hits.length).toBe(1);
  });

  it("supersedes chains a correction and retires the old fact", async () => {
    const b = await brain();
    const old = b.add({ text: "Budget is 40k", source: "planning", ownerId: "u1" });
    b.add({ text: "Budget is 55k after the board review", source: "planning", ownerId: "u1", supersedes: old.id });
    const q = b.query("budget", "u1");
    expect(q.hits.length).toBe(1);
    expect(q.hits[0].fact.text).toContain("55k");
    const audit = b.query("budget", "u1", { includingWithdrawn: true });
    expect(audit.hits.length).toBe(2);
  });

  it("requires provenance and nonempty text", async () => {
    const b = await brain();
    expect(() => b.add({ text: "", source: "x" })).toThrow();
    expect(() => b.add({ text: "fact", source: "  " })).toThrow();
  });

  it("extracts entities with zero LLM calls: names, emails, handles", async () => {
    const { extractEntities } = await import("./workspace-brain.ts");
    expect(extractEntities("Alice Chen and Bob meet; mail alice@acme.ai, ping @bob_dev")).toEqual(
      expect.arrayContaining(["Alice Chen", "alice@acme.ai", "@bob_dev"]),
    );
  });

  it("reports gaps: unknown entities and empty results", async () => {
    const b = await brain();
    b.add({ text: "Acme AI renewed the contract", source: "crm", ownerId: "u1" });
    const q = b.query("Did Initech sign the renewal with Zaphod?", "u1");
    expect(q.hits.length).toBe(0);
    expect(q.gaps.some((g) => g.includes("Initech"))).toBe(true);
    expect(q.gaps.some((g) => g.includes("Nothing in the brain matches"))).toBe(true);
  });

  it("flags weak single-token matches as a gap", async () => {
    const b = await brain();
    b.add({ text: "The deploy pipeline is green", source: "ci", ownerId: "u1" });
    const q = b.query("deploy?", "u1");
    expect(q.hits.length).toBe(1);
    expect(q.gaps.some((g) => g.includes("weak matches"))).toBe(true);
  });

  it("persists facts across brain instances (atomic file, schema-validated)", async () => {
    const first = await brain();
    first.add({ text: "Vega owns the onboarding tour", kind: "person", source: "planning", ownerId: "u1" });
    const second = await brain();
    const q = second.query("onboarding tour", "u1");
    expect(q.hits.length).toBe(1);
  });

  it("round-trips through JSON on disk with kinds intact", async () => {
    const first = await brain();
    first.add({ text: "Acme AI is a fintech", kind: "company", source: "crm", ownerId: "u1" });
    const raw = JSON.parse(readFileSync(join(dirs[0], "workspace-brain.json"), "utf8"));
    expect(raw.facts[0].kind).toBe("company");
    const second = await brain();
    expect(second.stats("u1").kinds.company).toBe(1);
  });

  it("history returns the full correction lineage oldest-first", async () => {
    const b = await brain();
    const v1 = b.add({ text: "The launch is March 1", source: "kickoff", ownerId: "u1" });
    const v2 = b.add({ text: "The launch is March 8", source: "kickoff", ownerId: "u1", supersedes: v1.id });
    const v3 = b.add({ text: "The launch is April 2", source: "kickoff", ownerId: "u1", supersedes: v2.id });
    const chain = b.history(v2.id, "u1");
    expect(chain.ancestors.map((f) => f.id)).toEqual([v1.id]);
    expect(chain.fact?.id).toBe(v2.id);
    expect(chain.descendants.map((f) => f.id)).toEqual([v3.id]);
  });

  it("restore un-withdraws a fact; restore of a live fact is refused", async () => {
    const b = await brain();
    const f = b.add({ text: "The API base is api.acme.ai", source: "ops", ownerId: "u1" });
    expect(b.withdraw(f.id, "u1")).toBe(true);
    expect(b.query("api base", "u1").hits.length).toBe(0);
    expect(b.restore(f.id, "u1")).toBe(true);
    expect(b.query("api base", "u1").hits.length).toBe(1);
    expect(b.restore(f.id, "u1")).toBe(false);
  });

  it("history never leaks another owner's chain", async () => {
    const b = await brain();
    const mine = b.add({ text: "My rollout is Tuesday", source: "standup", ownerId: "u1" });
    const other = b.add({ text: "Other rollout is Wednesday", source: "standup", ownerId: "u2" });
    expect(b.history(other.id, "u1").fact).toBeUndefined();
    const cross = b.add({ text: "My rollout is actually Thursday", source: "standup", ownerId: "u1", supersedes: other.id });
    // A correction pointing at a foreign fact stays visible, but the foreign
    // ancestor does not leak into my history.
    expect(b.history(cross.id, "u1").ancestors).toEqual([]);
    expect(b.history(mine.id, "u1").fact?.id).toBe(mine.id);
  });
});
