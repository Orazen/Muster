import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireVisibleAccess, VisibleAccessError } from "./drive-visible-access.ts";
import { createVisibleConsentState, consumeVisibleConsentState, getVisibleGrant, refreshVisibleGrant, revokeVisibleGrant, saveVisibleGrant, VISIBLE_FILE_SCOPE } from "./drive-visible-grants.ts";
import { VisibleTokenProtector } from "./drive-visible-token-protection.ts";
import { VisibleFileOAuthProvider } from "./drive-visible-oauth.ts";
import { resolveFollowUpAccount } from "./follow-up-identity.ts";

let db: DatabaseSync;
let protector: VisibleTokenProtector;
let controller: AbortController;
const alice = { userId: "alice", sessionId: "session-a", workspaceId: "workspace-a", isPrimary: true };
const bob = { userId: "bob", sessionId: "session-b", workspaceId: "workspace-b", isPrimary: false };
function seed(user = alice, accessToken = "synthetic-access", expiresAt = 900_000) {
  const attempt = createVisibleConsentState(db, user, protector, Date.now());
  consumeVisibleConsentState(db, { ...user, state: attempt.state }, protector, Date.now());
  return saveVisibleGrant(db, { userId: user.userId, googleSub: `google-${user.userId}`, accessToken, refreshToken: "synthetic-refresh", expiresAt, scopes: [VISIBLE_FILE_SCOPE], expectedGeneration: attempt.generation }, protector);
}
function current(user = alice) {
  const session = db.prepare("SELECT id FROM session WHERE id = ? AND userId = ? AND expiresAt > ?").get(user.sessionId, user.userId, Date.now());
  return session ? resolveFollowUpAccount(db, user, user.isPrimary) : null;
}
function provider() {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ access_token: "synthetic-refreshed", expires_in: 3600, token_type: "Bearer", scope: VISIBLE_FILE_SCOPE })));
  return { request, provider: new VisibleFileOAuthProvider({ clientId: "synthetic-client", clientSecret: "synthetic-secret", redirectUri: "https://owned.fixture.invalid/visible/callback", fetch: request }) };
}
function options(refresh: Pick<VisibleFileOAuthProvider, "refresh"> = provider().provider) { return { db, protector, account: alice, readCurrentAccount: () => current(), provider: refresh, signal: controller.signal }; }
const rows = () => JSON.stringify(db.prepare("SELECT * FROM drive_visible_grants ORDER BY userId").all());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(0);
  db = new DatabaseSync(":memory:"); protector = new VisibleTokenProtector(randomBytes(32)); controller = new AbortController();
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'), ('bob');
    CREATE TABLE session (id TEXT PRIMARY KEY, userId TEXT, activeOrganizationId TEXT, expiresAt INTEGER);
    INSERT INTO session VALUES ('session-a', 'alice', 'workspace-a', 9000000), ('session-b', 'bob', 'workspace-b', 9000000);
    CREATE TABLE member (id TEXT PRIMARY KEY, userId TEXT, organizationId TEXT, createdAt INTEGER);
    INSERT INTO member VALUES ('ma','alice','workspace-a',0), ('mb','bob','workspace-b',0);`);
  seed(); seed(bob, "synthetic-bob-access");
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Live visible Drive access custody", () => {
  it("reads the actual account grant without exposing credentials in the lease or changing rows", async () => {
    const before = rows(); const { provider: refresh, request } = provider();
    const lease = await acquireVisibleAccess(options(refresh));
    expect(lease.googleSub).toBe("google-alice");
    expect(JSON.stringify(lease)).not.toContain("synthetic-access");
    const operation = vi.fn(async (token: string) => { expect(token).toBe("synthetic-access"); return "owned result"; });
    expect(await lease.run(operation)).toBe("owned result");
    expect(request).not.toHaveBeenCalled(); expect(rows()).toBe(before);
    const other = await acquireVisibleAccess({ ...options(), account: bob, readCurrentAccount: () => current(bob) });
    expect(await other.run(async token => token)).toBe("synthetic-bob-access");
  });

  it("refreshes through the actual synthetic provider and persists encrypted CAS replacement", async () => {
    vi.setSystemTime(850_000); const { provider: refresh, request } = provider(); const before = rows();
    const lease = await acquireVisibleAccess(options(refresh));
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe("https://oauth2.googleapis.com/token");
    expect(await lease.run(async token => token)).toBe("synthetic-refreshed");
    expect(rows()).not.toBe(before); expect(rows()).not.toContain("synthetic-refreshed");
    expect(getVisibleGrant(db, "alice", protector)?.refreshToken).toBe("synthetic-refresh");
    expect(getVisibleGrant(db, "bob", protector)?.accessToken).toBe("synthetic-bob-access");
  });

  it.each(["membership", "session", "workspace", "primary"])("refuses changed %s authority after an awaited operation", async kind => {
    let primary = true;
    const opts = { ...options(), readCurrentAccount: () => {
      const resolved = current(); return resolved ? { ...resolved, isPrimary: primary } : null;
    } };
    const lease = await acquireVisibleAccess(opts);
    await expect(lease.run(async () => {
      if (kind === "membership") db.exec("DELETE FROM member WHERE userId = 'alice'");
      if (kind === "session") db.exec("DELETE FROM session WHERE id = 'session-a'");
      if (kind === "workspace") db.exec("INSERT INTO member VALUES ('next','alice','workspace-next',1); UPDATE session SET activeOrganizationId = 'workspace-next' WHERE id = 'session-a'");
      if (kind === "primary") primary = false;
      return "must not escape";
    })).rejects.toMatchObject({ code: "authority-changed" });
  });

  it("refuses wrong-account resolver before credentials or an operation are obtained", async () => {
    await expect(acquireVisibleAccess({ ...options(), readCurrentAccount: () => current(bob) })).rejects.toMatchObject({ code: "authority-changed" });
  });

  it.each(["refresh", "same-value-reseal", "revoke", "new-consent"])("refuses %s custody changes at operation completion", async kind => {
    const lease = await acquireVisibleAccess(options());
    await expect(lease.run(async () => {
      const held = getVisibleGrant(db, "alice", protector)!;
      if (kind === "refresh") refreshVisibleGrant(db, held, { ...held, accessToken: "newer-refresh" }, protector);
      if (kind === "same-value-reseal") refreshVisibleGrant(db, held, held, protector);
      if (kind === "revoke") revokeVisibleGrant(db, "alice");
      if (kind === "new-consent") seed(alice, "newer-consent");
      return "stale result";
    })).rejects.toBeInstanceOf(VisibleAccessError);
  });

  it("does not overwrite a newer winner during an awaited refresh", async () => {
    vi.setSystemTime(850_000); const { provider: refresh, request } = provider();
    request.mockImplementationOnce(async () => {
      seed(alice, "winning-consent", 9_000_000);
      return new Response(JSON.stringify({ access_token: "losing-refresh", expires_in: 3600, token_type: "Bearer" }));
    });
    await expect(acquireVisibleAccess(options(refresh))).rejects.toMatchObject({ code: "grant-changed" });
    expect(getVisibleGrant(db, "alice", protector)?.accessToken).toBe("winning-consent");
  });

  it.each(["abort", "membership", "session"])("does not save refresh after changed %s", async kind => {
    vi.setSystemTime(850_000); const { provider: refresh, request } = provider(); const before = rows();
    request.mockImplementationOnce(async () => {
      if (kind === "abort") controller.abort();
      if (kind === "membership") db.exec("DELETE FROM member WHERE userId = 'alice'");
      if (kind === "session") db.exec("DELETE FROM session WHERE id = 'session-a'");
      return new Response(JSON.stringify({ access_token: "canceled", expires_in: 3600, token_type: "Bearer" }));
    });
    await expect(acquireVisibleAccess(options(refresh))).rejects.toMatchObject({ code: kind === "abort" ? "aborted" : "authority-changed" });
    expect(rows()).toBe(before);
  });

  it("checks cancellation before starting and after awaiting each operation", async () => {
    const lease = await acquireVisibleAccess(options());
    await expect(lease.run(async () => { controller.abort(); return "discard me"; })).rejects.toMatchObject({ code: "aborted" });
    const operation = vi.fn(async () => "never start");
    await expect(lease.run(operation)).rejects.toMatchObject({ code: "aborted" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("does not silently use an expired lease", async () => {
    const lease = await acquireVisibleAccess(options()); vi.setSystemTime(900_000);
    const operation = vi.fn(async () => "never start");
    await expect(lease.run(operation)).rejects.toMatchObject({ code: "grant-unavailable", reconnectRequired: true });
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(["invalid_grant", "server_error"])("sanitizes %s refresh and preserves old and foreign rows", async error => {
    vi.setSystemTime(850_000); const before = rows(); const { provider: refresh, request } = provider();
    request.mockResolvedValueOnce(new Response(JSON.stringify({ error, error_description: "PRIVATE_SYNTHETIC_DETAIL" }), { status: 400 }));
    await expect(acquireVisibleAccess(options(refresh))).rejects.toMatchObject({ message: "Visible Drive access is unavailable", code: "refresh-failed", reconnectRequired: error === "invalid_grant" });
    expect(rows()).toBe(before);
  });

  it("refuses broader refresh scopes without changing the saved grant", async () => {
    vi.setSystemTime(850_000); const before = rows(); const { provider: refresh, request } = provider();
    request.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "widened", token_type: "Bearer", expires_in: 3600, scope: "https://www.googleapis.com/auth/drive" })));
    await expect(acquireVisibleAccess(options(refresh))).rejects.toMatchObject({ code: "refresh-failed", reconnectRequired: true });
    expect(rows()).toBe(before);
  });

  it("sanitizes operation and resolver errors without logging credential details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}); const lease = await acquireVisibleAccess(options());
    await expect(lease.run(async () => { throw new Error("PRIVATE_SYNTHETIC_TOKEN"); })).rejects.toMatchObject({ message: "Visible Drive access is unavailable", code: "operation-failed" });
    await expect(acquireVisibleAccess({ ...options(), readCurrentAccount: () => { throw new Error("PRIVATE_SESSION"); } })).rejects.toMatchObject({ code: "authority-changed" });
    expect(log).not.toHaveBeenCalled();
  });
  it.each(["subject", "expiry"])("rejects a replacement with invalid %s before changing rows", async kind => {
    vi.setSystemTime(850_000); const before = rows();
    const refresh = { refresh: vi.fn(async () => ({ googleSub: kind === "subject" ? "wrong-subject" : "google-alice", accessToken: "invalid-replacement", expiresAt: kind === "expiry" ? 1 : 9_000_000, scopes: [VISIBLE_FILE_SCOPE] })) };
    await expect(acquireVisibleAccess(options(refresh))).rejects.toMatchObject({ code: "refresh-failed" });
    expect(rows()).toBe(before);
  });

});
