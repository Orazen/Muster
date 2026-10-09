import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPersistedSessionCurrent, type SessionReference } from "./sse-session.ts";

const NOW = Date.parse("2026-10-09T18:00:00Z");
const CURRENT = new Date(NOW + 60_000).toISOString();
const A = { userId: "owner-a", sessionId: "session-a" };
const B = { userId: "owner-a", sessionId: "session-b" };

describe("persisted SSE session validity", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    // Deliberately no token column: a stream needs only trusted identifiers.
    db.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY); CREATE TABLE "session" (id TEXT PRIMARY KEY, userId TEXT, expiresAt);');
    db.prepare('INSERT INTO "user" VALUES (?)').run(A.userId);
    db.prepare('INSERT INTO "user" VALUES (?)').run("owner-b");
    for (const session of [A, B]) db.prepare('INSERT INTO "session" VALUES (?, ?, ?)').run(session.sessionId, session.userId, CURRENT);
  });
  afterEach(() => db.close());

  it("accepts current ISO expiry without reading or retaining a bearer", () => {
    expect(isPersistedSessionCurrent(db, A, NOW)).toBe(true);
    expect(A).toEqual({ userId: "owner-a", sessionId: "session-a" });
  });
  it("distinguishes two sessions of the same user when one is revoked", () => {
    expect(isPersistedSessionCurrent(db, A, NOW)).toBe(true);
    expect(isPersistedSessionCurrent(db, B, NOW)).toBe(true);
    db.prepare('DELETE FROM "session" WHERE id = ?').run(A.sessionId);
    expect(isPersistedSessionCurrent(db, A, NOW)).toBe(false);
    expect(isPersistedSessionCurrent(db, B, NOW)).toBe(true);
  });
  it("observes a revoke-all update on the next check", () => {
    db.prepare('DELETE FROM "session" WHERE userId = ?').run(A.userId);
    expect(isPersistedSessionCurrent(db, A, NOW)).toBe(false);
    expect(isPersistedSessionCurrent(db, B, NOW)).toBe(false);
  });
  it("rejects surviving orphan sessions after user deletion", () => {
    db.prepare('DELETE FROM "user" WHERE id = ?').run(A.userId);
    expect(isPersistedSessionCurrent(db, A, NOW)).toBe(false);
  });
  it("requires the exact user and session pair", () => {
    expect(isPersistedSessionCurrent(db, { ...A, userId: "owner-b" }, NOW)).toBe(false);
    expect(isPersistedSessionCurrent(db, { ...A, sessionId: "missing" }, NOW)).toBe(false);
    expect(isPersistedSessionCurrent(db, { ...A, sessionId: "session-a' OR 1=1 --" }, NOW)).toBe(false);
  });
  it.each([null, undefined, { userId: "", sessionId: "session-a" }, { userId: "owner-a", sessionId: " " },
    { userId: 1, sessionId: "session-a" }, { userId: "owner-a", sessionId: 1 }])("rejects malformed reference %j", (reference) => {
    // SAFETY: Deliberately inject malformed runtime input to verify boundary rejection.
    expect(isPersistedSessionCurrent(db, reference as SessionReference, NOW)).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity])("rejects invalid current time %s", now => {
    expect(isPersistedSessionCurrent(db, A, now)).toBe(false);
  });
  it("refuses the exact expiration instant and earlier times", () => {
    db.prepare('UPDATE "session" SET expiresAt = ? WHERE id = ?').run(new Date(NOW).toISOString(), A.sessionId);
    expect(isPersistedSessionCurrent(db, A, NOW)).toBe(false);
    expect(isPersistedSessionCurrent(db, A, NOW + 1)).toBe(false);
    expect(isPersistedSessionCurrent(db, A, NOW - 1)).toBe(true);
  });
  it("rereads a persisted refresh instead of caching the first expiry", () => {
    db.prepare('UPDATE "session" SET expiresAt = ? WHERE id = ?').run(new Date(NOW + 1).toISOString(), A.sessionId);
    expect(isPersistedSessionCurrent(db, A, NOW)).toBe(true);
    db.prepare('UPDATE "session" SET expiresAt = ? WHERE id = ?').run(CURRENT, A.sessionId);
    expect(isPersistedSessionCurrent(db, A, NOW + 2)).toBe(true);
    db.prepare('UPDATE "session" SET expiresAt = ? WHERE id = ?').run(new Date(NOW - 1).toISOString(), A.sessionId);
    expect(isPersistedSessionCurrent(db, A, NOW + 2)).toBe(false);
  });
  it.each(["2026-10-09 18:01:00Z", NOW + 60_000])("preserves adapter-compatible expiry %s", expiry => {
    db.prepare('UPDATE "session" SET expiresAt = ? WHERE id = ?').run(expiry, A.sessionId);
    expect(isPersistedSessionCurrent(db, A, NOW)).toBe(true);
  });
  it.each(["invalid-date", "", null, new Uint8Array([1, 2]), Infinity])("rejects malformed persisted expiry %j", expiry => {
    db.prepare('UPDATE "session" SET expiresAt = ? WHERE id = ?').run(expiry, A.sessionId);
    expect(isPersistedSessionCurrent(db, A, NOW)).toBe(false);
  });
  it("fails closed when the current database query fails", () => {
    db.exec('DROP TABLE "session"');
    expect(isPersistedSessionCurrent(db, A, NOW)).toBe(false);
  });
});
