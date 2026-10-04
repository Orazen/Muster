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

export const VISIBLE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** OIDC identity scope for the visible consent only — never a Drive scope. */
export const VISIBLE_OIDC_SCOPE = "openid";
const STATE_TTL_MS = 10 * 60 * 1000;
const id = z.string().min(1).max(1024);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bindingSchema = z.object({ userId: id, sessionId: id });
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
    codeVerifier TEXT NOT NULL, nonce TEXT NOT NULL, expiresAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS drive_visible_oauth_states_user ON drive_visible_oauth_states(userId);
  CREATE TABLE IF NOT EXISTS drive_visible_grants (
    userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE, googleSub TEXT NOT NULL, accessToken TEXT NOT NULL,
    refreshToken TEXT NOT NULL, expiresAt INTEGER NOT NULL, scopes TEXT NOT NULL, generation INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drive_visible_grant_generations (
    userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE, generation INTEGER NOT NULL
  );`);
}
function hash(value: string): string { return createHash("sha256").update(value).digest("base64url"); }

/**
 * Returns the opaque browser state once; only its digest is persisted. The
 * visible consent supersedes only visible consents — an appData or Calendar
 * flow already in flight elsewhere is left untouched, because each lifecycle
 * owns its own table and epoch.
 */
export function createVisibleConsentState(
  db: DatabaseSync, binding: VisibleConsentBinding, now = Date.now(),
): VisibleConsentState & { state: string; codeChallenge: string } {
  if (!bindingSchema.safeParse(binding).success || !timestamp.safeParse(now + STATE_TTL_MS).success) {
    throw new Error("Invalid visible consent binding");
  }
  initialize(db);
  db.prepare("DELETE FROM drive_visible_oauth_states WHERE expiresAt <= ?").run(now);
  const generation = advanceGeneration(db, binding.userId);
  db.prepare("DELETE FROM drive_visible_oauth_states WHERE userId = ?").run(binding.userId);
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = now + STATE_TTL_MS;
  db.prepare(`INSERT INTO drive_visible_oauth_states
    (stateHash, userId, sessionId, generation, codeVerifier, nonce, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(hash(state), binding.userId, binding.sessionId, generation, codeVerifier, nonce, expiresAt);
  return { ...binding, generation, state, codeVerifier, codeChallenge: hash(codeVerifier), nonce, expiresAt };
}

/** Wrong-account/session attempts do not burn another browser's valid consent. */
export function consumeVisibleConsentState(
  db: DatabaseSync, input: VisibleConsentBinding & { state: string }, now = Date.now(),
): VisibleConsentState | null {
  if (!bindingSchema.safeParse(input).success || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || !timestamp.safeParse(now).success) {
    return null;
  }
  initialize(db);
  const row = db.prepare(`DELETE FROM drive_visible_oauth_states
    WHERE stateHash = ? AND userId = ? AND sessionId = ? AND expiresAt > ?
    RETURNING userId, sessionId, generation, codeVerifier, nonce, expiresAt`)
    .get(hash(input.state), input.userId, input.sessionId, now);
  const parsed = stateRowSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export function getVisibleGrant(db: DatabaseSync, userId: string): VisibleFileGrant | null {
  initialize(db);
  const row = db.prepare(
    "SELECT userId, googleSub, accessToken, refreshToken, expiresAt, scopes, generation FROM drive_visible_grants WHERE userId = ?",
  ).get(userId);
  if (!row) return null;
  const scopes = z.string().safeParse(row.scopes);
  if (!scopes.success) return null;
  try {
    const parsed = grantSchema.safeParse({ ...row, scopes: JSON.parse(scopes.data) });
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** A saved token is usable only while both its consent epoch and exact row remain current. */
export function isVisibleGrantCurrent(db: DatabaseSync, grant: VisibleFileGrant): boolean {
  const saved = getVisibleGrant(db, grant.userId);
  const epoch = db.prepare("SELECT generation FROM drive_visible_grant_generations WHERE userId = ?").get(grant.userId);
  return !!saved && epoch?.generation === grant.generation
    && saved.generation === grant.generation && saved.googleSub === grant.googleSub
    && saved.accessToken === grant.accessToken && saved.refreshToken === grant.refreshToken
    && saved.expiresAt === grant.expiresAt && JSON.stringify(saved.scopes) === JSON.stringify(grant.scopes);
}

/**
 * Provider-verified identity is required. Switching Google accounts requires
 * a revoke first, and an in-flight exchange lands only while its own consent
 * epoch is still the live one — a newer visible consent or a revoke makes the
 * pending save fail closed instead of resurrecting a stale grant.
 */
export function saveVisibleGrant(db: DatabaseSync, input: VisibleFileGrantInput): VisibleFileGrant {
  initialize(db);
  const current = db.prepare("SELECT generation FROM drive_visible_grant_generations WHERE userId = ?").get(input.userId);
  if (!Number.isSafeInteger(input.expectedGeneration) || current?.generation !== input.expectedGeneration) {
    throw new Error("Visible consent was superseded or revoked");
  }
  const prior = getVisibleGrant(db, input.userId);
  // Read the identity even if an existing token row is corrupt; never reuse or replace across subjects.
  const identity = db.prepare("SELECT googleSub FROM drive_visible_grants WHERE userId = ?").get(input.userId);
  if (identity && identity.googleSub !== input.googleSub) throw new Error("Visible file account mismatch");
  const parsed = grantSchema.safeParse({
    ...input, generation: input.expectedGeneration, refreshToken: input.refreshToken ?? prior?.refreshToken,
  });
  if (!parsed.success) throw new Error("Visible grant requires the drive.file scope and no broader scope");
  const grant = parsed.data;
  const saved = db.prepare(`INSERT INTO drive_visible_grants (userId, googleSub, accessToken, refreshToken, expiresAt, scopes, generation)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM drive_visible_grant_generations WHERE userId = ? AND generation = ?
    ) ON CONFLICT(userId) DO UPDATE SET
    googleSub = excluded.googleSub, accessToken = excluded.accessToken,
    refreshToken = excluded.refreshToken, expiresAt = excluded.expiresAt, scopes = excluded.scopes, generation = excluded.generation RETURNING userId`)
    .get(grant.userId, grant.googleSub, grant.accessToken, grant.refreshToken, grant.expiresAt,
      JSON.stringify(grant.scopes), grant.generation, grant.userId, grant.generation);
  if (!saved) throw new Error("Visible consent was superseded or revoked");
  return grant;
}

/**
 * Local removal only: never revokes Google's sign-in, appData or Calendar
 * authorization, and never touches the appData grant tables. Bumping the
 * epoch is what invalidates an exchange that is still in flight.
 */
export function revokeVisibleGrant(db: DatabaseSync, userId: string): void {
  initialize(db);
  advanceGeneration(db, userId);
  db.prepare("DELETE FROM drive_visible_grants WHERE userId = ?").run(userId);
  db.prepare("DELETE FROM drive_visible_oauth_states WHERE userId = ?").run(userId);
}

function advanceGeneration(db: DatabaseSync, userId: string): number {
  const row = db.prepare(`INSERT INTO drive_visible_grant_generations (userId, generation) VALUES (?, 1)
    ON CONFLICT(userId) DO UPDATE SET generation = generation + 1 RETURNING generation`).get(userId);
  return z.object({ generation: z.number().int().positive() }).parse(row).generation;
}
