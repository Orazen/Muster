// Withdrawing a fact that is already withdrawn answers "no such fact".
//
// The fact exists, the caller owns it, and the state they asked for is already
// true — yet the brain collapsed "not found", "not yours" and "already
// withdrawn" into a single `false`, and the route mapped all three to
// 404 "no such fact". A user who taps withdraw twice is told their memory does
// not exist. The sibling `revert` route already answers this honestly with a
// 409 and a sentence saying what to do instead, so the correct behaviour was
// written down three lines away and never applied here.
//
// Ownership must stay indistinguishable: a foreign id has to report the same
// way a missing one does, or the endpoint becomes an existence oracle across
// accounts. So "not yours" and "not found" stay merged — only the case where
// the caller demonstrably owns the fact is allowed to say more.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];

beforeEach(() => {
  dirs.push(mkdtempSync(join(tmpdir(), "muster-brain-outcome-")));
  vi.stubEnv("OMB_DATA_DIR", dirs[dirs.length - 1]);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Brain = import("./workspace-brain.ts").WorkspaceBrain;
const brain = async (): Promise<Brain> => (await import("./workspace-brain.ts")).workspaceBrain();

describe("withdraw says which of the three things went wrong", () => {
  it("reports already_withdrawn for a fact this caller owns", async () => {
    const b = await brain();
    const fact = b.add({ text: "The rollout is Tuesday", source: "standup", ownerId: "u1" });
    expect(b.withdrawOutcome(fact.id, "u1")).toEqual({ ok: true });
    // The second tap is the whole point: same owner, same fact, end state
    // already satisfied.
    expect(b.withdrawOutcome(fact.id, "u1")).toEqual({ ok: false, reason: "already_withdrawn" });
    // And it is genuinely still withdrawn, not accidentally restored.
    expect(b.stats("u1").withdrawn).toBe(1);
  });

  it("keeps a foreign id indistinguishable from a missing one", async () => {
    // The reason this fix is not simply "always explain": reporting
    // not_owner would tell an attacker that an id exists in someone else's
    // account. Both stay not_found.
    const b = await brain();
    const theirs = b.add({ text: "Bob's private fact", source: "s", ownerId: "bob" });
    expect(b.withdrawOutcome("no-such-fact", "u1")).toEqual({ ok: false, reason: "not_found" });
    expect(b.withdrawOutcome(theirs.id, "u1")).toEqual({ ok: false, reason: "not_found" });
    // Bob's fact is untouched by the attempt.
    expect(b.stats("bob").facts).toBe(1);
  });

  it("restore distinguishes already-live from not-found and not-yours", async () => {
    const b = await brain();
    const fact = b.add({ text: "The rollout is Tuesday", source: "standup", ownerId: "u1" });
    // Restoring a fact that was never withdrawn: it exists, it is yours, it is
    // already live. Same class of lie as withdraw-twice.
    expect(b.restoreOutcome(fact.id, "u1")).toEqual({ ok: false, reason: "not_withdrawn" });
    b.withdraw(fact.id, "u1");
    expect(b.restoreOutcome(fact.id, "u1")).toEqual({ ok: true });
  });
});

describe("the boolean wrappers still answer for existing callers", () => {
  it("keeps the previous true/false contract intact", async () => {
    // server/workspace-brain.test.ts pins `withdraw`/`restore` as booleans.
    // Those assertions are load-bearing for five call sites and are left
    // untouched, so the outcome variants are purely additive.
    const b = await brain();
    const fact = b.add({ text: "The rollout is Tuesday", source: "standup", ownerId: "u1" });
    expect(b.withdraw(fact.id, "u1")).toBe(true);
    expect(b.withdraw(fact.id, "u1")).toBe(false);
    expect(b.restore(fact.id, "u1")).toBe(true);
    expect(b.restore(fact.id, "u1")).toBe(false);
  });

  it("agrees with the outcome variant on every path", async () => {
    // Two independent brains driven through the same sequence, because these
    // calls MUTATE: running the boolean variant and the outcome variant
    // against the same brain compares the first call's "before" state against
    // the second call's "after" state. That mistake is what the first draft of
    // this case did, and it failed for a reason that had nothing to do with
    // the code under test.
    type Step = { id: "live" | "missing"; owner: string };
    const steps: Step[] = [
      { id: "live", owner: "u1" }, // succeeds
      { id: "live", owner: "u1" }, // now already withdrawn
      { id: "live", owner: "u1" }, // still already withdrawn
      { id: "missing", owner: "u1" },
      { id: "live", owner: "u2" }, // exists, but not the caller's
    ];
    const seeded = async (): Promise<{ brain: Brain; factId: string }> => {
      const fresh = await brain();
      const fact = fresh.add({ text: "The rollout is Tuesday", source: "standup", ownerId: "u1" });
      return { brain: fresh, factId: fact.id };
    };
    const a = await seeded();
    const other = await seeded();
    const resolve = (id: "live" | "missing", factId: string) => (id === "missing" ? "no-such-fact" : factId);

    const viaBoolean = steps.map((s) => a.brain.withdraw(resolve(s.id, a.factId), s.owner));
    const viaOutcome = steps.map((s) => other.brain.withdrawOutcome(resolve(s.id, other.factId), s.owner).ok);

    expect(viaBoolean).toEqual([true, false, false, false, false]);
    expect(viaOutcome).toEqual(viaBoolean);
  });
});
