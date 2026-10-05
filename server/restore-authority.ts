// Current-authority validation for a live restore inside the exclusive window.
//
// PR #79's exclusive-restore boundary proves THAT a restore may run (one
// claim holder per data directory). It does not prove WHO the restore is for.
// This module is the who-half: a future live-restore consumer adopts authority
// through `acquireRestoreAuthority` while it holds an `ExclusiveRestoreClaim`,
// and keeps proving it at every commit boundary through `assertCurrent()` —
// the same re-check-at-every-boundary posture the visible-Drive routes apply
// between their signed session and their grant lease.
//
// NO parallel identity system. Every check below reads the real records the
// running server already trusts:
//   - the signed-session row check mirrors `readLiveVisibleAccount`
//     (server/drive-visible-routes.ts): session id + account join, then an
//     unexpired `expiresAt`. The proof deliberately names the session rather
//     than carrying its token — token possession is proven by the HTTP layer
//     that authenticated the request before this module is ever called, so
//     re-asking for the token here would invent a second credential channel.
//   - workspace resolution is `resolveFollowUpAccount`
//     (server/follow-up-identity.ts), the one real resolver: the session's own
//     active organization validated against CURRENT member rows.
//   - the verified Google identity binding is the `drive_visible_grants` row
//     for the account — the same binding of record the visible routes compare
//     against (read as a bare plaintext column exactly like
//     `saveVisibleGrant`'s identity probe does; tokens stay sealed).
//   - the persisted enrollment fence (`isEnrollmentKeyFenced`,
//     server/installation-enrollment-contract.ts) is consulted at adoption and
//     re-read inside every `assertCurrent()`, so a key fenced mid-restore
//     stops the restore at its next boundary.
//
// SCOPE — the boot-path gap, stated rather than papered over. Every check here
// needs the better-auth SQLite database, which does not exist during the
// boot-time apply: `bootWithRestoreFirst` (server/boot-order.ts) applies a
// staged restore BEFORE the Store and the auth machinery are constructed, and
// the recovery-journal importer runs in an owned child before Store
// construction. Full session validation is therefore impossible on that path
// without initializing auth machinery inside the boundary it must not touch.
// This module is scoped to the RUNNING-server context — the future HTTP
// consumer that already holds a live claim inside a running server. The
// boot-time apply path cannot adopt authority through this module; a boot-time
// restore consumer would need its own authority story. Nothing here fakes one.
//
// Every refusal is a typed `RestoreAuthorityRefusal` with a distinct code per
// cause, so a consumer (and an operator) can tell "your session expired" from
// "your session was replaced" from "the key you named is fenced".
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { DataDirExclusivityError, type ExclusiveRestoreClaim } from "./data-dir-exclusivity.ts";
import { resolveFollowUpAccount } from "./follow-up-identity.ts";
import { isEnrollmentKeyFenced } from "./installation-enrollment-contract.ts";

/** Why an authority was refused. One cause, one code. */
export type RestoreAuthorityRefusalCode =
  /** The exclusivity claim was removed or replaced mid-window. */
  | "claim-not-held"
  /** The named session row does not exist for any account. */
  | "session-unknown"
  /** The named session row exists but its expiresAt has passed. */
  | "session-expired"
  /** The named session is gone and the account holds no other live session. */
  | "session-revoked"
  /** The named session is gone but the account has signed in again under a
   * different session — the proof names a session that no longer exists. */
  | "session-replaced"
  /** The session belongs to a different account than the proof names, or the
   * account's operator role changed mid-window. */
  | "account-mismatch"
  /** The account's live workspace is not the one the proof names. */
  | "workspace-mismatch"
  /** The restore kind requires a verified Google identity binding and none is
   * offered or none is on record. */
  | "identity-binding-missing"
  /** The account's verified binding is no longer the one adopted. */
  | "identity-binding-changed"
  /** The enrollment client key named for this restore is fenced. */
  | "enrollment-fenced"
  /** The proof itself was malformed. */
  | "proof-malformed"
  /** release() was called; the handle no longer speaks for anyone. */
  | "authority-released";

export class RestoreAuthorityRefusal extends Error {
  readonly code: RestoreAuthorityRefusalCode;
  constructor(code: RestoreAuthorityRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** How much identity the restore kind must prove. `account-bound` restores
 * (account-visible recovery archives) carry a googleSub binding in their
 * manifest, so the operator must still be that Google identity. `workspace`
 * restores name a workspace and need no Google binding. */
export type RestoreAuthorityKind = "workspace" | "account-bound";

const identifier = z.string().min(1).max(200);
const googleSub = z.string().min(1).max(1024);

/** What the operator offers as proof. Every field is re-derived from the real
 * store on every check — the proof is the claim to VERIFY, never the evidence
 * itself. */
export interface RestoreAuthorityProof {
  /** The signed better-auth session id the operator is acting under. */
  sessionId: string;
  /** The account the session must belong to. */
  userId: string;
  /** The workspace the restore is scoped to. */
  workspaceId: string;
  /** The verified Google identity, when the restore is bound to one. Required
   * for `account-bound` restores; checked whenever offered. */
  googleSub?: string;
}

/** Host-provided live reads. Everything environmental, nothing from the wire. */
export interface RestoreAuthorityDeps {
  /** The real better-auth database (server/auth.ts `getDb()`). */
  db: DatabaseSync;
  /** The deployment's operator (primary user id), the same source the visible
   * routes use for the primary rule. */
  operator(): string | null;
  /** The enrollment client key whose persisted fence gates this restore. When
   * omitted, no fence is consulted (a restore not scoped to an enrollment). */
  enrollmentKey?: string;
  /** Clock for session expiry. Injectable for determinism. */
  now?(): number;
}

/** What a handle pins. The account view is captured at adoption and re-derived
 * (never trusted) on every `assertCurrent()`. */
export interface RestoreAuthorityView {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly isPrimary: boolean;
  /** The pinned binding; null when the proof names none. */
  readonly googleSub: string | null;
  readonly kind: RestoreAuthorityKind;
}

export interface RestoreAuthority extends RestoreAuthorityView {
  /** Full re-validation, every call: the exclusivity claim is still exactly as
   * held, the fence is re-read, the SAME session id is still live, the account
   * and its membership still resolve to the pinned workspace, and the identity
   * binding is unchanged. A stale, replaced, revoked or mismatched authority
   * throws a typed refusal. */
  assertCurrent(): void;
  /** Retire the handle. The exclusivity claim itself belongs to the restore
   * flow and is NOT released here. */
  release(): void;
}

/** The expiry shapes the real signed-session path accepts, verbatim in intent:
 * a numeric epoch or the ISO form better-auth writes. Kept local because
 * drive-visible-routes.ts does not export it. */
const expirySchema = z.union([
  z.number().int().max(8.64e15),
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
]);

/** The raw expiry cell as the SQLite driver hands it over: an integer epoch
 * or the ISO form better-auth writes. Parsed at this boundary, nowhere else. */
interface SessionExpiryCell {
  expiresAt?: number | string;
}

function sessionExpiryAt(row: SessionExpiryCell): number | null {
  const parsed = expirySchema.safeParse(row.expiresAt);
  if (!parsed.success) return null;
  const numeric = z.number().int().safeParse(parsed.data);
  const expiresAt = numeric.success ? numeric.data : Date.parse(z.string().parse(parsed.data));
  return Number.isFinite(expiresAt) ? expiresAt : null;
}

interface SessionState {
  status: "live" | "absent" | "expired";
}

/** The signed-session row check, mirrored from readLiveVisibleAccount: the
 * row must join session id to account, and must not have expired. The JOIN
 * against `user` is kept because it is the real path's shape. Errors read as
 * absent — a store that cannot answer cannot authorize. */
function lookUpSession(db: DatabaseSync, sessionId: string, userId: string, at: number): SessionState {
  try {
    // SAFETY: the SELECT projects only the session row's expiresAt column,
    // joined through the user table exactly as the visible routes do.
    const row = db.prepare(`SELECT s.expiresAt FROM session s JOIN user u ON u.id = s.userId
      WHERE s.id = ? AND s.userId = ?`).get(sessionId, userId) as SessionExpiryCell | undefined;
    if (!row) return { status: "absent" };
    const expiresAt = sessionExpiryAt(row);
    if (expiresAt === null || expiresAt <= at) return { status: "expired" };
    return { status: "live" };
  } catch {
    return { status: "absent" };
  }
}

/** Which account a session id belongs to, ignoring the proof. The distinct
 * "belongs to another account" refusal needs the row's real owner. */
function sessionOwner(db: DatabaseSync, sessionId: string): string | null {
  try {
    // SAFETY: the SELECT projects only the session row's userId column.
    const row = db.prepare('SELECT "userId" FROM "session" WHERE "id" = ?').get(sessionId) as
      | { userId?: unknown }
      | undefined;
    const parsed = identifier.safeParse(row?.userId);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Whether the account holds any OTHER live session — the evidence that
 * distinguishes a replaced session (signed out, signed back in) from a
 * revoked one (session gone, nothing behind it). */
function hasOtherLiveSession(db: DatabaseSync, userId: string, exceptSessionId: string, at: number): boolean {
  try {
    // SAFETY: the SELECT projects only other sessions' expiresAt column.
    const rows = db.prepare('SELECT "expiresAt" FROM "session" WHERE "userId" = ? AND "id" != ?')
      .all(userId, exceptSessionId) as SessionExpiryCell[];
    return rows.some((row) => {
      const expiresAt = sessionExpiryAt(row);
      return expiresAt !== null && expiresAt > at;
    });
  } catch {
    return false;
  }
}

/** The verified Google identity binding of record for the account — the same
 * plaintext column probe saveVisibleGrant uses for its identity comparison.
 * A grants schema that is absent or unreadable means no binding to prove. */
function liveIdentityBinding(db: DatabaseSync, userId: string): string | null {
  try {
    // SAFETY: the SELECT projects only the grant row's googleSub column.
    const row = db.prepare("SELECT googleSub FROM drive_visible_grants WHERE userId = ?").get(userId) as
      | { googleSub?: unknown }
      | undefined;
    const parsed = googleSub.safeParse(row?.googleSub);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function assertClaimHeld(claim: ExclusiveRestoreClaim): void {
  try {
    claim.assert();
  } catch (error) {
    if (error instanceof DataDirExclusivityError) {
      throw new RestoreAuthorityRefusal("claim-not-held",
        `Restore authority requires the exclusive-restore claim, and it is no longer held (${error.message})`);
    }
    throw error;
  }
}

function assertFenceOpen(deps: RestoreAuthorityDeps): void {
  if (deps.enrollmentKey === undefined) return;
  if (isEnrollmentKeyFenced(deps.enrollmentKey)) {
    throw new RestoreAuthorityRefusal("enrollment-fenced",
      `Enrollment key ${deps.enrollmentKey} is fenced; restore authority cannot be adopted or held through it`);
  }
}

/** Everything every boundary re-proves: the full check sequence runs at
 * adoption and again, unchanged, on each `assertCurrent()`. `pinned` carries
 * the adopted account view; `goneSessionCode` names how a vanished session row
 * reads at this boundary (unknown at adoption; replaced or revoked after). */
function validateAuthority(deps: RestoreAuthorityDeps, claim: ExclusiveRestoreClaim,
  pinned: RestoreAuthorityView, goneSessionCode: "session-unknown" | "gone"): void {
  const at = deps.now?.() ?? Date.now();
  assertClaimHeld(claim);
  assertFenceOpen(deps);

  const owner = sessionOwner(deps.db, pinned.sessionId);
  if (owner === null) {
    if (goneSessionCode === "session-unknown") {
      throw new RestoreAuthorityRefusal("session-unknown",
        `Session ${pinned.sessionId} does not exist; restore authority refused`);
    }
    const replaced = hasOtherLiveSession(deps.db, pinned.userId, pinned.sessionId, at);
    throw new RestoreAuthorityRefusal(replaced ? "session-replaced" : "session-revoked",
      replaced
        ? `Session ${pinned.sessionId} no longer exists and the account has signed in under a different session`
        : `Session ${pinned.sessionId} no longer exists and the account holds no other live session`);
  }
  if (owner !== pinned.userId) {
    throw new RestoreAuthorityRefusal("account-mismatch",
      `Session ${pinned.sessionId} belongs to ${owner}, not to ${pinned.userId}`);
  }
  const session = lookUpSession(deps.db, pinned.sessionId, pinned.userId, at);
  if (session.status === "expired") {
    throw new RestoreAuthorityRefusal("session-expired", `Session ${pinned.sessionId} has expired`);
  }
  if (session.status !== "live") {
    // Unreachable in practice (the owner was just proven); kept explicit so a
    // racing store reads as a refusal, never as authority.
    throw new RestoreAuthorityRefusal(goneSessionCode === "session-unknown" ? "session-unknown" : "session-revoked",
      `Session ${pinned.sessionId} could not be revalidated`);
  }

  const isPrimary = pinned.userId === deps.operator();
  const account = resolveFollowUpAccount(deps.db, { userId: pinned.userId, sessionId: pinned.sessionId }, isPrimary);
  if (account === null || account.workspaceId !== pinned.workspaceId) {
    throw new RestoreAuthorityRefusal("workspace-mismatch",
      account === null
        ? `Account ${pinned.userId} currently resolves to no workspace; ${pinned.workspaceId} is not authorized`
        : `Account ${pinned.userId} now resolves to workspace ${account.workspaceId}, not ${pinned.workspaceId}`);
  }
  if (account.isPrimary !== pinned.isPrimary) {
    throw new RestoreAuthorityRefusal("account-mismatch",
      `Account ${pinned.userId}'s operator role changed mid-restore`);
  }

  if (pinned.googleSub !== null) {
    const live = liveIdentityBinding(deps.db, pinned.userId);
    if (live === null) {
      throw new RestoreAuthorityRefusal("identity-binding-missing",
        `Account ${pinned.userId} has no verified Google identity binding on record; the restore kind requires one`);
    }
    if (live !== pinned.googleSub) {
      throw new RestoreAuthorityRefusal("identity-binding-changed",
        `Account ${pinned.userId}'s verified Google identity changed since authority was adopted`);
    }
  }
}

/** Adopt restore authority INSIDE the exclusive window. Refuses unless the
 * exclusivity claim is currently held, the named session is live and belongs
 * to the named account, the account's live membership resolves to the named
 * workspace, the identity binding matches where the restore kind requires one,
 * and the enrollment fence is open. */
export function acquireRestoreAuthority(claim: ExclusiveRestoreClaim, proof: RestoreAuthorityProof,
  deps: RestoreAuthorityDeps, kind: RestoreAuthorityKind = "account-bound"): RestoreAuthority {
  // Shape the proof at the boundary; the parsed values are what get verified.
  const offered = z.object({
    sessionId: identifier, userId: identifier, workspaceId: identifier,
    googleSub: googleSub.optional(),
  }).strict().safeParse(proof);
  if (!offered.success) {
    throw new RestoreAuthorityRefusal("proof-malformed",
      `Restore authority proof is malformed: ${offered.error.issues[0]?.message ?? "invalid"}`);
  }
  const view: RestoreAuthorityView = Object.freeze({
    sessionId: offered.data.sessionId,
    userId: offered.data.userId,
    workspaceId: offered.data.workspaceId,
    isPrimary: offered.data.userId === deps.operator(),
    googleSub: offered.data.googleSub ?? null,
    kind,
  });
  // An account-bound restore can never adopt without its identity, and a
  // binding offered for a workspace restore is honored, never ignored.
  if (kind === "account-bound" && view.googleSub === null) {
    throw new RestoreAuthorityRefusal("identity-binding-missing",
      "Account-bound restore requires a verified Google identity binding; the proof names none");
  }
  validateAuthority(deps, claim, view, "session-unknown");
  let released = false;
  return {
    ...view,
    assertCurrent(): void {
      if (released) {
        throw new RestoreAuthorityRefusal("authority-released",
          "Restore authority was released; adopt it again to continue");
      }
      validateAuthority(deps, claim, view, "gone");
    },
    release(): void {
      released = true;
    },
  };
}
