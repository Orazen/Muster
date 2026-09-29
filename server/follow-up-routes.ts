// Authenticated follow-up proposal routes: read, propose, dismiss, snooze and
// withdraw, scoped to one real account.
//
// Route family (first match wins; false = the family does not claim the
// request):
//   GET  /api/follow-ups/status            capability only, no session needed
//   GET  /api/follow-ups                   the caller's own cards (bounded)
//   GET  /api/follow-ups/:id               one card
//   POST /api/follow-ups                   propose one card (bounded, explicit)
//   POST /api/follow-ups/:id/dismiss
//   POST /api/follow-ups/:id/snooze
//   POST /api/follow-ups/:id/withdraw     withdraw the source behind a card
//
// Authorization, unchanged from the Calendar family this sits beside: a real
// account session is required even on loopback, a desktop install gets no
// implicit trust here, mutations require an explicit same-origin request, and
// the session is RE-RESOLVED after every await and compared by account AND
// session id. A card belonging to another account is answered exactly as a
// card that never existed, and the account's workspace is derived from its own
// session and its own current membership — never from the request.
//
// Two deliberate absences, so this slice cannot pretend to be more than it is:
//
// - No accept route. Accepting a card reserves an intent identity for a later
//   admission path; nothing here admits, dispatches or contacts a provider.
// - No browser-supplied source. The observation a proposal is built from is
//   read by a server-side source reader, never taken from the request body.
//   With no reader configured on this host, proposing answers 503 rather than
//   inventing evidence.
//
// Reads never write and never poll a source; expiry is derived on read.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  dismissFollowUp,
  followUpEffectiveStatus,
  listNotifyableFollowUps,
  proposeFollowUp,
  readFollowUp,
  snoozeFollowUp,
  withdrawFollowUps,
  type FollowUpControlOutcome,
  type FollowUpDenialReason,
  type FollowUpExecutionCapability,
  type FollowUpNotificationPolicy,
  type FollowUpObservation,
  type FollowUpProposal,
  type FollowUpProposalExplanation,
  type FollowUpTaskReference,
} from "./follow-up-proposals.ts";
import {
  followUpAuthority,
  resolveFollowUpAccount,
  resolveFollowUpTask,
  type FollowUpAccount,
  type FollowUpTaskLookups,
} from "./follow-up-identity.ts";
import { createFollowUpStore } from "./follow-up-store.ts";
import { json, readBody } from "./http-helpers.ts";

export const FOLLOW_UP_ROUTE_PREFIX = "/api/follow-ups";
const CONTROL_PATTERN = /^\/api\/follow-ups\/([^/]+)\/(dismiss|snooze|withdraw)$/;
const MAX_IDENTIFIER = 200;
const MAX_LISTED = 50;
const MIN_SNOOZE_MS = 60_000;
const MAX_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
/** How long a card stays actionable after the day it was read. Server-chosen:
 * the client never states its own freshness window. */
const FRESH_FOR_MS = 4 * 60 * 60 * 1000;
/** Bounded explicit mutations per account, on the same fixed-window shape
 * index.ts uses for its other capped endpoints. */
const WRITE_WINDOW_MS = 60_000;
const WRITE_MAX_PER_WINDOW = 30;

const proposalIdSchema = z.string().min(1).max(MAX_IDENTIFIER)
  .refine(value => /^fup_[A-Za-z0-9_-]{8,}$/.test(value), "unknown proposal");
const revisionSchema = z.number().int().positive();
const snoozeSchema = z.object({
  expectedRevision: revisionSchema,
  snoozeForMs: z.number().int().min(MIN_SNOOZE_MS).max(MAX_SNOOZE_MS),
}).strict();
const controlSchema = z.object({ expectedRevision: revisionSchema }).strict();
const proposeSchema = z.object({
  planId: z.string().min(1).max(MAX_IDENTIFIER),
  calendarId: z.string().min(1).max(1024),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.string().min(1).max(100),
  evidenceEventIds: z.array(z.string().min(1).max(MAX_IDENTIFIER)).min(1).max(4),
}).strict();
const readBodyErrorSchema = z.object({ status: z.number().int() });

export interface FollowUpSession {
  readonly userId: string;
  readonly sessionId: string;
}

/** One selected day, read under the caller's own authority. The route names
 * the day; the reader names everything that makes it evidence. */
export interface FollowUpSourceRequest {
  readonly account: FollowUpAccount;
  readonly task: FollowUpTaskReference;
  readonly day: { readonly calendarId: string; readonly date: string; readonly timeZone: string };
  readonly evidenceEventIds: readonly string[];
  readonly now: number;
}

export interface FollowUpSourceDraft {
  readonly observation: FollowUpObservation;
  readonly explanation: FollowUpProposalExplanation;
  readonly capability: FollowUpExecutionCapability;
}

export interface FollowUpRouteContext {
  db(): DatabaseSync;
  /** Re-resolved live on every check; never a value carried in from a header
   * the route decided to trust. */
  session(): Promise<FollowUpSession | null>;
  origin: string;
  now?(): number;
  /** The deployment's first account, for the unowned-records-are-operator
   * rule. Null when there is none. */
  operator?(): string | null;
  lookups: FollowUpTaskLookups;
  /** Absent until a guarded Calendar read exists; proposing is then
   * unavailable rather than fabricated. */
  readSource?(request: FollowUpSourceRequest): Promise<FollowUpSourceDraft | null>;
}

const windowCounts = new Map<string, { count: number; windowStart: number }>();

function consumeWriteBudget(account: string, now: number): boolean {
  const window = windowCounts.get(account);
  if (!window || window.windowStart + WRITE_WINDOW_MS <= now) {
    windowCounts.set(account, { count: 1, windowStart: now });
    return true;
  }
  window.count++;
  return window.count <= WRITE_MAX_PER_WINDOW;
}

/** I0 owns no scheduler and this slice stores no quiet hours, so there is no
 * open polling window to be eligible against. The policy is an input, not
 * stored state: stating it closed is the honest answer, and this route
 * projects the card and its effective status, never the notification verdict. */
function schedulingPolicy(now: number): FollowUpNotificationPolicy {
  return {
    timeZone: "UTC",
    quietHours: null,
    pollingWindow: { id: "no-scheduler", startedAt: now, endsAt: now },
  };
}

/** The wire view of a card. Evidence excerpts travel as the untrusted data
 * they are; nothing here is authority, and nothing here can start work. */
function present(proposal: FollowUpProposal, now: number) {
  return {
    proposalId: proposal.proposalId,
    revision: proposal.revision,
    effectiveStatus: followUpEffectiveStatus(proposal, now),
    proposal,
  };
}

function denialMessage(reason: FollowUpDenialReason): string {
  switch (reason) {
    case "invalid-request":
    case "payload-too-large":
      return "Choose one plan, one calendar day and up to four cited events.";
    case "missing-authority":
    case "missing-task-identity":
    case "task-not-owned":
    case "task-cancelled":
    case "task-not-active":
    case "task-binding-changed":
      return "No such task.";
    case "no-relevant-event":
    case "evidence-not-found":
      return "No cited busy event remains on the selected day.";
    case "persistence-uncertain":
      return "Could not confirm this suggestion was saved. Reload and try again.";
    default:
      return "Could not build a suggestion from that day. Reload Calendar and try again.";
  }
}

function denialStatus(reason: FollowUpDenialReason): number {
  if (reason === "invalid-request" || reason === "payload-too-large") return 400;
  if (reason === "persistence-uncertain") return 503;
  if (reason === "missing-authority" || reason === "missing-task-identity" || reason === "task-not-owned"
    || reason === "task-cancelled" || reason === "task-not-active" || reason === "task-binding-changed") {
    return 404;
  }
  return 409;
}

function controlMessage(reason: string): string {
  switch (reason) {
    case "not-found":
      return "No such suggestion.";
    case "revision-conflict":
      return "This suggestion changed. Reload it and try again.";
    case "invalid-snooze":
      return "Choose a snooze between one minute and fourteen days.";
    case "invalid-clock":
      return "The server clock is not usable right now.";
    case "expired":
    case "not-proposable":
      return "This suggestion can no longer be controlled.";
    default:
      return "Could not update this suggestion. Try again.";
  }
}

function controlReply(outcome: FollowUpControlOutcome, now: number) {
  if (outcome.status === "rejected") {
    const clientFault = outcome.reason === "invalid-snooze" || outcome.reason === "invalid-clock";
    const absent = outcome.reason === "not-found";
    return {
      status: absent ? 404 : clientFault ? 400 : 409,
      body: { error: controlMessage(outcome.reason), reason: outcome.reason },
    };
  }
  return { status: 200, body: present(outcome.proposal, now) };
}

/** The account whose authority the request runs under, resolved now. */
async function accountFor(ctx: FollowUpRouteContext, res: ServerResponse): Promise<FollowUpAccount | null> {
  const session = await ctx.session();
  if (!session) {
    json(res, 401, { error: "Sign in to see your follow-up suggestions." });
    return null;
  }
  const account = resolveFollowUpAccount(ctx.db(), session, ctx.operator?.() === session.userId);
  if (account === null) {
    // An account with no resolvable workspace is unavailable here, not
    // authorized by default.
    json(res, 404, { error: "No such workspace." });
    return null;
  }
  return account;
}

async function sameAccount(ctx: FollowUpRouteContext, account: FollowUpAccount): Promise<boolean> {
  const current = await ctx.session();
  return current?.userId === account.userId && current.sessionId === account.sessionId;
}

export async function handleFollowUpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  ctx: FollowUpRouteContext,
): Promise<boolean> {
  if (path !== FOLLOW_UP_ROUTE_PREFIX && !path.startsWith(`${FOLLOW_UP_ROUTE_PREFIX}/`)) return false;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const now = ctx.now?.() ?? Date.now();
  if (method !== "GET" && method !== "POST") {
    json(res, 405, { error: "Method not allowed." });
    return true;
  }
  // A local paired desktop can have no web login. Advertising the capability
  // must not trigger the shared API client's 401 sign-out.
  if (method === "GET" && path === `${FOLLOW_UP_ROUTE_PREFIX}/status`) {
    json(res, 200, { available: Boolean(ctx.readSource), requiresSignIn: true });
    return true;
  }
  // Browser mutations require an explicit same-origin request.
  if (method === "POST" && req.headers.origin !== ctx.origin) {
    json(res, 403, { error: "Open Muster to make this change." });
    return true;
  }
  const account = await accountFor(ctx, res);
  if (account === null) return true;
  if (method === "POST" && !consumeWriteBudget(account.userId, now)) {
    json(res, 429, { error: "Too many changes — wait a minute and try again." });
    return true;
  }
  const store = createFollowUpStore(ctx.db());
  const authority = followUpAuthority(account);

  if (method === "GET" && path === FOLLOW_UP_ROUTE_PREFIX) {
    const listed = listNotifyableFollowUps(store, {
      authority, lookup: {}, policy: schedulingPolicy(now), now,
    });
    json(res, 200, {
      proposals: listed.slice(0, MAX_LISTED).map(candidate => ({
        proposalId: candidate.proposalId,
        effectiveStatus: candidate.effectiveStatus,
      })),
    });
    return true;
  }
  if (method === "POST" && path === FOLLOW_UP_ROUTE_PREFIX) {
    await propose(ctx, req, res, account, now);
    return true;
  }
  if (method === "GET") {
    const id = proposalIdSchema.safeParse(path.slice(FOLLOW_UP_ROUTE_PREFIX.length + 1));
    // readFollowUp is the module's own read: it loads under this authority,
    // re-parses the row and refuses another account's card, so the route
    // never parses stored JSON itself.
    const view = id.success
      ? readFollowUp(store, authority, id.data, schedulingPolicy(now), now)
      : null;
    if (view === null) {
      json(res, 404, { error: "No such suggestion." });
      return true;
    }
    json(res, 200, present(view.proposal, now));
    return true;
  }

  const action = path.match(CONTROL_PATTERN);
  const verb = action?.[2];
  const id = action ? proposalIdSchema.safeParse(action[1]) : null;
  if (verb === undefined || id === null || !id.success) {
    json(res, 404, { error: "Follow-up endpoint not found." });
    return true;
  }
  const proposalId = id.data;
  const view = readFollowUp(store, authority, proposalId, schedulingPolicy(now), now);
  if (view === null) {
    json(res, 404, { error: "No such suggestion." });
    return true;
  }
  if (verb === "withdraw") {
    // The source identity is read from a card this account already owns, not
    // from the request, so a caller cannot aim a withdrawal at a source it
    // cannot prove it holds.
    const withdrawn = withdrawFollowUps(store, authority, { sourceKey: view.proposal.evidence.sourceKey }, now);
    json(res, 200, { withdrawn });
    return true;
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    // readBody tags its own rejections: 413 for a body over the ceiling, 400
    // for malformed JSON. A failure it did not tag is treated as malformed.
    const reported = readBodyErrorSchema.safeParse(error);
    json(res, reported.success ? reported.data.status : 400, { error: "Invalid request." });
    return true;
  }
  // The session is re-resolved after the body was read: an account that
  // changed or logged out mid-request does not get to finish the change.
  if (!(await sameAccount(ctx, account))) {
    json(res, 401, { error: "Sign in to make this change." });
    return true;
  }
  if (verb === "snooze") {
    const parsed = snoozeSchema.safeParse(body);
    if (!parsed.success) {
      json(res, 400, { error: controlMessage("invalid-snooze") });
      return true;
    }
    const reply = controlReply(snoozeFollowUp(store, {
      authority, proposalId, expectedRevision: parsed.data.expectedRevision,
      snoozeForMs: parsed.data.snoozeForMs, now,
    }), now);
    json(res, reply.status, reply.body);
    return true;
  }
  const parsed = controlSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: "Reload this suggestion and try again." });
    return true;
  }
  const reply = controlReply(dismissFollowUp(store, {
    authority, proposalId, expectedRevision: parsed.data.expectedRevision, now,
  }), now);
  json(res, reply.status, reply.body);
  return true;
}

async function propose(
  ctx: FollowUpRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  account: FollowUpAccount,
  now: number,
): Promise<void> {
  if (!ctx.readSource) {
    // No guarded source read is configured on this host. A card is never
    // built from something the browser supplied.
    json(res, 503, { error: "Follow-up suggestions are not available on this host." });
    return;
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    const reported = readBodyErrorSchema.safeParse(error);
    json(res, reported.success ? reported.data.status : 400, { error: denialMessage("invalid-request") });
    return;
  }  const parsed = proposeSchema.safeParse(body);
  if (!parsed.success) {
    json(res, 400, { error: denialMessage("invalid-request") });
    return;
  }
  const task = resolveFollowUpTask(account, parsed.data.planId, ctx.lookups);
  if (task === null) {
    json(res, 404, { error: "No such task." });
    return;
  }
  // A task that is not live work is refused before anything is read. A
  // cancelled or finished plan is not a reason to spend a provider read.
  if (task.status !== "active") {
    json(res, 404, { error: "No such task." });
    return;
  }
  const draft = await ctx.readSource({
    account, task, now,
    day: { calendarId: parsed.data.calendarId, date: parsed.data.date, timeZone: parsed.data.timeZone },
    evidenceEventIds: parsed.data.evidenceEventIds,
  });
  // The account, its workspace and its task are re-resolved after the read.
  if (!(await sameAccount(ctx, account))) {
    json(res, 401, { error: "Sign in to make this change." });
    return;
  }
  const current = resolveFollowUpAccount(
    ctx.db(),
    { userId: account.userId, sessionId: account.sessionId },
    account.isPrimary,
  );
  if (current === null || current.workspaceId !== account.workspaceId) {
    json(res, 404, { error: "No such workspace." });
    return;
  }
  const rebound = resolveFollowUpTask(current, parsed.data.planId, ctx.lookups);
  if (rebound === null) {
    json(res, 404, { error: "No such task." });
    return;
  }
  if (draft === null) {
    json(res, 409, { error: "Could not read a complete selected day." });
    return;
  }
  // The reader must have read the day that was asked for. A reader that
  // answered about a different calendar, date or zone is not evidence here.
  const source = draft.observation;
  if (source.calendarId !== parsed.data.calendarId
    || source.requestedDate !== parsed.data.date
    || source.timeZone !== parsed.data.timeZone) {
    json(res, 409, { error: "Could not read the selected day." });
    return;
  }
  const outcome = proposeFollowUp(createFollowUpStore(ctx.db()), {
    authority: followUpAuthority(current),
    origin: rebound.origin,
    proposalType: "meeting-preparation",
    task: rebound,
    observation: source,
    evidenceEventIds: parsed.data.evidenceEventIds,
    explanation: draft.explanation,
    freshForMs: FRESH_FOR_MS,
    capability: draft.capability,
    now,
  });
  if (outcome.status === "denied") {
    json(res, denialStatus(outcome.reason), { error: denialMessage(outcome.reason), reason: outcome.reason });
    return;
  }
  if (outcome.status === "refresh-required") {
    json(res, 409, { error: "Review and refresh the open suggestion first.", proposal: present(outcome.proposal, now) });
    return;
  }
  json(res, outcome.status === "proposed" ? 201 : 200, present(outcome.proposal, now));
}
