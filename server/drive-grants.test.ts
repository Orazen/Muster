import { createCalendarState, saveCalendarGrant, getCalendarGrant, CALENDAR_READONLY_SCOPE } from "./calendar-grants.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRIVE_APPDATA_SCOPE, createDriveState, consumeDriveState, getDriveGrant, saveDriveGrant, disconnectDrive } from "./drive-grants.ts";

let db: DatabaseSync;
const binding = { userId: "alice", sessionId: "session-a" };
const grant = { userId: "alice", googleSub: "google-a", accessToken: "test-access", refreshToken: "test-refresh", expiresAt: 900_000, scopes: [DRIVE_APPDATA_SCOPE], expectedGeneration: 1 };
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'), ('bob')");
  createDriveState(db, binding, 0);
  createDriveState(db, { userId: "bob", sessionId: "b" }, 0);
});
const savedGrant = () => { const { expectedGeneration: _generation, ...saved } = grant; return { ...saved, generation: 1 }; };
afterEach(() => { db.close(); });

describe("Drive consent states", () => {
  it("persists only a state digest and supplies independent PKCE and nonce material", () => {
    const flow = createDriveState(db, binding, 1000);
    const other = createDriveState(db, binding, 1000);
    const rows = db.prepare("SELECT * FROM drive_oauth_states").all();
    expect(JSON.stringify(rows)).not.toContain(flow.state);
    expect(flow.state).not.toBe(other.state);
    expect(flow.nonce).not.toBe(other.nonce);
    expect(flow.codeChallenge).toBe(createHash("sha256").update(flow.codeVerifier).digest("base64url"));
    expect(flow.expiresAt).toBe(601000);
  });
  it("rejects another account and another session without consuming the correct flow; rejects replay", () => {
    const flow = createDriveState(db, binding, 1000);
    expect(consumeDriveState(db, { ...binding, userId: "bob", state: flow.state }, 1001)).toBeNull();
    expect(consumeDriveState(db, { ...binding, sessionId: "session-b", state: flow.state }, 1001)).toBeNull();
    expect(consumeDriveState(db, { ...binding, state: flow.state }, 1001)).toEqual({ ...binding, codeVerifier: flow.codeVerifier, nonce: flow.nonce, expiresAt: flow.expiresAt, generation: flow.generation });
    expect(consumeDriveState(db, { ...binding, state: flow.state }, 1001)).toBeNull();
  });
  it("rejects state at the exact expiry boundary and rejects fabricated state", () => {
    const flow = createDriveState(db, binding, 1000);
    expect(consumeDriveState(db, { ...binding, state: flow.state }, flow.expiresAt)).toBeNull();
    expect(consumeDriveState(db, { ...binding, state: "x".repeat(43) }, 1001)).toBeNull();
  });
  it("supersedes previous attempts per user without evicting other users", () => {
    const bob = createDriveState(db, { userId: "bob", sessionId: "b" }, 1000);
    const first = createDriveState(db, binding, 1000);
    for (let n = 0; n < 8; n++) createDriveState(db, binding, 1000);
    expect(db.prepare("SELECT count(*) AS count FROM drive_oauth_states WHERE userId = 'alice'").get()?.count).toBe(1);
    expect(consumeDriveState(db, { ...binding, state: first.state }, 1001)).toBeNull();
    expect(consumeDriveState(db, { userId: "bob", sessionId: "b", state: bob.state }, 1001)).not.toBeNull();
  });
});

describe("Drive grants", () => {
  it("keeps accounts isolated", () => {
    saveDriveGrant(db, grant);
    saveDriveGrant(db, { ...grant, userId: "bob", googleSub: "google-b", accessToken: "bob-access" });
    expect(getDriveGrant(db, "alice")).toEqual(savedGrant());
    expect(getDriveGrant(db, "bob")?.accessToken).toBe("bob-access");
    expect(getDriveGrant(db, "unknown")).toBeNull();
  });
  it("requires appdata scope and offline refresh token for the initial connection", () => {
    expect(() => saveDriveGrant(db, { ...grant, scopes: ["https://www.googleapis.com/auth/drive.file"] })).toThrow();
    expect(() => saveDriveGrant(db, { ...grant, refreshToken: undefined })).toThrow();
    expect(() => saveDriveGrant(db, { ...grant, refreshToken: "" })).toThrow();
    expect(getDriveGrant(db, "alice")).toBeNull();
  });
  it("preserves a missing refresh token only for the same Google identity", () => {
    saveDriveGrant(db, grant);
    expect(saveDriveGrant(db, { ...grant, accessToken: "new-access", refreshToken: null }).refreshToken).toBe(grant.refreshToken);
    expect(() => saveDriveGrant(db, { ...grant, googleSub: "google-b", refreshToken: undefined })).toThrow("Drive account mismatch");
    expect(() => saveDriveGrant(db, { ...grant, googleSub: "google-b", refreshToken: "new-refresh" })).toThrow("Drive account mismatch");
    expect(getDriveGrant(db, "alice")?.accessToken).toBe("new-access");
  });
  it("rejects scope loss on refresh without replacing the stored grant", () => {
    saveDriveGrant(db, grant);
    expect(() => saveDriveGrant(db, { ...grant, accessToken: "new-access", scopes: [] })).toThrow();
    expect(getDriveGrant(db, "alice")).toEqual(savedGrant());
  });
  it("rejects an in-flight exchange after disconnect or newer consent", () => {
    const flow = createDriveState(db, binding, 1000);
    consumeDriveState(db, { ...binding, state: flow.state }, 1001);
    disconnectDrive(db, "alice");
    expect(() => saveDriveGrant(db, { ...grant, expectedGeneration: flow.generation })).toThrow("superseded or disconnected");
    const next = createDriveState(db, binding, 1002);
    createDriveState(db, binding, 1003);
    expect(() => saveDriveGrant(db, { ...grant, expectedGeneration: next.generation })).toThrow("superseded or disconnected");
    expect(getDriveGrant(db, "alice")).toBeNull();
  });
  it("keeps the saved grant epoch stable while a newer consent begins", () => {
    saveDriveGrant(db, grant);
    createDriveState(db, binding, 1000);
    const previous = getDriveGrant(db, "alice")!;
    expect(previous.generation).toBe(1);
    expect(() => saveDriveGrant(db, { ...previous, expectedGeneration: previous.generation })).toThrow("superseded or disconnected");
  });
  it("removes grants, consent and generation when the auth user is deleted", () => {
    saveDriveGrant(db, grant);
    db.prepare("DELETE FROM user WHERE id = ?").run("alice");
    expect(getDriveGrant(db, "alice")).toBeNull();
    expect(db.prepare("SELECT * FROM drive_oauth_states WHERE userId = ?").all("alice")).toEqual([]);
    expect(db.prepare("SELECT * FROM drive_grant_generations WHERE userId = ?").all("alice")).toEqual([]);
  });
  it("fails closed on malformed persisted rows", () => {
    saveDriveGrant(db, grant);
    db.prepare("UPDATE drive_grants SET scopes = ?").run("not-json");
    expect(getDriveGrant(db, "alice")).toBeNull();
    expect(() => saveDriveGrant(db, { ...grant, refreshToken: undefined })).toThrow();
    db.prepare("UPDATE drive_grants SET scopes = ?, expiresAt = ?").run(JSON.stringify(grant.scopes), "invalid");
    expect(getDriveGrant(db, "alice")).toBeNull();
  });
  it("disconnect removes only this account's Drive grant and pending states, preserving Calendar/login", () => {
    db.exec("CREATE TABLE account (userId TEXT, providerId TEXT, accessToken TEXT, refreshToken TEXT)");
    db.prepare("INSERT INTO account VALUES (?, ?, ?, ?)").run("alice", "google", "login-access", "login-refresh");
    const before = db.prepare("SELECT * FROM account").all();
    const calendarState = createCalendarState(db, binding, 0);
    const calendar = saveCalendarGrant(db, { ...grant, scopes: [CALENDAR_READONLY_SCOPE], expectedGeneration: calendarState.generation });
    saveDriveGrant(db, grant);
    saveDriveGrant(db, { ...grant, userId: "bob", googleSub: "google-b" });
    const alice = createDriveState(db, binding, 1000);
    const bob = createDriveState(db, { userId: "bob", sessionId: "b" }, 1000);
    disconnectDrive(db, "alice");
    expect(getDriveGrant(db, "alice")).toBeNull();
    expect(getDriveGrant(db, "bob")).not.toBeNull();
    expect(consumeDriveState(db, { ...binding, state: alice.state }, 1001)).toBeNull();
    expect(consumeDriveState(db, { userId: "bob", sessionId: "b", state: bob.state }, 1001)).not.toBeNull();
    expect(db.prepare("SELECT * FROM account").all()).toEqual(before);
    expect(getCalendarGrant(db, "alice")).toEqual(calendar);
    expect(saveDriveGrant(db, { ...grant, googleSub: "replacement-google", expectedGeneration: createDriveState(db, binding, 2000).generation }).googleSub).toBe("replacement-google");
  });
});
