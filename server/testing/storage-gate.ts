// Fixture helper for the storage-sovereignty gate (decision 14,
// docs/plans/cloud-relay-strategy-2026-09-18.md): harness users that predate
// the gate behave like EXISTING hosted users — their workspace is open
// because their own Drive row is connected. Tests that exercise the gate
// itself live in server/storage-gate-harness.test.ts.
import { createDriveState, saveDriveGrant, DRIVE_APPDATA_SCOPE } from "../drive-grants.ts";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Seed an existing signed-in user plus their separately verified Drive grant.
 * This is fixture state, not a substitute for real consent acceptance. */
export function seedConnectedGoogleRow(dataDirectory: string, userId: string): void {
  const db = new DatabaseSync(join(dataDirectory, "auth.db"));
  try {
    const now = new Date().toISOString();
    const googleSub = randomBytes(16).toString("hex");
    db.prepare(`INSERT INTO account (id,accountId,providerId,userId,accessToken,refreshToken,scope,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randomBytes(16).toString("hex"), googleSub, "google", userId,
        randomBytes(12).toString("hex"), randomBytes(24).toString("hex"), "", now, now);
    const pending = createDriveState(db, { userId, sessionId: "owned-existing-consent" });
    saveDriveGrant(db, { userId, googleSub, expectedGeneration: pending.generation,
      accessToken: randomBytes(24).toString("hex"), refreshToken: randomBytes(24).toString("hex"),
      expiresAt: Date.now() + 3600000, scopes: [DRIVE_APPDATA_SCOPE] });
  } finally { db.close(); }
}
