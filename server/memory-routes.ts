// The memory retrieval + shared-memory grant route family (DESIGN §38
// M1–M2), registered in server/index.ts beside the workspace-backup
// family — INSIDE the session gate, ABOVE the shared multi-tenant
// ownership guard. That position is the feature: a grantee who is not
// the bot's owner would be 404'd by the shared guard before any grant
// could be consulted, so this family resolves ownership itself
// (memory-grants.isResourceOwner mirrors index.ts's ownsRecord, with the
// same inputs — the gate's requestUserId and the operator) and applies
// default deny itself: an unauthorized caller gets the exact "no such
// bot" answer the guard would have given. Identity is deliberately no
// RICHER than the guard's — a local install keeps loopback's implicit
// trust here exactly as every other /api/bots route does below.
//
// Route table (first match wins; false = the family does not claim it):
//   GET    /api/bots/:id/memory/search?q=&limit=
//            BM25 retrieval — the owner's own view, or an active read
//            grant; empty/whitespace q browses recent-first; limit
//            clamps to [1, MAX_LIMIT]; every hit carries provenance.
//   GET    /api/bots/:id/memory/grants      owner-only list (withdrawal state included).
//   POST   /api/bots/:id/memory/grants      owner-only issue → 201.
//   DELETE /api/bots/:id/memory/grants/:id  owner-only withdrawal (never deletion).
//
// Session auth is NOT re-checked here: the gate above already 401'd
// anonymous callers under SELF_HOSTED (none of these paths are in
// isPublicApiPath). Grant and revoke CHANGES are appended to the
// existing trust ledger through deps.record — the DecisionLog behind
// GET /api/bots/:id/audit — so the audit surface gains no new system.

import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody } from "./http-helpers.ts";
import {
  grantErrorStatus,
  grantInputSchema,
  isResourceOwner,
  MemoryGrantStore,
  type GrantInput,
  type MemoryGrant,
  type Requester,
} from "./memory-grants.ts";
import { searchMemory } from "./memory-retrieval.ts";

/** One ledger per process, built on first use so importing this module has
 * no filesystem side effect. Every mutation persists synchronously, so all
 * later requests read the same rows through this instance. */
let ledger: MemoryGrantStore | null = null;
const grants = (): MemoryGrantStore => (ledger ??= new MemoryGrantStore());

/** Exactly the entry shape DecisionLog.record accepts, narrowed to what
 * this family ever writes into the trust ledger. */
export interface GrantLedgerEntry {
  action: string;
  decision: "approved" | "denied" | "auto";
  summary: string;
}

/** Everything index.ts's one-line mount supplies: the record lookup, the
 * gate's resolved session user (null on desktop/local), the operator for
 * unowned records, and the audit append. */
export interface MemoryRouteDeps {
  bot(id: string): { id: string; ownerId?: string } | null | undefined;
  requestUserId: string | null;
  operator: string | null;
  record(botId: string, entry: GrantLedgerEntry): void;
}

/** One request's resolved identity against one bot — the guard's decision,
 * made early. */
interface RouteContext {
  bot: { id: string; ownerId?: string };
  isOwner: boolean;
  requester: Requester;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Shared preamble: unknown bot and unauthorized requester both answer the
 * guard's "no such bot" — existence is never leaked to a non-owner. Null
 * means the 404 is already written. */
function routeContext(res: ServerResponse, deps: MemoryRouteDeps, botId: string): RouteContext | null {
  const bot = deps.bot(botId);
  if (!bot) {
    json(res, 404, { error: "no such bot" });
    return null;
  }
  return {
    bot,
    isOwner: isResourceOwner({ botOwnerId: bot.ownerId, requester: deps.requestUserId, operator: deps.operator }),
    requester: deps.requestUserId ? { kind: "user", id: deps.requestUserId } : { kind: "desktop" },
  };
}

/** GET /memory/search — searchMemory returns null when neither resource
 * kind admits the requester (default deny), rendered as the guard's 404;
 * a granted-but-empty corpus answers honestly with hits:[]. */
function handleSearch(req: IncomingMessage, res: ServerResponse, deps: MemoryRouteDeps, botId: string): void {
  const ctx = routeContext(res, deps, botId);
  if (!ctx) return;
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const rawLimit = params.get("limit");
  const result = searchMemory({
    botId: ctx.bot.id,
    botOwnerId: ctx.bot.ownerId,
    requester: ctx.requester,
    isOwner: ctx.isOwner,
    grants: grants().list(ctx.bot.id),
    q: params.get("q") ?? "",
    limit: rawLimit === null || rawLimit === "" ? undefined : Number(rawLimit),
    now: Date.now(),
  });
  if (!result) {
    json(res, 404, { error: "no such bot" });
    return;
  }
  json(res, 200, result);
}

/** Read + validate one create payload. Null means the failure response
 * (400 with every zod issue, or a store/readBody-tagged status) is
 * already written. */
async function readGrantInput(req: IncomingMessage, res: ServerResponse): Promise<GrantInput | null> {
  try {
    const parsed = grantInputSchema.safeParse(await readBody(req));
    if (!parsed.success) {
      json(res, 400, { error: `invalid grant — ${parsed.error.issues.map((issue) => issue.message).join("; ")}` });
      return null;
    }
    return parsed.data;
  } catch (cause) {
    json(res, grantErrorStatus(cause), { error: messageOf(cause) });
    return null;
  }
}

/** Persist one grant. Null means the store's tagged refusal (400 invalid
 * or expired input, 409 per-bot live cap) is already written. */
function persistGrant(
  res: ServerResponse,
  botId: string,
  grantorId: string | undefined,
  input: GrantInput,
): MemoryGrant | null {
  try {
    return grants().add(botId, grantorId, input);
  } catch (cause) {
    json(res, grantErrorStatus(cause), { error: messageOf(cause) });
    return null;
  }
}

const grantSummary = (grant: MemoryGrant): string =>
  `granted ${grant.permission} ${grant.resource} access to ${grant.grantee.kind} ${grant.grantee.id}` +
  (grant.expiresAt ? `, expires ${new Date(grant.expiresAt).toISOString()}` : "");

/** GET (owner list) | POST (owner issue) — both are owner-only: a grantee
 * probing this surface sees the guard's 404, never the grant list. The
 * ledger append sits outside every catch so a failed audit write surfaces
 * honestly instead of masquerading as a rejected grant. */
async function handleGrants(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  deps: MemoryRouteDeps,
  botId: string,
): Promise<void> {
  const ctx = routeContext(res, deps, botId);
  if (!ctx) return;
  if (!ctx.isOwner) {
    json(res, 404, { error: "no such bot" });
    return;
  }
  if (method === "GET") {
    json(res, 200, { grants: grants().list(ctx.bot.id) });
    return;
  }
  const input = await readGrantInput(req, res);
  if (!input) return;
  const created = persistGrant(res, ctx.bot.id, deps.requestUserId ?? undefined, input);
  if (!created) return;
  deps.record(ctx.bot.id, { action: "memory_grant", decision: "approved", summary: grantSummary(created) });
  json(res, 201, { grant: created });
}

/** DELETE — withdrawal, never deletion: revoke() sets revokedAt, and an
 * unknown, foreign, or already-revoked id is the same 404 miss (mirrors
 * WorkspaceBrain.withdraw). Immediate: the next search re-reads the row. */
function handleRevoke(res: ServerResponse, deps: MemoryRouteDeps, botId: string, grantId: string): void {
  const ctx = routeContext(res, deps, botId);
  if (!ctx) return;
  if (!ctx.isOwner) {
    json(res, 404, { error: "no such bot" });
    return;
  }
  const withdrawn = grants().revoke(grantId, ctx.bot.id);
  if (!withdrawn) {
    json(res, 404, { error: "no such grant" });
    return;
  }
  deps.record(ctx.bot.id, {
    action: "memory_grant_revoke",
    decision: "denied",
    summary: `withdrew ${withdrawn.permission} ${withdrawn.resource} access for ${withdrawn.grantee.kind} ${withdrawn.grantee.id}`,
  });
  json(res, 200, { grant: withdrawn });
}

/** The family's single entry point. Claim by path+method only — identity
 * is resolved after a claim, so a wrong method on these paths stays
 * unclaimed and falls through to the rest of the chain untouched. */
export async function handleMemoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  deps: MemoryRouteDeps,
): Promise<boolean> {
  const search = path.match(/^\/api\/bots\/([\w-]+)\/memory\/search$/);
  if (search) {
    if (method !== "GET") return false;
    handleSearch(req, res, deps, search[1]);
    return true;
  }
  const collection = path.match(/^\/api\/bots\/([\w-]+)\/memory\/grants$/);
  if (collection) {
    if (method !== "GET" && method !== "POST") return false;
    await handleGrants(req, res, method, deps, collection[1]);
    return true;
  }
  const single = path.match(/^\/api\/bots\/([\w-]+)\/memory\/grants\/([\w-]+)$/);
  if (single) {
    if (method !== "DELETE") return false;
    handleRevoke(res, deps, single[1], single[2]);
    return true;
  }
  return false;
}
