// Authority adoption and mid-window revalidation, against the real records:
// a real better-auth-shaped SQLite database (the same tables and columns the
// signed-session path reads), a real ExclusiveRestoreClaim on an owned
// temporary directory, and the real persisted-fence registry through its
// documented seam. No auth layer is mocked — every refusal below is produced
// by the actual store state the cause names.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireDataDirExclusivity, type ExclusiveRestoreClaim } from "./data-dir-exclusivity.ts";
import { FileFencePersistence, MemoryFencePersistence } from "./installation-fence-persistence.ts";
import { fenceEnrollmentKey, isEnrollmentKeyFenced, resetEnrollmentFences,
  setEnrollmentFencePersistence } from "./installation-enrollment-contract.ts";
import { acquireRestoreAuthority, RestoreAuthorityRefusal,
  type RestoreAuthorityDeps, type RestoreAuthorityProof, type RestoreAuthorityRefusalCode } from "./restore-authority.ts";

// The shared fence registry persists by default under the real data dir, so
// this suite points it at a memory-backed store through the documented seam
// (the same isolation the enrollment contract's own suite performs) and
// resets it between cases.
const suiteFence = new MemoryFencePersistence();
setEnrollmentFencePersistence(suiteFence);

const LIVE = new Date(Date.now() + 86_400_000).toISOString();
const DEAD = "2020-01-01T00:00:00.000Z";
const CLIENT_KEY = "owned-restore-client-key";

const proof = (overrides: Partial<RestoreAuthorityProof> = {}): RestoreAuthorityProof =>
  ({ sessionId: "alice-session", userId: "alice", workspaceId: "alice-org", googleSub: "google-alice", ...overrides });

function expectRefusal(run: () => void, code: RestoreAuthorityRefusalCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreAuthorityRefusal);
    if (error instanceof RestoreAuthorityRefusal) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected refusal ${code}, but the call succeeded`);
}

describe("restore authority inside the exclusive window", () => {
  let db: DatabaseSync;
  let claim: ExclusiveRestoreClaim;
  let parent: string;
  let fenceDirectory: string | null = null;

  // Named after the suite's fixture so every case runs against the SAME live
  // records the claim and the database hold.
  const deps = (overrides: Partial<RestoreAuthorityDeps> = {}): RestoreAuthorityDeps =>
    ({ db, operator: () => "alice", enrollmentKey: CLIENT_KEY, ...overrides });

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE user(id TEXT PRIMARY KEY);
      CREATE TABLE organization(id TEXT PRIMARY KEY);
      CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,token TEXT,expiresAt,activeOrganizationId TEXT);
      CREATE TABLE member(id TEXT PRIMARY KEY,userId TEXT,organizationId TEXT,createdAt TEXT);
      CREATE TABLE drive_visible_grants(userId TEXT PRIMARY KEY,googleSub TEXT);
      INSERT INTO user VALUES('alice'),('bob');
      INSERT INTO organization VALUES('alice-org'),('bob-org');
      INSERT INTO session VALUES('alice-session','alice','alice-token','${LIVE}','alice-org'),
        ('bob-session','bob','bob-token','${LIVE}','bob-org');
      INSERT INTO member VALUES('m1','alice','alice-org','2026-01-01'),('m2','bob','bob-org','2026-01-01');
      INSERT INTO drive_visible_grants VALUES('alice','google-alice');`);
    parent = realpathSync(mkdtempSync(join(tmpdir(), "muster-restore-authority-")));
    const dataDir = join(parent, "data");
    mkdirSync(dataDir);
    claim = acquireDataDirExclusivity(dataDir, "owned restore-authority fixture");
  });

  afterEach(() => {
    db.close();
    // A case may have released the claim itself; a released claim refuses, so
    // cleanup swallows exactly that.
    try { claim.release(); } catch { /* released by the case */ }
    rmSync(parent, { recursive: true, force: true });
    if (fenceDirectory !== null) {
      rmSync(fenceDirectory, { recursive: true, force: true });
      fenceDirectory = null;
    }
    resetEnrollmentFences();
    setEnrollmentFencePersistence(suiteFence);
  });

  it("adopts authority for a valid live session and keeps proving it", () => {
    const authority = acquireRestoreAuthority(claim, proof(), deps());
    expect(authority.sessionId).toBe("alice-session");
    expect(authority.userId).toBe("alice");
    expect(authority.workspaceId).toBe("alice-org");
    expect(authority.isPrimary).toBe(true);
    expect(authority.googleSub).toBe("google-alice");
    expect(() => authority.assertCurrent()).not.toThrow();
    expect(() => authority.assertCurrent()).not.toThrow();
    // The handle never releases the exclusivity claim it borrowed.
    expect(() => claim.assert()).not.toThrow();
    authority.release();
  });

  it("refuses an unknown session", () => {
    expectRefusal(() => acquireRestoreAuthority(claim, proof({ sessionId: "ghost-session" }), deps()), "session-unknown");
  });

  it("refuses a session that belongs to another account", () => {
    expectRefusal(() => acquireRestoreAuthority(claim, proof({ sessionId: "bob-session" }), deps()), "account-mismatch");
    expectRefusal(() => acquireRestoreAuthority(claim, proof({ userId: "bob" }), deps()), "account-mismatch");
  });

  it("refuses an expired session", () => {
    db.prepare("UPDATE session SET expiresAt=? WHERE id='alice-session'").run(DEAD);
    expectRefusal(() => acquireRestoreAuthority(claim, proof(), deps()), "session-expired");
  });

  it("refuses a workspace mismatch, at adoption and mid-window", () => {
    expectRefusal(() => acquireRestoreAuthority(claim, proof({ workspaceId: "other-org" }), deps()), "workspace-mismatch");
    const authority = acquireRestoreAuthority(claim, proof(), deps());
    // The operator's account moves to another organization it is a member of.
    db.exec("INSERT INTO organization VALUES('alice-next')");
    db.exec("INSERT INTO member VALUES('m3','alice','alice-next','2026-02-01')");
    db.exec("UPDATE session SET activeOrganizationId='alice-next' WHERE id='alice-session'");
    expectRefusal(() => authority.assertCurrent(), "workspace-mismatch");
    // And an account that loses every membership resolves to no workspace.
    db.exec("DELETE FROM member WHERE userId='alice'");
    db.exec("UPDATE session SET activeOrganizationId=NULL WHERE id='alice-session'");
    expectRefusal(() => authority.assertCurrent(), "workspace-mismatch");
    authority.release();
  });

  it("refuses a session replaced between acquire and assertCurrent", () => {
    const authority = acquireRestoreAuthority(claim, proof(), deps());
    // Sign-out deletes the row; the next sign-in mints a different session id.
    db.exec("DELETE FROM session WHERE id='alice-session'");
    db.prepare("INSERT INTO session VALUES('alice-session-2','alice','alice-token-2',?,'alice-org')").run(LIVE);
    expectRefusal(() => authority.assertCurrent(), "session-replaced");
    authority.release();
  });

  it("refuses a session revoked between acquire and assertCurrent", () => {
    const authority = acquireRestoreAuthority(claim, proof(), deps());
    db.exec("DELETE FROM session WHERE id='alice-session'");
    expectRefusal(() => authority.assertCurrent(), "session-revoked");
    authority.release();
  });

  it("refuses a session that expires between acquire and assertCurrent", () => {
    const authority = acquireRestoreAuthority(claim, proof(), deps());
    db.prepare("UPDATE session SET expiresAt=? WHERE id='alice-session'").run(DEAD);
    expectRefusal(() => authority.assertCurrent(), "session-expired");
    authority.release();
  });

  it("refuses a fenced enrollment key, from memory and from the persisted store", () => {
    fenceEnrollmentKey(CLIENT_KEY, "owned test fence");
    expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
    expectRefusal(() => acquireRestoreAuthority(claim, proof(), deps()), "enrollment-fenced");

    resetEnrollmentFences();
    // The fence also survives the restart seam: a fence written by a prior
    // process stops a fresh registry instance reading the same store.
    fenceDirectory = realpathSync(mkdtempSync(join(tmpdir(), "muster-restore-authority-fence-")));
    const fencePath = join(fenceDirectory, "enrollment-fence.json");
    setEnrollmentFencePersistence(new FileFencePersistence({ path: fencePath }));
    fenceEnrollmentKey(CLIENT_KEY, "owned persisted fence");
    setEnrollmentFencePersistence(new FileFencePersistence({ path: fencePath }));
    expect(isEnrollmentKeyFenced(CLIENT_KEY)).toBe(true);
    expectRefusal(() => acquireRestoreAuthority(claim, proof(), deps()), "enrollment-fenced");
    setEnrollmentFencePersistence(suiteFence);
  });

  it("re-reads the fence inside assertCurrent", () => {
    const authority = acquireRestoreAuthority(claim, proof(), deps());
    fenceEnrollmentKey(CLIENT_KEY, "fenced mid-restore");
    expectRefusal(() => authority.assertCurrent(), "enrollment-fenced");
    authority.release();
  });

  it("refuses when the exclusivity claim is no longer held", () => {
    claim.release();
    expectRefusal(() => acquireRestoreAuthority(claim, proof(), deps()), "claim-not-held");
  });

  it("refuses at the next boundary when the claim is lost mid-window", () => {
    const authority = acquireRestoreAuthority(claim, proof(), deps());
    claim.release();
    expectRefusal(() => authority.assertCurrent(), "claim-not-held");
    authority.release();
  });

  it("requires the identity binding for account-bound restores", () => {
    expectRefusal(() => acquireRestoreAuthority(claim,
      { sessionId: "alice-session", userId: "alice", workspaceId: "alice-org" }, deps()), "identity-binding-missing");
    // A binding offered with nothing on record is equally unprovable.
    expectRefusal(() => acquireRestoreAuthority(claim, proof({ googleSub: "google-ghost" }), deps()),
      "identity-binding-changed");
    db.exec("DELETE FROM drive_visible_grants WHERE userId='alice'");
    expectRefusal(() => acquireRestoreAuthority(claim, proof(), deps()), "identity-binding-missing");
  });

  it("refuses a binding that changes between acquire and assertCurrent", () => {
    const authority = acquireRestoreAuthority(claim, proof(), deps());
    db.exec("UPDATE drive_visible_grants SET googleSub='google-rotated' WHERE userId='alice'");
    expectRefusal(() => authority.assertCurrent(), "identity-binding-changed");
    db.exec("DELETE FROM drive_visible_grants WHERE userId='alice'");
    expectRefusal(() => authority.assertCurrent(), "identity-binding-missing");
    authority.release();
  });

  it("adopts workspace restores without a binding, but still honors one that is offered", () => {
    const unbound = acquireRestoreAuthority(claim,
      { sessionId: "alice-session", userId: "alice", workspaceId: "alice-org" }, deps(), "workspace");
    expect(unbound.googleSub).toBeNull();
    expect(() => unbound.assertCurrent()).not.toThrow();
    unbound.release();
    // A proof that names a binding is held to it even for a workspace restore.
    expectRefusal(() => acquireRestoreAuthority(claim, proof({ googleSub: "google-ghost" }), deps(), "workspace"),
      "identity-binding-changed");
  });

  it("retires the handle on release", () => {
    const authority = acquireRestoreAuthority(claim, proof(), deps());
    authority.release();
    expectRefusal(() => authority.assertCurrent(), "authority-released");
  });

  it("refuses a malformed proof instead of guessing its identity", () => {
    expectRefusal(() => acquireRestoreAuthority(claim,
      { sessionId: "", userId: "alice", workspaceId: "alice-org" }, deps()), "proof-malformed");
  });

  it("keeps a non-operator account non-primary for the whole window", () => {
    const bobAuthority = acquireRestoreAuthority(claim,
      { sessionId: "bob-session", userId: "bob", workspaceId: "bob-org" },
      { ...deps(), operator: () => "alice" }, "workspace");
    expect(bobAuthority.isPrimary).toBe(false);
    expect(() => bobAuthority.assertCurrent()).not.toThrow();
    bobAuthority.release();
  });
});
