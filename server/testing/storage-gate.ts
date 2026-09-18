// Fixture helper for the storage-sovereignty gate (decision 14,
// docs/plans/cloud-relay-strategy-2026-09-18.md): harness users that predate
// the gate behave like EXISTING hosted users — their workspace is open
// because their own Drive row is connected. Tests that exercise the gate
// itself live in server/storage-gate-harness.test.ts.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Insert the google-account row the gate reads, carrying a refresh token —
 * the shape a real Drive consent leaves behind. */
export function seedConnectedGoogleRow(dataDirectory: string, userId: string): void {
  const db = new DatabaseSync(join(dataDirectory, "auth.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO account (id,accountId,providerId,userId,accessToken,refreshToken,scope,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randomBytes(16).toString("hex"), randomBytes(16).toString("hex"), "google", userId,
        randomBytes(12).toString("hex"), randomBytes(24).toString("hex"), "", now, now);
  } finally { db.close(); }
}
