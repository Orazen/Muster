// Who operates a self-hosted deployment.
//
// Historically the operator ("primary user") is simply the oldest row in the
// user table. On a fresh self-hosted deploy with open sign-ups, whoever
// registers first therefore gets engines, MCP servers, config and the host
// computer. MUSTER_OPERATOR_EMAIL lets the person deploying pin the operator
// to their own address instead.
//
// Scope, deliberately narrow so nothing else moves:
//  - Desktop (loopback) installs: unchanged; the pin is ignored.
//  - Muster Cloud (MUSTER_CLOUD=true): unchanged; the pin is ignored.
//  - Self-hosted with no pin: unchanged (oldest account), plus a loud warning.
//  - Self-hosted with a pin: the operator is the account with that email
//    whose current mailbox has recorded proof. Until it exists, nobody is the
//    operator — an attacker who pre-registers the address without proving the
//    mailbox does not get the role, and neither does an earlier account.
import type { DatabaseSync } from "node:sqlite";

export type OperatorPinMode =
  | { kind: "legacy" } // oldest account, no warning (desktop / cloud)
  | { kind: "unpinned" } // oldest account, warn loudly (self-hosted)
  | { kind: "pinned"; email: string };

export function operatorPinMode(env: NodeJS.ProcessEnv, selfHosted: boolean): OperatorPinMode {
  if (!selfHosted || env.MUSTER_CLOUD === "true") return { kind: "legacy" };
  const email = env.MUSTER_OPERATOR_EMAIL?.trim().toLowerCase();
  if (email) return { kind: "pinned", email };
  return { kind: "unpinned" };
}

export const UNPINNED_OPERATOR_WARNING =
  "[auth] WARNING: self-hosted deployment without MUSTER_OPERATOR_EMAIL — the OLDEST account is the " +
  "operator, with control of engines, MCP servers, config and this host's computer. If sign-ups are " +
  "open, whoever registers first takes that role. Set MUSTER_OPERATOR_EMAIL to your verified email " +
  "(or OMB_SIGNUPS_CLOSED=true) to pin it.";

export function pinnedOperatorMissingWarning(email: string): string {
  return (
    `[auth] MUSTER_OPERATOR_EMAIL is set but no account with a verified ${email} exists yet — ` +
    "this deployment has no operator until that account signs up and proves its mailbox " +
    "(Google sign-in or the email code)."
  );
}

/** The operator's user id under `mode`, or null when there is none. */
export function resolveOperatorId(db: DatabaseSync, mode: OperatorPinMode): string | null {
  if (mode.kind === "pinned") {
    // Verification alone is insufficient: historical pairing accounts were
    // stamped verified without mailbox proof. Require the bound proof row.
    // SAFETY: the SELECT projects only the users table's id column
    const row = db
      .prepare(
        `SELECT u."id" FROM "user" u JOIN "operator_mailbox_proof" p ON p."userId" = u."id" ` +
          `WHERE lower(u."email") = ? AND lower(p."email") = lower(u."email") ` +
          `AND (u."emailVerified" = 1 OR u."emailVerified" = 'true') ORDER BY u."createdAt" ASC LIMIT 1`,
      )
      .get(mode.email) as { id: string } | undefined;
    return row?.id ?? null;
  }
  // SAFETY: the SELECT projects only the users table's id column
  const row = db.prepare('SELECT id FROM "user" ORDER BY "createdAt" ASC LIMIT 1').get() as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

export type MailboxProofSource = "local-email" | "local-google" | "paired";

/** Preserve accounts and sessions, but quarantine old bridge verification
 * stamps that did not establish mailbox custody. No status-only backfill. */
export function migrateOperatorMailboxProof(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS "operator_mailbox_proof" (
    "userId" text primary key references "user" ("id") on delete cascade,
    "email" text not null,
    "source" text not null CHECK ("source" IN ('local-email', 'local-google', 'paired'))
  );
  CREATE TABLE IF NOT EXISTS "operator_mailbox_quarantine" (
    "userId" text primary key references "user" ("id") on delete cascade
  )`);
  db.exec(`SAVEPOINT operator_mailbox_migration;
    INSERT OR IGNORE INTO "operator_mailbox_quarantine" ("userId")
      SELECT u."id" FROM "user" u WHERE substr(u."id", 1, 4) = 'usr_'
        AND NOT EXISTS (SELECT 1 FROM "operator_mailbox_proof" p WHERE p."userId" = u."id");
    UPDATE "user" SET "emailVerified" = 0
      WHERE "id" IN (SELECT "userId" FROM "operator_mailbox_quarantine")
        AND ("emailVerified" = 1 OR "emailVerified" = 'true');
    RELEASE operator_mailbox_migration`);
}

/** Called only after a real local proof or a validated configured pairing
 * response. Binding to the current verified mailbox prevents email changes
 * from inheriting a proof for the old address. */
export function recordOperatorMailboxProof(db: DatabaseSync, userId: string, source: MailboxProofSource): void {
  db.exec("SAVEPOINT operator_mailbox_record");
  try {
    const quarantined = db.prepare('SELECT "userId" FROM "operator_mailbox_quarantine" WHERE "userId" = ?').get(userId);
    if (quarantined) {
      // The library's real email-primary cleanup must have removed unproven
      // sessions and account links before this proof confers operator power.
      if (source !== "local-email" || db.prepare('SELECT count(*) AS n FROM "session" WHERE "userId" = ?').get(userId)?.n !== 0 ||
          db.prepare('SELECT count(*) AS n FROM "account" WHERE "userId" = ?').get(userId)?.n !== 0) {
        db.exec("RELEASE operator_mailbox_record");
        return;
      }
    }
    const written = db.prepare(`INSERT INTO "operator_mailbox_proof" ("userId", "email", "source")
      SELECT "id", lower("email"), ? FROM "user" WHERE "id" = ? AND ("emailVerified" = 1 OR "emailVerified" = 'true')
      ON CONFLICT("userId") DO UPDATE SET "email" = excluded."email", "source" = excluded."source"`).run(source, userId);
    if (written.changes > 0 && quarantined) db.prepare('DELETE FROM "operator_mailbox_quarantine" WHERE "userId" = ?').run(userId);
    db.exec("RELEASE operator_mailbox_record");
  } catch (error) {
    db.exec("ROLLBACK TO operator_mailbox_record; RELEASE operator_mailbox_record");
    throw error;
  }
}
