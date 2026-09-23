// M2 shared-memory grants — default deny, the read → read-write ladder, the
// ownership mirror, payload validation, and the file-backed store:
// persistence, the per-bot cap, withdrawal-not-deletion, fail-closed loads,
// and the 0600 ledger. Store fixtures write to explicit throwaway paths —
// the DATA_DIR-derived default ledger is never touched here. No server,
// no network.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { GrantInput, MemoryGrant, Requester } from "./memory-grants.ts";

const dataDir = mkdtempSync(join(tmpdir(), "muster-memory-grants-"));

const lib = await import("./memory-grants.ts");

const NOW = 1_700_000_000_000;
const requester: Requester = { kind: "user", id: "u1" };

const grant = (overrides: Partial<MemoryGrant> = {}): MemoryGrant => ({
  id: "g1",
  grantee: { kind: "user", id: "u1" },
  botId: "bot1",
  resource: "memory",
  permission: "read",
  createdAt: NOW - 1_000,
  ...overrides,
});

const decide = (options: {
  grants: MemoryGrant[];
  isOwner?: boolean;
  requester?: Requester;
  resource?: "memory" | "facts";
  permission?: "read" | "read-write";
  botId?: string;
  now?: number;
}) => lib.authorizeMemoryAccess({
  botId: options.botId ?? "bot1",
  isOwner: options.isOwner ?? false,
  requester: options.requester ?? requester,
  grants: options.grants,
  resource: options.resource ?? "memory",
  permission: options.permission ?? "read",
  now: options.now ?? NOW,
});

describe("authorizeMemoryAccess", () => {
  it("denies everything by default — no ambient access", () => {
    for (const resource of ["memory", "facts"] as const) {
      for (const permission of ["read", "read-write"] as const) {
        expect(decide({ grants: [], resource, permission })).toEqual({ allowed: false });
      }
    }
  });

  it("admits the owner, and the session-less desktop, without any grant", () => {
    expect(decide({ grants: [], isOwner: true })).toEqual({ allowed: true, via: "owner" });
    expect(decide({ grants: [], isOwner: true, requester: { kind: "desktop" } }))
      .toEqual({ allowed: true, via: "desktop" });
    expect(decide({ grants: [], isOwner: true, permission: "read-write" }).allowed).toBe(true);
  });

  it("never admits a session-less requester through someone else's grant", () => {
    expect(decide({ grants: [grant()], requester: { kind: "desktop" } })).toEqual({ allowed: false });
  });

  it("matches only the same bot, resource, grantee kind, and grantee id", () => {
    const active = grant();
    expect(decide({ grants: [active] })).toMatchObject({ allowed: true, via: "grant", grantId: "g1" });
    expect(decide({ grants: [active], botId: "bot2" }).allowed).toBe(false);
    expect(decide({ grants: [active], resource: "facts" }).allowed).toBe(false);
    expect(decide({ grants: [active], requester: { kind: "user", id: "u2" } }).allowed).toBe(false);
    expect(decide({ grants: [grant({ grantee: { kind: "bot", id: "u1" } })] }).allowed).toBe(false);
    expect(decide({
      grants: [grant({ grantee: { kind: "bot", id: "helper-bot" } })],
      requester: { kind: "bot", id: "helper-bot" },
    })).toMatchObject({ allowed: true, grantId: "g1" });
  });

  it("upgrades along the read → read-write ladder, never implicitly downward", () => {
    const readOnly = grant({ permission: "read" });
    const readWrite = grant({ permission: "read-write" });
    expect(decide({ grants: [readOnly], permission: "read" }).allowed).toBe(true);
    expect(decide({ grants: [readOnly], permission: "read-write" }).allowed).toBe(false);
    expect(decide({ grants: [readWrite], permission: "read" }).allowed).toBe(true);
    expect(decide({ grants: [readWrite], permission: "read-write" }).allowed).toBe(true);
  });

  it("treats revocation and expiry as immediate denial, boundary inclusive", () => {
    expect(lib.isGrantActive(grant(), NOW)).toBe(true);
    expect(lib.isGrantActive(grant({ expiresAt: NOW + 1 }), NOW)).toBe(true);
    expect(lib.isGrantActive(grant({ expiresAt: NOW }), NOW)).toBe(false);
    expect(lib.isGrantActive(grant({ expiresAt: NOW - 1 }), NOW)).toBe(false);
    expect(lib.isGrantActive(grant({ revokedAt: NOW - 1 }), NOW)).toBe(false);
    expect(decide({ grants: [grant({ revokedAt: NOW - 500 })] }).allowed).toBe(false);
    expect(decide({ grants: [grant({ expiresAt: NOW })] }).allowed).toBe(false);
    expect(decide({ grants: [grant({ expiresAt: NOW + 1 })] }).allowed).toBe(true);
    // A dead grant first in the list falls through to a live one behind it.
    const dead = grant({ id: "g-dead", revokedAt: NOW - 500 });
    const live = grant({ id: "g-live" });
    expect(decide({ grants: [dead, live] })).toMatchObject({ allowed: true, grantId: "g-live" });
  });
});

describe("isResourceOwner", () => {
  it("mirrors the shared ownership guard, nulls included", () => {
    expect(lib.isResourceOwner({})).toBe(true); // session-less local install
    expect(lib.isResourceOwner({ requester: null })).toBe(true);
    expect(lib.isResourceOwner({ botOwnerId: "u1", requester: null, operator: "op" })).toBe(true);
    expect(lib.isResourceOwner({ botOwnerId: "u1", requester: "u1", operator: "op" })).toBe(true);
    expect(lib.isResourceOwner({ botOwnerId: "u2", requester: "u1", operator: "u1" })).toBe(false);
    expect(lib.isResourceOwner({ requester: "u1", operator: "u1" })).toBe(true); // unowned → operator
    expect(lib.isResourceOwner({ requester: "u2", operator: "u1" })).toBe(false);
    expect(lib.isResourceOwner({ requester: "u1", operator: null })).toBe(false);
    expect(lib.isResourceOwner({ botOwnerId: "u1", requester: "u2", operator: null })).toBe(false);
  });
});

describe("grant payload validation and status mapping", () => {
  it("rejects malformed grant payloads at the schema", () => {
    const valid = {
      grantee: { kind: "user", id: "user_1-abc" },
      resource: "memory",
      permission: "read",
      expiresAt: NOW + 1_000,
    };
    expect(lib.grantInputSchema.safeParse(valid).success).toBe(true);
    const rejects = (cause: unknown): void => {
      expect(lib.grantInputSchema.safeParse(cause).success).toBe(false);
    };
    rejects({ ...valid, grantee: { kind: "user", id: "../../etc/passwd" } });
    rejects({ ...valid, grantee: { kind: "user", id: "a".repeat(129) } });
    rejects({ ...valid, grantee: { kind: "user", id: "" } });
    rejects({ ...valid, grantee: { kind: "group", id: "ok" } });
    rejects({ ...valid, resource: "everything" });
    rejects({ ...valid, permission: "admin" });
    rejects({ ...valid, expiresAt: 10.5 });
    rejects({ ...valid, expiresAt: 0 });
    rejects({ ...valid, expiresAt: -1 });
    rejects({ resource: "memory", permission: "read" });
    expect(lib.GRANTEE_ID.test("bot-1_x")).toBe(true);
    expect(lib.GRANTEE_ID.test("a".repeat(128))).toBe(true);
    expect(lib.GRANTEE_ID.test("")).toBe(false);
    expect(lib.GRANTEE_ID.test("a b")).toBe(false);
  });

  it("maps only well-formed HTTP statuses off a caught cause", () => {
    expect(lib.grantErrorStatus(Object.assign(new Error("conflict"), { status: 409 }))).toBe(409);
    expect(lib.grantErrorStatus(new Error("plain"))).toBe(400);
    expect(lib.grantErrorStatus({ status: 700 })).toBe(400);
    expect(lib.grantErrorStatus({ status: 409.5 })).toBe(400);
    expect(lib.grantErrorStatus({ status: "409" })).toBe(400);
    expect(lib.grantErrorStatus(null)).toBe(400);
    expect(lib.grantErrorStatus(409)).toBe(400);
    expect(lib.grantErrorStatus("boom")).toBe(400);
  });
});

describe("MemoryGrantStore", () => {
  const fileFor = (name: string): string => join(dataDir, `${name}.json`);

  it("persists grants, reopens them, and withdraws without deleting", () => {
    const file = fileFor("store-basic");
    const clock = { t: 1_000 };
    const store = new lib.MemoryGrantStore({ file, now: () => clock.t });
    const created = store.add("bot1", "owner-1", {
      grantee: { kind: "user", id: "u1" },
      resource: "memory",
      permission: "read",
    });
    expect(created.id).toMatch(/^[\w-]+$/);
    expect(created.grantorId).toBe("owner-1");
    expect(created.createdAt).toBe(1_000);
    expect(store.list("bot1")).toHaveLength(1);
    expect(store.list("bot2")).toEqual([]);

    const reopened = new lib.MemoryGrantStore({ file, now: () => clock.t });
    expect(reopened.list("bot1").map((entry) => entry.id)).toEqual([created.id]);

    clock.t = 2_000;
    const withdrawn = store.revoke(created.id, "bot1");
    expect(withdrawn?.revokedAt).toBe(2_000);
    expect(store.list("bot1")).toHaveLength(1); // withdrawal, not deletion
    expect(store.revoke(created.id, "bot1")).toBeNull(); // double revoke misses
    expect(store.revoke(created.id, "other-bot")).toBeNull(); // wrong anchor misses
    expect(store.revoke("no-such-grant", "bot1")).toBeNull();
    expect(lib.authorizeMemoryAccess({
      botId: "bot1",
      isOwner: false,
      requester,
      grants: store.list("bot1"),
      resource: "memory",
      permission: "read",
      now: clock.t,
    }).allowed).toBe(false);
    const afterReopen = new lib.MemoryGrantStore({ file, now: () => clock.t });
    expect(afterReopen.list("bot1")[0].revokedAt).toBe(2_000);
  });

  it("refuses invalid and already-expired inputs with their HTTP status, writing nothing", () => {
    const clock = { t: 10_000 };
    const store = new lib.MemoryGrantStore({ file: fileFor("store-validate"), now: () => clock.t });
    const statusOf = (fn: () => MemoryGrant): number => {
      try {
        fn();
        return 0;
      } catch (cause) {
        return lib.grantErrorStatus(cause);
      }
    };
    // SAFETY: the store must re-validate at runtime — these payloads are
    // invalid by construction (that is why they exist), so the widened
    // field types are the deliberate bypass of TypeScript's narrowing.
    const malformed = (payload: {
      grantee: { kind: string; id: string };
      resource: string;
      permission: string;
    }): GrantInput => payload as GrantInput;
    expect(statusOf(() => store.add("bot1", undefined, malformed({
      grantee: { kind: "user", id: "ok" },
      resource: "everything",
      permission: "read",
    })))).toBe(400);
    expect(statusOf(() => store.add("bot1", undefined, malformed({
      grantee: { kind: "user", id: "../../etc/passwd" },
      resource: "memory",
      permission: "read",
    })))).toBe(400);
    expect(statusOf(() => store.add("bot1", undefined, {
      grantee: { kind: "user", id: "ok" },
      resource: "memory",
      permission: "read",
      expiresAt: 9_999, // clock is 10_000 — already past
    }))).toBe(400);
    expect(store.list("bot1")).toEqual([]);
  });

  it("caps live grants per bot with 409 before anything can evict a live row", () => {
    const store = new lib.MemoryGrantStore({ file: fileFor("store-cap"), now: () => 5_000, maxActivePerBot: 2 });
    const payload: GrantInput = { grantee: { kind: "user", id: "u1" }, resource: "memory", permission: "read" };
    store.add("bot1", undefined, payload);
    store.add("bot1", undefined, { ...payload, resource: "facts" });
    let status = 0;
    try {
      store.add("bot1", undefined, { ...payload, permission: "read-write" });
    } catch (cause) {
      status = lib.grantErrorStatus(cause);
    }
    expect(status).toBe(409);
    expect(store.list("bot1").filter((entry) => !entry.revokedAt)).toHaveLength(2);
    // A different bot is unaffected by the first bot's cap.
    expect(() => store.add("bot2", undefined, payload)).not.toThrow();
  });

  it("fails closed on a corrupt or foreign ledger and leaves the file untouched", () => {
    const corrupt = fileFor("store-corrupt");
    writeFileSync(corrupt, "{definitely not json");
    expect(new lib.MemoryGrantStore({ file: corrupt }).list("bot1")).toEqual([]);
    expect(readFileSync(corrupt, "utf8")).toBe("{definitely not json"); // left for triage
    const foreign = fileFor("store-foreign");
    writeFileSync(foreign, JSON.stringify({ version: 1, grants: "nope" }));
    expect(new lib.MemoryGrantStore({ file: foreign }).list("bot1")).toEqual([]);
    expect(JSON.parse(readFileSync(foreign, "utf8")).grants).toBe("nope");
    const wrongVersion = fileFor("store-version");
    writeFileSync(wrongVersion, JSON.stringify({ version: 2, grants: [] }));
    expect(new lib.MemoryGrantStore({ file: wrongVersion }).list("bot1")).toEqual([]);
    expect(new lib.MemoryGrantStore({ file: fileFor("store-absent") }).list("bot1")).toEqual([]);
  });

  it("writes the persisted ledger with mode 0600", () => {
    if (process.platform === "win32") return;
    const file = fileFor("store-mode");
    const store = new lib.MemoryGrantStore({ file, now: () => 1_000 });
    store.add("bot1", "owner", { grantee: { kind: "user", id: "u1" }, resource: "memory", permission: "read" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
