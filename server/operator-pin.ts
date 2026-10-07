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
//    whose mailbox is proven (emailVerified). Until it exists, nobody is the
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
    // SAFETY: the SELECT projects only the users table's id column
    const row = db
      .prepare(
        `SELECT "id" FROM "user" WHERE lower("email") = ? AND ("emailVerified" = 1 OR "emailVerified" = 'true') ` +
          'ORDER BY "createdAt" ASC LIMIT 1',
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
