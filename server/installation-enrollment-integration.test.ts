import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EnrollmentAttemptPersistenceError, FileEnrollmentAttemptStore } from "./installation-enrollment-attempt-store.ts";
import type { EnrollmentAttemptCommitObserver } from "./installation-enrollment-attempt-store.ts";
import {
  createEnrollmentEngine, enrollmentEnabled, MemoryProtectedStore,
  mintEnrollmentVerifier, resetEnrollmentFences, setEnrollmentFencePersistence,
} from "./installation-enrollment-contract.ts";
import type {
  EnrollmentBinding, EnrollmentDeps, EnrollmentIntent, ProtectedCredentialStore,
  TrustedCloudConfig, UpstreamExchange,
} from "./installation-enrollment-contract.ts";
import { createEnrollmentIdentityResolver } from "./installation-enrollment-identity.ts";
import type {
  EnrollmentIdentityConfiguration, EnrollmentIdentityContext, EnrollmentIdentityDependencies,
} from "./installation-enrollment-identity.ts";
import { resolveFollowUpAccount } from "./follow-up-identity.ts";
import { MemoryFencePersistence } from "./installation-fence-persistence.ts";

// This composes the real, currently unwired components. Trust, context and
// custody are explicit isolated fixtures; this is no OAuth producer, native
// bridge, protected-key policy or production enrollment configuration.
const trusted: TrustedCloudConfig = {
  issuer: "https://enrollment-fixture.example.invalid",
  approvedRedirects: {
    macos: "https://callback.enrollment-fixture.example.invalid/macos",
    ios: "", watchos: "", android: "", windows: "", linux: "", cli: "", web: "",
  },
};
const configuration: EnrollmentIdentityConfiguration = { clientId: "fixture-google-enrollment-client", trusted };
let signingKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let localKeys: JWTVerifyGetKey;
const fixtures: EnrollmentFixture[] = [];

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

class EnrollmentFixture {
  readonly root = mkdtempSync(join(tmpdir(), "muster-enrollment-composition-"));
  readonly path = join(this.root, "attempts.enc");
  // A caller-supplied ephemeral key, never a product default or user secret.
  readonly key = randomBytes(32);
  readonly db = new DatabaseSync(":memory:");
  readonly custody = new MemoryProtectedStore();
  readonly engine = createEnrollmentEngine({ enabled: true, trusted }, { fencePersistence: new MemoryFencePersistence() });
  readonly proof = mintEnrollmentVerifier();
  readonly clientKey = `fixture-client-${randomUUID()}`;
  readonly at = Date.now();
  readonly request = {
    protocolVersion: 1 as const, purpose: "add-device" as const, platform: "macos" as const,
    label: "Isolated composed fixture", clientKey: this.clientKey, deviceConfirmed: true as const,
    state: `fixture-state-${randomUUID()}`, codeChallenge: this.proof.challenge, codeChallengeMethod: "S256" as const,
    redirect: trusted.approvedRedirects.macos, expiresAt: this.at + 60_000,
  };
  context = { ownerId: "owner", sessionId: "owner-session", endpoint: trusted.issuer };
  identityContext: EnrollmentIdentityContext = {
    session: { userId: "owner", sessionId: "owner-session" },
    attempt: {
      id: `fixture-held-attempt-${randomUUID()}`, nonce: `fixture-nonce-${randomUUID()}`,
      clientKey: this.clientKey, platform: "macos", redirect: trusted.approvedRedirects.macos,
      expiresAt: this.request.expiresAt,
    },
  };
  cloudValid = true;
  verifiedBinding: EnrollmentBinding | null = null;
  attempts: FileEnrollmentAttemptStore;
  readonly stores: FileEnrollmentAttemptStore[] = [];
  readonly releases: Array<() => void> = [];
  readonly pending: Promise<unknown>[] = [];
  readonly exchange = vi.fn(async (binding: EnrollmentBinding, intent: EnrollmentIntent): Promise<UpstreamExchange> => this.response(binding, intent));
  readonly deps: EnrollmentDeps;

  constructor(observer?: EnrollmentAttemptCommitObserver) {
    this.db.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);
      CREATE TABLE session (id TEXT PRIMARY KEY, userId TEXT, expiresAt, activeOrganizationId TEXT);
      CREATE TABLE member (id TEXT PRIMARY KEY, userId TEXT, organizationId TEXT, createdAt TEXT);
      CREATE TABLE account (id TEXT PRIMARY KEY, userId TEXT, providerId TEXT, accountId TEXT);
      INSERT INTO user VALUES ('owner', 'same@example.invalid'), ('other', 'same@example.invalid');
      INSERT INTO member VALUES ('owner-member', 'owner', 'owner-workspace', '2026-01-01'),
        ('other-member', 'other', 'other-workspace', '2026-01-01');
      INSERT INTO account VALUES ('owner-google-link', 'owner', 'google', 'fixture-google-owner-sub'),
        ('other-google-link', 'other', 'google', 'fixture-google-other-sub');
    `);
    const insert = this.db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)");
    insert.run("owner-session", "owner", this.at + 600_000, "owner-workspace");
    insert.run("other-session", "other", this.at + 600_000, "other-workspace");
    this.attempts = this.open(observer);
    this.deps = {
      attempts: this.attempts, store: this.custody, exchange: this.exchange,
      mintInstallationId: () => "fixture-installation", now: () => Date.now(),
      currentContext: () => ({ ...this.context }), cloudSessionValid: () => this.currentCloudSessionValid(),
      noteGeneration: (clientKey, generation) => this.custody.noteGeneration(clientKey, generation),
    };
    fixtures.push(this);
  }

  open(observer?: EnrollmentAttemptCommitObserver) {
    const store = new FileEnrollmentAttemptStore({ path: this.path, key: this.key, observeCommit: observer });
    this.stores.push(store);
    return store;
  }

  restart() {
    this.attempts.close();
    this.attempts = this.open();
    this.deps.attempts = this.attempts;
  }

  response(binding: EnrollmentBinding, intent: EnrollmentIntent): UpstreamExchange {
    return {
      headers: {
        installationId: `fixture-installation-${intent.generation}`, cloudSubject: binding.cloudSubject,
        authority: trusted.issuer, capability: "workspace", credentialExpiresAt: this.at + 600_000,
      },
      credential: `fixture-only-credential-${intent.generation}`,
    };
  }

  currentCloudSessionValid() {
    // An explicit fixture freshness reader, not signed-cookie authentication.
    // Use the real public workspace resolver; the remaining query checks this
    // fixture's known linked provider row and live numeric session expiry.
    const binding = this.verifiedBinding;
    if (!this.cloudValid || binding === null) return false;
    const account = resolveFollowUpAccount(this.db, {
      userId: this.context.ownerId, sessionId: this.context.sessionId,
    }, false);
    if (account?.workspaceId !== binding.workspaceId) return false;
    return this.db.prepare(`
      SELECT 1 FROM session s JOIN account a ON a.userId = s.userId
      WHERE s.id = ? AND s.userId = ? AND s.expiresAt > ?
        AND a.id = 'owner-google-link' AND a.providerId = 'google' AND a.accountId = ?
    `).get(this.context.sessionId, binding.localOwnerId, Date.now(), binding.cloudSubject) !== undefined;
  }

  async token(overrides: JWTPayload = {}) {
    return new SignJWT({
      iss: "https://accounts.google.com", aud: configuration.clientId, sub: "fixture-google-owner-sub",
      nonce: this.identityContext.attempt.nonce, exp: Math.floor(this.at / 1000) + 600, ...overrides,
    }).setProtectedHeader({ alg: "RS256", kid: "composed-local-fixture" }).sign(signingKeys.privateKey);
  }

  identity(options: Partial<Pick<EnrollmentIdentityDependencies, "context" | "keyResolver">> = {}, config: EnrollmentIdentityConfiguration | null = configuration) {
    return createEnrollmentIdentityResolver(config, {
      db: this.db, now: () => Date.now(), context: async () => structuredClone(this.identityContext),
      keyResolver: localKeys, ...options,
    });
  }

  async begin(token: string, resolver = this.identity(), signal?: AbortSignal) {
    const verified = await resolver(token, signal);
    if (!verified.ok) return verified;
    this.verifiedBinding = verified.value;
    return this.engine.begin(this.request, verified.value, { ...this.context }, this.deps);
  }

  complete(intentId: string) {
    return this.engine.complete(intentId, {
      context: { ...this.context }, cloudSessionValid: this.currentCloudSessionValid(), verifier: this.proof.verifier,
      state: this.request.state, deviceConfirmed: true,
    }, this.deps);
  }

  hold() {
    const entered = latch();
    const released = latch();
    this.releases.push(released.release);
    return { entered: entered.promise, enter: entered.release, wait: released.promise, release: released.release };
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.push(promise);
    return promise;
  }

  untouchedOtherAccount() {
    return JSON.stringify({
      user: this.db.prepare("SELECT * FROM user WHERE id = 'other'").all(),
      session: this.db.prepare("SELECT * FROM session WHERE userId = 'other'").all(),
      member: this.db.prepare("SELECT * FROM member WHERE userId = 'other'").all(),
      account: this.db.prepare("SELECT * FROM account WHERE userId = 'other'").all(),
    });
  }
}

beforeAll(async () => {
  signingKeys = await generateKeyPair("RS256");
  const jwk = await exportJWK(signingKeys.publicKey);
  localKeys = createLocalJWKSet({ keys: [{ ...jwk, kid: "composed-local-fixture", alg: "RS256" }] });
});

beforeEach(() => {
  // MemoryProtectedStore consults the shared fence too; prohibit default-path IO.
  setEnrollmentFencePersistence(new MemoryFencePersistence());
});

afterEach(async () => {
  for (const fixture of fixtures) fixture.releases.forEach(release => release());
  for (const fixture of fixtures.splice(0)) {
    await Promise.allSettled(fixture.pending);
    fixture.stores.forEach(store => store.close());
    fixture.db.close();
    fixture.key.fill(0);
    rmSync(fixture.root, { recursive: true, force: true });
  }
  resetEnrollmentFences();
  setEnrollmentFencePersistence(null);
});

describe("verified identity + durable attempts + enrollment engine composition", () => {
  it("restarts encrypted verified provenance, commits the credential once, and preserves the other account", async () => {
    const f = new EnrollmentFixture();
    const untouched = f.untouchedOtherAccount();
    const token = await f.token();
    const begun = await f.begin(token);
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error("fixture begin refused");
    const bytes = readFileSync(f.path);
    for (const plaintext of [token, f.proof.verifier, "fixture-google-owner-sub", "owner-workspace", "owner-session", "fixture-only-credential-1"]) {
      expect(bytes.includes(Buffer.from(plaintext))).toBe(false);
    }
    f.restart();
    const persisted = await f.attempts.peekIntent(begun.value.intentId);
    expect(persisted).toMatchObject({ generation: "1", claimedBy: null, binding: {
      cloudSubject: "fixture-google-owner-sub", cloudIssuer: trusted.issuer, cloudAuthority: trusted.issuer,
      workspaceId: "owner-workspace", localOwnerId: "owner", localSessionId: "owner-session", clientKey: f.clientKey,
    } });
    const result = await f.complete(begun.value.intentId);
    expect(result).toEqual({ ok: true, value: {
      installationId: "fixture-installation-1", clientKey: f.clientKey, platform: "macos",
      capabilities: ["workspace"], envelopeVersion: 3, credentialExpiresAt: f.at + 600_000,
    } });
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect(f.custody.row(f.clientKey)).toMatchObject({ cloudSubject: "fixture-google-owner-sub",
      localOwnerId: "owner", localSessionId: "owner-session", workspaceId: "owner-workspace", cloudIssuer: trusted.issuer });
    expect(f.custody.credential(f.clientKey)).toBe("fixture-only-credential-1");
    expect(JSON.stringify(result)).not.toContain("fixture-only-credential-1");
    f.restart();
    expect((await f.attempts.peekIntent(begun.value.intentId))?.claimedBy).toEqual(expect.any(String));
    expect(await f.complete(begun.value.intentId)).toEqual({ ok: false, reason: "unknown-intent" });
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect(f.untouchedOtherAccount()).toBe(untouched);
    expect(enrollmentEnabled).toBe(false);
    expect(f.custody.conformsToProtectedCustody).toBe(false);
  });

  it.each([
    ["foreign audience", { aud: "another-google-client" }, "id-token"],
    ["foreign Google identity issuer", { iss: "https://foreign-google.example.invalid" }, "id-token"],
    ["foreign nonce", { nonce: "another-held-attempt-nonce" }, "id-token"],
    ["same email, other linked subject", { sub: "fixture-google-other-sub" }, "provider-subject"],
  ] as const)("refuses %s before durable allocation or exchange", async (_label, claims, reason) => {
    const f = new EnrollmentFixture();
    expect(await f.begin(await f.token(claims))).toEqual({ ok: false, reason });
    expect(existsSync(f.path)).toBe(false);
    expect(f.attempts.listIntents()).toEqual([]);
    expect(f.attempts.generationFor(f.clientKey)).toBe(0);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.custody.keys()).toEqual([]);
  });

  it("missing trust configuration refuses the composed entry before context or JWKS access", async () => {
    const f = new EnrollmentFixture();
    const context = vi.fn(async () => f.identityContext);
    const keyResolver = vi.fn(localKeys);
    expect(await f.begin(await f.token(), f.identity({ context, keyResolver }, null))).toEqual({ ok: false, reason: "not-configured" });
    expect(context).not.toHaveBeenCalled();
    expect(keyResolver).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(false);
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it("an unapproved callback cannot carry verified identity into durable enrollment", async () => {
    const f = new EnrollmentFixture();
    f.identityContext = { ...f.identityContext, attempt: {
      ...f.identityContext.attempt, redirect: "https://foreign-callback.example.invalid/macos",
    } };
    const keyResolver = vi.fn(localKeys);
    expect(await f.begin(await f.token(), f.identity({ keyResolver }))).toEqual({ ok: false, reason: "redirect" });
    expect(keyResolver).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(false);
    expect(f.attempts.generationFor(f.clientKey)).toBe(0);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.custody.keys()).toEqual([]);
  });

  it.each(["session revoked", "account switched", "aborted"] as const)("does not persist identity when JWKS resolution is held and %s", async change => {
    const f = new EnrollmentFixture();
    const hold = f.hold();
    const abort = new AbortController();
    const keyResolver: JWTVerifyGetKey = async (...args) => {
      hold.enter();
      await hold.wait;
      return localKeys(...args);
    };
    const pending = f.track(f.begin(await f.token(), f.identity({ keyResolver }), abort.signal));
    await hold.entered;
    if (change === "session revoked") f.db.exec("DELETE FROM session WHERE id = 'owner-session'");
    if (change === "account switched") f.identityContext = { ...f.identityContext, session: { userId: "other", sessionId: "other-session" } };
    if (change === "aborted") abort.abort();
    hold.release();
    expect(await pending).toEqual({ ok: false, reason: change === "aborted" ? "cancelled" : change === "session revoked" ? "local-session" : "context-changed" });
    expect(existsSync(f.path)).toBe(false);
    expect(f.attempts.listIntents()).toEqual([]);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.custody.keys()).toEqual([]);
  });

  it("rechecks membership at the final held identity-context read before allocating an intent", async () => {
    const f = new EnrollmentFixture();
    const hold = f.hold();
    let reads = 0;
    const context = async () => {
      if (++reads === 2) { hold.enter(); await hold.wait; }
      return structuredClone(f.identityContext);
    };
    const pending = f.track(f.begin(await f.token(), f.identity({ context })));
    await hold.entered;
    f.db.exec("DELETE FROM member WHERE userId = 'owner'");
    hold.release();
    expect(await pending).toEqual({ ok: false, reason: "workspace" });
    expect(reads).toBe(2);
    expect(existsSync(f.path)).toBe(false);
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it("preserves a newer verified winner when an older generation announcement returns late", async () => {
    const f = new EnrollmentFixture();
    const hold = f.hold();
    f.deps.noteGeneration = async (clientKey, generation) => {
      if (generation === "1") { hold.enter(); await hold.wait; }
      f.custody.noteGeneration(clientKey, generation);
    };
    const older = f.track(f.begin(await f.token()));
    await hold.entered;
    const newer = await f.begin(await f.token());
    expect(newer.ok).toBe(true);
    if (!newer.ok) throw new Error("newer fixture begin refused");
    expect((await f.complete(newer.value.intentId)).ok).toBe(true);
    hold.release();
    expect(await older).toEqual({ ok: false, reason: "superseded" });
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect(f.custody.storedGenerationFor(f.clientKey)).toBe("2");
    expect(f.custody.credential(f.clientKey)).toBe("fixture-only-credential-2");
    f.restart();
    expect(f.attempts.generationFor(f.clientKey)).toBe(2);
    expect(f.attempts.listIntents().filter(row => row.invalidatedAt === null)).toHaveLength(1);
    expect((await f.attempts.peekIntent(newer.value.intentId))?.invalidatedAt).toBeNull();
  });

  it("durable supersession survives restart and concurrent completion can exchange only once", async () => {
    const f = new EnrollmentFixture();
    const older = await f.begin(await f.token());
    expect(older.ok).toBe(true);
    if (!older.ok) throw new Error("older fixture begin refused");
    f.restart();
    const newer = await f.begin(await f.token());
    expect(newer.ok).toBe(true);
    if (!newer.ok) throw new Error("newer fixture begin refused");
    f.restart();
    expect(await f.complete(older.value.intentId)).toEqual({ ok: false, reason: "superseded" });
    const results = await Promise.all([f.complete(newer.value.intentId), f.complete(newer.value.intentId)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, reason: "unknown-intent" }]);
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect(f.custody.storedGenerationFor(f.clientKey)).toBe("2");
    expect(f.custody.credential(f.clientKey)).toBe("fixture-only-credential-2");
  });

  it.each(["intent cancelled", "current session changed"] as const)("does not adopt a held credential after %s", async change => {
    const f = new EnrollmentFixture();
    const begun = await f.begin(await f.token());
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error("fixture begin refused");
    const hold = f.hold();
    f.exchange.mockImplementationOnce(async (binding, intent) => {
      hold.enter(); await hold.wait;
      return f.response(binding, intent);
    });
    const pending = f.track(f.complete(begun.value.intentId));
    await hold.entered;
    if (change === "intent cancelled") expect(await f.attempts.invalidateIntent(begun.value.intentId, Date.now())).toBe(true);
    else f.context.sessionId = "rotated-owner-session";
    hold.release();
    expect(await pending).toEqual({ ok: false, reason: change === "intent cancelled" ? "cancelled" : "session-changed" });
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect(f.custody.keys()).toEqual([]);
    f.restart();
    expect((await f.attempts.peekIntent(begun.value.intentId))?.claimedBy).toEqual(expect.any(String));
    expect((await f.complete(begun.value.intentId)).ok).toBe(false);
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });

  it.each(["provider relinked", "workspace changed", "session expired"] as const)("the live SQL fixture reader refuses a held credential when %s", async change => {
    const f = new EnrollmentFixture();
    const begun = await f.begin(await f.token());
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error("fixture begin refused");
    const hold = f.hold();
    f.exchange.mockImplementationOnce(async (binding, intent) => {
      hold.enter(); await hold.wait;
      return f.response(binding, intent);
    });
    const pending = f.track(f.complete(begun.value.intentId));
    await hold.entered;
    expect(f.currentCloudSessionValid()).toBe(true);
    if (change === "provider relinked") f.db.exec("UPDATE account SET accountId = 'fixture-google-other-sub' WHERE id = 'owner-google-link'");
    if (change === "workspace changed") {
      f.db.exec("INSERT INTO member VALUES ('new-owner-member', 'owner', 'new-owner-workspace', '2026-02-01'); UPDATE session SET activeOrganizationId = 'new-owner-workspace' WHERE id = 'owner-session'");
    }
    if (change === "session expired") f.db.prepare("UPDATE session SET expiresAt = ? WHERE id = 'owner-session'").run(Date.now() - 1);
    expect(f.currentCloudSessionValid()).toBe(false);
    hold.release();
    expect(await pending).toEqual({ ok: false, reason: "subject" });
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect(f.custody.keys()).toEqual([]);
    f.restart();
    expect((await f.attempts.peekIntent(begun.value.intentId))?.binding).toMatchObject({
      cloudSubject: "fixture-google-owner-sub", workspaceId: "owner-workspace", localSessionId: "owner-session",
    });
    expect((await f.complete(begun.value.intentId)).ok).toBe(false);
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });

  it("cleanup after a held custody return preserves the newer actually committed credential", async () => {
    const f = new EnrollmentFixture();
    const hold = f.hold();
    const store: ProtectedCredentialStore = {
      commit: async (request, generation) => {
        const committed = await f.custody.commit(request, generation);
        if (generation === "1") { hold.enter(); await hold.wait; }
        return committed;
      },
      get: clientKey => f.custody.get(clientKey), read: clientKey => f.custody.read(clientKey),
      invalidate: (clientKey, generation) => f.custody.invalidate(clientKey, generation),
      delete: clientKey => f.custody.delete(clientKey),
    };
    f.deps.store = store;
    const older = await f.begin(await f.token());
    expect(older.ok).toBe(true);
    if (!older.ok) throw new Error("older fixture begin refused");
    const pending = f.track(f.complete(older.value.intentId));
    await hold.entered;
    expect(f.custody.storedGenerationFor(f.clientKey)).toBe("1");
    const newer = await f.begin(await f.token());
    expect(newer.ok).toBe(true);
    if (!newer.ok) throw new Error("newer fixture begin refused");
    expect((await f.complete(newer.value.intentId)).ok).toBe(true);
    hold.release();
    expect(await pending).toEqual({ ok: false, reason: "superseded" });
    expect(f.exchange).toHaveBeenCalledTimes(2);
    expect(await f.custody.read(f.clientKey)).toMatchObject({ kind: "present", record: {
      storedGeneration: "2", installationId: "fixture-installation-2", cloudSubject: "fixture-google-owner-sub",
    } });
    expect(f.custody.credential(f.clientKey)).toBe("fixture-only-credential-2");
    expect(await f.complete(newer.value.intentId)).toEqual({ ok: false, reason: "unknown-intent" });
    // Cleanup must also leave the key usable, rather than falsely fencing it.
    expect((await f.begin(await f.token())).ok).toBe(true);
  });

  it.each(["subject", "authority"] as const)("refuses upstream %s that contradicts the verified durable account binding", async field => {
    const f = new EnrollmentFixture();
    const begun = await f.begin(await f.token());
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error("fixture begin refused");
    f.restart();
    f.exchange.mockImplementationOnce(async (binding, intent) => {
      const response = f.response(binding, intent);
      if (field === "subject") response.headers.cloudSubject = "fixture-google-other-sub";
      else response.headers.authority = "https://foreign-issuer.example.invalid";
      return response;
    });
    expect(await f.complete(begun.value.intentId)).toEqual({ ok: false, reason: field });
    expect(f.exchange).toHaveBeenCalledTimes(1);
    expect(f.custody.keys()).toEqual([]);
    expect((await f.attempts.peekIntent(begun.value.intentId))?.binding.cloudSubject).toBe("fixture-google-owner-sub");
  });

  it("a before-rename fault is uncertain until a fresh owner proves nothing landed", async () => {
    let faulted = false;
    const f = new EnrollmentFixture((operation, phase) => {
      if (!faulted && operation === "rename" && phase === "before") { faulted = true; throw new Error("fixture before-rename uncertainty"); }
    });
    await expect(f.begin(await f.token())).rejects.toBeInstanceOf(EnrollmentAttemptPersistenceError);
    expect(faulted).toBe(true);
    expect(existsSync(f.path)).toBe(false);
    expect(() => f.attempts.listIntents()).toThrow(EnrollmentAttemptPersistenceError);
    expect(await f.begin(await f.token())).toEqual({ ok: false, reason: "intent-persist-failed" });
    expect(existsSync(f.path)).toBe(false);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.custody.keys()).toEqual([]);
    // The visible absence cannot make the failed cached owner authoritative.
    f.restart();
    expect(f.attempts.listIntents()).toEqual([]);
    expect(f.attempts.generationFor(f.clientKey)).toBe(0);
  });

  it("a pre-commit file-sync refusal allocates nothing but degrades its owner", async () => {
    let faulted = false;
    const f = new EnrollmentFixture((operation, phase) => {
      if (!faulted && operation === "file-sync" && phase === "before") { faulted = true; throw new Error("fixture pre-commit refusal"); }
    });
    expect(await f.begin(await f.token())).toEqual({ ok: false, reason: "intent-persist-failed" });
    expect(faulted).toBe(true);
    expect(existsSync(f.path)).toBe(false);
    expect(() => f.attempts.listIntents()).toThrow(EnrollmentAttemptPersistenceError);
    expect(await f.begin(await f.token())).toEqual({ ok: false, reason: "intent-persist-failed" });
    expect(existsSync(f.path)).toBe(false);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.custody.keys()).toEqual([]);
    // Only a fresh owner can prove absence; this fault never resumes writes.
    f.restart();
    expect(f.attempts.listIntents()).toEqual([]);
    expect(f.attempts.generationFor(f.clientKey)).toBe(0);
  });

  it("a post-rename uncertainty throws, degrades that owner, and retains committed encrypted provenance on restart", async () => {
    let faulted = false;
    const f = new EnrollmentFixture((operation, phase) => {
      if (!faulted && operation === "rename" && phase === "after") { faulted = true; throw new Error("fixture uncertain commit"); }
    });
    await expect(f.begin(await f.token())).rejects.toBeInstanceOf(EnrollmentAttemptPersistenceError);
    expect(faulted).toBe(true);
    const committed = readFileSync(f.path);
    expect(committed.includes(Buffer.from("fixture-google-owner-sub"))).toBe(false);
    expect(() => f.attempts.listIntents()).toThrow(EnrollmentAttemptPersistenceError);
    expect(await f.begin(await f.token())).toEqual({ ok: false, reason: "intent-persist-failed" });
    expect(readFileSync(f.path).equals(committed)).toBe(true);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.custody.keys()).toEqual([]);
    f.restart();
    expect(f.attempts.listIntents()).toMatchObject([{ generation: "1", claimedBy: null, binding: {
      cloudSubject: "fixture-google-owner-sub", localOwnerId: "owner", workspaceId: "owner-workspace",
    } }]);
    // Recovery is explicit fresh ownership, never a rollback or clean-absence claim.
    const winner = await f.begin(await f.token());
    expect(winner.ok).toBe(true);
    if (!winner.ok) throw new Error("fresh owner begin refused");
    expect(f.attempts.generationFor(f.clientKey)).toBe(2);
    expect((await f.complete(winner.value.intentId)).ok).toBe(true);
    expect(f.custody.credential(f.clientKey)).toBe("fixture-only-credential-2");
  });
});
