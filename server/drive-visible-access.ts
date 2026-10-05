// Runtime prerequisite only: the host supplies its real account resolver and
// configured provider. Each external operation must use the lease separately.
// No routes, account selection, network isolation or credential logging here.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { FollowUpAccount } from "./follow-up-identity.ts";
import { getVisibleGrant, isVisibleGrantCurrent, refreshVisibleGrant, type VisibleFileGrant } from "./drive-visible-grants.ts";
import { VisibleFileOAuthRefreshError, type VisibleFileOAuthProvider } from "./drive-visible-oauth.ts";
import type { VisibleTokenProtector } from "./drive-visible-token-protection.ts";

const id = z.string().min(1).max(200);
const accountSchema = z.object({ userId: id, sessionId: id, workspaceId: id, isPrimary: z.boolean() });
export type VisibleAccessFailure = "authority-changed" | "grant-unavailable" | "grant-changed" | "aborted" | "refresh-failed" | "operation-failed";
export class VisibleAccessError extends Error {
  readonly code: VisibleAccessFailure;
  readonly reconnectRequired: boolean;
  constructor(code: VisibleAccessFailure, reconnectRequired = false) {
    super("Visible Drive access is unavailable");
    this.code = code;
    this.reconnectRequired = reconnectRequired;
    this.name = "VisibleAccessError";
  }
}
export interface VisibleAccessOptions {
  readonly db: DatabaseSync;
  readonly protector: VisibleTokenProtector;
  readonly account: FollowUpAccount;
  /** Re-resolve the actual BetterAuth session and CURRENT membership, never
   * return a client-supplied workspace or an email-derived account. */
  readonly readCurrentAccount: () => FollowUpAccount | null;
  readonly provider: Pick<VisibleFileOAuthProvider, "refresh">;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}
function refuse(code: VisibleAccessFailure, reconnect = false): never { throw new VisibleAccessError(code, reconnect); }
function custody(options: VisibleAccessOptions, userId: string): string {
  const row = options.db.prepare("SELECT userId, googleSub, accessToken, refreshToken, expiresAt, scopes, generation FROM drive_visible_grants WHERE userId = ?").get(userId);
  if (!row) refuse("grant-unavailable", true);
  // Only a private digest is held; no ciphertext/plaintext reaches the API.
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

export interface VisibleAccessLease {
  readonly googleSub: string;
  assertCurrent(): void;
  /** One awaited client operation. Guard each step of a multi-request job;
   * this is not a rollback promise for an already-sent remote request. */
  run<T>(operation: (accessToken: string) => Promise<T>): Promise<T>;
}

export async function acquireVisibleAccess(options: VisibleAccessOptions): Promise<VisibleAccessLease> {
  const parsed = accountSchema.safeParse(options.account);
  if (!parsed.success) refuse("authority-changed");
  const account = parsed.data;
  const signature = JSON.stringify(account);
  const now = options.now ?? Date.now;
  const authority = () => {
    if (options.signal?.aborted) refuse("aborted");
    let current: ReturnType<typeof accountSchema.safeParse>;
    try { current = accountSchema.safeParse(options.readCurrentAccount()); }
    catch { refuse("authority-changed"); }
    if (!current.success || JSON.stringify(current.data) !== signature) refuse("authority-changed");
  };
  authority();
  let grant: VisibleFileGrant;
  let stamp: string;
  try {
    const saved = getVisibleGrant(options.db, account.userId, options.protector);
    if (!saved) refuse("grant-unavailable", true);
    grant = saved;
    stamp = custody(options, account.userId);
  } catch (error) {
    if (error instanceof VisibleAccessError) throw error;
    refuse("grant-unavailable", true);
  }
  const assertCurrent = () => {
    authority();
    try {
      if (custody(options, account.userId) !== stamp || !isVisibleGrantCurrent(options.db, grant, options.protector)) refuse("grant-changed");
    } catch (error) {
      if (error instanceof VisibleAccessError) throw error;
      refuse("grant-changed");
    }
  };
  assertCurrent();
  if (grant.expiresAt <= now() + 60_000) {
    try {
      const replacement = await options.provider.refresh(grant);
      assertCurrent();
      if (!Number.isSafeInteger(replacement.expiresAt) || replacement.expiresAt <= now()) refuse("refresh-failed");
      grant = refreshVisibleGrant(options.db, grant, replacement, options.protector);
      stamp = custody(options, account.userId);
    } catch (error) {
      // Check cancellation/new winners even on provider failure. Never delete
      // a usable grant or expose the upstream error/token in a response.
      assertCurrent();
      if (error instanceof VisibleAccessError) throw error;
      refuse("refresh-failed", error instanceof VisibleFileOAuthRefreshError && error.reconnectRequired);
    }
  }
  assertCurrent();
  return Object.freeze({
    googleSub: grant.googleSub,
    assertCurrent,
    async run<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
      assertCurrent();
      if (grant.expiresAt <= now()) refuse("grant-unavailable", true);
      try {
        const result = await operation(grant.accessToken);
        assertCurrent();
        return result;
      } catch (error) {
        assertCurrent();
        if (error instanceof VisibleAccessError) throw error;
        refuse("operation-failed");
      }
    },
  });
}
