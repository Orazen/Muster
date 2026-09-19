import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CALENDAR_READONLY_SCOPE, createCalendarState, consumeCalendarState, getCalendarGrant, saveCalendarGrant, disconnectCalendar } from "./calendar-grants.ts";

let db: DatabaseSync;
const binding = { userId: "alice", sessionId: "session-a" };
const grant = { userId: "alice", googleSub: "google-a", accessToken: "test-access", refreshToken: "test-refresh", expiresAt: 900_000, scopes: [CALENDAR_READONLY_SCOPE], expectedGeneration: 1 };
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'), ('bob')");
  createCalendarState(db, binding, 0);
  createCalendarState(db, { userId: "bob", sessionId: "b" }, 0);
});
const savedGrant = () => { const { expectedGeneration: _generation, ...saved } = grant; return { ...saved, generation: 1 }; };
afterEach(() => { db.close(); });

describe("Calendar consent states", () => {
  it("persists only a state digest and supplies independent PKCE and nonce material", () => {
    const flow = createCalendarState(db, binding, 1000);
    const other = createCalendarState(db, binding, 1000);
    const rows = db.prepare("SELECT * FROM calendar_oauth_states").all();
    expect(JSON.stringify(rows)).not.toContain(flow.state);
    expect(flow.state).not.toBe(other.state);
    expect(flow.nonce).not.toBe(other.nonce);
    expect(flow.codeChallenge).toBe(createHash("sha256").update(flow.codeVerifier).digest("base64url"));
    expect(flow.expiresAt).toBe(601000);
  });
  it("rejects another account and another session without consuming the correct flow; rejects replay", () => {
    const flow = createCalendarState(db, binding, 1000);
    expect(consumeCalendarState(db, { ...binding, userId: "bob", state: flow.state }, 1001)).toBeNull();
    expect(consumeCalendarState(db, { ...binding, sessionId: "session-b", state: flow.state }, 1001)).toBeNull();
    expect(consumeCalendarState(db, { ...binding, state: flow.state }, 1001)).toEqual({ ...binding, codeVerifier: flow.codeVerifier, nonce: flow.nonce, expiresAt: flow.expiresAt, generation: flow.generation });
    expect(consumeCalendarState(db, { ...binding, state: flow.state }, 1001)).toBeNull();
  });
  it("rejects state at the exact expiry boundary and rejects fabricated state", () => {
    const flow = createCalendarState(db, binding, 1000);
    expect(consumeCalendarState(db, { ...binding, state: flow.state }, flow.expiresAt)).toBeNull();
    expect(consumeCalendarState(db, { ...binding, state: "x".repeat(43) }, 1001)).toBeNull();
  });
  it("supersedes previous attempts per user without evicting other users", () => {
    const bob = createCalendarState(db, { userId: "bob", sessionId: "b" }, 1000);
    const first = createCalendarState(db, binding, 1000);
    for (let n = 0; n < 8; n++) createCalendarState(db, binding, 1000);
    expect(db.prepare("SELECT count(*) AS count FROM calendar_oauth_states WHERE userId = 'alice'").get()?.count).toBe(1);
    expect(consumeCalendarState(db, { ...binding, state: first.state }, 1001)).toBeNull();
    expect(consumeCalendarState(db, { userId: "bob", sessionId: "b", state: bob.state }, 1001)).not.toBeNull();
  });
});

describe("Calendar grants", () => {
  it("keeps accounts isolated", () => {
    saveCalendarGrant(db, grant);
    saveCalendarGrant(db, { ...grant, userId: "bob", googleSub: "google-b", accessToken: "bob-access" });
    expect(getCalendarGrant(db, "alice")).toEqual(savedGrant());
    expect(getCalendarGrant(db, "bob")?.accessToken).toBe("bob-access");
    expect(getCalendarGrant(db, "unknown")).toBeNull();
  });
  it("requires readonly scope and offline refresh token for the initial connection", () => {
    expect(() => saveCalendarGrant(db, { ...grant, scopes: ["https://www.googleapis.com/auth/drive.file"] })).toThrow();
    expect(() => saveCalendarGrant(db, { ...grant, refreshToken: undefined })).toThrow();
    expect(() => saveCalendarGrant(db, { ...grant, refreshToken: "" })).toThrow();
    expect(getCalendarGrant(db, "alice")).toBeNull();
  });
  it("preserves a missing refresh token only for the same Google identity", () => {
    saveCalendarGrant(db, grant);
    expect(saveCalendarGrant(db, { ...grant, accessToken: "new-access", refreshToken: null }).refreshToken).toBe(grant.refreshToken);
    expect(() => saveCalendarGrant(db, { ...grant, googleSub: "google-b", refreshToken: undefined })).toThrow("Calendar account mismatch");
    expect(() => saveCalendarGrant(db, { ...grant, googleSub: "google-b", refreshToken: "new-refresh" })).toThrow("Calendar account mismatch");
    expect(getCalendarGrant(db, "alice")?.accessToken).toBe("new-access");
  });
  it("rejects scope loss on refresh without replacing the stored grant", () => {
    saveCalendarGrant(db, grant);
    expect(() => saveCalendarGrant(db, { ...grant, accessToken: "new-access", scopes: [] })).toThrow();
    expect(getCalendarGrant(db, "alice")).toEqual(savedGrant());
  });
  it("rejects an in-flight exchange after disconnect or newer consent", () => {
    const flow = createCalendarState(db, binding, 1000);
    consumeCalendarState(db, { ...binding, state: flow.state }, 1001);
    disconnectCalendar(db, "alice");
    expect(() => saveCalendarGrant(db, { ...grant, expectedGeneration: flow.generation })).toThrow("superseded or disconnected");
    const next = createCalendarState(db, binding, 1002);
    createCalendarState(db, binding, 1003);
    expect(() => saveCalendarGrant(db, { ...grant, expectedGeneration: next.generation })).toThrow("superseded or disconnected");
    expect(getCalendarGrant(db, "alice")).toBeNull();
  });
  it("keeps the saved grant epoch stable while a newer consent begins", () => {
    saveCalendarGrant(db, grant);
    createCalendarState(db, binding, 1000);
    const previous = getCalendarGrant(db, "alice")!;
    expect(previous.generation).toBe(1);
    expect(() => saveCalendarGrant(db, { ...previous, expectedGeneration: previous.generation })).toThrow("superseded or disconnected");
  });
  it("removes grants, consent and generation when the auth user is deleted", () => {
    saveCalendarGrant(db, grant);
    db.prepare("DELETE FROM user WHERE id = ?").run("alice");
    expect(getCalendarGrant(db, "alice")).toBeNull();
    expect(db.prepare("SELECT * FROM calendar_oauth_states WHERE userId = ?").all("alice")).toEqual([]);
    expect(db.prepare("SELECT * FROM calendar_grant_generations WHERE userId = ?").all("alice")).toEqual([]);
  });
  it("fails closed on malformed persisted rows", () => {
    saveCalendarGrant(db, grant);
    db.prepare("UPDATE calendar_grants SET scopes = ?").run("not-json");
    expect(getCalendarGrant(db, "alice")).toBeNull();
    expect(() => saveCalendarGrant(db, { ...grant, refreshToken: undefined })).toThrow();
    db.prepare("UPDATE calendar_grants SET scopes = ?, expiresAt = ?").run(JSON.stringify(grant.scopes), "invalid");
    expect(getCalendarGrant(db, "alice")).toBeNull();
  });
  it("disconnect removes only this account's Calendar grant and pending states, preserving Drive/login", () => {
    db.exec("CREATE TABLE account (userId TEXT, providerId TEXT, accessToken TEXT, refreshToken TEXT)");
    db.prepare("INSERT INTO account VALUES (?, ?, ?, ?)").run("alice", "google", "drive-access", "drive-refresh");
    const before = db.prepare("SELECT * FROM account").all();
    saveCalendarGrant(db, grant);
    saveCalendarGrant(db, { ...grant, userId: "bob", googleSub: "google-b" });
    const alice = createCalendarState(db, binding, 1000);
    const bob = createCalendarState(db, { userId: "bob", sessionId: "b" }, 1000);
    disconnectCalendar(db, "alice");
    expect(getCalendarGrant(db, "alice")).toBeNull();
    expect(getCalendarGrant(db, "bob")).not.toBeNull();
    expect(consumeCalendarState(db, { ...binding, state: alice.state }, 1001)).toBeNull();
    expect(consumeCalendarState(db, { userId: "bob", sessionId: "b", state: bob.state }, 1001)).not.toBeNull();
    expect(db.prepare("SELECT * FROM account").all()).toEqual(before);
    expect(saveCalendarGrant(db, { ...grant, googleSub: "replacement-google", expectedGeneration: createCalendarState(db, binding, 2000).generation }).googleSub).toBe("replacement-google");
  });
});
