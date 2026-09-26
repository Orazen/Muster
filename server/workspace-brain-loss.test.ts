// Two defects in the workspace brain, both about what one account can do to
// another's facts. Reproduced from the 2026-09-26 bug sweep, findings 6 and 7.
//
// 6. ONE off-enum `kind` destroys the whole file, silently and permanently.
//    `POST /api/brain/facts` passed `body.kind` through unvalidated, and the
//    enum was enforced only at LOAD time — where it is all-or-nothing: a single
//    bad record fails the whole array parse, `facts` starts empty, and the next
//    `persist()` writes `{facts: []}`. Every account's memory, gone, with no
//    error anywhere. The load() comment claimed the file was "left untouched for
//    triage", which is true only until the next write.
//
// 7. The 10,000-fact cap is GLOBAL. A busy account evicts the oldest facts
//    across every owner, so one tenant's volume silently deletes another
//    tenant's memory.
//
// The load-tolerance case is the one that matters most, because it is the
// difference between "one bad record is dropped" and "the file is gone". It is
// also the one a reviewer is most likely to believe is already handled — the
// try/catch looks like handling.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const dirs: string[] = [];
let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "muster-brain-loss-"));
  dirs.push(dataDir);
  vi.stubEnv("OMB_DATA_DIR", dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Brain = import("./workspace-brain.ts").WorkspaceBrain;
const brain = async (): Promise<Brain> => (await import("./workspace-brain.ts")).workspaceBrain();

const BRAIN_FILE = () => join(dataDir, "workspace-brain.json");

/** The on-disk record shapes these cases write. Deliberately a named contract
 * rather than a loose dictionary: the point of several cases is that a record
 * is malformed, so the malformed shape has to be expressible on purpose. */
type RawField = string | number | boolean | null | undefined;
type RawFact = { id?: RawField; ownerId?: RawField; text?: RawField; kind?: RawField; source?: RawField; createdAt?: RawField };

/** The ids currently persisted, parsed at the boundary rather than asserted
 * into shape: this file is written by `persist()` and nothing else touches it
 * between the write and this read. */
function persistedIds(): string[] {
  const parsed = z.object({ facts: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(readFileSync(BRAIN_FILE(), "utf8")));
  return parsed.facts.map((f) => f.id);
}

/** One good record on disk, written straight to the file, bypassing every
 * writer. `extra` records are APPENDED after it — the point of these cases is
 * one bad record sitting next to good ones, so a fixture that replaced the good
 * record would test nothing. */
function seedRawFact(...extra: RawFact[]) {
  const good: RawFact = {
    id: "fact-good-1",
    ownerId: "alice",
    text: "Alice runs engineering at Acme AI",
    kind: "person",
    source: "meeting-notes",
    createdAt: 1,
  };
  writeFileSync(BRAIN_FILE(), JSON.stringify({ facts: [good, ...extra] }));
  return good;
}

/** Seed the FILE with `count` facts for one owner.
 *
 * Deliberately not `count` calls to `add()`: each add re-persists the whole
 * file, so building a full cap that way is quadratic — the first draft of this
 * suite took 95 seconds per case. Writing the file directly is also the honest
 * shape of the scenario, since the cap guards a file that ALREADY holds 10,000
 * records however they got there. */
function seedBulk(ownerId: string | undefined, count: number, prefix = "bulk") {
  const facts = Array.from({ length: count }, (_, i) => {
    const record: RawFact = {
      id: `${prefix}-${ownerId ?? "local"}-${i}`,
      text: `${prefix} fact ${i} about topic${i}`,
      kind: "note",
      source: "bulk",
      createdAt: i + 1,
    };
    if (ownerId) record.ownerId = ownerId;
    return record;
  });
  writeFileSync(BRAIN_FILE(), JSON.stringify({ facts }));
  return facts;
}

describe("one bad record must not cost every account their memory", () => {
  it("keeps the good facts when one record carries an off-enum kind", async () => {
    // The sweep's repro: a fact written with kind "robot".
    seedRawFact({ id: "fact-bad", kind: "robot", text: "R2D2 is a robot" });
    const b = await brain();
    // The good record survives...
    expect(b.query("Acme", "alice").hits.length).toBeGreaterThan(0);
    // ...and the bad one is simply not loaded.
    expect(b.query("R2D2", "alice").hits.length).toBe(0);
  });

  it("does not lose the file when a later write happens after a bad record", async () => {
    // This is the part that turned a bad record into data loss: the empty load
    // was only dangerous because the NEXT persist() overwrote the file.
    seedRawFact({ id: "fact-bad", kind: "robot", text: "R2D2 is a robot" });
    const b = await brain();
    b.add({ text: "Bob prefers dark mode", kind: "note", source: "interview", ownerId: "bob" });

    // Alice's good record is still on disk — before the fix this file contained
    // only Bob's new fact and Alice's memory was simply gone.
    const onDisk = persistedIds();
    expect(onDisk).toContain("fact-good-1");
    // And it survives a restart, which is the whole point.
    const reloaded = await brain();
    expect(reloaded.query("Acme", "alice").hits.length).toBeGreaterThan(0);
  });

  it("drops the unreadable record once it next writes, keeping the rest", async () => {
    // The convergence, stated as its own contract: after a write the file no
    // longer holds the record that could not be read. That step IS lossy, which
    // is why the drop is logged loudly and why nothing is written at all until a
    // real fact arrives.
    seedRawFact({ id: "fact-bad", kind: "robot", text: "R2D2 is a robot" });
    const b = await brain();
    b.add({ text: "Bob prefers dark mode", kind: "note", source: "interview", ownerId: "bob" });
    b.add({ text: "Bob uses a standing desk", kind: "note", source: "interview", ownerId: "bob" });

    const onDisk = persistedIds();
    expect(onDisk).not.toContain("fact-bad");
    expect(onDisk).toContain("fact-good-1");
    expect(b.query("R2D2", "alice").hits.length).toBe(0);
  });

  it("keeps facts when a record is malformed in other ways", async () => {
    // The tolerance is for the RECORD, not for one specific field. A missing
    // id, a non-string text, or a missing createdAt must not each be able to
    // empty the file.
    for (const broken of [{ id: "x", text: "no kind, no source, no time" }, { text: "no id, no kind, no source, no time" }, { id: "y", kind: "note", source: "s", text: "ok", createdAt: "soon" }]) {
      seedRawFact(broken);
      const b = await brain();
      expect(b.query("Acme", "alice").hits.length, `survives ${JSON.stringify(broken)}`).toBeGreaterThan(0);
    }
  });

  it("keeps facts when the file is not an object with a facts array", async () => {
    // Whole-file garbage is a different case and is allowed to start empty —
    // but it must not become a reason to delete a file we could not read.
    writeFileSync(BRAIN_FILE(), "{not json at all");
    const b = await brain();
    expect(b.query("Acme", "alice").hits.length).toBe(0);
    // Nothing was persisted, so the unreadable file is still there to triage.
    expect(readFileSync(BRAIN_FILE(), "utf8")).toBe("{not json at all");
  });
});

describe("the fact cap is per owner, not global", () => {
  it("does not let a busy account evict another account's facts", async () => {
    // The file already holds a full cap for one account; a second account adds
    // one fact. Before the fix that single add evicted the oldest records in the
    // FILE, whose owner had nothing to do with who was writing.
    seedBulk("noisy", 10_000);
    const b = await brain();
    b.add({ text: "Carol signed the Acme contract", kind: "note", source: "contract", ownerId: "carol" });

    const reloaded = await brain();
    expect(reloaded.query("Carol signed", "carol").hits.length).toBeGreaterThan(0);
    // The noisy account is untouched by someone ELSE writing.
    expect(reloaded.stats("noisy").facts).toBe(10_000);
  });

  it("evicts the writing owner's oldest facts when that owner is over the cap", async () => {
    seedBulk("noisy", 10_001);
    const b = await brain();
    b.add({ text: "one more from noisy", kind: "note", source: "bulk", ownerId: "noisy" });

    const reloaded = await brain();
    // Its own oldest went, so it sits exactly at the cap...
    expect(reloaded.stats("noisy").facts).toBe(10_000);
    // ...and its own newest stayed.
    expect(reloaded.query("one more from noisy", "noisy").hits.length).toBeGreaterThan(0);
  });

  it("keeps an unowned (desktop) record when a member writes past the cap", async () => {
    // A desktop install's facts carry no ownerId. They are the operator's, and
    // trimming must not treat them as "nobody's" and delete them first.
    seedBulk(undefined, 10_000, "studio");
    const b = await brain();
    b.add({ text: "one more from noisy", kind: "note", source: "bulk", ownerId: "noisy" });

    const reloaded = await brain();
    // The member's single add evicted nothing: the desktop's newest record is
    // still there.
    expect(reloaded.query("studio fact 9999", undefined).hits.length).toBeGreaterThan(0);
    // Unowned records are visible to every account by design (the gbrain
    // company-brain invariant), so "noisy" sees the desktop's 10,000 plus its
    // own one. What matters is that the TOTAL is intact rather than trimmed.
    expect(reloaded.stats("noisy").facts).toBe(10_001);
  });
});

describe("stats stay numeric for every kind a file can contain", () => {
  it("counts an off-enum kind without producing NaN", async () => {
    // `kinds[f.kind] += 1` on an unknown key yields NaN, which serialises to
    // null in JSON — so the client's own count read as broken.
    seedRawFact({ id: "fact-bad", kind: "robot", text: "R2D2 is a robot" });
    const b = await brain();
    const stats = b.stats("alice");
    for (const [kind, count] of Object.entries(stats.kinds)) {
      expect(Number.isFinite(count), `kinds.${kind} must be a finite number`).toBe(true);
    }
  });
});

describe("a correction must point at a fact that exists", () => {
  it("refuses a supersedes id that is not in the brain", async () => {
    // Accepted with a 201 and a dangling chain: the "correction" corrected
    // nothing, and the caller was told it worked.
    const b = await brain();
    expect(() => b.add({ text: "A correction of nothing", kind: "note", source: "s", ownerId: "alice", supersedes: "no-such-fact" })).toThrow();
  });

  it("keeps a cross-owner correction without retiring the other account's fact", async () => {
    // Deliberately NOT a refusal. The existing suite pins that a correction
    // naming a foreign fact stays visible with an empty ancestor chain, and
    // `history()` already refuses to walk into another owner's chain — so the
    // reference leaks nothing.
    //
    // What was genuinely broken is the SIDE EFFECT: the old code marked the
    // foreign fact withdrawn, which is a write to another account's data. Bob's
    // live fact stopped answering his queries, with no error and nothing in his
    // history to explain it.
    const b = await brain();
    const theirs = b.add({ text: "Bob's private fact", kind: "note", source: "s", ownerId: "bob" });
    const mine = b.add({ text: "Alice corrects Bob", kind: "note", source: "s", ownerId: "alice", supersedes: theirs.id });

    // Alice's correction exists and does not drag Bob's chain into her history.
    expect(b.stats("alice").facts).toBe(1);
    expect(b.history(mine.id, "alice").ancestors).toEqual([]);
    // And Bob's fact is untouched: still live, still his.
    expect(b.stats("bob").facts).toBe(1);
    expect(b.stats("bob").withdrawn).toBe(0);
  });

  it("still retires the caller's OWN superseded fact", async () => {
    // The other half of the contract: a same-owner correction must keep working
    // exactly as before, or the fix would have broken the feature it protects.
    const b = await brain();
    const first = b.add({ text: "The rollout is Tuesday", kind: "note", source: "standup", ownerId: "alice" });
    b.add({ text: "The rollout is Thursday", kind: "note", source: "standup", ownerId: "alice", supersedes: first.id });
    expect(b.stats("alice").facts).toBe(1);
    expect(b.stats("alice").withdrawn).toBe(1);
  });
});
