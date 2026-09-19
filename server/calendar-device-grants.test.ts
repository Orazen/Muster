import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { CALENDAR_READONLY_SCOPE, createCalendarState, saveCalendarGrant, disconnectCalendar } from "./calendar-grants.ts";
import { issueCalendarDeviceGrant, listCalendarDeviceGrants, revokeCalendarDeviceGrant, resolveCalendarDeviceGrant, CALENDAR_DEVICE_GRANT_TTL_MS } from "./calendar-device-grants.ts";

let db: DatabaseSync;
const input = { userId: "alice", calendarId: "selected-calendar", label: "My Watch" };
function connect(userId = "alice", googleSub = `google-${userId}`) {
  const flow = createCalendarState(db, { userId, sessionId: "session" }, 0);
  return saveCalendarGrant(db, { userId, googleSub, expectedGeneration: flow.generation, accessToken: `access-${userId}`, refreshToken: `refresh-${userId}`, expiresAt: 100_000, scopes: [CALENDAR_READONLY_SCOPE] });
}
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'), ('bob')");
  connect(); connect("bob");
});
afterEach(() => db.close());

describe("Calendar device permission store", () => {
  it("issues independent opaque tokens once, stores only hashes and lists safe selected-calendar metadata", () => {
    const first = issueCalendarDeviceGrant(db, input, 1000);
    const second = issueCalendarDeviceGrant(db, input, 1000);
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.grant.id).not.toBe(second.grant.id);
    expect(first.grant.expiresAt).toBe(1000 + CALENDAR_DEVICE_GRANT_TTL_MS);
    const rows = db.prepare("SELECT * FROM calendar_device_grants").all();
    expect(JSON.stringify(rows)).not.toContain(first.token);
    expect(JSON.stringify(rows)).not.toContain("access-alice");
    expect(JSON.stringify(rows)).not.toContain("refresh-alice");
    expect(rows[0].tokenHash).toBe(createHash("sha256").update(first.token).digest("hex"));
    for (const grant of listCalendarDeviceGrants(db, "alice", 1000)) expect(Object.keys(grant).sort()).toEqual(["calendarId", "expiresAt", "id", "label"]);
    const resolved = resolveCalendarDeviceGrant(db, first.token, 1000);
    expect(resolved).toMatchObject({ ...first.grant, userId: "alice", calendarId: "selected-calendar", generation: 1, googleSub: "google-alice" });
    expect(JSON.stringify(resolved)).not.toMatch(/accessToken|refreshToken|tokenHash/);
  });
  it("isolates lists and revocation by owner without arbitrary-owner fallback", () => {
    const alice = issueCalendarDeviceGrant(db, input, 0);
    const bob = issueCalendarDeviceGrant(db, { ...input, userId: "bob" }, 0);
    expect(listCalendarDeviceGrants(db, "alice", 0)).toEqual([alice.grant]);
    expect(listCalendarDeviceGrants(db, "bob", 0)).toEqual([bob.grant]);
    expect(listCalendarDeviceGrants(db, "unknown", 0)).toEqual([]);
    expect(revokeCalendarDeviceGrant(db, "bob", alice.grant.id)).toBe(false);
    expect(resolveCalendarDeviceGrant(db, alice.token, 0)?.userId).toBe("alice");
    expect(revokeCalendarDeviceGrant(db, "alice", alice.grant.id)).toBe(true);
    expect(revokeCalendarDeviceGrant(db, "alice", alice.grant.id)).toBe(false);
    expect(resolveCalendarDeviceGrant(db, alice.token, 0)).toBeNull();
    expect(resolveCalendarDeviceGrant(db, bob.token, 0)?.userId).toBe("bob");
  });
  it("requires current connected consent and rejects missing owner", () => {
    disconnectCalendar(db, "alice");
    expect(() => issueCalendarDeviceGrant(db, input, 0)).toThrow("Connect your Calendar");
    expect(() => issueCalendarDeviceGrant(db, { ...input, userId: "unknown" }, 0)).toThrow("Connect your Calendar");
    expect(() => issueCalendarDeviceGrant(db, { ...input, userId: "" }, 0)).toThrow();
  });
  it("expires at the exact fixed lifetime and never renews through list or resolve", () => {
    const created = issueCalendarDeviceGrant(db, input, 1000);
    expect(resolveCalendarDeviceGrant(db, created.token, created.grant.expiresAt - 1)?.expiresAt).toBe(created.grant.expiresAt);
    expect(resolveCalendarDeviceGrant(db, created.token, created.grant.expiresAt)).toBeNull();
    expect(listCalendarDeviceGrants(db, "alice", created.grant.expiresAt)).toEqual([]);
  });
  it.each(["", "z".repeat(64), "A".repeat(64), "a".repeat(63), "a".repeat(65), " a".repeat(32)])("refuses malformed capability %s", (token) => {
    expect(resolveCalendarDeviceGrant(db, token, 0)).toBeNull();
  });
  it("invalidates disconnection and reconsent even when Google identity is unchanged", () => {
    const created = issueCalendarDeviceGrant(db, input, 0);
    disconnectCalendar(db, "alice");
    expect(resolveCalendarDeviceGrant(db, created.token, 0)).toBeNull();
    connect();
    expect(resolveCalendarDeviceGrant(db, created.token, 0)).toBeNull();
    expect(listCalendarDeviceGrants(db, "alice", 0)).toEqual([]);
  });
  it("invalidates a new consent epoch before replacement consent has completed", () => {
    const created = issueCalendarDeviceGrant(db, input, 0);
    createCalendarState(db, { userId: "alice", sessionId: "new" }, 0);
    expect(resolveCalendarDeviceGrant(db, created.token, 0)).toBeNull();
    expect(() => issueCalendarDeviceGrant(db, input, 0)).toThrow("Connect your Calendar");
  });
  it("binds Google subject independently of generation and permits ordinary credential refresh", () => {
    const created = issueCalendarDeviceGrant(db, input, 0);
    saveCalendarGrant(db, { userId: "alice", googleSub: "google-alice", expectedGeneration: 1, accessToken: "refreshed", expiresAt: 200000, scopes: [CALENDAR_READONLY_SCOPE] });
    expect(resolveCalendarDeviceGrant(db, created.token, 0)).not.toBeNull();
    db.prepare("UPDATE calendar_grants SET googleSub = ? WHERE userId = ?").run("other-google", "alice");
    expect(resolveCalendarDeviceGrant(db, created.token, 0)).toBeNull();
  });
  it("caps ten active permissions without silently evicting them or another account", () => {
    const grants = Array.from({ length: 10 }, () => issueCalendarDeviceGrant(db, input, 0));
    const bob = issueCalendarDeviceGrant(db, { ...input, userId: "bob" }, 0);
    expect(() => issueCalendarDeviceGrant(db, input, 0)).toThrow("Revoke a device permission");
    expect(listCalendarDeviceGrants(db, "alice", 0)).toHaveLength(10);
    for (const grant of grants) expect(resolveCalendarDeviceGrant(db, grant.token, 0)).not.toBeNull();
    expect(resolveCalendarDeviceGrant(db, bob.token, 0)).not.toBeNull();
    revokeCalendarDeviceGrant(db, "alice", grants[0].grant.id);
    expect(issueCalendarDeviceGrant(db, input, 0)).toBeDefined();
  });
  it("prunes only issuing account's stale/expired grants before applying cap", () => {
    for (let i = 0; i < 10; i++) issueCalendarDeviceGrant(db, input, 0);
    const bob = issueCalendarDeviceGrant(db, { ...input, userId: "bob" }, CALENDAR_DEVICE_GRANT_TTL_MS);
    issueCalendarDeviceGrant(db, input, CALENDAR_DEVICE_GRANT_TTL_MS);
    expect(db.prepare("SELECT count(*) AS count FROM calendar_device_grants WHERE userId='alice'").get()?.count).toBe(1);
    expect(resolveCalendarDeviceGrant(db, bob.token, CALENDAR_DEVICE_GRANT_TTL_MS)).not.toBeNull();
  });
  it("validates and trims labels and refuses oversized identifiers and timestamps", () => {
    expect(issueCalendarDeviceGrant(db, { ...input, label: "  My Watch  " }, 0).grant.label).toBe("My Watch");
    expect(issueCalendarDeviceGrant(db, { ...input, calendarId: " exact id " }, 0).grant.calendarId).toBe(" exact id ");
    for (const calendarId of [" ", "a\nb", "a\u0000b"]) expect(() => issueCalendarDeviceGrant(db, { ...input, calendarId }, 0)).toThrow();
    for (const label of [" ", "x".repeat(81)]) expect(() => issueCalendarDeviceGrant(db, { ...input, label }, 0)).toThrow();
    expect(() => issueCalendarDeviceGrant(db, { ...input, calendarId: "x".repeat(1025) }, 0)).toThrow();
    expect(() => issueCalendarDeviceGrant(db, input, Number.MAX_SAFE_INTEGER)).toThrow();
    expect(resolveCalendarDeviceGrant(db, "a".repeat(64), NaN)).toBeNull();
  });
  it("account deletion cascades permissions", () => {
    const created = issueCalendarDeviceGrant(db, input, 0);
    db.prepare("DELETE FROM user WHERE id = 'alice'").run();
    expect(resolveCalendarDeviceGrant(db, created.token, 0)).toBeNull();
  });
});
