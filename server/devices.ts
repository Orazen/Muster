// S0 device inventory — a per-user VIEW over the better-auth session table,
// feeding the Restore Center's "Manage devices" (DESIGN §29): name,
// platform, last seen, key-envelope status. No new table and no migration:
// a session row IS a signed-in device instance — web sign-in, the
// claim-paired phone and `muster pair` all create one — and grouping by
// user-agent collapses one machine's re-sign-ins into a single device.
//
// Honesty notes (mirrored in the loop receipts):
//   * there is no hardware fingerprint: two machines with matching
//     user-agents read as one device until a later phase gives sessions a
//     stable device id;
//   * `keyEnvelopeStatus` is "none" for every row today — the per-device
//     key re-wrap that fills it has no producer yet. The column exists
//     because DESIGN §29 names it, not because something already fills it;
//   * the visibility predicate is structural twice: the SQL is keyed by the
//     caller's own session userId (never query/body input) AND
//     deriveDevices drops foreign rows again. Pinned by devices.test.ts and
//     on the wire by devices-harness.test.ts.
import { createHash } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

export interface SessionRow {
  userId: string;
  userAgent: string | null;
  updatedAt: number;
}

export type DevicePlatform = "ios" | "watchos" | "android" | "macos" | "windows" | "linux" | "cli" | "web";

export interface DeviceView {
  /** Stable per (user, user-agent): the React key and the harness pin. */
  id: string;
  name: string;
  platform: DevicePlatform;
  lastSeenAt: number;
  /** DESIGN §29 names this column; producers arrive with later sync phases. */
  keyEnvelopeStatus: "none";
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

/** Stable per (user, user-agent). The user's id is part of the hash, so two
 * accounts' identical browsers can never collide into one device. */
export function deviceIdFor(userId: string, userAgent: string | null): string {
  return createHash("sha256").update(`${userId}\n${userAgent ?? ""}`).digest("hex").slice(0, 16);
}

/** Turn session rows into the device view: group by user-agent, keep the
 * newest sighting, and DROP any row belonging to another user even if a bug
 * upstream ever handed it over (the second fence after the SQL predicate). */
export function deriveDevices(userId: string, rows: readonly SessionRow[]): DeviceView[] {
  const grouped = new Map<string, number>();
  for (const row of rows) {
    if (row.userId !== userId) continue;
    const key = row.userAgent ?? "";
    const seen = row.updatedAt;
    const previous = grouped.get(key);
    grouped.set(key, previous === undefined ? seen : Math.max(previous, seen));
  }
  return [...grouped.entries()]
    .map(([agent, lastSeenAt]) => {
      const canonical = agent === "" ? null : agent;
      return {
        id: deviceIdFor(userId, canonical),
        name: nameOf(canonical),
        platform: platformOf(canonical),
        lastSeenAt,
        keyEnvelopeStatus: "none" as const,
      };
    })
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

const sessionRowWire = z.object({
  userId: z.string(),
  userAgent: z.string().nullish(),
  updatedAt: sqliteDateWire,
});

/** The route's read path: only this user's session rows ever leave the
 * database, keyed by the session binding the caller already proved. */
export function devicesForUser(db: DatabaseSync, userId: string): DeviceView[] {
  const rows = db
    .prepare(`SELECT "userId", "userAgent", "updatedAt" FROM "session" WHERE "userId" = ?`)
    .all(userId);
  const parsed = rows.map((row) => sessionRowWire.parse(row));
  return deriveDevices(
    userId,
    parsed.map((row) => ({
      userId: row.userId,
      userAgent: row.userAgent ?? null,
      updatedAt: row.updatedAt,
    })),
  );
}
