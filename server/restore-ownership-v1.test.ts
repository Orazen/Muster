// A restored bundle must not carry another account's ownership with it.
//
// Sweep 4, items 4 and 5. Both are the same defect in two restore paths: the
// bundle is allowed to say who owns what, and a bundle produced on another
// installation is not evidence about who owns anything HERE.
//
//   S4-4  the v1 restore inserts bot and group records with `ownerId` intact
//         (`unshift(raw)` at two sites). v2 already drops it —
//         `RESTORE_DROPPED_BOT_FIELDS` and `RESTORE_DROPPED_GROUP_FIELDS` both
//         list `ownerId` — so a v1 restore materialises bots owned by whoever
//         made the bundle, invisible to the restoring account under the
//         `ownsRecord` guard. Records the user just restored are records they
//         cannot see or use.
//   S4-5  v2 stages `social.json` byte-for-byte: it is in `SUBSET_ROOT_FILES`
//         but has no rewrite branch, so `ownerAId`/`ownerBId`/`ownerId` survive
//         intact. A bundle from another account re-attaches that account's
//         friendships, and the SSE social filter reads exactly those ids — so
//         the restored graph re-grants visibility the local accounts never had.
//
// The fix is not new policy: it is the rule v2 already applies to bots and
// groups, applied to the two places that were missed. What replaces a dropped
// owner is the installation's own — the boot ownership migration and
// `restore-apply.ts` assign unowned records — so dropping is both the safe
// direction and the one already in use.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
let dataDir = "";

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "muster-restore-owner-"));
  roots.push(root);
  dataDir = join(root, "data");
  vi.stubEnv("OMB_DATA_DIR", dataDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A bundle record as it arrives from elsewhere: the fields these cases vary. */
interface BundleRecord {
  id: string;
  name: string;
  ownerId?: string;
}

/** A v1 envelope carrying one bot and one group owned by somebody else. */
function foreignWorkspace() {
  return {
    bots: [{ id: "bot-from-elsewhere", name: "Their Bot", ownerId: "user-b" } satisfies BundleRecord],
    groups: [{ id: "group-from-elsewhere", name: "Their Room", ownerId: "user-b" } satisfies BundleRecord],
    memory: {},
    topics: {},
    exportedAt: 0,
    counts: { bots: 1, groups: 1, memoryFiles: 0 },
  };
}

describe("S4-4: a v1 restore drops the bundle's owner ids", () => {
  it("does not restore a bot owned by the account that made the bundle", async () => {
    const { restoreBundle } = await import("./workspace-bundle.ts");
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "", model: "" }));

    // SAFETY: `foreignWorkspace()` builds the literal v1 envelope field-for-field,
// and restoreBundle re-validates it against workspaceSchema before touching
    // anything - that validation is the boundary these cases exercise.
    const envelope: Parameters<typeof restoreBundle>[2] = foreignWorkspace();
    const result = restoreBundle(store, dataDir, envelope);
    expect(result.botsRestored).toBe(1);

    const restored = store.bots.find((b) => b.id === "bot-from-elsewhere");
    expect(restored, "the record is restored — the fix is about ownership, not existence").toBeDefined();
    // The point of the case: a bot the user just restored must not belong to
    // whoever produced the bundle.
    expect(restored?.ownerId, "a restored bot must not keep the bundle's ownerId").toBeUndefined();
  });

  it("does not restore a group owned by the account that made the bundle", async () => {
    const { restoreBundle } = await import("./workspace-bundle.ts");
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "", model: "" }));

    // SAFETY: `foreignWorkspace()` builds the literal v1 envelope field-for-field,
// and restoreBundle re-validates it against workspaceSchema before touching
    // anything - that validation is the boundary these cases exercise.
    const envelope: Parameters<typeof restoreBundle>[2] = foreignWorkspace();
    const result = restoreBundle(store, dataDir, envelope);
    expect(result.groupsRestored).toBe(1);

    const restored = store.groups.find((g) => g.id === "group-from-elsewhere");
    expect(restored).toBeDefined();
    expect(restored?.ownerId, "a restored group must not keep the bundle's ownerId").toBeUndefined();
  });

  it("leaves an already-local bot's owner alone", async () => {
    // The drop applies to what the bundle brings, never to a record this
    // installation already owns. A restore that reassigned existing records
    // would be a different and much worse bug.
    const { restoreBundle } = await import("./workspace-bundle.ts");
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "", model: "" }));
    const mine = store.createBot({ name: "Mine", ownerId: "user-a" });

    const envelope: Parameters<typeof restoreBundle>[2] = foreignWorkspace();
    // Only the fields a bundle record needs; the point is the SAME id as an
    // existing local bot, so the restore must skip rather than re-own it.
    envelope.bots = [{ id: mine.id, name: "Mine", ownerId: "user-b" } satisfies BundleRecord];
    const result = restoreBundle(store, dataDir, envelope);

    // Same id as an existing bot, so it is skipped rather than inserted twice.
    expect(result.botsRestored).toBe(0);
    expect(result.skippedExisting).toBeGreaterThan(0);
    expect(store.bot(mine.id)?.ownerId, "an existing record keeps its own owner").toBe("user-a");
  });
});
