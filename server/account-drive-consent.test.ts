import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const oauth = { exchange: vi.fn() };
import { completeDriveConsent } from "./account-drive.ts";
import { createDriveState, getDriveGrant, saveDriveGrant, DRIVE_APPDATA_SCOPE } from "./drive-grants.ts";

let db: DatabaseSync;
const binding = { userId: "owner", sessionId: "session-a" };
const grant = () => ({ googleSub: "google-a", accessToken: "drive-access", refreshToken: "drive-refresh", expiresAt: Date.now() + 3600000, scopes: [DRIVE_APPDATA_SCOPE] });
const login = () => db.prepare("SELECT * FROM account").all();
const complete = (pending = createDriveState(db, binding), guard = async () => {}) => completeDriveConsent(db, binding, pending, "owned-code", "http://127.0.0.1:48000", guard, oauth);
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('owner');
    CREATE TABLE account(id TEXT, userId TEXT, providerId TEXT, accountId TEXT, accessToken TEXT, refreshToken TEXT, createdAt INTEGER);
    INSERT INTO account VALUES ('row-a','owner','google','google-a','login-access','login-refresh',1)`);
  oauth.exchange.mockReset().mockResolvedValue(grant());
});
afterEach(() => db.close());

describe("Drive consent account boundary", () => {
  it("stores verified Drive credentials separately and preserves the complete login row", async () => {
    const before = login(); await complete();
    expect(login()).toEqual(before);
    expect(getDriveGrant(db, "owner")).toMatchObject({ googleSub: "google-a", accessToken: "drive-access", refreshToken: "drive-refresh" });
  });
  it("rejects another Google subject without mixing tokens with the existing login", async () => {
    const before = login(); oauth.exchange.mockResolvedValue({ ...grant(), googleSub: "google-b", refreshToken: undefined });
    await expect(complete()).rejects.toThrow("does not match");
    expect(login()).toEqual(before); expect(getDriveGrant(db, "owner")).toBeNull();
  });
  it("requires an offline token for initial consent instead of borrowing the login token", async () => {
    oauth.exchange.mockResolvedValue({ ...grant(), refreshToken: undefined });
    await expect(complete()).rejects.toThrow();
    expect(getDriveGrant(db, "owner")).toBeNull(); expect(login()[0].refreshToken).toBe("login-refresh");
  });
  it("allows email-only accounts to explicitly establish a separately pinned Drive identity", async () => {
    db.exec("DELETE FROM account"); await complete();
    expect(getDriveGrant(db, "owner")?.googleSub).toBe("google-a"); expect(login()).toEqual([]);
  });
  it("rejects a replaced Google login row while exchange is pending", async () => {
    oauth.exchange.mockImplementation(async () => {
      db.exec("UPDATE account SET id = 'replacement', accountId = 'google-b'"); return grant();
    });
    await expect(complete()).rejects.toThrow("does not match"); expect(getDriveGrant(db, "owner")).toBeNull();
  });
  it("rechecks the session after exchange before saving", async () => {
    let checks = 0;
    await expect(complete(createDriveState(db, binding), async () => { if (++checks > 1) throw new Error("signed out"); })).rejects.toThrow("signed out");
    expect(getDriveGrant(db, "owner")).toBeNull();
  });
  it("rejects a newer consent started while the exchange is pending", async () => {
    const pending = createDriveState(db, binding);
    oauth.exchange.mockImplementation(async () => { createDriveState(db, binding); return grant(); });
    await expect(complete(pending)).rejects.toThrow("superseded"); expect(getDriveGrant(db, "owner")).toBeNull();
  });
  it("never accepts state from another account session", async () => {
    const pending = createDriveState(db, { ...binding, sessionId: "other-session" });
    await expect(complete(pending)).rejects.toThrow("session changed"); expect(oauth.exchange).not.toHaveBeenCalled();
  });
  it("reuses only a prior verified Drive refresh token for the same Google identity", async () => {
    const first = createDriveState(db, binding);
    saveDriveGrant(db, { ...grant(), userId: binding.userId, expectedGeneration: first.generation });
    oauth.exchange.mockResolvedValue({ ...grant(), accessToken: "new-drive-access", refreshToken: undefined });
    await complete();
    expect(getDriveGrant(db, "owner")).toMatchObject({ accessToken: "new-drive-access", refreshToken: "drive-refresh" });
    expect(login()[0].refreshToken).toBe("login-refresh");
  });
});
