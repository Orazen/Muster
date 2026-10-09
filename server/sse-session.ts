import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/** Trusted server-resolved identifiers only; never retain the bearer token. */
export interface SessionReference {
  userId: string;
  sessionId: string;
}

const identifier = z.string().refine(value => value.trim().length > 0);
const referenceSchema = z.object({ userId: identifier, sessionId: identifier });
const expiryRowSchema = z.object({ expiresAt: z.union([
  z.string().transform(value => new Date(value).getTime()),
  z.number(),
]) });

/** Re-read persisted validity immediately before each hosted stream write.
 * SQLite's auth adapter stores dates as strings; legacy numeric timestamps
 * are milliseconds. A legitimate refresh must be observed, not cached. */
export function isPersistedSessionCurrent(
  db: DatabaseSync,
  reference: SessionReference | null | undefined,
  now = Date.now(),
): boolean {
  const binding = referenceSchema.safeParse(reference);
  if (!binding.success || !Number.isFinite(now)) return false;
  try {
    const row = db.prepare(`SELECT s.expiresAt FROM "session" s
      JOIN "user" u ON u.id = s.userId WHERE s.id = ? AND s.userId = ? LIMIT 1`)
      .get(binding.data.sessionId, binding.data.userId);
    const expiry = expiryRowSchema.safeParse(row);
    return expiry.success && Number.isFinite(expiry.data.expiresAt) && expiry.data.expiresAt > now;
  } catch {
    return false;
  }
}
