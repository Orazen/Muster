// The account's device inventory — the Restore Center's "Manage devices"
// (DESIGN §29): name, platform, last seen, key-envelope status, and (now) a
// revoke that actually ends the device's access. Two kinds of row live here
// side by side, and the wire says which is which:
//
//   identity: "install"         a device the server REGISTERED against a
//                               client-presented install id. A real identity:
//                               server-issued, stable across re-sign-ins and
//                               restarts, and revocable one device at a time.
//   identity: "userAgentGroup"  the S0 fallback for a session that has never
//                               presented an install id. Its id is a grouping
//                               key, NOT a device: two machines running the
//                               same browser still collapse into one row, and
//                               the row says so instead of pretending.
//
// A session row is still the raw material — web sign-in, the claim-paired
// phone and `muster pair` all create one, and nothing better-auth owns is
// rewritten here. What is new is the registry beside it: two additive tables
// (account_device, account_device_session) created idempotently on read, the
// same no-migration shape auth.ts itself uses.
//
// Identity rules, and they are the load-bearing part:
//   * an install id is a bare uuid the CLIENT mints and keeps (a browser's
//     localStorage, the CLI, the Electron app — which presents the very
//     `syncInstallId()` it already persists at 0600). The server mints a
//     device id and never derives one from anything it was handed, so there
//     is nothing here for a hardware fingerprint to leak through;
//   * `installIdWire` accepts a uuid and NOTHING ELSE, so a client that tries
//     to "register" a MAC address, a canvas hash or a user-agent string is
//     refused at the boundary instead of being hashed into a stable
//     identifier. The no-fingerprinting rule (sync-events.ts:21-24) is a
//     validator here, not just a comment;
//   * ACCOUNT and DEVICE identity stay strictly separate. The owner is a
//     column, never an input to the id: the device id is a random uuid, the
//     (userId, installId) pair is unique, and one install signing into two
//     accounts yields two unrelated devices. `devicesForUser` is always
//     keyed by the caller's own userId and deriveDevices drops foreign rows
//     again — the same double fence S0 had, pinned by devices.test.ts and on
//     the wire by devices-harness.test.ts (which presents no install id, so
//     it still exercises the fallback path and its cross-tenant pin is
//     unchanged).
//
// Still honestly not here:
//   * `keyEnvelopeStatus` is "none" for every row — the per-device key
//     re-wrap that fills it has no producer yet. The column exists because
//     DESIGN §29 names it, not because something already fills it;
//   * revoking a `userAgentGroup` row is deliberately not offered: its id
//     stands for "every session with this user-agent", and killing that
//     while calling it "this laptop" is the mistake this file exists to stop.
import { createHash, randomUUID } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

export interface SessionRow {
  userId: string;
  userAgent: string | null;
  updatedAt: number;
  /** Present when the row came from the session table. deriveDevices needs
   * it to tell a session already bound to a registered device from one that
   * has never registered; a caller that does not carry ids gets the pure
   * grouping behaviour. */
  id?: string;
}

export type DevicePlatform = "ios" | "watchos" | "android" | "macos" | "windows" | "linux" | "cli" | "web";

/** How a row's identity was established. The distinction is the point: an
 * `install` row is a device, a `userAgentGroup` row is a bucket. */
export type DeviceIdentity = "install" | "userAgentGroup";

export interface DeviceView {
  /** The React key and the harness pin. For `install` rows this is the
   * server-issued uuid; for `userAgentGroup` rows it stays the S0 grouping
   * key, which is why the two must never be confused for one another. */
  id: string;
  name: string;
  platform: DevicePlatform;
  lastSeenAt: number;
  /** DESIGN §29 names this column; producers arrive with later sync phases. */
  keyEnvelopeStatus: "none";
  identity: DeviceIdentity;
  /** The install id, on `install` rows only. Not a secret — the client that
   * registered it already holds it — and the one thing a UI needs to answer
   * "am I this device?", which is what keeps a revoke button from signing
   * the reader out of their own session. */
  installId?: string;
}

/** The I/O boundary for the session table's `date` columns — node:sqlite
 * hands back number | bigint | ISO string | null, and anything unreadable
 * reads as 0 (it sorts last rather than inventing a sighting). The schema
 * parses ONCE at the boundary; everything downstream takes a plain
 * epoch-ms number, so no representation checks leak past this line. */
export const sqliteDateWire = z
  .union([
    z.number().refine(Number.isFinite),
    z.bigint().transform((value) => Number(value)),
    z.string()
      .transform((value) => Date.parse(value))
      .transform((value) => (Number.isFinite(value) ? value : 0)),
  ])
  .catch(0);

export function platformOf(userAgent: string | null): DevicePlatform {
  if (!userAgent) return "web";
  // watchOS agents also contain "iPhone", and a CLI agent may name an OS —
  // both specific identities are checked before the generic ones.
  if (/watchOS/u.test(userAgent)) return "watchos";
  if (/muster-cli/u.test(userAgent)) return "cli";
  if (/iPhone|iPad|iPod/u.test(userAgent)) return "ios";
  if (/Android/u.test(userAgent)) return "android";
  if (/Windows NT/u.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/u.test(userAgent)) return "macos";
  if (/Linux|X11/u.test(userAgent)) return "linux";
  return "web";
}

function browserOf(userAgent: string): "Edge" | "Chrome" | "Firefox" | "Safari" | null {
  if (/Edg\//u.test(userAgent)) return "Edge";
  if (/Firefox|FxiOS/u.test(userAgent)) return "Firefox";
  if (/Chrome|CriOS/u.test(userAgent)) return "Chrome";
  if (/Version\/\d/u.test(userAgent) && /Safari/u.test(userAgent)) return "Safari";
  return null;
}

/** The display name: how a human would say the device out loud. */
export function nameOf(userAgent: string | null): string {
  if (!userAgent) return "Unknown client";
  const platform = platformOf(userAgent);
  if (platform === "cli") return "Muster CLI";
  if (platform === "watchos") return "Apple Watch";
  const browser = browserOf(userAgent);
  if (platform === "web") return browser ? `${browser} on the web` : "Web client";
  const os =
    platform === "ios"
      ? /iPad/u.test(userAgent)
        ? "iPad"
        : "iPhone"
      : platform === "android"
        ? "Android"
        : platform === "macos"
          ? "macOS"
          : platform === "windows"
            ? "Windows"
            : "Linux";
  return browser ? `${browser} on ${os}` : os;
}

/** The FALLBACK grouping key: stable per (user, user-agent). The user's id
 * is part of the hash, so two accounts' identical browsers can never collide
 * into one device.
 *
 * It is a bucket label, not an identity, and the view now says so on the wire
 * (`identity: "userAgentGroup"`). Nothing in this module revokes by it: the
 * bucket means "every session with this user-agent", and two laptops running
 * the same browser are indistinguishable inside it. */
export function deviceIdFor(userId: string, userAgent: string | null): string {
  return createHash("sha256").update(`${userId}\n${userAgent ?? ""}`).digest("hex").slice(0, 16);
}

/** A registered device as the pure view needs it: who it is, what it is
 * called, and which of the caller's sessions it currently owns. `userId` is
 * carried so the owner fence below is a real comparison and not a promise. */
export interface RegisteredDeviceGroup {
  userId: string;
  id: string;
  installId: string;
  name: string;
  userAgent: string | null;
  lastSeenAt: number;
  sessionIds: readonly string[];
}

/** Turn session rows into the device view: registered devices first (one row
 * each, newest sighting across the sessions they own), then whatever
 * never-registered sessions are left over grouped by user-agent.
 *
 * Two rules earn their keep here:
 *   * a session already bound to a registered device is SKIPPED by the
 *     user-agent grouping, so one machine never appears twice — once as the
 *     device it is and once as a bucket that happens to contain it;
 *   * foreign rows are dropped (the second fence after the SQL predicate),
 *     and a `registered` group is dropped unless it belongs to this user,
 *     even if a bug upstream hands one over.
 */
export function deriveDevices(
  userId: string,
  rows: readonly SessionRow[],
  registered: readonly RegisteredDeviceGroup[] = [],
): DeviceView[] {
  const owned = new Map<string, RegisteredDeviceGroup>();
  for (const group of registered) {
    if (group.userId !== userId) continue;
    if (owned.has(group.id)) continue;
    owned.set(group.id, group);
  }
  const bound = new Set<string>();
  for (const group of owned.values()) {
    for (const sessionId of group.sessionIds) bound.add(sessionId);
  }

  const views: DeviceView[] = [...owned.values()].map((group) => ({
    id: group.id,
    name: group.name,
    platform: platformOf(group.userAgent),
    lastSeenAt: group.lastSeenAt,
    keyEnvelopeStatus: "none" as const,
    identity: "install" as const,
    installId: group.installId,
  }));

  const grouped = new Map<string, number>();
  for (const row of rows) {
    if (row.userId !== userId) continue;
    if (row.id !== undefined && bound.has(row.id)) continue;
    const key = row.userAgent ?? "";
    const seen = row.updatedAt;
    const previous = grouped.get(key);
    grouped.set(key, previous === undefined ? seen : Math.max(previous, seen));
  }
  for (const [agent, lastSeenAt] of grouped) {
    const canonical = agent === "" ? null : agent;
    views.push({
      id: deviceIdFor(userId, canonical),
      name: nameOf(canonical),
      platform: platformOf(canonical),
      lastSeenAt,
      keyEnvelopeStatus: "none" as const,
      identity: "userAgentGroup" as const,
    });
  }
  return views.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

// --- the device registry (plan R12 / P5) ------------------------------------

/** An install id is a BARE UUID and nothing else.
 *
 * This is the no-fingerprinting rule as code rather than as a promise: the
 * values a hardware fingerprint would be made of — a MAC address, a canvas
 * or audio hash, a base64 blob of collected signals, a user-agent string — all
 * fail this pattern, so a client cannot smuggle one in and have the server
 * hand back a stable identifier derived from it. It has to present a random
 * id it minted itself and kept. */
const installIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const installIdWire = z
  .string()
  .max(64)
  .refine((value) => installIdPattern.test(value), "a device install id is a bare uuid");

/** Read the install id a request presents. An id we cannot read is treated as
 * ABSENT — never as something to hash into a fallback — so a malformed or
 * over-eager client lands in the user-agent bucket instead of minting an
 * identity out of whatever it sent.
 *
 * The clients that have an install id already keep one: the Electron app and
 * the CLI both hold `syncInstallId()` (server/sync-events.ts), a random uuid
 * persisted at 0600 beside the data and stable across restarts, and they
 * should present exactly that rather than mint a second identity. A browser
 * mints one into localStorage on first load. Reusing `syncInstallId()` rather
 * than re-exporting it here keeps this module free of a config import — the
 * route reads the header and passes the value down. */
export function readInstallId(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return null;
  const parsed = installIdWire.safeParse(raw.trim());
  return parsed.success ? parsed.data : null;
}

/** How many devices one account may register. A fleet of phones is already an
 * odd story; the bound is here because registration is a write any signed-in
 * session can make, and an unbounded one is a table-growth lever. */
export const MAX_ACCOUNT_DEVICES = 50;

export class DeviceRegistrationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DeviceRegistrationError";
    this.status = status;
  }
}

const userIdWire = z.string().min(1).max(1024);
const sessionIdWire = z.string().min(1).max(256);
const userAgentWire = z.string().max(1024).nullable();
const clockWire = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** What registering an install gets back. `id` is the server-issued device id
 * the wire and a revoke target use; it is never derived from the install id,
 * the user id, the user-agent or anything else the caller supplied. */
export interface DeviceRegistration {
  id: string;
  installId: string;
  name: string;
  platform: DevicePlatform;
  lastSeenAt: number;
}

export interface RevokedDevice {
  deviceId: string;
  sessionsRevoked: number;
  /** True when the revoke killed the very session the caller is holding, so a
   * route can say "you are signed out here" instead of pretending the reader
   * is still looking at a live page. */
  revokedCurrentSession: boolean;
}

const initialized = new WeakSet<DatabaseSync>();

/** Additive, idempotent, no migration step — the same shape auth.ts itself
 * uses. The owner is a column with a real cascade, so deleting an account
 * takes its devices and their session bindings with it. */
function initialize(db: DatabaseSync): void {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS account_device (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "installId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" INTEGER NOT NULL,
    "lastSeenAt" INTEGER NOT NULL,
    UNIQUE ("userId", "installId")
  ); CREATE TABLE IF NOT EXISTS account_device_session (
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL REFERENCES "account_device" ("id") ON DELETE CASCADE,
    PRIMARY KEY ("userId", "sessionId")
  ); CREATE INDEX IF NOT EXISTS "account_device_user_idx" ON "account_device" ("userId");
  CREATE INDEX IF NOT EXISTS "account_device_session_device_idx" ON "account_device_session" ("userId", "deviceId")`);
  initialized.add(db);
}

const registeredRowWire = z.object({
  userId: z.string(),
  id: z.string(),
  installId: z.string(),
  name: z.string(),
  userAgent: z.string().nullish(),
  registeredAt: sqliteDateWire,
  updatedAt: sqliteDateWire,
});

/** One (device, session) pair out of the join, and the count the cap reads. */
const registeredSessionRowWire = registeredRowWire.extend({ sessionId: z.string() });
const countWire = z.object({ n: z.number().int().nonnegative() });

const registrationRowWire = z.object({
  id: z.string(),
  installId: z.string(),
  name: z.string(),
  userAgent: z.string().nullish(),
  createdAt: sqliteDateWire,
  lastSeenAt: sqliteDateWire,
});

/** Bind the caller's own session to a stable device for an install id.
 *
 * Idempotent by (userId, installId): the first call mints the device id and
 * every later one keeps it, which is the whole point — re-sign-ins, a server
 * restart and a browser reload all resolve to the same device. `name` and
 * `userAgent` are descriptive and follow the client, but only when the client
 * actually reported one: an absent user-agent on some request must not
 * downgrade "Chrome on macOS" to "Unknown client".
 *
 * The session binding is what makes revocation real. A session that starts
 * presenting a DIFFERENT install id (cleared storage, a fresh install) moves
 * to the new device and leaves its old bindings behind, so the device it left
 * keeps the sessions it still owns instead of being erased by a guess.
 */
export function registerDevice(
  db: DatabaseSync,
  userId: string,
  installId: string,
  sessionId: string | null,
  userAgent: string | null,
  now: number = Date.now(),
): DeviceRegistration {
  const owner = userIdWire.parse(userId);
  const install = installIdWire.parse(installId);
  const session = sessionId === null ? null : sessionIdWire.parse(sessionId);
  const agent = userAgentWire.parse(userAgent);
  const stamp = clockWire.parse(now);
  initialize(db);

  const existing = db
    .prepare(`SELECT "id" FROM "account_device" WHERE "userId" = ? AND "installId" = ?`)
    .get(owner, install);
  if (existing === undefined) {
    const count = db.prepare(`SELECT COUNT(*) AS "n" FROM "account_device" WHERE "userId" = ?`).get(owner);
    const registered = countWire.parse(count).n;
    if (registered >= MAX_ACCOUNT_DEVICES) {
      throw new DeviceRegistrationError(
        409,
        `This account already has ${MAX_ACCOUNT_DEVICES} devices. Revoke one before adding another.`,
      );
    }
  }

  const row = db
    .prepare(
      `INSERT INTO "account_device" ("id", "userId", "installId", "name", "userAgent", "createdAt", "lastSeenAt")
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT ("userId", "installId") DO UPDATE SET
         "lastSeenAt" = excluded."lastSeenAt",
         "userAgent" = COALESCE(excluded."userAgent", "account_device"."userAgent"),
         "name" = CASE WHEN excluded."userAgent" IS NULL THEN "account_device"."name" ELSE excluded."name" END
       RETURNING "id", "installId", "name", "userAgent", "createdAt", "lastSeenAt"`,
    )
    .get(randomUUID(), owner, install, nameOf(agent), agent, stamp, stamp);
  const parsed = registrationRowWire.parse(row);

  if (session !== null) {
    db.prepare(
      `INSERT INTO "account_device_session" ("userId", "sessionId", "deviceId") VALUES (?, ?, ?)
       ON CONFLICT ("userId", "sessionId") DO UPDATE SET "deviceId" = excluded."deviceId"`,
    ).run(owner, session, parsed.id);
  }
  return {
    id: parsed.id,
    installId: parsed.installId,
    name: parsed.name,
    platform: platformOf(parsed.userAgent ?? null),
    lastSeenAt: parsed.lastSeenAt,
  };
}

/** Every device this account has registered that still owns a live session.
 *
 * A registration whose sessions have all expired drops out of the list — the
 * inventory answers "who is signed in", and better-auth expires sessions on
 * its own. The row itself stays, so a later sign-in on the same install gets
 * the same device id back instead of a new one.
 *
 * `lastSeenAt` is the newer of the two proofs we have that the device is
 * there: the registration's own stamp (refreshed every time that install
 * presents its id) and the session rows it owns. Either alone is an
 * under-report — a client that only re-presents on sign-in leaves stale
 * session dates, and better-auth touches `updatedAt` on activity that never
 * carried the header.
 *
 * Owner-scoped in SQL on all three tables, and grouped in JS rather than with
 * SQL MAX() because the session table's date column can be a number, a bigint
 * or an ISO string and the boundary above already normalises those.
 */
export function registeredDevicesForUser(db: DatabaseSync, userId: string): RegisteredDeviceGroup[] {
  const owner = userIdWire.parse(userId);
  initialize(db);
  const rows = db
    .prepare(
      `SELECT d."userId" AS "userId", d."id" AS "id", d."installId" AS "installId", d."name" AS "name",
              d."userAgent" AS "userAgent", d."lastSeenAt" AS "registeredAt", s."id" AS "sessionId",
              s."updatedAt" AS "updatedAt"
       FROM "account_device" d
       JOIN "account_device_session" b ON b."deviceId" = d."id" AND b."userId" = d."userId"
       JOIN "session" s ON s."id" = b."sessionId" AND s."userId" = d."userId"
       WHERE d."userId" = ?`,
    )
    .all(owner);
  const byDevice = new Map<string, RegisteredDeviceGroup & { sessionIds: string[] }>();
  for (const raw of rows) {
    const parsed = registeredSessionRowWire.parse(raw);
    const existing = byDevice.get(parsed.id);
    if (existing === undefined) {
      byDevice.set(parsed.id, {
        userId: parsed.userId,
        id: parsed.id,
        installId: parsed.installId,
        name: parsed.name,
        userAgent: parsed.userAgent ?? null,
        lastSeenAt: Math.max(parsed.registeredAt, parsed.updatedAt),
        sessionIds: [parsed.sessionId],
      });
      continue;
    }
    existing.sessionIds.push(parsed.sessionId);
    existing.lastSeenAt = Math.max(existing.lastSeenAt, parsed.updatedAt);
  }
  return [...byDevice.values()];
}

/** Take a device's access away, for real.
 *
 * "For real" is the whole clause: the device's sessions are DELETED, not
 * flagged, so the next request from that install carries a token the session
 * table no longer has. A revoke that only hid a row would leave the stolen
 * cookie working, which is the failure this closes.
 *
 * Owner-scoped in the predicate (`userId` on the device row, on the binding
 * and on the session delete) so a guessed device id from another account is
 * simply not there — the same answer as a made-up id, which is the only
 * answer that leaks nothing. A device id that IS in a `userAgentGroup` row is
 * not a device, so it matches nothing here rather than silently killing every
 * session its bucket happens to contain.
 *
 * Deletes run sessions → bindings → device, and every intermediate state is
 * fail-safe: an interruption leaves at worst an orphaned binding that matches
 * no session, never a live session with no record of who owned it. That is
 * why there is no transaction wrapper here.
 */
export function revokeDevice(
  db: DatabaseSync,
  userId: string,
  deviceId: string,
  currentSessionId: string | null = null,
): RevokedDevice | null {
  const owner = userIdWire.parse(userId);
  const target = sessionIdWire.parse(deviceId);
  const current = currentSessionId === null ? null : sessionIdWire.parse(currentSessionId);
  initialize(db);

  const device = db
    .prepare(`SELECT "id" FROM "account_device" WHERE "userId" = ? AND "id" = ?`)
    .get(owner, target);
  if (device === undefined) return null;

  const bound = db
    .prepare(`SELECT "sessionId" FROM "account_device_session" WHERE "userId" = ? AND "deviceId" = ?`)
    .all(owner, target)
    .map((row) => z.object({ sessionId: z.string() }).parse(row).sessionId);

  let sessionsRevoked = 0;
  for (const sessionId of bound) {
    sessionsRevoked += Number(
      db.prepare(`DELETE FROM "session" WHERE "userId" = ? AND "id" = ?`).run(owner, sessionId).changes,
    );
  }
  db.prepare(`DELETE FROM "account_device_session" WHERE "userId" = ? AND "deviceId" = ?`).run(owner, target);
  db.prepare(`DELETE FROM "account_device" WHERE "userId" = ? AND "id" = ?`).run(owner, target);

  return {
    deviceId: target,
    sessionsRevoked,
    revokedCurrentSession: current !== null && bound.includes(current),
  };
}

const sessionRowWire = z.object({
  id: z.string(),
  userId: z.string(),
  userAgent: z.string().nullish(),
  updatedAt: sqliteDateWire,
});

/** The route's read path: only this user's session rows ever leave the
 * database, keyed by the session binding the caller already proved. */
export function devicesForUser(db: DatabaseSync, userId: string): DeviceView[] {
  initialize(db);
  const rows = db
    .prepare(`SELECT "id", "userId", "userAgent", "updatedAt" FROM "session" WHERE "userId" = ?`)
    .all(userId);
  const parsed = rows.map((row) => sessionRowWire.parse(row));
  return deriveDevices(
    userId,
    parsed.map((row) => ({
      id: row.id,
      userId: row.userId,
      userAgent: row.userAgent ?? null,
      updatedAt: row.updatedAt,
    })),
    registeredDevicesForUser(db, userId),
  );
}
