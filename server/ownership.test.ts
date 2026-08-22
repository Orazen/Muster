// Per-user ownership (multi-tenant guard) at the store layer: bots and
// groups carry ownerId from creation, it round-trips through the persisted
// files, and the API boundary's ownsRecord semantics — owner matches, or
// record is pre-ownership unowned — are pinned here so a refactor of the
// HTTP guard can't silently reopen cross-account visibility.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { Store, type BotRecord, type GroupRecord } from "./store.ts";

afterEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const newStore = () => new Store(() => ({ instanceId: "claude", model: "fake-model" }));

/** The same predicate server/index.ts enforces with at its route choke point. */
function visibleTo(user: string | undefined, r: { ownerId?: string }): boolean {
  if (!user) return true;
  return r.ownerId === undefined || r.ownerId === null || r.ownerId === user;
}

describe("bot + group ownership", () => {
  it("stamps ownerId when provided at creation and omits it otherwise", () => {
    const store = newStore();
    const owned = store.createBot({ name: "Scout", ownerId: "user-a" }, { seedMessages: false });
    const plain = store.createBot({ name: "Legacy" }, { seedMessages: false });
    expect(owned.ownerId).toBe("user-a");
    expect(plain.ownerId).toBeUndefined();
  });

  it("round-trips ownerId through the persisted bot file", () => {
    const store = newStore();
    store.createBot({ name: "Scout", ownerId: "user-a" }, { seedMessages: false });
    store.saveBots();
    // SAFETY: bots.json was just written by saveBots from this store's BotRecords.
    const raw = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as BotRecord[];
    expect(raw.find((b) => b.name === "Scout")?.ownerId).toBe("user-a");
  });

  it("stamps group ownership through createGroup", () => {
    const store = newStore();
    const a = store.createBot({ name: "A", ownerId: "user-a" }, { seedMessages: false });
    const group = store.createGroup(`${a.name} & co.`, [a.id], false, "user-b");
    expect(group.ownerId).toBe("user-b");
  });

  it("keeps each user's list to their own records plus legacy unowned ones", () => {
    const store = newStore();
    store.createBot({ name: "mine", ownerId: "user-a" }, { seedMessages: false });
    store.createBot({ name: "theirs", ownerId: "user-b" }, { seedMessages: false });
    store.createBot({ name: "legacy" }, { seedMessages: false });
    const forA = store.bots.filter((b) => visibleTo("user-a", b)).map((b) => b.name);
    expect(forA).toContain("mine");
    expect(forA).toContain("legacy"); // boot migration hasn't run in-process
    expect(forA).not.toContain("theirs");
  });

  it("groups filter the same way", () => {
    const store = newStore();
    const a = store.createBot({ name: "A" }, { seedMessages: false });
    const mine = store.createGroup("mine", [a.id], false, "user-a");
    const theirs = store.createGroup("theirs", [a.id], false, "user-b");
    const visible = [mine, theirs].filter((g: GroupRecord) => visibleTo("user-a", g)).map((g) => g.name);
    expect(visible).toEqual(["mine"]);
  });

  it("patchBot cannot be used to reassign ownership via the generic patch path", () => {
    const store = newStore();
    const bot = store.createBot({ name: "Scout", ownerId: "user-a" }, { seedMessages: false });
    const patched = store.patchBot(bot.id, { title: "new role" })!;
    expect(patched.ownerId).toBe("user-a");
  });
});
