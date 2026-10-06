import { DatabaseSync } from "node:sqlite";
import {
  createLocalJWKSet, exportJWK, generateKeyPair, SignJWT,
  type JWTPayload, type JWTVerifyGetKey,
} from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { enrollmentEnabled } from "./installation-enrollment-contract.ts";
import {
  createEnrollmentIdentityResolver,
  type EnrollmentIdentityConfiguration,
  type EnrollmentIdentityContext,
  type EnrollmentIdentityDependencies,
} from "./installation-enrollment-identity.ts";

const config: EnrollmentIdentityConfiguration = {
  clientId: "synthetic-enrollment-client",
  trusted: {
    issuer: "https://enrollment.example.invalid",
    approvedRedirects: { macos: "muster-test://enrollment/finish", ios: "", watchos: "", android: "",
      windows: "", linux: "", cli: "", web: "" },
  },
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let localKeys: JWTVerifyGetKey;
let db: DatabaseSync;
let at: number;
let context: EnrollmentIdentityContext | null;
let readContext: ReturnType<typeof vi.fn<EnrollmentIdentityDependencies["context"]>>;

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  localKeys = createLocalJWKSet({ keys: [{ ...jwk, kid: "identity-fixture", alg: "RS256" }] });
});

beforeEach(() => {
  at = Date.now();
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE "session" (id TEXT PRIMARY KEY, userId TEXT, expiresAt, activeOrganizationId TEXT);
    CREATE TABLE "member" (id TEXT PRIMARY KEY, userId TEXT, organizationId TEXT, createdAt TEXT);
    CREATE TABLE "account" (id TEXT PRIMARY KEY, userId TEXT, providerId TEXT, accountId TEXT);
    INSERT INTO "user" VALUES ('owner', 'same-email@example.invalid'), ('other', 'same-email@example.invalid');
    INSERT INTO "member" VALUES ('membership', 'owner', 'workspace', '2026-01-01'),
      ('other-membership', 'other', 'other-workspace', '2026-01-01');
    INSERT INTO "account" VALUES ('google-link', 'owner', 'google', 'verified-google-sub'),
      ('other-google-link', 'other', 'google', 'other-google-sub');
  `);
  db.prepare('INSERT INTO "session" VALUES (?, ?, ?, ?)').run("session", "owner", at + 60_000, "workspace");
  db.prepare('INSERT INTO "session" VALUES (?, ?, ?, ?)').run("other-session", "other", at + 60_000, "other-workspace");
  context = { session: { userId: "owner", sessionId: "session" },
    attempt: { id: "held-attempt", nonce: "server-held-nonce", clientKey: "synthetic-client-key",
      platform: "macos", redirect: config.trusted.approvedRedirects.macos, expiresAt: at + 30_000 } };
  readContext = vi.fn(async () => context);
});

afterEach(() => { db.close(); });

function sign(patch: JWTPayload = {}): Promise<string> {
  return new SignJWT({ iss: "https://accounts.google.com", aud: config.clientId,
    sub: "verified-google-sub", nonce: "server-held-nonce", exp: Math.floor(Date.now() / 1000) + 120, ...patch })
    .setProtectedHeader({ alg: "RS256", kid: "identity-fixture" }).sign(keys.privateKey);
}

function resolver(overrides: Partial<EnrollmentIdentityDependencies> = {}, configuration = config) {
  return createEnrollmentIdentityResolver(configuration, { db, context: readContext, now: () => at,
    keyResolver: localKeys, ...overrides });
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function pausedKeys() {
  const entered = deferred();
  const held = deferred();
  const keyResolver: JWTVerifyGetKey = async (...args) => {
    entered.release();
    await held.promise;
    return localKeys(...args);
  };
  return { keyResolver, entered: entered.promise, release: held.release };
}

describe("unwired W2 verified identity resolver", () => {
  it("produces the existing binding from signed JWT, live signed session, linked Google subject and current membership", async () => {
    const before = db.prepare('SELECT * FROM "account" ORDER BY id').all();
    expect(await resolver()(await sign())).toEqual({ ok: true, value: {
      cloudSubject: "verified-google-sub", cloudIssuer: config.trusted.issuer, cloudAuthority: config.trusted.issuer,
      workspaceId: "workspace", clientKey: "synthetic-client-key", localOwnerId: "owner",
      localSessionId: "session", cloudSessionValid: true,
    } });
    expect(readContext).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT * FROM "account" ORDER BY id').all()).toEqual(before);
    expect(enrollmentEnabled).toBe(false);
  });

  it("uses the existing personal-workspace fallback with current membership and accepts ISO session expiry", async () => {
    db.prepare('UPDATE "session" SET activeOrganizationId = NULL, expiresAt = ? WHERE id = ?')
      .run(new Date(at + 60_000).toISOString(), "session");
    expect(await resolver()(await sign())).toMatchObject({ ok: true, value: { workspaceId: "workspace" } });
  });

  it.each([
    ["issuer", { iss: "https://untrusted.example.invalid" }],
    ["audience", { aud: "other-client" }],
    ["nonce", { nonce: "client-echoed-nonce" }],
    ["expiry", { exp: Math.floor(Date.now() / 1000) - 1 }],
    ["missing expiry", { exp: undefined }],
    ["authorized party", { azp: "other-client" }],
    ["empty subject", { sub: " " }],
  ] as const)("refuses an actual signed token with wrong %s", async (_name, patch) => {
    expect(await resolver()(await sign(patch))).toEqual({ ok: false, reason: "id-token" });
  });

  it("refuses a forged signature using the actual verifier", async () => {
    const forgedKeys = await generateKeyPair("RS256");
    const token = await new SignJWT({ iss: "https://accounts.google.com", aud: config.clientId,
      sub: "verified-google-sub", nonce: "server-held-nonce", exp: Math.floor(Date.now() / 1000) + 120 })
      .setProtectedHeader({ alg: "RS256", kid: "identity-fixture" }).sign(forgedKeys.privateKey);
    expect(await resolver()(token)).toEqual({ ok: false, reason: "id-token" });
  });

  it("refuses a valid Google token for another linked account even when emails match", async () => {
    expect(await resolver()(await sign({ sub: "other-google-sub", email: "same-email@example.invalid" })))
      .toEqual({ ok: false, reason: "provider-subject" });
  });

  it("refuses email-shaped provider subjects even when the linked account has that value", async () => {
    db.prepare('UPDATE "account" SET accountId = ? WHERE id = ?').run("same-email@example.invalid", "google-link");
    expect(await resolver()(await sign({ sub: "same-email@example.invalid" })))
      .toEqual({ ok: false, reason: "provider-subject" });
  });

  it.each([null, undefined, { ...config, clientId: "" },
    { ...config, trusted: { ...config.trusted, issuer: "https://enrollment.example.invalid/" } },
  ])("refuses absent or malformed deployment trust/audience without reading identity", async configuration => {
    const keyResolver = vi.fn(localKeys);
    const resolve = createEnrollmentIdentityResolver(configuration, { db, context: readContext, keyResolver });
    expect(await resolve(await sign())).toEqual({ ok: false, reason: "not-configured" });
    expect(readContext).not.toHaveBeenCalled();
    expect(keyResolver).not.toHaveBeenCalled();
  });

  it.each(["", "muster-test://unapproved/finish"])("refuses an absent or mismatched approved callback before JWT verification: %s", async redirect => {
    const keyResolver = vi.fn(localKeys);
    const configuration = { ...config, trusted: { ...config.trusted,
      approvedRedirects: { ...config.trusted.approvedRedirects, macos: redirect } } };
    expect(await resolver({ keyResolver }, configuration)(await sign())).toEqual({ ok: false, reason: "redirect" });
    expect(keyResolver).not.toHaveBeenCalled();
  });

  it("does not create an authenticated context when the host has no signed session/attempt", async () => {
    context = null;
    expect(await resolver()(await sign())).toEqual({ ok: false, reason: "attempt" });
  });

  it.each(["deleted", "expired", "malformed", "foreign-owner", "missing-user"])("refuses a %s session even if the host returns an identifier", async mode => {
    if (mode === "deleted") db.prepare('DELETE FROM "session" WHERE id = ?').run("session");
    if (mode === "expired") db.prepare('UPDATE "session" SET expiresAt = ? WHERE id = ?').run(at, "session");
    if (mode === "malformed") db.prepare('UPDATE "session" SET expiresAt = ? WHERE id = ?').run("garbage", "session");
    if (mode === "foreign-owner") db.prepare('UPDATE "session" SET userId = ? WHERE id = ?').run("other", "session");
    if (mode === "missing-user") db.prepare('DELETE FROM "user" WHERE id = ?').run("owner");
    expect(await resolver()(await sign())).toEqual({ ok: false, reason: "local-session" });
  });

  it("refuses missing current membership instead of trusting a session's workspace name", async () => {
    db.prepare('DELETE FROM "member" WHERE userId = ?').run("owner");
    expect(await resolver()(await sign())).toEqual({ ok: false, reason: "workspace" });
  });

  it.each(["missing", "ambiguous", "different-provider"])("refuses a %s Google provider link without Drive/Calendar grants", async mode => {
    if (mode === "missing") db.prepare('DELETE FROM "account" WHERE userId = ?').run("owner");
    if (mode === "ambiguous") db.prepare('INSERT INTO "account" VALUES (?, ?, ?, ?)')
      .run("second-google-link", "owner", "google", "verified-google-sub");
    if (mode === "different-provider") db.prepare('UPDATE "account" SET providerId = ? WHERE id = ?').run("github", "google-link");
    expect(await resolver()(await sign())).toEqual({ ok: false, reason: "provider-subject" });
  });

  it.each([
    ["session deletion", "local-session"], ["session expiry", "local-session"],
    ["membership removal", "workspace"], ["workspace switch", "context-changed"],
    ["Google account switch", "context-changed"], ["signed account switch", "context-changed"],
    ["attempt supersession", "context-changed"], ["attempt expiry", "expired"],
    ["cancellation", "cancelled"],
  ] as const)("rechecks %s after the actual verifier awaits keys", async (change, reason) => {
    const paused = pausedKeys();
    const controller = new AbortController();
    const pending = resolver({ keyResolver: paused.keyResolver })(await sign(), controller.signal);
    await paused.entered;
    if (change === "session deletion") db.prepare('DELETE FROM "session" WHERE id = ?').run("session");
    if (change === "session expiry") db.prepare('UPDATE "session" SET expiresAt = ? WHERE id = ?').run(at, "session");
    if (change === "membership removal") db.prepare('DELETE FROM "member" WHERE userId = ?').run("owner");
    if (change === "workspace switch") {
      db.prepare('INSERT INTO "member" VALUES (?, ?, ?, ?)').run("new-member", "owner", "new-workspace", "2026-01-02");
      db.prepare('UPDATE "session" SET activeOrganizationId = ? WHERE id = ?').run("new-workspace", "session");
    }
    if (change === "Google account switch") db.prepare('UPDATE "account" SET accountId = ? WHERE id = ?').run("other-google-sub", "google-link");
    if (change === "signed account switch") context = { ...context!, session: { userId: "other", sessionId: "other-session" } };
    if (change === "attempt supersession") context = { ...context!, attempt: { ...context!.attempt, id: "new-attempt" } };
    if (change === "attempt expiry") at += 30_000;
    if (change === "cancellation") controller.abort();
    paused.release();
    expect(await pending).toEqual({ ok: false, reason });
  });

  it.each(["session", "membership", "provider", "attempt", "cancel"])("rechecks %s after the final signed-session read awaits", async change => {
    const entered = deferred();
    const held = deferred();
    const controller = new AbortController();
    readContext.mockImplementationOnce(async () => context).mockImplementationOnce(async () => {
      entered.release();
      await held.promise;
      return context;
    });
    const pending = resolver()(await sign(), controller.signal);
    await entered.promise;
    if (change === "session") db.prepare('DELETE FROM "session" WHERE id = ?').run("session");
    if (change === "membership") db.prepare('DELETE FROM "member" WHERE userId = ?').run("owner");
    if (change === "provider") db.prepare('UPDATE "account" SET accountId = ? WHERE id = ?').run("other-google-sub", "google-link");
    if (change === "attempt") context = { ...context!, attempt: { ...context!.attempt, nonce: "new-nonce" } };
    if (change === "cancel") controller.abort();
    held.release();
    expect(await pending).toEqual({ ok: false, reason: change === "session" ? "local-session"
      : change === "membership" ? "workspace" : change === "cancel" ? "cancelled" : "context-changed" });
  });

  it("checks cancellation and expiry after the initial signed-session read", async () => {
    const controller = new AbortController();
    readContext.mockImplementationOnce(async () => { controller.abort(); return context; });
    expect(await resolver()(await sign(), controller.signal)).toEqual({ ok: false, reason: "cancelled" });
    readContext.mockImplementationOnce(async () => { at += 30_000; return context; });
    expect(await resolver()(await sign())).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a signed token that expires while the final authenticated context read awaits", async () => {
    const tokenExpiry = Math.floor(Date.now() / 1000) + 10;
    readContext.mockImplementationOnce(async () => context).mockImplementationOnce(async () => {
      at = tokenExpiry * 1000;
      return context;
    });
    expect(await resolver()(await sign({ exp: tokenExpiry }))).toEqual({ ok: false, reason: "id-token" });
  });

  it("does not adopt mutated host configuration or attempt objects across verification", async () => {
    const ownedConfig = structuredClone(config);
    const paused = pausedKeys();
    const pending = resolver({ keyResolver: paused.keyResolver }, ownedConfig)(await sign());
    await paused.entered;
    ownedConfig.trusted.issuer = "https://different.example.invalid";
    context = { ...context!, attempt: { ...context!.attempt, clientKey: "different-client-key" } };
    paused.release();
    expect(await pending).toEqual({ ok: false, reason: "context-changed" });
  });

  it("fails closed when the signed-session reader or database is unavailable", async () => {
    readContext.mockRejectedValueOnce(new Error("synthetic session reader unavailable"));
    expect(await resolver()(await sign())).toEqual({ ok: false, reason: "attempt" });
    db.exec('DROP TABLE "session"');
    expect(await resolver()(await sign())).toEqual({ ok: false, reason: "local-session" });
  });
});
