// The operator owns engines, MCP servers, config and the host computer, so
// who gets the role on a self-hosted deploy is pinned down here.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { operatorPinMode, resolveOperatorId } from "./operator-pin.ts";

function db(rows: Array<{ id: string; email: string; verified: number; createdAt: number }>) {
  const database = new DatabaseSync(":memory:");
  database.exec(
    'CREATE TABLE "user" ("id" text primary key, "email" text not null, "emailVerified" integer not null, "createdAt" date not null)',
  );
  const insert = database.prepare('INSERT INTO "user" ("id", "email", "emailVerified", "createdAt") VALUES (?, ?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.email, row.verified, row.createdAt);
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
    expect(resolveOperatorId(db(rows), { kind: "pinned", email: "op@example.com" })).toBe("operator");
  });

  it("has no operator until the pinned mailbox is proven", () => {
    const pending = db(rows.filter((row) => row.id !== "operator"));
    expect(resolveOperatorId(pending, { kind: "pinned", email: "op@example.com" })).toBeNull();
    expect(resolveOperatorId(db([]), { kind: "pinned", email: "op@example.com" })).toBeNull();
  });
});
