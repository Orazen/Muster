import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TaskPlanEngine } from "./task-engine.ts";

const dirs: string[] = [];
const now = () => Date.UTC(2026, 8, 28);
const input = { botId: "bot-a", ownerId: "account-a", steps: ["work"], intentId: "intent-review-001", start: false };

function file() {
  const dir = mkdtempSync(join(tmpdir(), "muster-intent-reconciliation-"));
  dirs.push(dir);
  return join(dir, "plans.json");
}

// The old version-one acceptance record stored only planId and acceptedAt.
// Write that format explicitly; the plan file remains the ownership evidence.
function writeLegacyIntent(path: string, planId: string) {
  writeFileSync(join(dirname(path), "task-delivery-intents.json"), JSON.stringify({
    version: 1,
    intents: { [input.intentId]: { planId, acceptedAt: now() } },
  }));
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("task intent reconciliation ownership and rollback", () => {
  it("reconciles an accepted owner intent after reconstruction without creating another plan", () => {
    const path = file();
    const original = new TaskPlanEngine({ file: path, now }).create({ ...input, intentOwnerId: "account-a" });
    const recovered = new TaskPlanEngine({ file: path, now });
    expect(recovered.create({ ...input, intentOwnerId: "account-a" }).id).toBe(original.id);
    expect(recovered.listPlans()).toHaveLength(1);
  });

  it("uses the trusted intent owner even when a caller repeats the original plan owner", () => {
    const engine = new TaskPlanEngine({ file: file(), now });
    engine.create({ ...input, intentOwnerId: "session-a" });
    expect(() => engine.create({ ...input, intentOwnerId: "session-b" })).toThrow(/different account/);
    expect(engine.listPlans()).toHaveLength(1);
  });

  it("lets the original owner reconcile a pre-upgrade intent while refusing a different owner", () => {
    const path = file();
    const original = new TaskPlanEngine({ file: path, now }).create(input);
    writeLegacyIntent(path, original.id);
    const recovered = new TaskPlanEngine({ file: path, now });
    expect(() => recovered.create({ ...input, intentOwnerId: "account-b" })).toThrow(/different account/);
    expect(recovered.create({ ...input, intentOwnerId: "account-a" }).id).toBe(original.id);
    expect(recovered.listPlans()).toHaveLength(1);
  });

  it("recognizes the local identity for an old ownerless desktop intent", () => {
    const path = file();
    const local = { ...input, ownerId: undefined };
    const original = new TaskPlanEngine({ file: path, now }).create(local);
    writeLegacyIntent(path, original.id);
    const recovered = new TaskPlanEngine({ file: path, now });
    expect(recovered.create({ ...local, intentOwnerId: "local" }).id).toBe(original.id);
    expect(() => recovered.create({ ...local, intentOwnerId: "account-b" })).toThrow(/different account/);
  });

  it("uses the original local request identity after a desktop bot gains a primary owner", () => {
    const path = file();
    const local = { ...input, ownerId: "primary-account", context: { accountId: "local" }, intentOwnerId: "local" };
    const original = new TaskPlanEngine({ file: path, now }).create(local);
    writeLegacyIntent(path, original.id);
    const recovered = new TaskPlanEngine({ file: path, now });
    expect(() => recovered.create({ ...local, intentOwnerId: "account-b" })).toThrow(/different account/);
    expect(recovered.create(local).id).toBe(original.id);
    // The plan's migrated owner cannot substitute for its acceptance identity.
    expect(() => recovered.create({ ...local, intentOwnerId: "primary-account" })).toThrow(/different account/);
    expect(recovered.listPlans()).toHaveLength(1);
  });

  it("rolls back a rejected acceptance so the same intent can be retried after storage is repaired", () => {
    const path = file();
    mkdirSync(path); // Atomic rename fails with EISDIR even when run as root.
    const engine = new TaskPlanEngine({ file: path, now });
    expect(() => engine.create(input)).toThrow();
    expect(engine.listPlans()).toHaveLength(0);
    rmSync(path, { recursive: true });
    const plan = engine.create(input);
    expect(plan.delivery?.intentId).toBe(input.intentId);
    expect(new TaskPlanEngine({ file: path, now }).create(input).id).toBe(plan.id);
  });

  it("keeps an accepted intent tombstone after the associated plan is no longer retained", () => {
    const path = file();
    new TaskPlanEngine({ file: path, now }).create(input);
    const disk = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...disk, plans: [] }));
    const recovered = new TaskPlanEngine({ file: path, now });
    expect(() => recovered.create(input)).toThrow(/already delivered/);
    expect(recovered.listPlans()).toHaveLength(0);
  });
});
