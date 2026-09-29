// Server-owned identity for one follow-up request: which real account is
// asking, which workspace it maps to, and which task it may act on.
//
// There is no canonical workspaceId adapter in this codebase yet. This
// module does not invent one and does not accept one from the client. It
// deliberately maps the account's own organization — the one its own
// better-auth session already carries as activeOrganizationId, validated
// against a CURRENT `member` row before use — and fails closed when that
// mapping cannot be established. A client-supplied id, an email match and a
// directory path are all rejected as authority, here and in the route.
//
// Task binding is deliberately not index.ts's `ownsPlan`. That helper answers
// true when the plan's bot is absent, so a plan whose bot was deleted reads as
// owned. This module requires all four independently:
//   an existing bot, that bot authorized under the established legacy policy,
//   the plan's own owner matching under that same policy, and the exact
//   original thread still being a live task of that bot.
// A deleted bot, a foreign bot, a mismatched plan owner, a missing thread and
// a thread that is no longer a task all read as "no such task" — unavailable,
// never authorized.

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import type { FollowUpAuthority, FollowUpTaskReference } from "./follow-up-proposals.ts";

/** Plan statuses that still describe live work. Terminal and resting states
 * are named here rather than inferred from a bot being busy or idle. */
const ACTIVE_PLAN_STATUSES = new Set([
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "paused",
]);
const COMPLETED_PLAN_STATUSES = new Set(["succeeded"]);
const CANCELLED_PLAN_STATUSES = new Set(["cancelled"]);

const MAX_IDENTIFIER = 200;
const identifier = z.string().min(1).max(MAX_IDENTIFIER);

const sessionOrganizationSchema = z.object({ activeOrganizationId: z.string().min(1).max(MAX_IDENTIFIER) });
const membershipRowSchema = z.object({ organizationId: z.string().min(1).max(MAX_IDENTIFIER) });
const membershipListSchema = z.array(membershipRowSchema);

/** The subset of a task plan this module reads. Keeping it narrow means a
 * caller cannot hand in a plan object it assembled itself. */
export interface FollowUpPlanView {
  readonly id: string;
  readonly botId: string;
  readonly ownerId?: string;
  readonly threadId?: string;
  readonly status: string;
}

export interface FollowUpBotView {
  readonly id: string;
  readonly ownerId?: string;
}

/** Lookups the host supplies. Every one of them is the real store/engine, not
 * a value from the request. */
export interface FollowUpTaskLookups {
  plan(id: string): FollowUpPlanView | null;
  bot(id: string): FollowUpBotView | null;
  taskByThread(botId: string, threadId: string): { readonly threadId: string } | null;
}

export interface FollowUpAccount {
  readonly userId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  /** The deployment's first account. Unowned records are operator-only under
   * the same rule index.ts applies to bots, groups and plans. */
  readonly isPrimary: boolean;
}

/** The legacy ownership rule, verbatim in intent: your own record, or an
 * unowned one if you are the operator. It is never "true because nobody
 * asked". */
export function ownsUnderLegacyPolicy(
  record: { readonly ownerId?: string },
  account: { readonly userId: string; readonly isPrimary: boolean },
): boolean {
  if (record.ownerId === account.userId) return true;
  return record.ownerId === undefined && account.isPrimary;
}

function readSessionOrganization(db: DatabaseSync, account: { userId: string; sessionId: string }): string | null {
  try {
    // SAFETY: the SELECT projects only the session's activeOrganizationId
    // column, and the WHERE names the caller's own session row.
    const record = db.prepare('SELECT "activeOrganizationId" FROM "session" WHERE "id" = ? AND "userId" = ?')
      .get(account.sessionId, account.userId);
    const parsed = sessionOrganizationSchema.safeParse(record);
    return parsed.success ? parsed.data.activeOrganizationId : null;
  } catch {
    return null;
  }
}

function readMemberships(db: DatabaseSync, userId: string): readonly string[] {
  try {
    // SAFETY: the SELECT projects only member rows' organizationId column.
    const records = db.prepare('SELECT "organizationId" FROM "member" WHERE "userId" = ? ORDER BY "createdAt" ASC, "id" ASC')
      .all(userId);
    return membershipListSchema.parse(records).map(membership => membership.organizationId);
  } catch {
    return [];
  }
}

/** The account's own workspace, resolved on the server from the account's own
 * session and its own current memberships. A session that names no
 * organization falls back to the account's earliest membership — the same
 * personal organization the session hook itself provisions. An account with
 * no membership row at all has no workspace to scope to, and saying so is the
 * answer.
 */
export function resolveFollowUpAccount(
  db: DatabaseSync,
  session: { readonly userId: string; readonly sessionId: string },
  isPrimary: boolean,
): FollowUpAccount | null {
  const account = identifier.safeParse(session.userId);
  const sessionId = identifier.safeParse(session.sessionId);
  if (!account.success || !sessionId.success) return null;
  const memberships = readMemberships(db, account.data);
  if (memberships.length === 0) return null;
  const active = readSessionOrganization(db, { userId: account.data, sessionId: sessionId.data });
  const workspaceId = active !== null && memberships.includes(active) ? active : memberships[0];
  if (workspaceId === undefined) return null;
  return { userId: account.data, sessionId: sessionId.data, workspaceId, isPrimary };
}

export function followUpAuthority(account: FollowUpAccount): FollowUpAuthority {
  return { ownerId: account.userId, workspaceId: account.workspaceId };
}

function planStatus(status: string): FollowUpTaskReference['status'] | null {
  if (ACTIVE_PLAN_STATUSES.has(status)) return "active";
  if (COMPLETED_PLAN_STATUSES.has(status)) return "completed";
  if (CANCELLED_PLAN_STATUSES.has(status)) return "cancelled";
  // An unknown or future status is refused rather than guessed into "active".
  return null;
}

/** The task this card may be built on, or null when the caller cannot name
 * one it owns. The origin is the plan's ORIGINAL bot and thread, read from the
 * plan itself — never a thread the client supplied and never the bot's current
 * thread, which a task switch can move underneath it.
 */
export function resolveFollowUpTask(
  account: FollowUpAccount,
  planId: string,
  lookups: FollowUpTaskLookups,
): FollowUpTaskReference | null {
  const id = identifier.safeParse(planId);
  if (!id.success) return null;
  // A pruned, deleted or unknown plan is unavailable, not authorized.
  const plan = lookups.plan(id.data);
  if (plan === null) return null;
  const bot = lookups.bot(plan.botId);
  // An absent bot is NOT ownership. index.ts's ownsPlan treats this as owned;
  // here it is the absence of the subject.
  if (bot === null) return null;
  if (!ownsUnderLegacyPolicy(bot, account)) return null;
  // The plan's own owner must satisfy the same policy. A legacy plan with no
  // recorded owner inherits its bot's, which the line above already cleared.
  if (!ownsUnderLegacyPolicy({ ownerId: plan.ownerId ?? bot.ownerId }, account)) return null;
  const threadId = plan.threadId;
  if (threadId === undefined || threadId.length === 0) return null;
  // The original thread must still be a live task of that bot.
  const task = lookups.taskByThread(bot.id, threadId);
  if (task === null || task.threadId !== threadId) return null;
  const status = planStatus(plan.status);
  if (status === null) return null;
  return {
    taskId: plan.id,
    ownerId: account.userId,
    workspaceId: account.workspaceId,
    origin: { botId: bot.id, threadId },
    status,
  };
}
