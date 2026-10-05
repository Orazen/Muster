// Visible-file consent and grants are their own lifecycle: a dedicated
// `drive.file` round trip, its own tables, its own epoch. The account-linked
// appData connect (drive-grants.ts) keeps driving snapshot/sync storage, and
// the sign-in scopes (google-auth.ts) stay basic — this module deliberately
// shares no table, no constant and no predicate with either, so a visible
// grant can never be mistaken for an appData grant or leak into a login.
//
// `drive.file` is NON-SENSITIVE (Google grants access only to files this app
// created), which is exactly the narrow scope a visible folder needs. It is
// never widened here: broad `auth/drive` and the restricted variants are
// rejected outright rather than tolerated, and appData is rejected too so the
// two Drive consents cannot contaminate each other in either direction.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { requireVisibleTokenProtector, type VisibleTokenProtector } from "./drive-visible-token-protection.ts";

export const VISIBLE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** OIDC identity scope for the visible consent only — never a Drive scope. */
export const VISIBLE_OIDC_SCOPE = "openid";
const STATE_TTL_MS = 10 * 60 * 1000;
const id = z.string().min(1).max(1024);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bindingSchema = z.object({ userId: id, sessionId: id });
const ciphertextSchema = z.string().min(1).max(45000);
const stateRowSchema = bindingSchema.extend({
  generation: z.number().int().positive(),
  codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: timestamp,
});

/**
 * The only scopes a visible grant may ever carry: the OIDC identity scope we
 * request alongside `drive.file`, and `drive.file` itself. Anything else —
 * broad `auth/drive`, `drive.readonly`, `drive.metadata`, or the appData
 * scope this module must stay clear of — fails the grant before it persists.
 * The set is closed on purpose: an unknown scope is a rejected scope, so a
 * future scope addition cannot silently widen what a stored grant authorises.
 */
const ALLOWED_SCOPES = new Set<string>([VISIBLE_OIDC_SCOPE, VISIBLE_FILE_SCOPE]);

const grantSchema = z.object({
  generation: z.number().int().positive(),
  userId: id,
  googleSub: id,
  accessToken: z.string().min(1).max(32768),
  refreshToken: z.string().min(1).max(32768),
  expiresAt: timestamp,
  scopes: z.array(z.string().min(1).max(2048)).min(1).max(100)
    .refine(scopes => scopes.includes(VISIBLE_FILE_SCOPE) && scopes.every(scope => ALLOWED_SCOPES.has(scope))),
});
export type VisibleFileGrant = z.infer<typeof grantSchema>;
export type VisibleConsentBinding = z.infer<typeof bindingSchema>;
export type VisibleConsentState = z.infer<typeof stateRowSchema>;
export type VisibleFileGrantInput = Omit<VisibleFileGrant, "refreshToken" | "generation">
  & { refreshToken?: string | null; expectedGeneration: number };

function initialize(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS drive_visible_oauth_states (
    stateHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, sessionId TEXT NOT NULL,
    generation INTEGER NOT NULL,
    codeVerifier TEXT NOT NULL, nonce TEXT NOT NULL, expiresAt INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS drive_visible_oauth_states_user ON drive_visible_oauth_states(userId);
  CREATE TABLE IF NOT EXISTS drive_visible_grants (
    userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE, googleSub TEXT NOT NULL, accessToken TEXT NOT NULL,
    refreshToken TEXT NOT NULL, expiresAt INTEGER NOT NULL, scopes TEXT NOT NULL, generation INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drive_visible_grant_generations (
    userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE, generation INTEGER NOT NULL
  );`);
  // Preserve any existing rows. Old plaintext credentials are not read as a
  // fallback; an explicit reconnect is required when they cannot be opened.
  if (!db.prepare("PRAGMA table_info(drive_visible_oauth_states)").all().some(row => row.name === "consumed")) {
    db.exec("ALTER TABLE drive_visible_oauth_states ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0");
  }
}
function hash(value: string): string { return createHash("sha256").update(value).digest("base64url"); }

function atomic<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("SAVEPOINT drive_visible_write");
  try {
    const result = operation();
    db.exec("RELEASE drive_visible_write");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO drive_visible_write; RELEASE drive_visible_write");
    throw error;
  }
}

/**
 * Returns the opaque browser state once; only its digest is persisted. The
 * visible consent supersedes only visible consents — an appData or Calendar
 * flow already in flight elsewhere is left untouched, because each lifecycle
 * owns its own table and epoch.
 */
export function createVisibleConsentState(
  db: DatabaseSync, binding: VisibleConsentBinding, protector: VisibleTokenProtector, now = Date.now(),
): VisibleConsentState & { state: string; codeChallenge: string } {
  requireVisibleTokenProtector(protector);
  if (!bindingSchema.safeParse(binding).success || !timestamp.safeParse(now + STATE_TTL_MS).success) {
    throw new Error("Invalid visible consent binding");
  }
  initialize(db);
  return atomic(db, () => {
    db.prepare("DELETE FROM drive_visible_oauth_states WHERE expiresAt <= ?").run(now);
    const generation = advanceGeneration(db, binding.userId);
    db.prepare("DELETE FROM drive_visible_oauth_states WHERE userId = ?").run(binding.userId);
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = now + STATE_TTL_MS;
    const sealedVerifier = protector.seal(codeVerifier, {
      kind: "consent", ...binding, generation, expiresAt, nonce, field: "codeVerifier",
    });
    db.prepare(`INSERT INTO drive_visible_oauth_states
      (stateHash, userId, sessionId, generation, codeVerifier, nonce, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(hash(state), binding.userId, binding.sessionId, generation, sealedVerifier, nonce, expiresAt);
    return { ...binding, generation, state, codeVerifier, codeChallenge: hash(codeVerifier), nonce, expiresAt };
  });
}

/** Wrong-account/session attempts do not burn another browser's valid consent. */
export function consumeVisibleConsentState(
  db: DatabaseSync, input: VisibleConsentBinding & { state: string }, protector: VisibleTokenProtector, now = Date.now(),
): VisibleConsentState | null {
  requireVisibleTokenProtector(protector);
  if (!bindingSchema.safeParse(input).success || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || !timestamp.safeParse(now).success) {
    return null;
  }
  initialize(db);
  return atomic(db, () => {
    const row = db.prepare(`SELECT userId, sessionId, generation, codeVerifier, nonce, expiresAt
      FROM drive_visible_oauth_states WHERE stateHash = ? AND userId = ? AND sessionId = ? AND expiresAt > ? AND consumed = 0`)
      .get(hash(input.state), input.userId, input.sessionId, now);
    const metadata = stateRowSchema.extend({ codeVerifier: ciphertextSchema }).safeParse(row);
    if (!metadata.success) return null;
    const codeVerifier = protector.open(metadata.data.codeVerifier, {
      kind: "consent", ...metadata.data, field: "codeVerifier",
    });
    const parsed = stateRowSchema.safeParse({ ...metadata.data, codeVerifier });
    if (!parsed.success) return null;
    const updated = db.prepare(`UPDATE drive_visible_oauth_states SET consumed = 1
      WHERE stateHash = ? AND userId = ? AND sessionId = ? AND generation = ? AND consumed = 0`)
      .run(hash(input.state), input.userId, input.sessionId, parsed.data.generation);
    return updated.changes === 1 ? parsed.data : null;
  });
}

/** Cancel this browser's attempt even after exchange has begun. The consumed
 * row is a one-time tombstone, not reusable OAuth state. Cancel and expiry
 * leave the previous usable grant intact; a newer attempt is never cancelled. */
export function cancelVisibleConsentState(
  db: DatabaseSync, input: VisibleConsentBinding & { state: string }, now = Date.now(),
): boolean {
  if (!bindingSchema.safeParse(input).success || !/^[A-Za-z0-9_-]{43}$/.test(input.state)
    || !timestamp.safeParse(now).success) return false;
  initialize(db);
  return atomic(db, () => {
    const row = db.prepare(`DELETE FROM drive_visible_oauth_states
      WHERE stateHash = ? AND userId = ? AND sessionId = ? AND expiresAt > ? RETURNING generation`)
      .get(hash(input.state), input.userId, input.sessionId, now);
    if (!row) return false;
    db.prepare(`UPDATE drive_visible_grant_generations SET generation = generation + 1
      WHERE userId = ? AND generation = ?`).run(input.userId, row.generation);
    return true;
  });
}

export function getVisibleGrant(db: DatabaseSync, userId: string, protector: VisibleTokenProtector): VisibleFileGrant | null {
  requireVisibleTokenProtector(protector);
  initialize(db);
  const row = db.prepare(
    "SELECT userId, googleSub, accessToken, refreshToken, expiresAt, scopes, generation FROM drive_visible_grants WHERE userId = ?",
  ).get(userId);
  if (!row) return null;
  const scopes = z.string().safeParse(row.scopes);
  if (!scopes.success) return null;
  try {
    const metadata = grantSchema.extend({ accessToken: ciphertextSchema, refreshToken: ciphertextSchema })
      .safeParse({ ...row, scopes: JSON.parse(scopes.data) });
    if (!metadata.success) return null;
    const grant = metadata.data;
    const accessToken = protector.open(grant.accessToken, { kind: "grant", ...grant, field: "accessToken" });
    const refreshToken = protector.open(grant.refreshToken, { kind: "grant", ...grant, field: "refreshToken" });
    const parsed = grantSchema.safeParse({ ...grant, accessToken, refreshToken });
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** A pending replacement does not revoke the prior grant. Only replacement,
 * rotation or explicit revoke changes the exact saved credential custody. */
export function isVisibleGrantCurrent(db: DatabaseSync, grant: VisibleFileGrant, protector: VisibleTokenProtector): boolean {
  const saved = getVisibleGrant(db, grant.userId, protector);
  return !!saved && saved.generation === grant.generation && saved.googleSub === grant.googleSub
    && saved.accessToken === grant.accessToken && saved.refreshToken === grant.refreshToken
    && saved.expiresAt === grant.expiresAt && JSON.stringify(saved.scopes) === JSON.stringify(grant.scopes);
}

/**
 * Provider-verified identity is required. Switching Google accounts requires
 * a revoke first, and an in-flight exchange lands only while its own consent
 * epoch is still the live one — a newer visible consent or a revoke makes the
 * pending save fail closed instead of resurrecting a stale grant.
 */
export function saveVisibleGrant(
  db: DatabaseSync, input: VisibleFileGrantInput, protector: VisibleTokenProtector, now = Date.now(),
): VisibleFileGrant {
  requireVisibleTokenProtector(protector);
  initialize(db);
  return atomic(db, () => {
    const current = db.prepare("SELECT generation FROM drive_visible_grant_generations WHERE userId = ?").get(input.userId);
    const pending = db.prepare(`SELECT generation FROM drive_visible_oauth_states
      WHERE userId = ? AND generation = ? AND consumed = 1 AND expiresAt > ?`)
      .get(input.userId, input.expectedGeneration, now);
    if (!timestamp.safeParse(now).success || !Number.isSafeInteger(input.expectedGeneration)
      || current?.generation !== input.expectedGeneration || !pending) {
      throw new Error("Visible consent was superseded or revoked");
    }
    const prior = getVisibleGrant(db, input.userId, protector);
    // Read the identity even if an existing token row is corrupt; never reuse or replace across subjects.
    const identity = db.prepare("SELECT googleSub FROM drive_visible_grants WHERE userId = ?").get(input.userId);
    if (identity && identity.googleSub !== input.googleSub) throw new Error("Visible file account mismatch");
    const parsed = grantSchema.safeParse({
      ...input, generation: input.expectedGeneration, refreshToken: input.refreshToken ?? prior?.refreshToken,
    });
    if (!parsed.success) throw new Error("Visible grant requires the drive.file scope and no broader scope");
    const grant = parsed.data;
    const accessToken = protector.seal(grant.accessToken, { kind: "grant", ...grant, field: "accessToken" });
    const refreshToken = protector.seal(grant.refreshToken, { kind: "grant", ...grant, field: "refreshToken" });
    const saved = db.prepare(`INSERT INTO drive_visible_grants (userId, googleSub, accessToken, refreshToken, expiresAt, scopes, generation)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM drive_visible_grant_generations WHERE userId = ? AND generation = ?
      ) ON CONFLICT(userId) DO UPDATE SET
      googleSub = excluded.googleSub, accessToken = excluded.accessToken,
      refreshToken = excluded.refreshToken, expiresAt = excluded.expiresAt, scopes = excluded.scopes, generation = excluded.generation RETURNING userId`)
      .get(grant.userId, grant.googleSub, accessToken, refreshToken, grant.expiresAt,
        JSON.stringify(grant.scopes), grant.generation, grant.userId, grant.generation);
    if (!saved) throw new Error("Visible consent was superseded or revoked");
    db.prepare("DELETE FROM drive_visible_oauth_states WHERE userId = ? AND generation = ?")
      .run(grant.userId, input.expectedGeneration);
    return grant;
  });
}

/** Refresh has separate custody from consent attempts. A refresh started
 * before replacement/revocation cannot overwrite the newer winning grant. */
export function refreshVisibleGrant(
  db: DatabaseSync, held: VisibleFileGrant,
  replacement: Omit<VisibleFileGrant, "userId" | "generation" | "refreshToken"> & { refreshToken?: string | null },
  protector: VisibleTokenProtector,
): VisibleFileGrant {
  requireVisibleTokenProtector(protector);
  initialize(db);
  return atomic(db, () => {
    if (!isVisibleGrantCurrent(db, held, protector)) throw new Error("Visible grant changed during refresh");
    const parsed = grantSchema.safeParse({
      ...replacement, userId: held.userId, generation: held.generation,
      refreshToken: replacement.refreshToken ?? held.refreshToken,
    });
    if (!parsed.success || parsed.data.googleSub !== held.googleSub) throw new Error("Invalid visible grant refresh");
    const next = parsed.data;
    const stored = db.prepare("SELECT accessToken, refreshToken FROM drive_visible_grants WHERE userId = ?").get(held.userId)!;
    const result = db.prepare(`UPDATE drive_visible_grants SET accessToken = ?, refreshToken = ?, expiresAt = ?, scopes = ?
      WHERE userId = ? AND googleSub = ? AND generation = ? AND accessToken = ? AND refreshToken = ?`)
      .run(protector.seal(next.accessToken, { kind: "grant", ...next, field: "accessToken" }),
        protector.seal(next.refreshToken, { kind: "grant", ...next, field: "refreshToken" }),
        next.expiresAt, JSON.stringify(next.scopes), held.userId, held.googleSub, held.generation,
        stored.accessToken, stored.refreshToken);
    if (result.changes !== 1) throw new Error("Visible grant changed during refresh");
    return next;
  });
}

/**
 * Local removal only: never revokes Google's sign-in, appData or Calendar
 * authorization, and never touches the appData grant tables. Bumping the
 * epoch is what invalidates an exchange that is still in flight.
 */
export function revokeVisibleGrant(db: DatabaseSync, userId: string): void {
  initialize(db);
  atomic(db, () => {
    advanceGeneration(db, userId);
    db.prepare("DELETE FROM drive_visible_grants WHERE userId = ?").run(userId);
    db.prepare("DELETE FROM drive_visible_oauth_states WHERE userId = ?").run(userId);
  });
}

function advanceGeneration(db: DatabaseSync, userId: string): number {
  const row = db.prepare(`INSERT INTO drive_visible_grant_generations (userId, generation) VALUES (?, 1)
    ON CONFLICT(userId) DO UPDATE SET generation = generation + 1 RETURNING generation`).get(userId);
  return z.object({ generation: z.number().int().positive() }).parse(row).generation;
}
