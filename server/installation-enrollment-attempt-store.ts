// Unwired, process-owned persistence for the existing enrollment attempt seam.
// The caller supplies both an owned path and a protected 32-byte key. No env
// lookup, default data path, key generation, route or enrollment enablement.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

import type { EnrollmentAttemptStore, EnrollmentIntent } from "./installation-enrollment-contract.ts";

const MAGIC = Buffer.from("muster-enrollment-attempts-v1\n", "utf8");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES + MAX_STATE_BYTES;
const MAX_ROWS = 1024;
const MAX_KEYS = 1024;
const ownedParents = new Map<string, symbol>();

/** Resolve the real existing parent, including /var -> /private/var on macOS.
 * Missing nested parents are appended to their real existing ancestor without
 * creating anything. A dangling/non-directory parent is unknown, not missing.
 */
function locatePath(path: string) {
  let parent = dirname(path);
  const missing: string[] = [];
  for (;;) {
    try { lstatSync(parent); }
    catch (error) {
      if (!z.object({ code: z.literal("ENOENT") }).safeParse(error).success) throw error;
      const ancestor = dirname(parent);
      if (ancestor === parent) throw error;
      missing.unshift(basename(parent));
      parent = ancestor;
      continue;
    }
    const stat = statSync(parent);
    if (!stat.isDirectory()) throw new Error();
    return { path: join(realpathSync(parent), ...missing, basename(path)),
      parentIdentity: `${stat.dev}:${stat.ino}`, parentExists: missing.length === 0 };
  }
}

const finite = z.number().refine(Number.isFinite);
const keyWire = z.string().min(16).max(256);
const generationWire = z.string().regex(/^[1-9][0-9]*$/)
  .refine(value => Number.isSafeInteger(Number(value)));
const issuerWire = z.string().min(1).max(256).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      && url.search === "" && url.hash === "" && url.pathname === "/" && url.origin === value;
  } catch { return false; }
});

// These are the current intent fields and request/binding bounds, not an
// identity policy. Unknown persisted fields are refused; no token, verifier,
// credential, issuer trust decision or new generation domain is introduced.
const intentWire = z.object({
  id: z.string().min(1).max(256),
  request: z.object({
    protocolVersion: z.literal(1),
    purpose: z.enum(["replace-client", "add-device", "recover-device"]),
    platform: z.enum(["ios", "watchos", "android", "macos", "windows", "linux", "cli", "web"]),
    label: z.string().max(128), clientKey: keyWire, deviceConfirmed: z.literal(true),
    state: z.string().min(16).max(512), codeChallenge: z.string().min(16).max(512),
    codeChallengeMethod: z.literal("S256"), redirect: z.string().min(1).max(2048), expiresAt: finite,
  }).strict(),
  binding: z.object({
    cloudSubject: z.string().min(1).max(256).refine(value => !value.includes("@")),
    cloudIssuer: issuerWire, cloudAuthority: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128), clientKey: keyWire,
    localOwnerId: z.string().min(1).max(256), localSessionId: z.string().min(1).max(256),
    cloudSessionValid: z.literal(true),
  }).strict(),
  context: z.object({
    ownerId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256),
    endpoint: z.string().min(1).max(2048),
  }).strict(),
  generation: generationWire, createdAt: finite, expiresAt: finite,
  invalidatedAt: finite.nullable(), claimedBy: z.string().min(1).max(256).nullable(),
}).strict().refine(intent => intent.binding.clientKey === intent.request.clientKey
  && intent.binding.localOwnerId === intent.context.ownerId
  && intent.binding.localSessionId === intent.context.sessionId);

const stateWire = z.object({
  version: z.literal(1),
  intents: z.array(intentWire).max(MAX_ROWS),
  generations: z.array(z.tuple([keyWire, z.number().int().positive().max(Number.MAX_SAFE_INTEGER)])).max(MAX_KEYS),
}).strict();
type State = z.infer<typeof stateWire>;

function validatedState(value: State): State {
  const state = stateWire.parse(value);
  const counters = new Map(state.generations);
  const ids = new Set<string>();
  const liveKeys = new Set<string>();
  if (counters.size !== state.generations.length) throw new Error("Invalid attempt state");
  for (const intent of state.intents) {
    const newest = counters.get(intent.request.clientKey);
    if (ids.has(intent.id) || newest === undefined || Number(intent.generation) > newest) {
      throw new Error("Invalid attempt state");
    }
    ids.add(intent.id);
    if (intent.invalidatedAt === null) {
      if (liveKeys.has(intent.request.clientKey) || intent.generation !== String(newest)) {
        throw new Error("Invalid attempt state");
      }
      liveKeys.add(intent.request.clientKey);
    }
  }
  return state;
}

/** Errors deliberately omit paths, input values, provenance and crypto causes. */
export class EnrollmentAttemptPersistenceError extends Error {
  constructor() { super("Enrollment attempt persistence is unavailable"); }
}

export interface FileEnrollmentAttemptStoreOptions {
  path: string;
  /** Supplied by the eventual protected-key owner; never persisted here. */
  key: Uint8Array;
  /** Synchronous fault observer may throw; real rename/fsync still perform the commit. */
  observeCommit?: EnrollmentAttemptCommitObserver;
}

export type EnrollmentAttemptCommitObserver = (
  operation: "file-sync" | "rename" | "directory-sync", phase: "before" | "after",
) => void;

/** One live owner per real storage-parent directory IN THIS PROCESS.
 * Different live snapshot files under that same directory are not supported:
 * reserving its device/inode also refuses case aliases of a missing basename.
 * An absent nested parent first reserves its real existing ancestor; once
 * created, its directory identity is reserved too. This conservative ancestor
 * lease stays until close. This is not an OS/hostwide lock or isolation claim.
 * Calls perform no await during comparison, snapshot write or cache adoption.
 * The first read loads once; external writers/watchers are outside this seam.
 * close() relinquishes ownership for shutdown/restart and disables that object.
 * A corrupt/read-failed/uncertain-write store refuses work until it is closed
 * and a fresh owner can prove the persisted state. There is no automatic reset.
 */
export class FileEnrollmentAttemptStore implements EnrollmentAttemptStore {
  private readonly path: string;
  private readonly requestedPath: string;
  private readonly ownership = Symbol();
  private readonly reservations = new Set<string>();
  private parentIdentity: string | null = null;
  private readonly key: Buffer;
  private readonly observeCommit: EnrollmentAttemptCommitObserver | undefined;
  private loaded = false;
  private failed = false;
  private closed = false;
  private state: State = { version: 1, intents: [], generations: [] };

  constructor(options: FileEnrollmentAttemptStoreOptions) {
    if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32) {
      throw new EnrollmentAttemptPersistenceError();
    }
    this.requestedPath = resolve(options.path);
    try {
      const located = locatePath(this.requestedPath);
      this.path = located.path;
      this.reserveParent(located.parentIdentity);
      if (located.parentExists) this.parentIdentity = located.parentIdentity;
    }
    catch { throw new EnrollmentAttemptPersistenceError(); }
    this.key = Buffer.from(options.key);
    this.observeCommit = options.observeCommit;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.key.fill(0);
    this.state = { version: 1, intents: [], generations: [] };
    for (const identity of this.reservations) {
      if (ownedParents.get(identity) === this.ownership) ownedParents.delete(identity);
    }
    this.reservations.clear();
  }

  generationFor(clientKey: string): number {
    this.ready();
    return new Map(this.state.generations).get(clientKey) ?? 0;
  }

  listIntents(): EnrollmentIntent[] {
    this.ready();
    return structuredClone(this.state.intents);
  }

  async peekIntent(id: string): Promise<EnrollmentIntent | null> {
    this.ready();
    const intent = this.state.intents.find(row => row.id === id);
    return intent ? structuredClone(intent) : null;
  }

  async putIntentWithGeneration(intent: EnrollmentIntent): Promise<string | null> {
    try { this.ready(); } catch { return null; }
    const offered = intentWire.safeParse({ ...intent, generation: "1" });
    if (!offered.success || offered.data.invalidatedAt !== null || offered.data.claimedBy !== null) return null;
    if (this.state.intents.some(row => row.id === offered.data.id)) return null;
    const clientKey = offered.data.request.clientKey;
    const counters = new Map(this.state.generations);
    const generation = (counters.get(clientKey) ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) return null;
    const stamped = { ...offered.data, generation: String(generation) };
    counters.set(clientKey, generation);
    const next: State = {
      version: 1,
      intents: [...this.state.intents.map(row => row.request.clientKey === clientKey && row.invalidatedAt === null
        ? { ...row, invalidatedAt: stamped.createdAt } : row), stamped],
      generations: [...counters],
    };
    const persisted = this.persist(next);
    if (persisted === "uncertain") throw new EnrollmentAttemptPersistenceError();
    if (persisted === "refused") return null;
    return String(generation);
  }

  async claimIntent(id: string, owner: string): Promise<EnrollmentIntent | null> {
    this.ready();
    // The engine owns clock/context/expiry guards before and after this await.
    // This seam compares persisted cancellation, single use and generation.
    if (!z.string().min(1).max(256).safeParse(owner).success) return null;
    const intent = this.state.intents.find(row => row.id === id);
    if (!intent || intent.invalidatedAt !== null || intent.claimedBy !== null
      || intent.generation !== String(this.generationFor(intent.request.clientKey))) return null;
    const claimed = { ...intent, claimedBy: owner };
    if (this.persist({ ...this.state, intents: this.state.intents.map(row => row.id === id ? claimed : row) }) !== "saved") {
      throw new EnrollmentAttemptPersistenceError();
    }
    return structuredClone(claimed);
  }

  async invalidateIntent(id: string, now: number): Promise<boolean> {
    this.ready();
    if (!Number.isFinite(now)) throw new EnrollmentAttemptPersistenceError();
    const intent = this.state.intents.find(row => row.id === id);
    if (!intent || intent.invalidatedAt !== null) return false;
    if (this.persist({ ...this.state,
      intents: this.state.intents.map(row => row.id === id ? { ...row, invalidatedAt: now } : row) }) !== "saved") {
      throw new EnrollmentAttemptPersistenceError();
    }
    return true;
  }

  async deleteIntent(id: string): Promise<boolean> {
    this.ready();
    if (!this.state.intents.some(row => row.id === id)) return false;
    // Retain generations even after the last row is deleted: no counter reuse.
    if (this.persist({ ...this.state, intents: this.state.intents.filter(row => row.id !== id) }) !== "saved") {
      throw new EnrollmentAttemptPersistenceError();
    }
    return true;
  }

  private ready(): void {
    if (this.closed || this.failed) throw new EnrollmentAttemptPersistenceError();
    try { this.checkParent(); }
    catch { this.failed = true; throw new EnrollmentAttemptPersistenceError(); }
    if (this.loaded) return;
    this.loaded = true;
    try {
      let stat;
      try { stat = lstatSync(this.path); }
      catch (error) {
        if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error();
      const fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const actual = fstatSync(fd);
        if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size > MAX_FILE_BYTES) throw new Error();
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        const size = readSync(fd, buffer, 0, buffer.length, 0);
        if (size !== actual.size || size > MAX_FILE_BYTES) throw new Error();
        bytes = buffer.subarray(0, size);
      } finally { closeSync(fd); }
      if (bytes.length <= MAGIC.length + IV_BYTES + TAG_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error();
      const iv = bytes.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
      const tag = bytes.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(MAGIC);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]);
      this.state = validatedState(stateWire.parse(JSON.parse(plaintext.toString("utf8"))));
    } catch {
      this.failed = true;
      throw new EnrollmentAttemptPersistenceError();
    }
  }

  private persist(value: State): "saved" | "refused" | "uncertain" {
    let state: State;
    let plaintext: Buffer;
    try {
      state = validatedState(value);
      plaintext = Buffer.from(JSON.stringify(state), "utf8");
      if (plaintext.length > MAX_STATE_BYTES) return "refused";
    } catch { return "refused"; }
    let temporary: string | null = null;
    let targetAttempted = false;
    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(MAGIC);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const bytes = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
      this.checkParent();
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      this.checkParent();
      // Refuse a symlink/directory target rather than silently replacing it.
      try {
        const stat = lstatSync(this.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error();
      } catch (error) {
        if (!z.object({ code: z.literal("ENOENT") }).safeParse(error).success) throw error;
      }
      temporary = `${this.path}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { writeFileSync(fd, bytes); this.sync(fd, "file-sync"); } finally { closeSync(fd); }
      targetAttempted = true;
      this.observeCommit?.("rename", "before");
      renameSync(temporary, this.path);
      this.observeCommit?.("rename", "after");
      temporary = null;
      let directory: number | null = null;
      try {
        directory = openSync(dirname(this.path), "r");
        this.sync(directory, "directory-sync");
      } catch (error) {
        // Windows may refuse opening the directory. Once opened, a sync or
        // observer failure is uncertain and must degrade this owner.
        // This seam promises process restart handling, not power-loss safety.
        if (process.platform !== "win32" || directory !== null) throw error;
      } finally { if (directory !== null) closeSync(directory); }
      this.state = state;
      return "saved";
    } catch {
      // A rename may already have landed. Never advertise the old cached state
      // as authoritative, retry over it, or report successful single-use work.
      this.failed = true;
      return targetAttempted ? "uncertain" : "refused";
    } finally {
      if (temporary !== null) { try { unlinkSync(temporary); } catch { /* preserve the failure */ } }
    }
  }

  private sync(fd: number, operation: "file-sync" | "directory-sync"): void {
    this.observeCommit?.(operation, "before");
    fsyncSync(fd);
    this.observeCommit?.(operation, "after");
  }

  private checkParent(): void {
    // A parent alias changing after a healthy cached read must not redirect
    // this owner to another snapshot or silently overwrite its current winner.
    const located = locatePath(this.requestedPath);
    if (located.path !== this.path || (this.parentIdentity !== null
      && (!located.parentExists || located.parentIdentity !== this.parentIdentity))) throw new Error();
    this.reserveParent(located.parentIdentity);
    if (located.parentExists) this.parentIdentity = located.parentIdentity;
  }

  private reserveParent(identity: string): void {
    const current = ownedParents.get(identity);
    if (current !== undefined && current !== this.ownership) throw new Error();
    ownedParents.set(identity, this.ownership);
    this.reservations.add(identity);
  }
}
