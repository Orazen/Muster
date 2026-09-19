import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getCalendarGrant, isCalendarGrantCurrent } from "./calendar-grants.ts";

export const CALENDAR_DEVICE_GRANT_TTL_MS = 24 * 60 * 60_000;
export const MAX_CALENDAR_DEVICE_GRANTS = 10;
const userSchema = z.string().min(1).max(1024);
const timeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const inputSchema = z.object({ userId: userSchema, calendarId: z.string().min(1).max(1024).refine(value => value.trim().length > 0 && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)), label: z.string().trim().min(1).max(80) }).strict();
const rowSchema = z.object({ id: z.string().uuid(), userId: userSchema, calendarId: z.string().min(1).max(1024), label: z.string().min(1).max(80),
  generation: z.number().int().positive(), googleSub: z.string().min(1).max(1024), expiresAt: timeSchema });
export interface CalendarDeviceGrantView { id: string; label: string; calendarId: string; expiresAt: number }
export interface CalendarDeviceGrantIdentity extends CalendarDeviceGrantView { userId: string; generation: number; googleSub: string }
export interface IssuedCalendarDeviceGrant { token: string; grant: CalendarDeviceGrantView }
export class CalendarDeviceGrantError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function initialize(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_device_grants (
    id TEXT PRIMARY KEY, tokenHash TEXT NOT NULL UNIQUE,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    calendarId TEXT NOT NULL, label TEXT NOT NULL,
    generation INTEGER NOT NULL, googleSub TEXT NOT NULL, expiresAt INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS calendar_device_grants_user ON calendar_device_grants(userId)`);
}
function hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function validateUser(userId: string): void {
  if (!userSchema.safeParse(userId).success) throw new CalendarDeviceGrantError(400, "A Calendar account is required.");
}
function active(db: DatabaseSync, row: CalendarDeviceGrantIdentity, now: number): boolean {
  if (row.expiresAt <= now) return false;
  const calendar = getCalendarGrant(db, row.userId);
  return !!calendar && calendar.generation === row.generation && calendar.googleSub === row.googleSub && isCalendarGrantCurrent(db, calendar);
}
function view(row: CalendarDeviceGrantIdentity): CalendarDeviceGrantView {
  return { id: row.id, label: row.label, calendarId: row.calendarId, expiresAt: row.expiresAt };
}

/** Explicit enrollment permission only, never an account session. The caller
 * must verify the selected Calendar with fresh account-authorized evidence.
 * A fixed 24-hour lifetime and ten active grants limit this foundation slice.
 * The raw capability is returned once and never persisted or listed.
 */
export function issueCalendarDeviceGrant(db: DatabaseSync, input: { userId: string; calendarId: string; label: string }, now = Date.now()): IssuedCalendarDeviceGrant {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || !timeSchema.safeParse(now).success || !timeSchema.safeParse(now + CALENDAR_DEVICE_GRANT_TTL_MS).success) {
    throw new CalendarDeviceGrantError(400, "Invalid Calendar device permission.");
  }
  const data = parsed.data;
  initialize(db);
  const calendar = getCalendarGrant(db, data.userId);
  if (!calendar || !isCalendarGrantCurrent(db, calendar)) throw new CalendarDeviceGrantError(409, "Connect your Calendar before authorizing a device.");
  const rows = db.prepare("SELECT id, userId, calendarId, label, generation, googleSub, expiresAt FROM calendar_device_grants WHERE userId = ?").all(data.userId);
  let count = 0;
  for (const value of rows) {
    const row = rowSchema.safeParse(value);
    if (row.success && active(db, row.data, now)) count++;
    else db.prepare("DELETE FROM calendar_device_grants WHERE userId = ? AND id = ?").run(data.userId, value.id);
  }
  if (count >= MAX_CALENDAR_DEVICE_GRANTS) throw new CalendarDeviceGrantError(429, "Revoke a device permission before adding another.");
  const token = randomBytes(32).toString("hex");
  const row: CalendarDeviceGrantIdentity = { ...data, id: randomUUID(), generation: calendar.generation, googleSub: calendar.googleSub, expiresAt: now + CALENDAR_DEVICE_GRANT_TTL_MS };
  db.prepare("INSERT INTO calendar_device_grants (id, tokenHash, userId, calendarId, label, generation, googleSub, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, hash(token), row.userId, row.calendarId, row.label, row.generation, row.googleSub, row.expiresAt);
  return { token, grant: view(row) };
}

export function listCalendarDeviceGrants(db: DatabaseSync, userId: string, now = Date.now()): CalendarDeviceGrantView[] {
  validateUser(userId);
  if (!timeSchema.safeParse(now).success) throw new CalendarDeviceGrantError(400, "Invalid Calendar device permission time.");
  initialize(db);
  const result: CalendarDeviceGrantView[] = [];
  for (const value of db.prepare("SELECT id, userId, calendarId, label, generation, googleSub, expiresAt FROM calendar_device_grants WHERE userId = ? ORDER BY expiresAt, id").all(userId)) {
    const row = rowSchema.safeParse(value);
    if (row.success && active(db, row.data, now)) result.push(view(row.data));
  }
  return result;
}

export function revokeCalendarDeviceGrant(db: DatabaseSync, userId: string, id: string): boolean {
  validateUser(userId);
  if (!z.string().uuid().safeParse(id).success) return false;
  initialize(db);
  return db.prepare("DELETE FROM calendar_device_grants WHERE userId = ? AND id = ?").run(userId, id).changes === 1;
}

/** Resolving grants only the selected calendar permission. Call/device
 * authorization must still be checked by the narrowly scoped consuming route.
 */
export function resolveCalendarDeviceGrant(db: DatabaseSync, token: string, now = Date.now()): CalendarDeviceGrantIdentity | null {
  if (!z.string().regex(/^[a-f0-9]{64}$/).safeParse(token).success || !timeSchema.safeParse(now).success) return null;
  initialize(db);
  const row = rowSchema.safeParse(db.prepare("SELECT id, userId, calendarId, label, generation, googleSub, expiresAt FROM calendar_device_grants WHERE tokenHash = ?").get(hash(token)));
  return row.success && active(db, row.data, now) ? row.data : null;
}
