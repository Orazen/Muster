// Calendar consent is independent of Google login and Drive recovery grants.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
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
const grantSchema = z.object({
  generation: z.number().int().positive(),
  userId: id,
  googleSub: id,
  accessToken: z.string().min(1).max(32768),
  refreshToken: z.string().min(1).max(32768),
  expiresAt: timestamp,
  scopes: z.array(z.string().min(1).max(2048)).min(1).max(100)
    .refine(scopes => scopes.includes(CALENDAR_READONLY_SCOPE)),
});
export type CalendarGrant = z.infer<typeof grantSchema>;
export type CalendarStateBinding = z.infer<typeof bindingSchema>;
export type CalendarPendingState = z.infer<typeof stateRowSchema>;
export type CalendarGrantInput = Omit<CalendarGrant, "refreshToken" | "generation"> & { refreshToken?: string | null; expectedGeneration: number };

function initialize(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_oauth_states (
    stateHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, sessionId TEXT NOT NULL,
    generation INTEGER NOT NULL,
    codeVerifier TEXT NOT NULL, nonce TEXT NOT NULL, expiresAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS calendar_oauth_states_user ON calendar_oauth_states(userId);
  CREATE TABLE IF NOT EXISTS calendar_grants (
    userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE, googleSub TEXT NOT NULL, accessToken TEXT NOT NULL,
    refreshToken TEXT NOT NULL, expiresAt INTEGER NOT NULL, scopes TEXT NOT NULL, generation INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS calendar_grant_generations (
    userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE, generation INTEGER NOT NULL
  );`);
}
function hash(value: string): string { return createHash("sha256").update(value).digest("base64url"); }

/** Returns the opaque browser state once; only its digest is persisted. */
export function createCalendarState(db: DatabaseSync, binding: CalendarStateBinding, now = Date.now()): CalendarPendingState & { state: string; codeChallenge: string } {
  if (!bindingSchema.safeParse(binding).success || !timestamp.safeParse(now + STATE_TTL_MS).success) {
    throw new Error("Invalid Calendar consent binding");
  }
  initialize(db);
  db.prepare("DELETE FROM calendar_oauth_states WHERE expiresAt <= ?").run(now);
  const generation = advanceGeneration(db, binding.userId);
  db.prepare("DELETE FROM calendar_oauth_states WHERE userId = ?").run(binding.userId);
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = now + STATE_TTL_MS;
  db.prepare(`INSERT INTO calendar_oauth_states
    (stateHash, userId, sessionId, generation, codeVerifier, nonce, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(hash(state), binding.userId, binding.sessionId, generation, codeVerifier, nonce, expiresAt);
  return { ...binding, generation, state, codeVerifier, codeChallenge: hash(codeVerifier), nonce, expiresAt };
}

/** Wrong-account/session attempts do not burn another browser's valid consent. */
export function consumeCalendarState(db: DatabaseSync, input: CalendarStateBinding & { state: string }, now = Date.now()): CalendarPendingState | null {
  if (!bindingSchema.safeParse(input).success || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || !timestamp.safeParse(now).success) return null;
  initialize(db);
  const row = db.prepare(`DELETE FROM calendar_oauth_states
    WHERE stateHash = ? AND userId = ? AND sessionId = ? AND expiresAt > ?
    RETURNING userId, sessionId, generation, codeVerifier, nonce, expiresAt`)
    .get(hash(input.state), input.userId, input.sessionId, now);
  const parsed = stateRowSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export function getCalendarGrant(db: DatabaseSync, userId: string): CalendarGrant | null {
  initialize(db);
  const row = db.prepare("SELECT userId, googleSub, accessToken, refreshToken, expiresAt, scopes, generation FROM calendar_grants WHERE userId = ?").get(userId);
  if (!row) return null;
  const scopes = z.string().safeParse(row.scopes);
  if (!scopes.success) return null;
  try {
    const parsed = grantSchema.safeParse({ ...row, scopes: JSON.parse(scopes.data) });
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** A saved token is usable only while both its consent epoch and exact row remain current. */
export function isCalendarGrantCurrent(db: DatabaseSync, grant: CalendarGrant): boolean {
  const saved = getCalendarGrant(db, grant.userId);
  const epoch = db.prepare("SELECT generation FROM calendar_grant_generations WHERE userId = ?").get(grant.userId);
  return !!saved && epoch?.generation === grant.generation
    && saved.generation === grant.generation && saved.googleSub === grant.googleSub
    && saved.accessToken === grant.accessToken && saved.refreshToken === grant.refreshToken
    && saved.expiresAt === grant.expiresAt && JSON.stringify(saved.scopes) === JSON.stringify(grant.scopes);
}

/** Provider-verified identity is required. Switching Google accounts requires disconnect first. */
export function saveCalendarGrant(db: DatabaseSync, input: CalendarGrantInput): CalendarGrant {
  initialize(db);
  const current = db.prepare("SELECT generation FROM calendar_grant_generations WHERE userId = ?").get(input.userId);
  if (!Number.isSafeInteger(input.expectedGeneration) || current?.generation !== input.expectedGeneration) {
    throw new Error("Calendar consent was superseded or disconnected");
  }
  const prior = getCalendarGrant(db, input.userId);
  // Read the identity even if an existing token row is corrupt; never reuse or replace across subjects.
  const identity = db.prepare("SELECT googleSub FROM calendar_grants WHERE userId = ?").get(input.userId);
  if (identity && identity.googleSub !== input.googleSub) throw new Error("Calendar account mismatch");
  const parsed = grantSchema.safeParse({ ...input, generation: input.expectedGeneration, refreshToken: input.refreshToken ?? prior?.refreshToken });
  if (!parsed.success) throw new Error("Calendar grant requires readonly scope and valid offline tokens");
  const grant = parsed.data;
  const saved = db.prepare(`INSERT INTO calendar_grants (userId, googleSub, accessToken, refreshToken, expiresAt, scopes, generation)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM calendar_grant_generations WHERE userId = ? AND generation = ?
    ) ON CONFLICT(userId) DO UPDATE SET
    googleSub = excluded.googleSub, accessToken = excluded.accessToken,
    refreshToken = excluded.refreshToken, expiresAt = excluded.expiresAt, scopes = excluded.scopes, generation = excluded.generation RETURNING userId`)
    .get(grant.userId, grant.googleSub, grant.accessToken, grant.refreshToken, grant.expiresAt, JSON.stringify(grant.scopes), grant.generation, grant.userId, grant.generation);
  if (!saved) throw new Error("Calendar consent was superseded or disconnected");
  return grant;
}

/** Local removal only: never revokes Google's shared login/Drive authorization. */
export function disconnectCalendar(db: DatabaseSync, userId: string): void {
  initialize(db);
  advanceGeneration(db, userId);
  db.prepare("DELETE FROM calendar_grants WHERE userId = ?").run(userId);
  db.prepare("DELETE FROM calendar_oauth_states WHERE userId = ?").run(userId);
}

function advanceGeneration(db: DatabaseSync, userId: string): number {
  const row = db.prepare(`INSERT INTO calendar_grant_generations (userId, generation) VALUES (?, 1)
    ON CONFLICT(userId) DO UPDATE SET generation = generation + 1 RETURNING generation`).get(userId);
  return z.object({ generation: z.number().int().positive() }).parse(row).generation;
}
