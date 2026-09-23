// Shared-memory grants (DESIGN §38 M1–M2) — the WHO side of retrieval.
// server/memory-retrieval.ts answers "what matches this query?"; this
// module answers "is this requester allowed to see this resource at all".
//
// The model, one row per grant:
//
//   grantor (the owner of the anchored bot, recorded at grant time)
//     → grantee (a bot id or a user id — never the string form of both)
//     → resource scope (which bot's memory files, or that bot owner's
//        fact set — the two corpora retrieval actually searches)
//     → permission (read | read-write)
//     → optional expiry (ms epoch)
//
// DEFAULT DENY: authorizeMemoryAccess returns { allowed: false } for any
// requester that is not the resource owner and does not match an active
// grant — there is no ambient access anywhere in this file. Revocation and
// expiry are checked at every decision against the injected clock, so both
// take effect immediately (an expired grant is inert the moment now passes
// expiresAt, with no sweeper to race).
//
// Two conventions this file deliberately reuses instead of inventing:
//   · factHistory/withdrawal (workspace-brain.ts): a revoked grant is never
//     deleted — revokedAt is set, the row stays for provenance, and a
//     double revoke is a miss, exactly like WorkspaceBrain.withdraw.
//   · the trust ledger (decision-log.ts / receipts): grant and revoke CHANGES
//     are recorded by the route into the existing per-bot audit log — the
//     durable record lives there, which is why this store may prune its own
//     oldest revoked rows to stay bounded without losing history.
//
// A corrupt/unreadable grants file loads as an empty ledger — for access
// control that fails CLOSED (previously granted requesters are denied until
// the owner re-grants; nobody silently gains access).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { parseJson } from "./schema.ts";

// ── shapes ──────────────────────────────────────────────────────────────

export type GrantPermission = "read" | "read-write";
export type GrantResource = "memory" | "facts";
export type GranteeKind = "bot" | "user";

export interface Grantee {
  kind: GranteeKind;
  id: string;
}

export interface MemoryGrant {
  id: string;
  /** The owner who issued the grant. Absent on a desktop install, where a
   * session-less operator owns everything and has no account id. */
  grantorId?: string;
  grantee: Grantee;
  /** The anchored resource bot: its memory files, its owner's fact set. */
  botId: string;
  resource: GrantResource;
  permission: GrantPermission;
  createdAt: number;
  /** ms epoch; the grant is inert from this instant on. */
  expiresAt?: number;
  /** ms epoch of revocation — withdrawal, never deletion. */
  revokedAt?: number;
}

/** Who is asking. The HTTP routes only ever produce "user" (signed in) or
 * "desktop" (session-less local install); "bot" exists for the engine/fleet
 * callers that will wire retrieval into tools in the follow-up slice, and is
 * the identity shared-memory grants are ultimately for (bot → bot). */
export type Requester =
  | { kind: "user"; id: string }
  | { kind: "bot"; id: string }
  | { kind: "desktop" };

/** Grantee ids: the route charset for bot ids and the word charset for
 * better-auth user ids alike — anything else never reaches a lookup. */
export const GRANTEE_ID = /^[\w-]{1,128}$/;

/** The create-grant payload, shared by the HTTP route and store.add. */
export const grantInputSchema = z.object({
  grantee: z.object({
    kind: z.enum(["bot", "user"]),
    id: z.string().regex(GRANTEE_ID, "grantee id must be 1–128 word characters"),
  }),
  resource: z.enum(["memory", "facts"]),
  permission: z.enum(["read", "read-write"]),
  expiresAt: z.number().int().positive().optional(),
});

export type GrantInput = z.infer<typeof grantInputSchema>;

// ── the decision ────────────────────────────────────────────────────────

/** A grant answers only while it is live: not revoked, not yet expired. */
export function isGrantActive(grant: MemoryGrant, now: number): boolean {
  return !grant.revokedAt && (grant.expiresAt === undefined || grant.expiresAt > now);
}

export interface AccessQuery {
  botId: string;
  /** Resolved by isResourceOwner (the ownsRecord mirror) before this call. */
  isOwner: boolean;
  requester: Requester;
  grants: MemoryGrant[];
  resource: GrantResource;
  /** "read-write" is never satisfied by a "read" grant — permissions only
   * upgrade along the declared ladder, never implicitly. */
  permission: GrantPermission;
  now: number;
}

export interface AccessDecision {
  allowed: boolean;
  via?: "desktop" | "owner" | "grant";
  grantId?: string;
}

/** Default deny. Owner (or the session-less desktop operator) passes; every
 * else must match an active grant on this exact bot + resource + grantee,
 * with a permission at least as strong as the one required. */
export function authorizeMemoryAccess(query: AccessQuery): AccessDecision {
  if (query.isOwner) {
    return { allowed: true, via: query.requester.kind === "desktop" ? "desktop" : "owner" };
  }
  // A desktop requester is always resolved as owner by isResourceOwner; if
  // one ever reaches here without ownership, deny — no grant can name a
  // "desktop" grantee, so there is nothing to match against anyway.
  if (query.requester.kind === "desktop") return { allowed: false };
  for (const grant of query.grants) {
    if (grant.botId !== query.botId || grant.resource !== query.resource) continue;
    if (grant.grantee.kind !== query.requester.kind || grant.grantee.id !== query.requester.id) continue;
    if (!isGrantActive(grant, query.now)) continue;
    if (query.permission === "read-write" && grant.permission !== "read-write") continue;
    return { allowed: true, via: "grant", grantId: grant.id };
  }
  return { allowed: false };
}

/** The ownership predicate every memory route runs — a deliberate mirror of
 * index.ts's ownsRecord, kept here because the retrieval family mounts
 * ABOVE the shared multi-tenant guard (grants must be consulted before a
 * non-owner request disappears into that guard's 404):
 *   · no requester (session-less local install) → the one local user owns;
 *   · an owned record → only its owner;
 *   · an unowned record → the operator (primary user) only. */
export function isResourceOwner(params: {
  botOwnerId?: string;
  requester?: string | null;
  operator?: string | null;
}): boolean {
  if (!params.requester) return true;
  if (params.botOwnerId === params.requester) return true;
  if (!params.botOwnerId) return params.requester === params.operator;
  return false;
}

// ── persistence ─────────────────────────────────────────────────────────

const GRANTS_FILE = join(DATA_DIR, "memory-grants.json");

/** Bounds: live grants per bot, and total rows kept in the file. Both are
 * refusing/pruning caps, never evictions of live access. */
const MAX_ACTIVE_PER_BOT = 500;
const MAX_GRANTS = 2000;

const grantSchema = z.object({
  id: z.string(),
  grantorId: z.string().optional(),
  grantee: z.object({ kind: z.enum(["bot", "user"]), id: z.string() }),
  botId: z.string(),
  resource: z.enum(["memory", "facts"]),
  permission: z.enum(["read", "read-write"]),
  createdAt: z.number(),
  expiresAt: z.number().optional(),
  revokedAt: z.number().optional(),
});

const grantFileSchema = z.object({
  version: z.literal(1),
  grants: z.array(grantSchema),
});

/** Store errors carry their HTTP status the way readBody rejections do, so
 * the route maps them without re-deriving policy. */
function tagged(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** zod parses the caught cause at this boundary — only a well-formed HTTP status maps through. */
export function grantErrorStatus(cause: unknown): number {
  const parsed = z.object({ status: z.number().int().min(100).max(599) }).passthrough().safeParse(cause);
  return parsed.success ? parsed.data.status : 400;
}

export class MemoryGrantStore {
  private grants: MemoryGrant[] = [];
  private readonly file: string;
  private readonly now: () => number;
  private readonly maxActivePerBot: number;

  constructor(options: { file?: string; now?: () => number; maxActivePerBot?: number } = {}) {
    this.file = options.file ?? GRANTS_FILE;
    this.now = options.now ?? Date.now;
    this.maxActivePerBot = options.maxActivePerBot ?? MAX_ACTIVE_PER_BOT;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = grantFileSchema.safeParse(parseJson(readFileSync(this.file, "utf8")));
      // Fail-closed: an unreadable or foreign-shaped ledger starts empty —
      // grants must be re-issued, never guessed from damaged bytes.
      if (parsed.success) this.grants = parsed.data.grants;
    } catch {
      // Left on disk untouched for triage, same as the brain's load.
    }
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, grants: this.grants }, null, 2), { mode: 0o600 });
  }

  /** Every grant anchored to this bot, including revoked/expired ones —
   * the owner's list view shows the true state, withdrawal included. */
  list(botId: string): MemoryGrant[] {
    return this.grants.filter((grant) => grant.botId === botId);
  }

  /** Issue a grant. Validation is re-run here (not only at the route) so a
   * future non-HTTP caller cannot mint a malformed permission. Throws errors
   * tagged with their HTTP status; nothing is written on a rejected input. */
  add(botId: string, grantorId: string | undefined, input: GrantInput): MemoryGrant {
    const parsed = grantInputSchema.safeParse(input);
    if (!parsed.success) throw tagged(400, `invalid grant — ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    const data = parsed.data;
    const now = this.now();
    if (data.expiresAt !== undefined && data.expiresAt <= now) {
      throw tagged(400, "expiry must be in the future");
    }
    const live = this.grants.filter((grant) => grant.botId === botId && isGrantActive(grant, now)).length;
    if (live >= this.maxActivePerBot) {
      throw tagged(409, `this memory already has ${live} live grants — revoke some before issuing another`);
    }
    const grant: MemoryGrant = {
      id: newId(),
      grantee: data.grantee,
      botId,
      resource: data.resource,
      permission: data.permission,
      createdAt: now,
    };
    if (grantorId) grant.grantorId = grantorId;
    if (data.expiresAt !== undefined) grant.expiresAt = data.expiresAt;
    this.grants.push(grant);
    this.prune();
    this.save();
    return grant;
  }

  /** Bound the file without ever evicting live access: revoked rows yield
   * first (the durable change record is the trust ledger, per the header),
   * and only a still-overflowing ledger refuses further writes upstream. */
  private prune(): void {
    if (this.grants.length <= MAX_GRANTS) return;
    let overflow = this.grants.length - MAX_GRANTS;
    const kept: MemoryGrant[] = [];
    for (const grant of this.grants) {
      if (overflow > 0 && grant.revokedAt) {
        overflow -= 1;
        continue;
      }
      kept.push(grant);
    }
    this.grants = kept;
  }

  /** Withdraw, not delete: sets revokedAt and persists. Unknown id, wrong
   * bot, or an already-revoked grant all return null — a double revoke is a
   * miss, exactly like WorkspaceBrain.withdraw. */
  revoke(grantId: string, botId: string): MemoryGrant | null {
    const grant = this.grants.find((g) => g.id === grantId && g.botId === botId);
    if (!grant || grant.revokedAt) return null;
    grant.revokedAt = this.now();
    this.save();
    return grant;
  }
}
