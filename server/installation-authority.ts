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

  private save(): void {
    this.durable = persist(this.path, this.file);
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
  register(input: RegisterInput, now = Date.now()): RegisterOutcome {
    const clientKey = input.clientKey.trim();
    const existing = this.file.installations.find(
      (row) => row.ownerId === input.ownerId && row.clientKey === clientKey && row.revokedAt === null,
    );
    if (existing) {
      existing.lastSeenAt = now;
      if (existing.label !== input.label) existing.label = input.label;
      const credential = randomBytes(32).toString("base64url");
      existing.credentialHash = hashCredential(credential);
      existing.credentialExpiresAt = now + CREDENTIAL_TTL_MS;
      this.save();
      return { record: existing, credential, reactivated: true };
    }
    if (this.file.installations.length >= REGISTRY_CAP) this.evict(now);
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
    };
    this.file.installations.push(record);
    const credential = randomBytes(32).toString("base64url");
    record.credentialHash = hashCredential(credential);
    record.credentialExpiresAt = now + CREDENTIAL_TTL_MS;
    this.save();
    return { record, credential, reactivated: false };
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
    record.credentialHash = hashCredential(credential);
    record.credentialExpiresAt = now + CREDENTIAL_TTL_MS;
    record.lastSeenAt = now;
    this.save();
    return { record, credential, reactivated: false };
  }

  /** Owner-scoped revocation: only the owning account can revoke, and the
   * row (with its revocation stamp) is kept so a restart re-reads it and a
   * re-register becomes a NEW installation rather than a resurrection. */
  revoke(ownerId: string, installationId: string, now = Date.now()): boolean {
    const record = this.file.installations.find(
      (row) => row.id === installationId && row.ownerId === ownerId && row.revokedAt === null,
    );
    if (!record) return false;
    record.revokedAt = now;
    record.credentialHash = null;
    record.credentialExpiresAt = null;
    this.save();
    return true;
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
    record.credentialHash = hashCredential(credential2);
    record.credentialExpiresAt = now + CREDENTIAL_TTL_MS;
    record.lastSeenAt = now;
    this.save();
    return { record, credential: credential2, reactivated: false };
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
  private evict(now: number): void {
    const neverAgain = (row: InstallationRecord): boolean =>
      row.revokedAt !== null || row.credentialExpiresAt === null || row.credentialExpiresAt <= now;
    const candidates = [...this.file.installations].sort((a, b) => {
      const aNever = neverAgain(a) ? 0 : 1;
      const bNever = neverAgain(b) ? 0 : 1;
      return aNever - bNever || a.lastSeenAt - b.lastSeenAt;
    });
    for (const row of candidates) {
      if (this.file.installations.length < REGISTRY_CAP) break;
      this.file.installations = this.file.installations.filter((other) => other.id !== row.id);
    }
  }
}
