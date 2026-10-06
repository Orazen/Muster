// Owned temp files, injected synthetic key, real attempt store/engine seam.
// No route, account, user file, network, or production enrollment enablement.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EnrollmentAttemptPersistenceError, FileEnrollmentAttemptStore } from "./installation-enrollment-attempt-store.ts";
import type { EnrollmentAttemptCommitObserver } from "./installation-enrollment-attempt-store.ts";
import { MemoryProtectedStore, createEnrollmentEngine, enrollmentEnabled,
  mintEnrollmentVerifier } from "./installation-enrollment-contract.ts";
import type { EnrollmentDeps, EnrollmentIntent, TrustedCloudConfig, UpstreamExchange } from "./installation-enrollment-contract.ts";
import { MemoryFencePersistence } from "./installation-fence-persistence.ts";

const faults = { mode: "" };
const observeCommit: EnrollmentAttemptCommitObserver = (operation, phase) => {
  if ((operation === "rename" && faults.mode === `${phase}-rename`)
    || (phase === "before" && faults.mode === operation)) {
    throw new Error("synthetic persistence fault");
  }
};

const NOW = 1_760_000_000_000;
const KEY = Buffer.alloc(32, 0x57);
const CLIENT = "client-key-synthetic-durable";
const OTHER = "client-key-synthetic-other";
const ISSUER = "https://cloud.synthetic.invalid";
const REDIRECT = "http://127.0.0.1:53411/oauth/finish";
const CONTEXT = { ownerId: "synthetic-owner", sessionId: "synthetic-session", endpoint: "http://127.0.0.1:53411" };
const MAGIC = Buffer.from("muster-enrollment-attempts-v1\n");
let directory: string;
const stores: FileEnrollmentAttemptStore[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "muster-durable-attempts-"));
  faults.mode = "";
});
afterEach(() => {
  faults.mode = "";
  for (const store of stores.splice(0)) store.close();
  rmSync(directory, { recursive: true, force: true });
});
const path = () => join(directory, "attempts.enc");
function open(key = KEY): FileEnrollmentAttemptStore {
  return openAt(path(), key);
}
function openAt(file: string, key = KEY): FileEnrollmentAttemptStore {
  const store = new FileEnrollmentAttemptStore({ path: file, key, observeCommit });
  stores.push(store);
  return store;
}
function caseInsensitiveFilesystem(): boolean {
  const probe = join(directory, "case-probe");
  writeFileSync(probe, "owned case-sensitivity probe");
  const insensitive = existsSync(join(directory, "CASE-PROBE"));
  rmSync(probe);
  return insensitive;
}
function intent(id = "intent-synthetic-a", clientKey = CLIENT): EnrollmentIntent {
  return {
    id,
    request: { protocolVersion: 1, purpose: "add-device", platform: "macos", label: "Synthetic device",
      clientKey, deviceConfirmed: true, state: "synthetic-state-0123456789", codeChallenge: "synthetic-challenge-0123456789",
      codeChallengeMethod: "S256", redirect: REDIRECT, expiresAt: NOW + 120_000 },
    binding: { cloudSubject: "synthetic-provider-subject", cloudIssuer: ISSUER, cloudAuthority: ISSUER,
      workspaceId: "synthetic-workspace", clientKey, localOwnerId: CONTEXT.ownerId,
      localSessionId: CONTEXT.sessionId, cloudSessionValid: true },
    context: { ...CONTEXT }, generation: "", createdAt: NOW, expiresAt: NOW + 90_000,
    invalidatedAt: null, claimedBy: null,
  };
}
function snapshot(rows = [{ ...intent(), generation: "1" }], generations: Array<[string, number]> = [[CLIENT, 1]]) {
  return { version: 1, intents: rows, generations };
}
// Authenticated but structurally invalid fixtures discriminate shape validation
// from mere AEAD success. They are written only to this case's owned temp path.
function writeSnapshot(value: ReturnType<typeof snapshot>): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv, { authTagLength: 16 });
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  writeFileSync(path(), Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]));
}
function readSnapshotPlaintext(): string {
  const bytes = readFileSync(path());
  const decipher = createDecipheriv("aes-256-gcm", KEY, bytes.subarray(MAGIC.length, MAGIC.length + 12), { authTagLength: 16 });
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(bytes.subarray(MAGIC.length + 12, MAGIC.length + 28));
  return Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 28)), decipher.final()]).toString("utf8");
}
function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}
const TRUSTED: TrustedCloudConfig = { issuer: ISSUER,
  approvedRedirects: { macos: REDIRECT, ios: "muster://ios", watchos: "muster://watch", android: "muster://android",
    windows: "http://127.0.0.1:53412/oauth/finish", linux: "http://127.0.0.1:53413/oauth/finish",
    cli: "http://127.0.0.1:53414/oauth/finish", web: "https://app.synthetic.invalid/oauth/finish" } };
function harness(attempts: FileEnrollmentAttemptStore) {
  const custody = new MemoryProtectedStore();
  const exchange = vi.fn(async (): Promise<UpstreamExchange> => ({
    headers: { installationId: "installation-synthetic-durable", cloudSubject: "synthetic-provider-subject",
      authority: ISSUER, capability: "workspace", credentialExpiresAt: NOW + 120_000 },
    credential: "synthetic-issued-credential",
  }));
  const deps: EnrollmentDeps = { attempts, store: custody, exchange,
    noteGeneration: (key, generation) => custody.noteGeneration(key, generation),
    mintInstallationId: () => "installation-synthetic-durable", currentContext: () => ({ ...CONTEXT }),
    cloudSessionValid: () => true, now: () => NOW };
  const engine = createEnrollmentEngine({ enabled: true, trusted: TRUSTED }, { fencePersistence: new MemoryFencePersistence() });
  const { verifier, challenge } = mintEnrollmentVerifier();
  const offered = intent();
  offered.request.codeChallenge = challenge;
  const begin = () => engine.begin(offered.request, offered.binding, CONTEXT, deps);
  const complete = (id: string) => engine.complete(id, { context: CONTEXT, cloudSessionValid: true,
    verifier, state: offered.request.state, deviceConfirmed: true }, deps);
  return { engine, deps, custody, exchange, offered, begin, complete };
}

describe("FileEnrollmentAttemptStore", () => {
  it("requires a supplied key and resolves the owned parent without creating a missing snapshot", () => {
    expect(() => new FileEnrollmentAttemptStore({ path: path(), key: Buffer.alloc(31) })).toThrow(EnrollmentAttemptPersistenceError);
    const store = open();
    expect(existsSync(path())).toBe(false);
    expect(store.listIntents()).toEqual([]);
    expect(store.generationFor(CLIENT)).toBe(0);
    expect(existsSync(path())).toBe(false);
  });

  it("refuses a second process-local path owner and permits a fresh owner after close", async () => {
    const store = open();
    expect(() => open()).toThrow(EnrollmentAttemptPersistenceError);
    await store.putIntentWithGeneration(intent());
    store.close();
    expect(() => store.listIntents()).toThrow(EnrollmentAttemptPersistenceError);
    expect(open().generationFor(CLIENT)).toBe(1);
  });

  it.each([false, true])("two parent aliases cannot own/allocate/claim the same snapshot with missing nested parents=%s", async nested => {
    const real = join(directory, "real"); const alias = join(directory, "alias");
    mkdirSync(real); symlinkSync(real, alias, "dir");
    const parts = nested ? ["missing", "nested", "attempts.enc"] : ["attempts.enc"];
    const canonical = join(real, ...parts); const aliased = join(alias, ...parts);
    const first = openAt(canonical);
    expect(first.listIntents()).toEqual([]); // Load the cache before either put.
    let second: FileEnrollmentAttemptStore | null = null;
    try { second = openAt(aliased); }
    catch (error) { expect(error).toBeInstanceOf(EnrollmentAttemptPersistenceError); }
    if (second !== null) {
      // The original defect admitted both empty caches and actually persisted
      // generation 1 twice, erasing the first row. Keep that exact reproduction
      // in the regression rather than only testing path-string equivalence.
      expect(second.listIntents()).toEqual([]);
      const firstGeneration = await first.putIntentWithGeneration(intent("first-cached"));
      const secondGeneration = await second.putIntentWithGeneration(intent("second-cached"));
      expect([firstGeneration, secondGeneration]).not.toEqual(["1", "1"]);
    }
    expect(second).toBeNull();
    expect(first.generationFor(CLIENT)).toBe(0);
    expect(await first.putIntentWithGeneration(intent("first"))).toBe("1");
    expect(await first.putIntentWithGeneration(intent("winner"))).toBe("2");
    const winnerBytes = readFileSync(canonical);
    expect(() => openAt(aliased)).toThrow(EnrollmentAttemptPersistenceError);
    expect(readFileSync(aliased)).toEqual(winnerBytes);
    expect(await first.claimIntent("first", "stale-owner")).toBeNull();
    expect((await first.claimIntent("winner", "winner-owner"))?.generation).toBe("2");
    first.close();
    const fresh = openAt(aliased);
    expect(fresh.generationFor(CLIENT)).toBe(2);
    expect((await fresh.peekIntent("winner"))?.claimedBy).toBe("winner-owner");
    expect(await fresh.putIntentWithGeneration(intent("next"))).toBe("3");
  });

  it("a parent replaced by a symlink after cached load cannot move ownership or overwrite either snapshot", async () => {
    const original = join(directory, "original"); const other = join(directory, "other");
    const saved = join(directory, "saved"); mkdirSync(original); mkdirSync(other);
    const originalFile = join(original, "attempts.enc"); const otherFile = join(other, "attempts.enc");
    const owner = openAt(originalFile); const otherOwner = openAt(otherFile);
    await owner.putIntentWithGeneration(intent("original-winner"));
    await otherOwner.putIntentWithGeneration(intent("other-winner"));
    const originalBytes = readFileSync(originalFile); const otherBytes = readFileSync(otherFile);
    owner.listIntents(); renameSync(original, saved); symlinkSync(other, original, "dir");
    expect(() => owner.generationFor(CLIENT)).toThrow(EnrollmentAttemptPersistenceError);
    expect(await owner.putIntentWithGeneration(intent("redirected"))).toBeNull();
    await expect(owner.claimIntent("original-winner", "owner")).rejects.toThrow(EnrollmentAttemptPersistenceError);
    expect(readFileSync(join(saved, "attempts.enc"))).toEqual(originalBytes);
    expect(readFileSync(otherFile)).toEqual(otherBytes);
    expect(otherOwner.generationFor(CLIENT)).toBe(1);
    expect((await otherOwner.peekIntent("other-winner"))?.invalidatedAt).toBeNull();
    expect(() => openAt(originalFile)).toThrow(EnrollmentAttemptPersistenceError);
  });

  it("filename case aliases cannot both allocate from cached empty state on the actual filesystem", async () => {
    const insensitive = caseInsensitiveFilesystem();
    const lower = path(); const upper = join(directory, "ATTEMPTS.ENC");
    const first = openAt(lower); expect(first.listIntents()).toEqual([]);
    let second: FileEnrollmentAttemptStore | null = null;
    try { second = openAt(upper); }
    catch (error) { expect(error).toBeInstanceOf(EnrollmentAttemptPersistenceError); }
    if (second !== null && insensitive) {
      expect(second.listIntents()).toEqual([]);
      const a = await first.putIntentWithGeneration(intent("first-cached"));
      const b = await second.putIntentWithGeneration(intent("case-alias-cached"));
      expect([a, b]).not.toEqual(["1", "1"]);
    }
    // The conservative parent-directory lease also refuses two distinct live
    // files on case-sensitive volumes, without claiming they are aliases.
    expect(second).toBeNull();
    expect(await first.putIntentWithGeneration(intent("winner"))).toBe("1");
    const winnerBytes = readFileSync(lower);
    if (insensitive) expect(readFileSync(upper)).toEqual(winnerBytes);
    else expect(existsSync(upper)).toBe(false);
    expect((await first.claimIntent("winner", "winner-owner"))?.generation).toBe("1");
    first.close();
    const fresh = openAt(upper);
    expect(fresh.generationFor(CLIENT)).toBe(insensitive ? 1 : 0);
    if (insensitive) expect((await fresh.peekIntent("winner"))?.claimedBy).toBe("winner-owner");
  });

  it("a storage parent supports one live snapshot owner even for different basenames", async () => {
    const first = open(); expect(first.listIntents()).toEqual([]);
    expect(() => openAt(join(directory, "another.enc"))).toThrow(EnrollmentAttemptPersistenceError);
    expect(await first.putIntentWithGeneration(intent())).toBe("1");
    first.close();
    const distinct = openAt(join(directory, "another.enc"));
    expect(distinct.generationFor(CLIENT)).toBe(0);
    expect(existsSync(join(directory, "another.enc"))).toBe(false);
  });

  it("missing parent case variants remain exclusive after the first parent is materialized", async () => {
    const lower = join(directory, "missing-parent", "nested", "attempts.enc");
    const upper = join(directory, "MISSING-PARENT", "nested", "attempts.enc");
    const first = openAt(lower); expect(first.listIntents()).toEqual([]);
    expect(() => openAt(upper)).toThrow(EnrollmentAttemptPersistenceError);
    expect(await first.putIntentWithGeneration(intent("winner"))).toBe("1");
    const bytes = readFileSync(lower);
    expect(() => openAt(upper)).toThrow(EnrollmentAttemptPersistenceError);
    expect(readFileSync(lower)).toEqual(bytes);
    expect(first.generationFor(CLIENT)).toBe(1);
  });

  it("hardlinked snapshots in different parents are unknown and cannot be written through either alias", async () => {
    const first = open(); await first.putIntentWithGeneration(intent()); first.close();
    const other = join(directory, "other-parent"); mkdirSync(other);
    const aliased = join(other, "attempts.enc"); linkSync(path(), aliased);
    const bytes = readFileSync(path());
    const original = open(); const alias = openAt(aliased);
    expect(() => original.listIntents()).toThrow(EnrollmentAttemptPersistenceError);
    expect(() => alias.listIntents()).toThrow(EnrollmentAttemptPersistenceError);
    expect(await original.putIntentWithGeneration(intent("original-retry"))).toBeNull();
    expect(await alias.putIntentWithGeneration(intent("alias-retry"))).toBeNull();
    expect(readFileSync(path())).toEqual(bytes); expect(readFileSync(aliased)).toEqual(bytes);
  });

  it("encrypts all intent provenance/state and the ledger, uses private modes and leaves no plaintext temp", async () => {
    const supplied = Buffer.from(KEY);
    const store = new FileEnrollmentAttemptStore({ path: path(), key: supplied }); stores.push(store);
    supplied.fill(0); // The store owns its key bytes independently of the caller.
    expect(await store.putIntentWithGeneration(intent())).toBe("1");
    const bytes = readFileSync(path());
    for (const value of [CLIENT, ISSUER, CONTEXT.ownerId, "synthetic-provider-subject", "synthetic-workspace",
      "synthetic-state-0123456789", "synthetic-challenge-0123456789", "intent-synthetic-a"]) {
      expect(bytes.includes(Buffer.from(value))).toBe(false);
    }
    expect(readSnapshotPlaintext()).toBe(JSON.stringify(snapshot()));
    if (process.platform !== "win32") expect(statSync(path()).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(["attempts.enc"]);
  });

  it("a returning fault observer cannot replace the actual commit or advertise an absent snapshot", async () => {
    const observed: string[] = [];
    const store = new FileEnrollmentAttemptStore({ path: path(), key: KEY,
      observeCommit(operation, phase) {
        observed.push(`${operation}:${phase}`);
        if (operation === "rename" && phase === "after") expect(existsSync(path())).toBe(true);
      } });
    stores.push(store);
    expect(await store.putIntentWithGeneration(intent())).toBe("1");
    expect(observed.slice(0, 4)).toEqual(["file-sync:before", "file-sync:after", "rename:before", "rename:after"]);
    if (process.platform !== "win32") expect(observed.slice(4)).toEqual(["directory-sync:before", "directory-sync:after"]);
    expect(readSnapshotPlaintext()).toBe(JSON.stringify(snapshot()));
    store.close();
    expect((await open().peekIntent("intent-synthetic-a"))?.generation).toBe("1");
  });

  it.skipIf(process.platform === "win32").each(["before", "after"] as const)(
    "the Windows portability branch still degrades after an opened-directory %s-sync observer fault", async phase => {
      let armed = false; let observed = false;
      const store = new FileEnrollmentAttemptStore({ path: path(), key: KEY,
        observeCommit(operation, boundary) {
          if (armed && operation === "directory-sync" && boundary === phase) {
            observed = true;
            throw new Error("synthetic opened-directory fault");
          }
        } });
      stores.push(store);
      expect(await store.putIntentWithGeneration(intent("old"))).toBe("1");
      armed = true;
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      if (!descriptor?.configurable) throw new Error("platform descriptor cannot be restored");
      const pending = (() => {
        // The put body performs no await. Exercise the Windows catch using
        // real owned-file I/O, then restore the exact descriptor before any
        // promise resumes; no global filesystem module or operation is mocked.
        Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
        try { return store.putIntentWithGeneration(intent("landed")); }
        finally { Object.defineProperty(process, "platform", descriptor); }
      })();
      await expect(pending).rejects.toThrow(EnrollmentAttemptPersistenceError);
      expect(observed).toBe(true);
      expect(() => store.listIntents()).toThrow(EnrollmentAttemptPersistenceError);
      expect(await store.putIntentWithGeneration(intent("retry"))).toBeNull();
      store.close();
      const fresh = open();
      expect(fresh.generationFor(CLIENT)).toBe(2);
      expect((await fresh.peekIntent("old"))?.invalidatedAt).toBe(NOW);
      expect((await fresh.peekIntent("landed"))?.generation).toBe("2");
    },
  );

  it("atomically supersedes and allocates distinct generations for overlapping puts, including after restart", async () => {
    const store = open();
    const [first, second] = await Promise.all([store.putIntentWithGeneration(intent("first")), store.putIntentWithGeneration(intent("second"))]);
    expect([first, second]).toEqual(["1", "2"]);
    expect((await store.peekIntent("first"))?.invalidatedAt).toBe(NOW);
    expect((await store.peekIntent("second"))?.invalidatedAt).toBeNull();
    store.close();
    const fresh = open();
    expect(fresh.generationFor(CLIENT)).toBe(2);
    expect(await fresh.claimIntent("first", "owner-old")).toBeNull();
    expect(await fresh.putIntentWithGeneration(intent("third"))).toBe("3");
    expect((await fresh.peekIntent("second"))?.invalidatedAt).toBe(NOW);
  });

  it("claims exactly once, persists the spent row across restart, and preserves an awaited cancellation observation", async () => {
    const store = open();
    await store.putIntentWithGeneration(intent());
    const claims = await Promise.all([store.claimIntent("intent-synthetic-a", "owner-one"), store.claimIntent("intent-synthetic-a", "owner-two")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims[0]?.claimedBy).toBe("owner-one");
    expect(await store.invalidateIntent("intent-synthetic-a", NOW + 1)).toBe(true);
    store.close();
    const fresh = open();
    expect((await fresh.peekIntent("intent-synthetic-a"))?.claimedBy).toBe("owner-one");
    expect((await fresh.peekIntent("intent-synthetic-a"))?.invalidatedAt).toBe(NOW + 1);
    expect(await fresh.claimIntent("intent-synthetic-a", "owner-three")).toBeNull();
  });

  it("overtaking a claim before its promise resumes retains cancellation and the exact newer winner", async () => {
    const store = open();
    await store.putIntentWithGeneration(intent("first"));
    const pendingClaim = store.claimIntent("first", "old-owner");
    const pendingPut = store.putIntentWithGeneration(intent("winner"));
    expect((await pendingClaim)?.generation).toBe("1");
    expect(await pendingPut).toBe("2");
    expect((await store.peekIntent("first"))?.invalidatedAt).toBe(NOW);
    expect((await store.claimIntent("winner", "new-owner"))?.generation).toBe("2");
  });

  it("invalidates/deletes only the exact intent, lists retained rows, and never reuses a deleted generation", async () => {
    const store = open();
    await store.putIntentWithGeneration(intent("old"));
    await store.putIntentWithGeneration(intent("winner"));
    await store.putIntentWithGeneration(intent("other", OTHER));
    expect(await store.invalidateIntent("missing", NOW)).toBe(false);
    expect(await store.invalidateIntent("old", NOW)).toBe(false);
    expect(await store.deleteIntent("old")).toBe(true);
    expect(await store.deleteIntent("old")).toBe(false);
    expect(store.listIntents().map(row => row.id)).toEqual(["winner", "other"]);
    expect((await store.peekIntent("winner"))?.invalidatedAt).toBeNull();
    await store.deleteIntent("winner"); store.close();
    const fresh = open();
    expect(await fresh.putIntentWithGeneration(intent("next"))).toBe("3");
    expect((await fresh.peekIntent("other"))?.generation).toBe("1");
  });

  it("returns cloned snapshots and rejects duplicate IDs without superseding the current row", async () => {
    const store = open(); const offered = intent();
    await store.putIntentWithGeneration(offered);
    offered.context.ownerId = "mutated-caller";
    const peeked = (await store.peekIntent(offered.id))!; peeked.binding.cloudSubject = "mutated-peek";
    const listed = store.listIntents(); listed[0].request.state = "mutated-list";
    const before = readFileSync(path());
    expect(await store.putIntentWithGeneration(intent())).toBeNull();
    expect(readFileSync(path())).toEqual(before);
    expect(await store.peekIntent(offered.id)).toEqual({ ...intent(), generation: "1" });
  });

  it("refuses malformed or extra intent fields without persisting or allocating", async () => {
    const store = open();
    for (const invalid of [null, {}, { ...intent(), token: "synthetic-token" },
      { ...intent(), binding: { ...intent().binding, cloudSubject: "person@example.invalid" } },
      { ...intent(), request: { ...intent().request, codeChallengeMethod: "plain" } },
      { ...intent(), context: { ...CONTEXT, ownerId: "different-owner" } }]) {
      // SAFETY: Deliberately cross the typed seam with malformed input to verify
      // the runtime schema refuses it before allocation or persistence.
      expect(await store.putIntentWithGeneration(invalid as EnrollmentIntent)).toBeNull();
    }
    expect(store.generationFor(CLIENT)).toBe(0);
    expect(existsSync(path())).toBe(false);
  });

  it.each(["file-sync", "before-rename", "after-rename", "directory-sync"])("%s failure refuses a put and degrades all subsequent work", async mode => {
    if (mode === "directory-sync" && process.platform === "win32") return;
    const store = open(); await store.putIntentWithGeneration(intent("old"));
    const before = readFileSync(path()); faults.mode = mode;
    const put = store.putIntentWithGeneration(intent("new"));
    if (mode === "file-sync") expect(await put).toBeNull();
    else await expect(put).rejects.toThrow(EnrollmentAttemptPersistenceError);
    faults.mode = "";
    expect(() => store.listIntents()).toThrow(EnrollmentAttemptPersistenceError);
    await expect(store.claimIntent("old", "owner")).rejects.toThrow(EnrollmentAttemptPersistenceError);
    expect(await store.putIntentWithGeneration(intent("retry"))).toBeNull();
    expect(readdirSync(directory)).toEqual(["attempts.enc"]);
    if (mode === "file-sync" || mode === "before-rename") expect(readFileSync(path())).toEqual(before);
    store.close();
    const fresh = open();
    const landed = mode === "after-rename" || mode === "directory-sync";
    expect(fresh.generationFor(CLIENT)).toBe(landed ? 2 : 1);
    expect((await fresh.peekIntent("old"))?.invalidatedAt).toBe(landed ? NOW : null);
    expect(await fresh.peekIntent("new")).toEqual(landed ? expect.objectContaining({ generation: "2" }) : null);
  });

  it.each(["claim", "invalidate", "delete"])("a failed %s never reports a successful mutation and a fresh owner reads the unchanged file", async operation => {
    const store = open(); await store.putIntentWithGeneration(intent());
    const before = readFileSync(path()); faults.mode = "before-rename";
    const action = operation === "claim" ? store.claimIntent("intent-synthetic-a", "owner")
      : operation === "invalidate" ? store.invalidateIntent("intent-synthetic-a", NOW)
        : store.deleteIntent("intent-synthetic-a");
    await expect(action).rejects.toThrow(EnrollmentAttemptPersistenceError);
    faults.mode = "";
    expect(readFileSync(path())).toEqual(before);
    store.close();
    expect(await open().peekIntent("intent-synthetic-a")).toEqual({ ...intent(), generation: "1" });
  });

  it("a claim landing before a persistence error remains single-use after restart", async () => {
    const store = open(); await store.putIntentWithGeneration(intent());
    faults.mode = "after-rename";
    await expect(store.claimIntent("intent-synthetic-a", "first-owner")).rejects.toThrow(EnrollmentAttemptPersistenceError);
    faults.mode = ""; store.close();
    const fresh = open();
    expect(await fresh.claimIntent("intent-synthetic-a", "replay-owner")).toBeNull();
    expect((await fresh.peekIntent("intent-synthetic-a"))?.claimedBy).toBe("first-owner");
  });

  it.each(["truncated", "tampered", "wrong-key", "oversized", "directory", "symlink"])("%s persisted state is unknown and cannot be overwritten", async damage => {
    const store = open(); await store.putIntentWithGeneration(intent()); store.close();
    if (damage === "truncated") writeFileSync(path(), MAGIC);
    if (damage === "tampered") { const bytes = readFileSync(path()); bytes[bytes.length - 1] ^= 1; writeFileSync(path(), bytes); }
    if (damage === "oversized") writeFileSync(path(), Buffer.alloc(3 * 1024 * 1024));
    if (damage === "directory") { rmSync(path()); mkdirSync(path()); }
    if (damage === "symlink") { const target = join(directory, "preserved.enc"); writeFileSync(target, readFileSync(path())); rmSync(path()); symlinkSync(target, path()); }
    const before = damage === "directory" ? null : readFileSync(path());
    const fresh = open(damage === "wrong-key" ? Buffer.alloc(32, 0x38) : KEY);
    expect(() => fresh.generationFor(CLIENT)).toThrow(EnrollmentAttemptPersistenceError);
    await expect(fresh.peekIntent("intent-synthetic-a")).rejects.toThrow(EnrollmentAttemptPersistenceError);
    expect(await fresh.putIntentWithGeneration(intent("replacement"))).toBeNull();
    // Compare every persisted byte without recursively enumerating a 3 MiB Buffer.
    if (before) expect(readFileSync(path()).equals(before)).toBe(true);
  });

  it.each([
    ["version", () => ({ ...snapshot(), version: 2 })],
    ["unknown field", () => ({ ...snapshot(), token: "synthetic-token" })],
    ["duplicate IDs", () => snapshot([{ ...intent(), generation: "1" }, { ...intent(), generation: "1", invalidatedAt: NOW }])],
    ["duplicate counters", () => snapshot(undefined, [[CLIENT, 1], [CLIENT, 2]])],
    ["missing counter", () => snapshot(undefined, [])],
    ["newer row than ledger", () => snapshot([{ ...intent(), generation: "2" }])],
    ["old live row", () => snapshot(undefined, [[CLIENT, 2]])],
    ["extra credential field", () => ({ ...snapshot(), intents: [{ ...intent(), generation: "1", credential: "synthetic-credential" }] })],
  ] as const)("authenticated %s corruption still refuses all work", async (_name, fixture) => {
    writeSnapshot(fixture()); const before = readFileSync(path()); const store = open();
    expect(() => store.listIntents()).toThrow(EnrollmentAttemptPersistenceError);
    expect(await store.putIntentWithGeneration(intent("new"))).toBeNull();
    expect(readFileSync(path())).toEqual(before);
  });

  it("retained counters refuse safe-integer exhaustion without changing the row", async () => {
    writeSnapshot(snapshot([{ ...intent(), generation: String(Number.MAX_SAFE_INTEGER) }], [[CLIENT, Number.MAX_SAFE_INTEGER]]));
    const before = readFileSync(path()); const store = open();
    expect(await store.putIntentWithGeneration(intent("overflow"))).toBeNull();
    expect(store.generationFor(CLIENT)).toBe(Number.MAX_SAFE_INTEGER);
    expect(readFileSync(path())).toEqual(before);
  });

  it("the row capacity refuses another intent without superseding or allocating", async () => {
    const rows = Array.from({ length: 1024 }, (_, i) => ({ ...intent(`retained-${i}`), generation: "1", invalidatedAt: NOW }));
    writeSnapshot(snapshot(rows)); const before = readFileSync(path()); const store = open();
    expect(await store.putIntentWithGeneration(intent("over-capacity"))).toBeNull();
    expect(store.generationFor(CLIENT)).toBe(1);
    expect(store.listIntents()).toHaveLength(1024);
    expect(readFileSync(path())).toEqual(before);
  });

  it("the retained key capacity refuses a new key without forgetting prior counters", async () => {
    const generations: Array<[string, number]> = Array.from({ length: 1024 }, (_, i) => [`client-key-synthetic-${i}`, 1]);
    writeSnapshot(snapshot([], generations)); const before = readFileSync(path()); const store = open();
    expect(await store.putIntentWithGeneration(intent())).toBeNull();
    expect(store.generationFor(CLIENT)).toBe(0);
    expect(store.generationFor("client-key-synthetic-0")).toBe(1);
    expect(readFileSync(path())).toEqual(before);
  });

  it("the encrypted snapshot byte budget refuses a put without adopting a generation", async () => {
    const large = intent("large");
    large.request.redirect = "r".repeat(2048); large.context.endpoint = "e".repeat(2048);
    large.request.state = "s".repeat(512); large.request.codeChallenge = "c".repeat(512);
    const retained = { ...large, generation: "1", invalidatedAt: NOW };
    const rowBytes = Buffer.byteLength(JSON.stringify(retained));
    const count = Math.floor((2 * 1024 * 1024) / (rowBytes + 16)) - 1;
    const rows = Array.from({ length: count }, (_, i) => ({ ...retained, id: `retained-${i}` }));
    while (Buffer.byteLength(JSON.stringify(snapshot([...rows, { ...large, generation: "2" }]))) <= 2 * 1024 * 1024) {
      rows.push({ ...retained, id: `retained-${rows.length}` });
    }
    expect(rows.length).toBeLessThan(1024);
    writeSnapshot(snapshot(rows)); const before = readFileSync(path()); const store = open();
    expect(await store.putIntentWithGeneration(large)).toBeNull();
    expect(store.generationFor(CLIENT)).toBe(1);
    expect(store.listIntents()).toHaveLength(rows.length);
    expect(readFileSync(path())).toEqual(before);
  });
});

describe("existing enrollment engine with durable attempts", () => {
  it("completes a pre-restart begin once through the actual engine and default production stays disabled", async () => {
    expect(enrollmentEnabled).toBe(false);
    const first = open(); const h = harness(first); const begun = await h.begin();
    if (!begun.ok) throw new Error("synthetic begin refused");
    first.close(); const resumed = open(); h.deps.attempts = resumed;
    const outcome = await h.complete(begun.value.intentId);
    expect(outcome.ok).toBe(true);
    expect(h.exchange).toHaveBeenCalledTimes(1);
    const before = h.custody.row(CLIENT);
    resumed.close(); h.deps.attempts = open();
    expect((await h.complete(begun.value.intentId)).ok).toBe(false);
    expect(h.exchange).toHaveBeenCalledTimes(1);
    expect(h.custody.row(CLIENT)).toEqual(before);
  });

  it("a held older exchange is overtaken and cannot erase the new durable winner", async () => {
    const store = open(); const h = harness(store);
    const waiting = held<UpstreamExchange>(); const entered = held<void>();
    const response = await h.exchange(); h.exchange.mockClear();
    h.exchange.mockImplementationOnce(async () => { entered.release(); return waiting.promise; });
    const first = await h.begin(); if (!first.ok) throw new Error("synthetic begin refused");
    const oldComplete = h.complete(first.value.intentId); await entered.promise;
    const second = await h.begin(); if (!second.ok) throw new Error("synthetic begin refused");
    expect((await h.complete(second.value.intentId)).ok).toBe(true);
    const winner = h.custody.row(CLIENT);
    waiting.release(response);
    expect(await oldComplete).toEqual({ ok: false, reason: "superseded" });
    expect(h.custody.row(CLIENT)).toEqual(winner);
    expect((await store.peekIntent(second.value.intentId))?.generation).toBe("2");
    store.close();
    expect((await open().peekIntent(second.value.intentId))?.claimedBy).not.toBeNull();
    expect(h.exchange).toHaveBeenCalledTimes(2);
  });

  it("held cancellation persists, stops issuance to custody, and survives restart", async () => {
    const store = open(); const h = harness(store);
    const waiting = held<UpstreamExchange>(); const entered = held<void>();
    const response = await h.exchange(); h.exchange.mockClear();
    h.exchange.mockImplementationOnce(async () => { entered.release(); return waiting.promise; });
    const begun = await h.begin(); if (!begun.ok) throw new Error("synthetic begin refused");
    const completion = h.complete(begun.value.intentId); await entered.promise;
    expect(await store.invalidateIntent(begun.value.intentId, NOW + 1)).toBe(true);
    waiting.release(response);
    expect(await completion).toEqual({ ok: false, reason: "cancelled" });
    expect(h.custody.row(CLIENT)).toBeNull(); store.close();
    expect((await open().peekIntent(begun.value.intentId))?.invalidatedAt).toBe(NOW + 1);
  });

  it("a failed begin persistence reports the existing failure and invokes no exchange", async () => {
    const h = harness(open()); faults.mode = "file-sync";
    expect(await h.begin()).toEqual({ ok: false, reason: "intent-persist-failed" });
    expect(h.exchange).not.toHaveBeenCalled();
    expect(h.custody.row(CLIENT)).toBeNull();
  });

  it("an uncertain begin rejects and a fresh owner preserves the visible generation before superseding it", async () => {
    const store = open(); const h = harness(store); faults.mode = "after-rename";
    await expect(h.begin()).rejects.toThrow(EnrollmentAttemptPersistenceError);
    faults.mode = "";
    expect(h.exchange).not.toHaveBeenCalled();
    expect(h.custody.row(CLIENT)).toBeNull(); store.close();
    const fresh = open(); h.deps.attempts = fresh;
    expect(fresh.generationFor(CLIENT)).toBe(1);
    const persisted = fresh.listIntents(); expect(persisted).toHaveLength(1);
    const next = await h.begin(); if (!next.ok) throw new Error("synthetic begin refused");
    expect(fresh.generationFor(CLIENT)).toBe(2);
    expect(await fresh.claimIntent(persisted[0].id, "stale-owner")).toBeNull();
    expect((await h.complete(next.value.intentId)).ok).toBe(true);
    expect(h.exchange).toHaveBeenCalledTimes(1);
  });

  it("concurrent actual-engine completions claim only once before calling the exchange", async () => {
    const h = harness(open()); const begun = await h.begin();
    if (!begun.ok) throw new Error("synthetic begin refused");
    const outcomes = await Promise.all([h.complete(begun.value.intentId), h.complete(begun.value.intentId)]);
    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
    expect(h.exchange).toHaveBeenCalledTimes(1);
    expect(h.custody.row(CLIENT)).not.toBeNull();
  });
});
