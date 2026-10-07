// The operator owns engines, MCP servers, config and the host computer, so
// who gets the role on a self-hosted deploy is pinned down here.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { operatorPinMode, resolveOperatorId, migrateOperatorMailboxProof, recordOperatorMailboxProof } from "./operator-pin.ts";

function db(rows: Array<{ id: string; email: string; verified: number; createdAt: number }>) {
  const database = new DatabaseSync(":memory:");
  database.exec(
    'CREATE TABLE "user" ("id" text primary key, "email" text not null, "emailVerified" integer not null, "createdAt" date not null)',
  );
  const insert = database.prepare('INSERT INTO "user" ("id", "email", "emailVerified", "createdAt") VALUES (?, ?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.email, row.verified, row.createdAt);
  database.exec('CREATE TABLE "session" ("id" text, "userId" text); CREATE TABLE "account" ("id" text, "userId" text)');
  migrateOperatorMailboxProof(database);
  return database;
}

describe("operatorPinMode", () => {
  it("leaves desktop installs on the legacy rule, even with a pin set", () => {
    expect(operatorPinMode({ MUSTER_OPERATOR_EMAIL: "op@example.com" }, false)).toEqual({ kind: "legacy" });
  });

  it("does not change Muster Cloud", () => {
    expect(operatorPinMode({ MUSTER_CLOUD: "true", MUSTER_OPERATOR_EMAIL: "op@example.com" }, true)).toEqual({
      kind: "legacy",
    });
    expect(operatorPinMode({ MUSTER_CLOUD: "true" }, true)).toEqual({ kind: "legacy" });
  });

  it("flags an unpinned self-hosted deploy and normalises a pin", () => {
    expect(operatorPinMode({}, true)).toEqual({ kind: "unpinned" });
    expect(operatorPinMode({ MUSTER_OPERATOR_EMAIL: "   " }, true)).toEqual({ kind: "unpinned" });
    expect(operatorPinMode({ MUSTER_OPERATOR_EMAIL: " Op@Example.COM " }, true)).toEqual({
      kind: "pinned",
      email: "op@example.com",
    });
  });
});

describe("resolveOperatorId", () => {
  const rows = [
    { id: "squatter", email: "first@example.com", verified: 1, createdAt: 1 },
    { id: "unproven", email: "Op@example.com", verified: 0, createdAt: 2 },
    { id: "operator", email: "op@example.com", verified: 1, createdAt: 3 },
  ];

  it("keeps the oldest-account rule without a pin", () => {
    expect(resolveOperatorId(db(rows), { kind: "legacy" })).toBe("squatter");
    expect(resolveOperatorId(db(rows), { kind: "unpinned" })).toBe("squatter");
  });

  it("gives a pinned deploy only to the verified pinned account", () => {
    const database = db(rows);
    expect(resolveOperatorId(database, { kind: "pinned", email: "op@example.com" })).toBeNull();
    recordOperatorMailboxProof(database, "operator", "local-email");
    expect(resolveOperatorId(database, { kind: "pinned", email: "op@example.com" })).toBe("operator");
    database.close();
  });

  it("has no operator until the pinned mailbox is proven", () => {
    const pending = db(rows.filter((row) => row.id !== "operator"));
    expect(resolveOperatorId(pending, { kind: "pinned", email: "op@example.com" })).toBeNull();
    expect(resolveOperatorId(db([]), { kind: "pinned", email: "op@example.com" })).toBeNull();
  });
});

describe("operator mailbox provenance", () => {
  it("does not promote historical blindly verified bridge identities or delete their account", () => {
    const database = db([{ id: "usr_old_bridge", email: "op@example.com", verified: 1, createdAt: 1 }]);
    expect(resolveOperatorId(database, { kind: "pinned", email: "op@example.com" })).toBeNull();
    expect(database.prepare('SELECT count(*) AS n FROM "user"').get()?.n).toBe(1);
    expect(database.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get("usr_old_bridge")?.emailVerified).toBe(0);
    database.prepare('INSERT INTO "session" ("id", "userId") VALUES (?, ?)').run("old-session", "usr_old_bridge");
    database.prepare('UPDATE "user" SET "emailVerified" = 1 WHERE "id" = ?').run("usr_old_bridge");
    recordOperatorMailboxProof(database, "usr_old_bridge", "local-email");
    expect(resolveOperatorId(database, { kind: "pinned", email: "op@example.com" })).toBeNull();
    database.prepare('DELETE FROM "session" WHERE "userId" = ?').run("usr_old_bridge");
    recordOperatorMailboxProof(database, "usr_old_bridge", "local-email");
    expect(resolveOperatorId(database, { kind: "pinned", email: "op@example.com" })).toBe("usr_old_bridge");
    database.close();
  });
  it("binds a proof to the current verified mailbox and refuses unverified rows", () => {
    const database = db([{ id: "usr_unproven", email: "op@example.com", verified: 0, createdAt: 1 }]);
    recordOperatorMailboxProof(database, "usr_unproven", "paired");
    expect(resolveOperatorId(database, { kind: "pinned", email: "op@example.com" })).toBeNull();
    database.prepare('UPDATE "user" SET "emailVerified" = 1 WHERE "id" = ?').run("usr_unproven");
    recordOperatorMailboxProof(database, "usr_unproven", "local-google");
    expect(resolveOperatorId(database, { kind: "pinned", email: "op@example.com" })).toBeNull();
    recordOperatorMailboxProof(database, "usr_unproven", "local-email");
    expect(resolveOperatorId(database, { kind: "pinned", email: "op@example.com" })).toBe("usr_unproven");
    database.prepare('UPDATE "user" SET "email" = ? WHERE "id" = ?').run("changed@example.com", "usr_unproven");
    expect(resolveOperatorId(database, { kind: "pinned", email: "changed@example.com" })).toBeNull();
    database.close();
  });
  it("rolls back a failed proof write/quarantine clear and preserves the old authority boundary", () => {
    const database = db([{ id: "usr_failure", email: "op@example.com", verified: 1, createdAt: 1 }]);
    database.prepare('UPDATE "user" SET "emailVerified" = 1 WHERE "id" = ?').run("usr_failure");
    database.exec(`CREATE TRIGGER refuse_quarantine_clear BEFORE DELETE ON "operator_mailbox_quarantine"
      BEGIN SELECT RAISE(ABORT, 'owned persistence failure'); END`);
    expect(() => recordOperatorMailboxProof(database, "usr_failure", "local-email")).toThrow("owned persistence failure");
    expect(database.prepare('SELECT count(*) AS n FROM "operator_mailbox_proof"').get()?.n).toBe(0);
    expect(database.prepare('SELECT count(*) AS n FROM "operator_mailbox_quarantine"').get()?.n).toBe(1);
    expect(resolveOperatorId(database, { kind: "pinned", email: "op@example.com" })).toBeNull();
    database.exec("DROP TRIGGER refuse_quarantine_clear");
    migrateOperatorMailboxProof(database);
    expect(database.prepare('SELECT "emailVerified" FROM "user" WHERE "id" = ?').get("usr_failure")?.emailVerified).toBe(0);
    database.close();
  });

});
