import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VISIBLE_FILE_SCOPE, createVisibleConsentState, consumeVisibleConsentState, getVisibleGrant,
  isVisibleGrantCurrent, saveVisibleGrant, revokeVisibleGrant, cancelVisibleConsentState, refreshVisibleGrant,
} from "./drive-visible-grants.ts";
import { VisibleTokenProtector } from "./drive-visible-token-protection.ts";
import { createDriveState, saveDriveGrant, getDriveGrant, disconnectDrive, DRIVE_APPDATA_SCOPE } from "./drive-grants.ts";
import { createCalendarState, saveCalendarGrant, getCalendarGrant, CALENDAR_READONLY_SCOPE } from "./calendar-grants.ts";

let db: DatabaseSync;
let protector: VisibleTokenProtector;
const binding = { userId: "alice", sessionId: "session-a" };
const grant = {
  userId: "alice", googleSub: "google-a", accessToken: "visible-access", refreshToken: "visible-refresh",
  expiresAt: 900_000, scopes: [VISIBLE_FILE_SCOPE], expectedGeneration: 1,
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  protector = new VisibleTokenProtector(randomBytes(32));
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'), ('bob')");
  const alice = createVisibleConsentState(db, binding, protector, 0);
  consumeVisibleConsentState(db, { ...binding, state: alice.state }, protector, 1);
  const bob = createVisibleConsentState(db, { userId: "bob", sessionId: "b" }, protector, 0);
  consumeVisibleConsentState(db, { userId: "bob", sessionId: "b", state: bob.state }, protector, 1);
});
const savedGrant = () => {
  const { expectedGeneration: _generation, ...saved } = grant;
  return { ...saved, generation: 1 };
};
afterEach(() => { db.close(); vi.useRealTimers(); });

describe("Visible consent states", () => {
  it("persists only a state digest and supplies independent PKCE and nonce material", () => {
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    const other = createVisibleConsentState(db, binding, protector, 1000);
    const rows = db.prepare("SELECT * FROM drive_visible_oauth_states").all();
    expect(JSON.stringify(rows)).not.toContain(flow.state);
    expect(JSON.stringify(rows)).not.toContain(other.codeVerifier);
    expect(flow.state).not.toBe(other.state);
    expect(flow.nonce).not.toBe(other.nonce);
    expect(flow.codeChallenge).toBe(createHash("sha256").update(flow.codeVerifier).digest("base64url"));
    expect(flow.expiresAt).toBe(601000);
  });
  it("rejects another account and another session without consuming the correct flow; rejects replay", () => {
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    expect(consumeVisibleConsentState(db, { ...binding, userId: "bob", state: flow.state }, protector, 1001)).toBeNull();
    expect(consumeVisibleConsentState(db, { ...binding, sessionId: "session-b", state: flow.state }, protector, 1001)).toBeNull();
    expect(consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, 1001)).toEqual({
      ...binding, codeVerifier: flow.codeVerifier, nonce: flow.nonce, expiresAt: flow.expiresAt, generation: flow.generation,
    });
    expect(consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, 1001)).toBeNull();
  });
  it("rejects state at the exact expiry boundary and rejects fabricated state", () => {
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    expect(consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, flow.expiresAt)).toBeNull();
    expect(consumeVisibleConsentState(db, { ...binding, state: "x".repeat(43) }, protector, 1001)).toBeNull();
  });
  it("supersedes previous attempts per user without evicting other users", () => {
    const bob = createVisibleConsentState(db, { userId: "bob", sessionId: "b" }, protector, 1000);
    const first = createVisibleConsentState(db, binding, protector, 1000);
    for (let n = 0; n < 8; n++) createVisibleConsentState(db, binding, protector, 1000);
    expect(db.prepare("SELECT count(*) AS count FROM drive_visible_oauth_states WHERE userId = 'alice'").get()?.count).toBe(1);
    expect(consumeVisibleConsentState(db, { ...binding, state: first.state }, protector, 1001)).toBeNull();
    expect(consumeVisibleConsentState(db, { userId: "bob", sessionId: "b", state: bob.state }, protector, 1001)).not.toBeNull();
  });
});

describe("Visible file grants", () => {
  it("keeps accounts isolated", () => {
    saveVisibleGrant(db, grant, protector);
    saveVisibleGrant(db, { ...grant, userId: "bob", googleSub: "google-b", accessToken: "bob-access" }, protector);
    expect(getVisibleGrant(db, "alice", protector)).toEqual(savedGrant());
    expect(getVisibleGrant(db, "bob", protector)?.accessToken).toBe("bob-access");
    expect(getVisibleGrant(db, "unknown", protector)).toBeNull();
  });
  it("requires the drive.file scope and an offline refresh token for the initial connection", () => {
    expect(() => saveVisibleGrant(db, { ...grant, scopes: [DRIVE_APPDATA_SCOPE] }, protector)).toThrow();
    expect(() => saveVisibleGrant(db, { ...grant, scopes: ["openid"] }, protector)).toThrow();
    expect(() => saveVisibleGrant(db, { ...grant, refreshToken: undefined }, protector)).toThrow();
    expect(() => saveVisibleGrant(db, { ...grant, refreshToken: "" }, protector)).toThrow();
    expect(getVisibleGrant(db, "alice", protector)).toBeNull();
  });
  it("refuses a grant that came back wider than the visible consent, never persisting it", () => {
    const broad = "https://www.googleapis.com/auth/drive";
    for (const scope of [broad, `${broad}.readonly`, `${broad}.metadata`, DRIVE_APPDATA_SCOPE]) {
      expect(() => saveVisibleGrant(db, { ...grant, scopes: [VISIBLE_FILE_SCOPE, scope] }, protector)).toThrow();
      expect(getVisibleGrant(db, "alice", protector)).toBeNull();
    }
    expect(saveVisibleGrant(db, { ...grant, scopes: ["openid", VISIBLE_FILE_SCOPE] }, protector).scopes)
      .toEqual(["openid", VISIBLE_FILE_SCOPE]);
  });
  it("treats an unknown scope as a rejected scope rather than an allowed one", () => {
    expect(() => saveVisibleGrant(db, { ...grant, scopes: [VISIBLE_FILE_SCOPE, "https://example.test/future-scope"] }, protector)).toThrow();
    expect(getVisibleGrant(db, "alice", protector)).toBeNull();
  });
  it("preserves a missing refresh token only for the same Google identity", () => {
    saveVisibleGrant(db, grant, protector);
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, 1001);
    const input = { ...grant, expectedGeneration: flow.generation };
    expect(() => saveVisibleGrant(db, { ...input, googleSub: "google-b", refreshToken: undefined }, protector))
      .toThrow("Visible file account mismatch");
    expect(() => saveVisibleGrant(db, { ...input, googleSub: "google-b", refreshToken: "new-refresh" }, protector))
      .toThrow("Visible file account mismatch");
    expect(saveVisibleGrant(db, { ...input, accessToken: "new-access", refreshToken: null }, protector).refreshToken)
      .toBe(grant.refreshToken);
    expect(getVisibleGrant(db, "alice", protector)?.accessToken).toBe("new-access");
  });
  it("rejects scope loss on refresh without replacing the stored grant", () => {
    const held = saveVisibleGrant(db, grant, protector);
    expect(() => refreshVisibleGrant(db, held, { ...held, accessToken: "new-access", scopes: [] }, protector)).toThrow();
    expect(getVisibleGrant(db, "alice", protector)).toEqual(savedGrant());
  });
  it("rejects an in-flight exchange after revoke or newer consent", () => {
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, 1001);
    revokeVisibleGrant(db, "alice");
    expect(() => saveVisibleGrant(db, { ...grant, expectedGeneration: flow.generation }, protector))
      .toThrow("superseded or revoked");
    const next = createVisibleConsentState(db, binding, protector, 1002);
    createVisibleConsentState(db, binding, protector, 1003);
    expect(() => saveVisibleGrant(db, { ...grant, expectedGeneration: next.generation }, protector))
      .toThrow("superseded or revoked");
    expect(getVisibleGrant(db, "alice", protector)).toBeNull();
  });
  it("preserves a held grant through pending re-consent and invalidates it only on successful replacement", () => {
    saveVisibleGrant(db, grant, protector);
    const held = getVisibleGrant(db, "alice", protector)!;
    expect(isVisibleGrantCurrent(db, held, protector)).toBe(true);
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    expect(isVisibleGrantCurrent(db, held, protector)).toBe(true);
    consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, 1001);
    saveVisibleGrant(db, { ...grant, expectedGeneration: flow.generation, accessToken: "replacement-access" }, protector);
    expect(isVisibleGrantCurrent(db, held, protector)).toBe(false);
    const other = { ...grant, userId: "bob", googleSub: "google-b" };
    saveVisibleGrant(db, other, protector);
    expect(isVisibleGrantCurrent(db, getVisibleGrant(db, "bob", protector)!, protector)).toBe(true);
  });
  it("removes grants, consent and generation when the auth user is deleted", () => {
    saveVisibleGrant(db, grant, protector);
    db.prepare("DELETE FROM user WHERE id = ?").run("alice");
    expect(getVisibleGrant(db, "alice", protector)).toBeNull();
    expect(db.prepare("SELECT * FROM drive_visible_oauth_states WHERE userId = ?").all("alice")).toEqual([]);
    expect(db.prepare("SELECT * FROM drive_visible_grant_generations WHERE userId = ?").all("alice")).toEqual([]);
  });
  it("fails closed on malformed persisted rows", () => {
    saveVisibleGrant(db, grant, protector);
    db.prepare("UPDATE drive_visible_grants SET scopes = ?").run("not-json");
    expect(getVisibleGrant(db, "alice", protector)).toBeNull();
    expect(() => saveVisibleGrant(db, { ...grant, refreshToken: undefined }, protector)).toThrow();
    db.prepare("UPDATE drive_visible_grants SET scopes = ?, expiresAt = ?").run(JSON.stringify(grant.scopes), "invalid");
    expect(getVisibleGrant(db, "alice", protector)).toBeNull();
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
    saveVisibleGrant(db, grant, protector);
    saveVisibleGrant(db, { ...grant, userId: "bob", googleSub: "google-b" }, protector);
    saveDriveGrant(db, {
      userId: "alice", googleSub: "google-a", accessToken: "appdata-access", refreshToken: "appdata-refresh",
      expiresAt: 900_000, scopes: [DRIVE_APPDATA_SCOPE], expectedGeneration: createDriveState(db, binding, 0).generation,
    });
    const visibleAlice = createVisibleConsentState(db, binding, protector, 1000);
    const visibleBob = createVisibleConsentState(db, { userId: "bob", sessionId: "b" }, protector, 1000);

    revokeVisibleGrant(db, "alice");

    expect(getVisibleGrant(db, "alice", protector)).toBeNull();
    expect(consumeVisibleConsentState(db, { ...binding, state: visibleAlice.state }, protector, 1001)).toBeNull();
    // appData grant, its consent state, Calendar and the login account are untouched.
    expect(getDriveGrant(db, "alice")?.accessToken).toBe("appdata-access");
    expect(getCalendarGrant(db, "alice")).toEqual(calendar);
    expect(db.prepare("SELECT * FROM account").all()).toEqual(before);
    expect(getVisibleGrant(db, "bob", protector)).not.toBeNull();
    expect(consumeVisibleConsentState(db, { userId: "bob", sessionId: "b", state: visibleBob.state }, protector, 1001)).not.toBeNull();
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
    const visibleState = createVisibleConsentState(db, binding, protector, 1000);
    // …and a visible consent never moves the appData one. Each lifecycle owns
    // its own counter, so neither can invalidate the other's in-flight work.
    expect(visibleState.generation).toBe(visibleBefore + 1);
    expect(appDataEpoch()).toBe(1);
    // The epoch advanced because this very test began a second consent, so the
    // save must name it — the refusal below is the invariant, not a nuisance.
    expect(consumeVisibleConsentState(db, { ...binding, state: visibleState.state }, protector, 1001)).not.toBeNull();
    saveVisibleGrant(db, { ...grant, expectedGeneration: visibleState.generation }, protector);
    expect(db.prepare("SELECT count(*) AS count FROM drive_grants WHERE userId = 'alice'").get()?.count).toBe(0);
    expect(db.prepare("SELECT count(*) AS count FROM drive_visible_grants WHERE userId = 'alice'").get()?.count).toBe(1);
    // Consuming one lifecycle's state must not consume the other's.
    expect(consumeVisibleConsentState(db, { ...binding, state: visibleState.state }, protector, 1001)).toBeNull();
    expect(db.prepare("SELECT count(*) AS count FROM drive_oauth_states WHERE userId = 'alice'").get()?.count).toBe(1);
  });
  it("never stores a visible grant under the appData scope or vice versa", () => {
    saveVisibleGrant(db, grant, protector);
    expect(getVisibleGrant(db, "alice", protector)!.scopes).toEqual([VISIBLE_FILE_SCOPE]);
    expect(getDriveGrant(db, "alice")).toBeNull();
    saveDriveGrant(db, {
      userId: "alice", googleSub: "google-a", accessToken: "appdata-access", refreshToken: "appdata-refresh",
      expiresAt: 900_000, scopes: [DRIVE_APPDATA_SCOPE], expectedGeneration: createDriveState(db, binding, 0).generation,
    });
    expect(getVisibleGrant(db, "alice", protector)!.scopes).toEqual([VISIBLE_FILE_SCOPE]);
    expect(getDriveGrant(db, "alice")!.scopes).toEqual([DRIVE_APPDATA_SCOPE]);
  });
  it("a stale appData disconnect cannot invalidate a visible grant", () => {
    saveVisibleGrant(db, grant, protector);
    saveDriveGrant(db, {
      userId: "alice", googleSub: "google-a", accessToken: "appdata-access", refreshToken: "appdata-refresh",
      expiresAt: 900_000, scopes: [DRIVE_APPDATA_SCOPE], expectedGeneration: createDriveState(db, binding, 0).generation,
    });
    const held = getVisibleGrant(db, "alice", protector)!;
    disconnectDrive(db, "alice");
    expect(getDriveGrant(db, "alice")).toBeNull();
    expect(isVisibleGrantCurrent(db, held, protector)).toBe(true);
  });
});

describe("Credential custody and replacement lifecycle regressions", () => {
  it("stores both tokens as ciphertext and refuses legacy plaintext without removing it", () => {
    saveVisibleGrant(db, grant, protector);
    const ciphertext = db.prepare("SELECT * FROM drive_visible_grants WHERE userId = 'alice'").get();
    expect(JSON.stringify(ciphertext)).not.toContain(grant.accessToken);
    expect(JSON.stringify(ciphertext)).not.toContain(grant.refreshToken);
    const wrongKey = new VisibleTokenProtector(randomBytes(32));
    expect(getVisibleGrant(db, "alice", wrongKey)).toBeNull();
    expect(db.prepare("SELECT * FROM drive_visible_grants WHERE userId = 'alice'").get()).toEqual(ciphertext);
    db.prepare("UPDATE drive_visible_grants SET accessToken = ?, refreshToken = ? WHERE userId = 'alice'")
      .run(grant.accessToken, grant.refreshToken);
    const legacy = db.prepare("SELECT * FROM drive_visible_grants WHERE userId = 'alice'").get();
    expect(getVisibleGrant(db, "alice", protector)).toBeNull();
    expect(db.prepare("SELECT * FROM drive_visible_grants WHERE userId = 'alice'").get()).toEqual(legacy);
  });
  it.each(["userId", "googleSub", "generation", "expiresAt", "scopes"] as const)("authenticates stored token %s", field => {
    saveVisibleGrant(db, grant, protector);
    const replacement = field === "userId" ? "bob" : field === "googleSub" ? "other"
      : field === "scopes" ? JSON.stringify(["openid", VISIBLE_FILE_SCOPE]) : 2;
    db.prepare(`UPDATE drive_visible_grants SET ${field} = ? WHERE userId = 'alice'`).run(replacement);
    expect(getVisibleGrant(db, field === "userId" ? "bob" : "alice", protector)).toBeNull();
  });
  it("rejects swapping token ciphertext fields", () => {
    saveVisibleGrant(db, grant, protector);
    db.prepare("UPDATE drive_visible_grants SET accessToken = refreshToken, refreshToken = accessToken").run();
    expect(getVisibleGrant(db, "alice", protector)).toBeNull();
  });
  it.each(["sessionId", "generation", "nonce", "expiresAt"] as const)("authenticates stored PKCE %s", field => {
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    const replacement = field === "sessionId" ? "changed-session" : field === "nonce" ? "a".repeat(43) : 999999;
    db.prepare(`UPDATE drive_visible_oauth_states SET ${field} = ? WHERE userId = 'alice'`).run(replacement);
    const actualBinding = field === "sessionId" ? { ...binding, sessionId: "changed-session" } : binding;
    expect(consumeVisibleConsentState(db, { ...actualBinding, state: flow.state }, protector, 1001)).toBeNull();
    expect(db.prepare("SELECT consumed FROM drive_visible_oauth_states WHERE userId = 'alice'").get()?.consumed).toBe(0);
  });
  it("rejects legacy plaintext PKCE and preserves its unconsumed row", () => {
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    db.prepare("UPDATE drive_visible_oauth_states SET codeVerifier = ? WHERE userId = 'alice'").run(flow.codeVerifier);
    expect(consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, 1001)).toBeNull();
    expect(db.prepare("SELECT codeVerifier, consumed FROM drive_visible_oauth_states WHERE userId = 'alice'").get())
      .toEqual({ codeVerifier: flow.codeVerifier, consumed: 0 });
  });
  it("requires the protector before reading, storing or creating consent", () => {
    const before = db.prepare("SELECT * FROM drive_visible_oauth_states").all();
    // @ts-expect-error exercise missing protection at an untyped boundary
    expect(() => createVisibleConsentState(db, binding, undefined, 1000)).toThrow("protection is unavailable");
    // @ts-expect-error exercise missing protection at an untyped boundary
    expect(() => saveVisibleGrant(db, grant, undefined)).toThrow("protection is unavailable");
    // @ts-expect-error exercise missing protection at an untyped boundary
    expect(() => getVisibleGrant(db, "alice", undefined)).toThrow("protection is unavailable");
    expect(db.prepare("SELECT * FROM drive_visible_oauth_states").all()).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM drive_visible_grants").get()?.n).toBe(0);
  });
  it("requires consumed live consent and refuses completion replay and expiry", () => {
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    const input = { ...grant, expectedGeneration: flow.generation };
    expect(() => saveVisibleGrant(db, input, protector, 1000)).toThrow("superseded or revoked");
    consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, 1001);
    expect(() => saveVisibleGrant(db, input, protector, flow.expiresAt)).toThrow("superseded or revoked");
    saveVisibleGrant(db, input, protector, 1001);
    expect(() => saveVisibleGrant(db, input, protector, 1001)).toThrow("superseded or revoked");
  });
  it.each([false, true])("preserves prior usable grant on cancellation after consumption=%s", consumed => {
    const held = saveVisibleGrant(db, grant, protector);
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    if (consumed) consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, 1001);
    expect(cancelVisibleConsentState(db, { ...binding, state: flow.state }, 1002)).toBe(true);
    expect(cancelVisibleConsentState(db, { ...binding, state: flow.state }, 1002)).toBe(false);
    expect(isVisibleGrantCurrent(db, held, protector)).toBe(true);
    expect(getVisibleGrant(db, "alice", protector)).toEqual(held);
    expect(() => saveVisibleGrant(db, { ...grant, expectedGeneration: flow.generation }, protector, 1002))
      .toThrow("superseded or revoked");
  });
  it("preserves prior usable grant when replacement fails or expires", () => {
    const held = saveVisibleGrant(db, grant, protector);
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, 1001);
    expect(() => saveVisibleGrant(db, { ...grant, expectedGeneration: flow.generation, scopes: [] }, protector, 1001)).toThrow();
    expect(isVisibleGrantCurrent(db, held, protector)).toBe(true);
    expect(() => saveVisibleGrant(db, { ...grant, expectedGeneration: flow.generation }, protector, flow.expiresAt)).toThrow();
    expect(isVisibleGrantCurrent(db, held, protector)).toBe(true);
  });
  it("wrong session/account and stale state cannot cancel the newer attempt", () => {
    const stale = createVisibleConsentState(db, binding, protector, 1000);
    const flow = createVisibleConsentState(db, binding, protector, 1001);
    for (const input of [
      { ...binding, state: stale.state }, { ...binding, sessionId: "other", state: flow.state },
      { ...binding, userId: "bob", state: flow.state },
    ]) expect(cancelVisibleConsentState(db, input, 1002)).toBe(false);
    expect(consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, 1003)).not.toBeNull();
    saveVisibleGrant(db, { ...grant, expectedGeneration: flow.generation }, protector, 1003);
    expect(getVisibleGrant(db, "alice", protector)?.generation).toBe(flow.generation);
  });
  it("refreshes an existing grant during pending replacement, with exact-row custody", () => {
    const held = saveVisibleGrant(db, grant, protector);
    createVisibleConsentState(db, binding, protector, 1000);
    const refreshed = refreshVisibleGrant(db, held, { ...held, accessToken: "rotated", refreshToken: null }, protector);
    expect(refreshed.refreshToken).toBe(held.refreshToken);
    expect(isVisibleGrantCurrent(db, refreshed, protector)).toBe(true);
    expect(isVisibleGrantCurrent(db, held, protector)).toBe(false);
    expect(() => refreshVisibleGrant(db, held, { ...held, accessToken: "stale" }, protector)).toThrow("changed during refresh");
  });
  it("stale refresh cannot overwrite successful re-consent or resurrect a revoked grant", () => {
    const held = saveVisibleGrant(db, grant, protector);
    const flow = createVisibleConsentState(db, binding, protector, 1000);
    consumeVisibleConsentState(db, { ...binding, state: flow.state }, protector, 1001);
    const next = saveVisibleGrant(db, { ...grant, expectedGeneration: flow.generation, accessToken: "new-consent" }, protector, 1001);
    expect(() => refreshVisibleGrant(db, held, { ...held, accessToken: "stale" }, protector)).toThrow("changed during refresh");
    expect(getVisibleGrant(db, "alice", protector)).toEqual(next);
    revokeVisibleGrant(db, "alice");
    expect(() => refreshVisibleGrant(db, next, { ...next, accessToken: "late" }, protector)).toThrow("changed during refresh");
    expect(getVisibleGrant(db, "alice", protector)).toBeNull();
  });
  it("invalid refresh subject/scope cannot replace a valid row", () => {
    const held = saveVisibleGrant(db, grant, protector);
    for (const change of [{ googleSub: "other" }, { scopes: [] }, { scopes: [DRIVE_APPDATA_SCOPE] }, { refreshToken: "" }]) {
      expect(() => refreshVisibleGrant(db, held, { ...held, ...change }, protector)).toThrow("Invalid visible grant refresh");
      expect(getVisibleGrant(db, "alice", protector)).toEqual(held);
    }
  });
  it("does not write raw tokens or PKCE to a fresh on-disk database and reopens with the same key", () => {
    const dir = mkdtempSync(join(tmpdir(), "muster-visible-credentials-"));
    const file = join(dir, "synthetic.db");
    const database = new DatabaseSync(file);
    const key = randomBytes(32);
    const diskProtector = new VisibleTokenProtector(key);
    try {
      database.exec("PRAGMA foreign_keys=ON; CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES('alice')");
      const flow = createVisibleConsentState(database, binding, diskProtector, 0);
      consumeVisibleConsentState(database, { ...binding, state: flow.state }, diskProtector, 1);
      saveVisibleGrant(database, grant, diskProtector, 1);
      const pending = createVisibleConsentState(database, binding, diskProtector, 2);
      database.close();
      const bytes = readFileSync(file);
      for (const value of [grant.accessToken, grant.refreshToken, flow.codeVerifier, pending.codeVerifier]) {
        expect(bytes.includes(Buffer.from(value))).toBe(false);
      }
      const reopened = new DatabaseSync(file);
      try { expect(getVisibleGrant(reopened, "alice", new VisibleTokenProtector(key))).toEqual(savedGrant()); }
      finally { reopened.close(); }
    } finally {
      if (database.isOpen) database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
