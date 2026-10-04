import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VISIBLE_FILE_SCOPE, createVisibleConsentState, consumeVisibleConsentState, getVisibleGrant,
  isVisibleGrantCurrent, saveVisibleGrant, revokeVisibleGrant,
} from "./drive-visible-grants.ts";
import { createDriveState, saveDriveGrant, getDriveGrant, disconnectDrive, DRIVE_APPDATA_SCOPE } from "./drive-grants.ts";
import { createCalendarState, saveCalendarGrant, getCalendarGrant, CALENDAR_READONLY_SCOPE } from "./calendar-grants.ts";

let db: DatabaseSync;
const binding = { userId: "alice", sessionId: "session-a" };
const grant = {
  userId: "alice", googleSub: "google-a", accessToken: "visible-access", refreshToken: "visible-refresh",
  expiresAt: 900_000, scopes: [VISIBLE_FILE_SCOPE], expectedGeneration: 1,
};
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'), ('bob')");
  createVisibleConsentState(db, binding, 0);
  createVisibleConsentState(db, { userId: "bob", sessionId: "b" }, 0);
});
const savedGrant = () => {
  const { expectedGeneration: _generation, ...saved } = grant;
  return { ...saved, generation: 1 };
};
afterEach(() => { db.close(); });

describe("Visible consent states", () => {
  it("persists only a state digest and supplies independent PKCE and nonce material", () => {
    const flow = createVisibleConsentState(db, binding, 1000);
    const other = createVisibleConsentState(db, binding, 1000);
    const rows = db.prepare("SELECT * FROM drive_visible_oauth_states").all();
    expect(JSON.stringify(rows)).not.toContain(flow.state);
    expect(flow.state).not.toBe(other.state);
    expect(flow.nonce).not.toBe(other.nonce);
    expect(flow.codeChallenge).toBe(createHash("sha256").update(flow.codeVerifier).digest("base64url"));
    expect(flow.expiresAt).toBe(601000);
  });
  it("rejects another account and another session without consuming the correct flow; rejects replay", () => {
    const flow = createVisibleConsentState(db, binding, 1000);
    expect(consumeVisibleConsentState(db, { ...binding, userId: "bob", state: flow.state }, 1001)).toBeNull();
    expect(consumeVisibleConsentState(db, { ...binding, sessionId: "session-b", state: flow.state }, 1001)).toBeNull();
    expect(consumeVisibleConsentState(db, { ...binding, state: flow.state }, 1001)).toEqual({
      ...binding, codeVerifier: flow.codeVerifier, nonce: flow.nonce, expiresAt: flow.expiresAt, generation: flow.generation,
    });
    expect(consumeVisibleConsentState(db, { ...binding, state: flow.state }, 1001)).toBeNull();
  });
  it("rejects state at the exact expiry boundary and rejects fabricated state", () => {
    const flow = createVisibleConsentState(db, binding, 1000);
    expect(consumeVisibleConsentState(db, { ...binding, state: flow.state }, flow.expiresAt)).toBeNull();
    expect(consumeVisibleConsentState(db, { ...binding, state: "x".repeat(43) }, 1001)).toBeNull();
  });
  it("supersedes previous attempts per user without evicting other users", () => {
    const bob = createVisibleConsentState(db, { userId: "bob", sessionId: "b" }, 1000);
    const first = createVisibleConsentState(db, binding, 1000);
    for (let n = 0; n < 8; n++) createVisibleConsentState(db, binding, 1000);
    expect(db.prepare("SELECT count(*) AS count FROM drive_visible_oauth_states WHERE userId = 'alice'").get()?.count).toBe(1);
    expect(consumeVisibleConsentState(db, { ...binding, state: first.state }, 1001)).toBeNull();
    expect(consumeVisibleConsentState(db, { userId: "bob", sessionId: "b", state: bob.state }, 1001)).not.toBeNull();
  });
});

describe("Visible file grants", () => {
  it("keeps accounts isolated", () => {
    saveVisibleGrant(db, grant);
    saveVisibleGrant(db, { ...grant, userId: "bob", googleSub: "google-b", accessToken: "bob-access" });
    expect(getVisibleGrant(db, "alice")).toEqual(savedGrant());
    expect(getVisibleGrant(db, "bob")?.accessToken).toBe("bob-access");
    expect(getVisibleGrant(db, "unknown")).toBeNull();
  });
  it("requires the drive.file scope and an offline refresh token for the initial connection", () => {
    expect(() => saveVisibleGrant(db, { ...grant, scopes: [DRIVE_APPDATA_SCOPE] })).toThrow();
    expect(() => saveVisibleGrant(db, { ...grant, scopes: ["openid"] })).toThrow();
    expect(() => saveVisibleGrant(db, { ...grant, refreshToken: undefined })).toThrow();
    expect(() => saveVisibleGrant(db, { ...grant, refreshToken: "" })).toThrow();
    expect(getVisibleGrant(db, "alice")).toBeNull();
  });
  it("refuses a grant that came back wider than the visible consent, never persisting it", () => {
    const broad = "https://www.googleapis.com/auth/drive";
    for (const scope of [broad, `${broad}.readonly`, `${broad}.metadata`, DRIVE_APPDATA_SCOPE]) {
      expect(() => saveVisibleGrant(db, { ...grant, scopes: [VISIBLE_FILE_SCOPE, scope] })).toThrow();
      expect(getVisibleGrant(db, "alice")).toBeNull();
    }
    expect(saveVisibleGrant(db, { ...grant, scopes: ["openid", VISIBLE_FILE_SCOPE] }).scopes)
      .toEqual(["openid", VISIBLE_FILE_SCOPE]);
  });
  it("treats an unknown scope as a rejected scope rather than an allowed one", () => {
    expect(() => saveVisibleGrant(db, { ...grant, scopes: [VISIBLE_FILE_SCOPE, "https://example.test/future-scope"] })).toThrow();
    expect(getVisibleGrant(db, "alice")).toBeNull();
  });
  it("preserves a missing refresh token only for the same Google identity", () => {
    saveVisibleGrant(db, grant);
    expect(saveVisibleGrant(db, { ...grant, accessToken: "new-access", refreshToken: null }).refreshToken)
      .toBe(grant.refreshToken);
    expect(() => saveVisibleGrant(db, { ...grant, googleSub: "google-b", refreshToken: undefined }))
      .toThrow("Visible file account mismatch");
    expect(() => saveVisibleGrant(db, { ...grant, googleSub: "google-b", refreshToken: "new-refresh" }))
      .toThrow("Visible file account mismatch");
    expect(getVisibleGrant(db, "alice")?.accessToken).toBe("new-access");
  });
  it("rejects scope loss on refresh without replacing the stored grant", () => {
    saveVisibleGrant(db, grant);
    expect(() => saveVisibleGrant(db, { ...grant, accessToken: "new-access", scopes: [] })).toThrow();
    expect(getVisibleGrant(db, "alice")).toEqual(savedGrant());
  });
  it("rejects an in-flight exchange after revoke or newer consent", () => {
    const flow = createVisibleConsentState(db, binding, 1000);
    consumeVisibleConsentState(db, { ...binding, state: flow.state }, 1001);
    revokeVisibleGrant(db, "alice");
    expect(() => saveVisibleGrant(db, { ...grant, expectedGeneration: flow.generation }))
      .toThrow("superseded or revoked");
    const next = createVisibleConsentState(db, binding, 1002);
    createVisibleConsentState(db, binding, 1003);
    expect(() => saveVisibleGrant(db, { ...grant, expectedGeneration: next.generation }))
      .toThrow("superseded or revoked");
    expect(getVisibleGrant(db, "alice")).toBeNull();
  });
  it("invalidates a held grant the moment its epoch moves", () => {
    saveVisibleGrant(db, grant);
    const held = getVisibleGrant(db, "alice")!;
    expect(isVisibleGrantCurrent(db, held)).toBe(true);
    createVisibleConsentState(db, binding, 1000);
    expect(isVisibleGrantCurrent(db, held)).toBe(false);
    const other = { ...grant, userId: "bob", googleSub: "google-b" };
    saveVisibleGrant(db, other);
    expect(isVisibleGrantCurrent(db, getVisibleGrant(db, "bob")!)).toBe(true);
  });
  it("removes grants, consent and generation when the auth user is deleted", () => {
    saveVisibleGrant(db, grant);
    db.prepare("DELETE FROM user WHERE id = ?").run("alice");
    expect(getVisibleGrant(db, "alice")).toBeNull();
    expect(db.prepare("SELECT * FROM drive_visible_oauth_states WHERE userId = ?").all("alice")).toEqual([]);
    expect(db.prepare("SELECT * FROM drive_visible_grant_generations WHERE userId = ?").all("alice")).toEqual([]);
  });
  it("fails closed on malformed persisted rows", () => {
    saveVisibleGrant(db, grant);
    db.prepare("UPDATE drive_visible_grants SET scopes = ?").run("not-json");
    expect(getVisibleGrant(db, "alice")).toBeNull();
    expect(() => saveVisibleGrant(db, { ...grant, refreshToken: undefined })).toThrow();
    db.prepare("UPDATE drive_visible_grants SET scopes = ?, expiresAt = ?").run(JSON.stringify(grant.scopes), "invalid");
    expect(getVisibleGrant(db, "alice")).toBeNull();
  });
});

describe("Visible consent stays separate from appData, sign-in and Calendar", () => {
  it("revoke drops only the visible grant, preserving the appData grant and Calendar", () => {
    db.exec("CREATE TABLE account (userId TEXT, providerId TEXT, accessToken TEXT, refreshToken TEXT)");
    db.prepare("INSERT INTO account VALUES (?, ?, ?, ?)").run("alice", "google", "login-access", "login-refresh");
    const before = db.prepare("SELECT * FROM account").all();
    const calendarState = createCalendarState(db, binding, 0);
    const calendar = saveCalendarGrant(db, {
      userId: "alice", googleSub: "google-a", accessToken: "cal-access", refreshToken: "cal-refresh",
      expiresAt: 900_000, scopes: [CALENDAR_READONLY_SCOPE], expectedGeneration: calendarState.generation,
    });
    saveVisibleGrant(db, grant);
    saveVisibleGrant(db, { ...grant, userId: "bob", googleSub: "google-b" });
    saveDriveGrant(db, {
      userId: "alice", googleSub: "google-a", accessToken: "appdata-access", refreshToken: "appdata-refresh",
      expiresAt: 900_000, scopes: [DRIVE_APPDATA_SCOPE], expectedGeneration: createDriveState(db, binding, 0).generation,
    });
    const visibleAlice = createVisibleConsentState(db, binding, 1000);
    const visibleBob = createVisibleConsentState(db, { userId: "bob", sessionId: "b" }, 1000);

    revokeVisibleGrant(db, "alice");

    expect(getVisibleGrant(db, "alice")).toBeNull();
    expect(consumeVisibleConsentState(db, { ...binding, state: visibleAlice.state }, 1001)).toBeNull();
    // appData grant, its consent state, Calendar and the login account are untouched.
    expect(getDriveGrant(db, "alice")?.accessToken).toBe("appdata-access");
    expect(getCalendarGrant(db, "alice")).toEqual(calendar);
    expect(db.prepare("SELECT * FROM account").all()).toEqual(before);
    expect(getVisibleGrant(db, "bob")).not.toBeNull();
    expect(consumeVisibleConsentState(db, { userId: "bob", sessionId: "b", state: visibleBob.state }, 1001)).not.toBeNull();
  });
  it("keeps the two Drive consents in separate tables with separate epochs", () => {
    const visibleEpoch = () => Number(db
      .prepare("SELECT generation FROM drive_visible_grant_generations WHERE userId = 'alice'").get()?.generation);
    const appDataEpoch = () => Number(db
      .prepare("SELECT generation FROM drive_grant_generations WHERE userId = 'alice'").get()?.generation);
    const visibleBefore = visibleEpoch();
    const appDataState = createDriveState(db, binding, 1000);
    expect(appDataState.generation).toBe(1);
    // An appData consent never moves the visible epoch…
    expect(visibleEpoch()).toBe(visibleBefore);
    const visibleState = createVisibleConsentState(db, binding, 1000);
    // …and a visible consent never moves the appData one. Each lifecycle owns
    // its own counter, so neither can invalidate the other's in-flight work.
    expect(visibleState.generation).toBe(visibleBefore + 1);
    expect(appDataEpoch()).toBe(1);
    // The epoch advanced because this very test began a second consent, so the
    // save must name it — the refusal below is the invariant, not a nuisance.
    saveVisibleGrant(db, { ...grant, expectedGeneration: visibleState.generation });
    expect(db.prepare("SELECT count(*) AS count FROM drive_grants WHERE userId = 'alice'").get()?.count).toBe(0);
    expect(db.prepare("SELECT count(*) AS count FROM drive_visible_grants WHERE userId = 'alice'").get()?.count).toBe(1);
    // Consuming one lifecycle's state must not consume the other's.
    expect(consumeVisibleConsentState(db, { ...binding, state: visibleState.state }, 1001)).not.toBeNull();
    expect(db.prepare("SELECT count(*) AS count FROM drive_oauth_states WHERE userId = 'alice'").get()?.count).toBe(1);
  });
  it("never stores a visible grant under the appData scope or vice versa", () => {
    saveVisibleGrant(db, grant);
    expect(getVisibleGrant(db, "alice")!.scopes).toEqual([VISIBLE_FILE_SCOPE]);
    expect(getDriveGrant(db, "alice")).toBeNull();
    saveDriveGrant(db, {
      userId: "alice", googleSub: "google-a", accessToken: "appdata-access", refreshToken: "appdata-refresh",
      expiresAt: 900_000, scopes: [DRIVE_APPDATA_SCOPE], expectedGeneration: createDriveState(db, binding, 0).generation,
    });
    expect(getVisibleGrant(db, "alice")!.scopes).toEqual([VISIBLE_FILE_SCOPE]);
    expect(getDriveGrant(db, "alice")!.scopes).toEqual([DRIVE_APPDATA_SCOPE]);
  });
  it("a stale appData disconnect cannot invalidate a visible grant", () => {
    saveVisibleGrant(db, grant);
    saveDriveGrant(db, {
      userId: "alice", googleSub: "google-a", accessToken: "appdata-access", refreshToken: "appdata-refresh",
      expiresAt: 900_000, scopes: [DRIVE_APPDATA_SCOPE], expectedGeneration: createDriveState(db, binding, 0).generation,
    });
    const held = getVisibleGrant(db, "alice")!;
    disconnectDrive(db, "alice");
    expect(getDriveGrant(db, "alice")).toBeNull();
    expect(isVisibleGrantCurrent(db, held)).toBe(true);
  });
});
