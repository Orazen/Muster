// Stable installation authority (the research report's slice 3).
//
// The device inventory (server/devices.ts) is honest about what it is: a VIEW
// over session rows grouped by user-agent, with no stable installation
// identity — two machines with matching user-agents read as one device, and
// there is nothing to revoke that is not a login session. This module gives
// each installation a first-class row instead:
//
//   stable id          minted once, survives restarts, survives re-sign-in
//   owner              the account that registered it — only that account
//                      (proven by session) can list or revoke
//   credential         a bearer token returned EXACTLY once at registration,
//                      stored only as a SHA-256 digest — a leaked registry
//                      file mints nothing
//   capabilities       what this installation may act as (runner scope),
//                      fixed at minting like companion grants
//   lifecycle          active → revoked (revocation is durable and final:
//                      a restart re-reads the file, so nothing resurrects)
//
// Additive by design: registration is idempotent per (owner, stable client
// key), account identity is a separate table from sessions and companion
// grants, and no existing flow changes behaviour. Managed hosting, if chosen
// later, adds an endpoint ADAPTER on top of this authority — it is not part
// of this slice.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

const REGISTRY_VERSION = 1;
/** 24 hours — a registration credential is for bootstrapping, not forever. */
const CREDENTIAL_TTL_MS = 24 * 60 * 60_000;
/** Bounded table: one machine is one row, but a begin loop must not grow it. */
const REGISTRY_CAP = 256;

export const platformWire = z.enum(["ios", "watchos", "android", "macos", "windows", "linux", "cli", "web"]);

export type InstallationPlatform = z.infer<typeof platformWire>;

export interface InstallationRecord {
  /** Stable installation identity. Not derived from user-agent. */
  id: string;
  ownerId: string;
  /** Client-chosen stable key; (owner, key) is unique and idempotent. */
  clientKey: string;
  label: string;
  platform: InstallationPlatform;
  /** SHA-256 hex of the one-time registration credential. Never the secret. */
  credentialHash: string | null;
  /** null when the row predates a rotation or the credential was cleared. */
  credentialExpiresAt: number | null;
  capabilities: string[];
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  /** Durable transition counter for this row, or null when the row has never
   * opened one. Persisted, so it survives the process — that is the entire
   * reason it lives here and not in a private field. A restart resets every
   * in-memory counter to zero, which would let a transition opened before the
   * restart commit over one opened after it. Monotonic per row: only
   * `beginTransition` moves it, and only ever upward.
   *
   * `null` is a real state, not an absence: it is what a legacy registry file
   * reads as, and the first transition from it mints 1. */
  generation: number | null;
}

const recordWire = z.object({
  id: z.string().min(8),
  ownerId: z.string().min(1),
  clientKey: z.string().min(1).max(256),
  label: z.string().max(128),
  platform: platformWire,
  credentialHash: z.string().length(64).nullable(),
  credentialExpiresAt: z.number().refine(Number.isFinite).nullable(),
  capabilities: z.array(z.string().max(64)).max(16),
  createdAt: z.number().refine(Number.isFinite),
  lastSeenAt: z.number().refine(Number.isFinite),
  revokedAt: z.number().refine(Number.isFinite).nullable(),
  /** Defaults to null so a file written before this field existed still
   * parses — otherwise every already-registered installation would be
   * silently discarded as a corrupt registry, which fails safe in the wrong
   * direction: it destroys live state instead of refusing one transition. */
  generation: z.number().int().nonnegative().nullable().default(null),
});

const registryFileWire = z.object({
  version: z.literal(REGISTRY_VERSION),
  installations: z.array(recordWire).max(REGISTRY_CAP),
});

export interface RegistryFile {
  version: typeof REGISTRY_VERSION;
  installations: InstallationRecord[];
}

export interface RegisterInput {
  ownerId: string;
  clientKey: string;
  label: string;
  platform: InstallationPlatform;
  capabilities?: string[];
}

export interface RegisterOutcome {
  record: InstallationRecord;
  /** Present ONLY on first registration and rotation: the bearer credential,
   * returned once and never stored in readable form. */
  credential?: string;
  /** True when an existing active row was matched (idempotent re-register). */
  reactivated: boolean;
}

/** The default runner scope. Kept explicit so a future capability has to be
 * named here rather than inherited silently. */
export const INSTALLATION_CAPABILITIES = ["workspace"] as const;

export function hashCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

export function registryPathFor(dataDir: string): string {
  return join(dataDir, "installation-registry.json");
}

export function loadRegistry(path: string, _now = Date.now()): RegistryFile {
  try {
    // Every row is loaded, revoked ones on purpose (a restart must re-read
    // the revocation) and expired-credential ones too (the ROW is the stable
    // identity; the credential is only a bootstrap secret, and returning
    // machines re-mint one — see register). Nothing at load time decides
    // trust: authenticate() checks revocation and expiry on every use.
    return registryFileWire.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Missing or corrupt file = empty authority. Corrupt state never mints
    // trust — the same posture as the usage-allowance ledger.
    return { version: REGISTRY_VERSION, installations: [] };
  }
}

function persist(path: string, file: RegistryFile): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export class InstallationRegistry {
  private path: string;
  private file: RegistryFile;
  private durable: boolean;
  /** Bumped whenever this.file is adopted from disk. It exists so a commit
   * can notice that a NESTED commit landed while its draft was open, and
   * refuse rather than overwrite. In-memory only, and deliberately not part
   * of the persisted row: nothing durable depends on it. */
  private revision = 0;

  constructor(path: string, now = Date.now()) {
    this.path = path;
    this.file = loadRegistry(path, now);
    this.durable = true;
  }

  /** False when the last write failed — callers surface that instead of
   * claiming a durability they do not have. */
  get isDurable(): boolean {
    return this.durable;
  }

  /** Apply a change to a COPY of the registry, persist it, and adopt it in
   * memory only if the write actually reached disk.
   *
   * Every mutator used to edit `this.file` in place and then call
   * `persist`, which only flipped a `durable` flag. So a failed write left
   * memory disagreeing with the file, and the three routes — which all already
   * promised the opposite — were telling installations something untrue:
   * "nothing was registered" for a row that existed in memory, and "the old
   * credential still works" for a credential whose hash had already been
   * replaced. On a machine that could not write the registry, a failed
   * rotation 401'd the old credential immediately and then, after a restart
   * that reloaded the unchanged file, accepted it again.
   *
   * Copying also keeps the returned record honest: adopting the draft means
   * the object handed back is the one that is on disk, not the pre-commit
   * object the caller was already holding.
   *
   * REENTRANCY. `change` runs while this draft is open and the caller is
   * handed it, so a callback that calls back into the registry starts a
   * second commit in the middle of this one. That nested commit persists and
   * adopts its own draft; if this one then persisted its older draft, it would
   * erase the nested write and still report success. The observable damage is
   * not the lost edit but the silence: a revoke issued from inside a
   * transition vanished from the file while the transition reported `true`, so
   * the installation stayed live and the caller believed otherwise.
   *
   * So the state this draft was built from is remembered, and the write is
   * skipped if that state moved underneath us. The nested commit already
   * reached disk, so refusing here loses nothing and keeps the more
   * important of the two — a revocation — instead of letting an in-flight
   * edit roll it back. The caller is told it did not apply. Nothing failed to
   * write, so durability is untouched. */
  private commit(change: (draft: RegistryFile) => void): boolean {
    const base = this.revision;
    const draft: RegistryFile = {
      version: this.file.version,
      installations: this.file.installations.map((row) => ({ ...row, capabilities: [...row.capabilities] })),
    };
    change(draft);
    if (this.revision !== base) return false;
    if (!persist(this.path, draft)) {
      // The change is discarded whole. `this.file` still describes the last
      // durable state, so a caller that retries changes nothing it did not mean to.
      this.durable = false;
      return false;
    }
    this.file = draft;
    this.revision += 1;
    this.durable = true;
    return true;
  }

  /** The committed row, by id. Always read back from `this.file` after a
   * commit: the pre-commit object belongs to the previous generation. */
  private row(id: string): InstallationRecord | null {
    return this.file.installations.find((row) => row.id === id) ?? null;
  }

  /** Register (or re-attach) an installation for an owner. Idempotent per
   * (ownerId, clientKey): every call with the same key returns the SAME
   * stable id. Each registration MINTS a one-time credential — including on
   * re-attach, because the only caller of register is an attach flow that
   * does not hold a usable secret; a lost provisioning response is therefore
   * reconciled by the stable identity (same row, fresh secret) rather than a
   * second row, and "one live secret per installation" stays strictly true.
   * A revoked row stays revoked — re-registering after a revocation is a NEW
   * installation with a NEW id, never a resurrection. */
  register(input: RegisterInput, now = Date.now()): RegisterOutcome | null {
    const clientKey = input.clientKey.trim();
    const existing = this.file.installations.find(
      (row) => row.ownerId === input.ownerId && row.clientKey === clientKey && row.revokedAt === null,
    );
    if (existing) {
      const id = existing.id;
      const credential = randomBytes(32).toString("base64url");
      const committed = this.commit((draft) => {
        const row = draft.installations.find((candidate) => candidate.id === id);
        if (!row) throw new Error("the row vanished from the draft");
        row.lastSeenAt = now;
        if (row.label !== input.label) row.label = input.label;
        row.credentialHash = hashCredential(credential);
        row.credentialExpiresAt = now + CREDENTIAL_TTL_MS;
      });
      if (!committed) return null;
      return { record: this.row(id)!, credential, reactivated: true };
    }
    const record: InstallationRecord = {
      id: randomBytes(12).toString("base64url"),
      ownerId: input.ownerId,
      clientKey,
      label: input.label.trim().slice(0, 128) || "Installation",
      platform: input.platform,
      credentialHash: null,
      credentialExpiresAt: null,
      capabilities: input.capabilities ?? [...INSTALLATION_CAPABILITIES],
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
      generation: null,
    };
    const credential = randomBytes(32).toString("base64url");
    record.credentialHash = hashCredential(credential);
    record.credentialExpiresAt = now + CREDENTIAL_TTL_MS;
    // The table bound and the insert are ONE change: evicting to make room and
    // then failing the write would drop rows on disk for a row that never
    // landed.
    const committed = this.commit((draft) => {
      if (draft.installations.length >= REGISTRY_CAP) evictFrom(draft, now);
      draft.installations.push({ ...record, capabilities: [...record.capabilities] });
    });
    if (!committed) return null;
    return { record: this.row(record.id)!, credential, reactivated: false };
  }

  /** Issue a fresh one-time credential for an existing active row. The
   * previous credential stops working at that moment (single live secret per
   * installation), and the row's identity does not change. */
  rotate(ownerId: string, installationId: string, now = Date.now()): RegisterOutcome | null {
    const record = this.file.installations.find(
      (row) => row.id === installationId && row.ownerId === ownerId && row.revokedAt === null,
    );
    if (!record) return null;
    const credential = randomBytes(32).toString("base64url");
    const committed = this.commit((draft) => {
      const row = draft.installations.find((candidate) => candidate.id === installationId);
      if (!row) throw new Error("the row vanished from the draft");
      row.credentialHash = hashCredential(credential);
      row.credentialExpiresAt = now + CREDENTIAL_TTL_MS;
      row.lastSeenAt = now;
    });
    if (!committed) return null;
    return { record: this.row(installationId)!, credential, reactivated: false };
  }

  /** Owner-scoped revocation: only the owning account can revoke, and the
   * row (with its revocation stamp) is kept so a restart re-reads it and a
   * re-register becomes a NEW installation rather than a resurrection. */
  revoke(ownerId: string, installationId: string, now = Date.now()): boolean {
    const record = this.file.installations.find(
      (row) => row.id === installationId && row.ownerId === ownerId && row.revokedAt === null,
    );
    if (!record) return false;
    // A revocation that cannot be written must not half-happen. In memory it
    // would read as revoked while the file still said active, so a restart
    // quietly un-revoked the installation.
    return this.commit((draft) => {
      const row = draft.installations.find((candidate) => candidate.id === installationId);
      if (!row) throw new Error("the row vanished from the draft");
      row.revokedAt = now;
      row.credentialHash = null;
      row.credentialExpiresAt = null;
    });
  }

  /** Prove a bearer credential. Returns the record only when the digest
   * matches, the credential is unexpired, and the row was never revoked. */
  authenticate(credential: string, now = Date.now()): InstallationRecord | null {
    const digest = hashCredential(credential);
    const record = this.file.installations.find(
      (row) =>
        row.revokedAt === null &&
        row.credentialHash !== null &&
        row.credentialExpiresAt !== null &&
        row.credentialExpiresAt > now &&
        row.credentialHash === digest,
    );
    if (record) record.lastSeenAt = now;
    return record ?? null;
  }

  /** Re-mint the one-time credential for an installation proven by its
   * CURRENT, UNEXPIRED credential — the machine's own renewal path, no
   * session involved (the old credential stops working at mint time, so
   * one live secret per installation stays true). Expiry stays final: an
   * expired credential authenticates nothing and refreshes nothing; a
   * machine that let its credential die re-registers through its owner's
   * session, which re-mints for the same stable client key. Revocation is
   * the only other door out, and it is final. */
  refresh(installationId: string, credential: string, now = Date.now()): RegisterOutcome | null {
    const digest = hashCredential(credential);
    const record = this.file.installations.find(
      (row) =>
        row.id === installationId &&
        row.revokedAt === null &&
        row.credentialHash !== null &&
        row.credentialExpiresAt !== null &&
        row.credentialExpiresAt > now &&
        row.credentialHash === digest,
    );
    if (!record) return null;
    const credential2 = randomBytes(32).toString("base64url");
    // The machine's own renewal path. This is the one that mattered most: a
    // failed write here used to replace the hash in memory and then tell the
    // caller to keep presenting the credential it had just invalidated.
    const committed = this.commit((draft) => {
      const row = draft.installations.find((candidate) => candidate.id === installationId);
      if (!row) throw new Error("the row vanished from the draft");
      row.credentialHash = hashCredential(credential2);
      row.credentialExpiresAt = now + CREDENTIAL_TTL_MS;
      row.lastSeenAt = now;
    });
    if (!committed) return null;
    return { record: this.row(installationId)!, credential: credential2, reactivated: false };
  }

  /** Open a durable transition on a row and take the next generation.
   *
   * The generation is persisted by this call, not by the eventual commit. Two
   * begins therefore cannot both take the same number: the second reads the
   * first's committed value back out of `this.file` and mints the number
   * after it, which is exactly what makes the older holder stale. Reading the
   * value off the draft instead would hand both callers the same generation
   * and let the slower one overwrite the faster one's work.
   *
   * Refuses a missing row and refuses a revoked one. Revocation is final, so
   * a revoked row admits no transition at all — re-registering is a NEW
   * installation with a NEW id, never a resurrection of this one. */
  beginTransition(installationId: string, _now = Date.now()): { generation: number } | null {
    const current = this.row(installationId);
    if (!current || current.revokedAt !== null) return null;
    const next = (current.generation ?? 0) + 1;
    const committed = this.commit((draft) => {
      const row = draft.installations.find((candidate) => candidate.id === installationId);
      if (!row) throw new Error("the row vanished from the draft");
      row.generation = next;
    });
    if (!committed) return null;
    // Read back from the committed file, never from the draft: the draft is
    // the previous generation's object graph.
    const stored = this.row(installationId);
    if (!stored || stored.generation === null) return null;
    return { generation: stored.generation };
  }

  /** Apply an edit ONLY while the caller's generation is the row's newest.
   *
   * A caller that was overtaken — by a later begin, or by a restart that
   * re-read a newer value — is refused, and refusing writes nothing: the edit
   * is not run at all, so it cannot half-apply or leave a trace. The counter
   * is left exactly where it was, because a refusal consumed nothing.
   *
   * This is the only durable boundary a later wiring needs. It deliberately
   * does not mint authority: `change` may edit a row, but a stale caller
   * cannot, and a revoked row cannot be reached here either. */
  commitTransition(installationId: string, generation: number, change: (row: InstallationRecord) => void): boolean {
    const current = this.row(installationId);
    if (!current || current.revokedAt !== null) return false;
    if (current.generation === null || current.generation !== generation) return false;
    const committed = this.commit((draft) => {
      const row = draft.installations.find((candidate) => candidate.id === installationId);
      if (!row) throw new Error("the row vanished from the draft");
      if (row.generation !== generation) throw new Error("the generation moved under this commit");
      change(row);
    });
    return committed;
  }

  /** The owner's own view. Rows of other accounts never leave the file. */
  list(ownerId: string): Array<Pick<InstallationRecord, "id" | "label" | "platform" | "capabilities" | "createdAt" | "lastSeenAt" | "revokedAt">> {
    return this.file.installations
      .filter((row) => row.ownerId === ownerId)
      .map(({ id, label, platform, capabilities, createdAt, lastSeenAt, revokedAt }) => ({
        id, label, platform, capabilities, createdAt, lastSeenAt, revokedAt,
      }));
  }

  /** Bounded table: an anti-abuse memory bound, not a trust decision. Rows
   * that can never authenticate again (revoked, or credential expired with
   * no return) go first, then the least-recently-seen; the bound wins over
   * any individual row. */
}

function evictFrom(file: RegistryFile, now: number): void {
    const neverAgain = (row: InstallationRecord): boolean =>
      row.revokedAt !== null || row.credentialExpiresAt === null || row.credentialExpiresAt <= now;
    const candidates = [...file.installations].sort((a, b) => {
      const aNever = neverAgain(a) ? 0 : 1;
      const bNever = neverAgain(b) ? 0 : 1;
      return aNever - bNever || a.lastSeenAt - b.lastSeenAt;
    });
    for (const row of candidates) {
      if (file.installations.length < REGISTRY_CAP) break;
      file.installations = file.installations.filter((other) => other.id !== row.id);
    }
}
