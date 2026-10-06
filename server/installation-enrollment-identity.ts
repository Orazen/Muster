// Unwired identity adapter for W2. This verifies an ID token and current
// account membership; it creates no OAuth callback, enrollment intent,
// installation, credential or grant. Ordinary sign-in and provider scopes
// are unchanged. The integrator must still supply the trusted deployment
// configuration and a current server-held attempt from its own completion
// flow. Neither is inferred from an ID token, email, request body or origin.

import type { DatabaseSync } from "node:sqlite";
import { decodeJwt, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

import { createGoogleIdTokenVerifier } from "./calendar-oauth.ts";
import { resolveFollowUpAccount } from "./follow-up-identity.ts";
import {
  canonicalIssuerWire,
  enrollmentBindingWire,
  enrollmentPlatformWire,
  type EnrollmentBinding,
  type EnrollmentPlatform,
  type TrustedCloudConfig,
} from "./installation-enrollment-contract.ts";

const identifier = z.string().min(1).max(200).refine(value => value.trim() === value);
const nonempty = z.string().min(1).refine(value => value.trim().length > 0);
const redirectPolicy = z.object({
  macos: z.string().max(2048), ios: z.string().max(2048),
  watchos: z.string().max(2048), android: z.string().max(2048),
  windows: z.string().max(2048), linux: z.string().max(2048),
  cli: z.string().max(2048), web: z.string().max(2048),
});
const configurationWire = z.object({
  clientId: nonempty.max(512).refine(value => value.trim() === value),
  trusted: z.object({ issuer: canonicalIssuerWire.max(128), approvedRedirects: redirectPolicy }),
});
const contextWire = z.object({
  session: z.object({ userId: identifier, sessionId: identifier }),
  attempt: z.object({
    id: identifier,
    nonce: nonempty.max(512),
    clientKey: z.string().min(16).max(256),
    platform: enrollmentPlatformWire,
    redirect: nonempty.max(2048),
    expiresAt: z.number().int().nonnegative().max(8.64e15),
  }),
});
const expiryWire = z.union([
  z.number().int().max(8.64e15),
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
]);
const providerRowsWire = z.array(z.object({ id: identifier, accountId: nonempty.max(256) })).length(1);

export interface EnrollmentIdentityConfiguration {
  /** The explicit Google ID-token audience, independent of Calendar/Drive consent. */
  readonly clientId: string;
  /** The integrator's W2 authority, not Google's ID-token issuer. No default. */
  readonly trusted: TrustedCloudConfig;
}

export interface EnrollmentIdentityContext {
  readonly session: { readonly userId: string; readonly sessionId: string };
  /** A current server-held attempt, never fields echoed from a client. This
   * adapter does not create or consume it, or validate state/PKCE on its behalf. */
  readonly attempt: {
    readonly id: string;
    readonly nonce: string;
    readonly clientKey: string;
    readonly platform: EnrollmentPlatform;
    readonly redirect: string;
    readonly expiresAt: number;
  };
}

export interface EnrollmentIdentityDependencies {
  readonly db: DatabaseSync;
  /** Must authenticate the same request through the host's signed-session
   * API and read its current server-held attempt on EVERY call. A local
   * account lookup, loopback trust or client-provided session is insufficient. */
  readonly context: () => Promise<EnrollmentIdentityContext | null>;
  readonly now?: () => number;
  /** Local signed-JWT/JWKS test seam, as in createGoogleIdTokenVerifier.
   * Production omits it and uses the actual Google JWKS resolver. */
  readonly keyResolver?: JWTVerifyGetKey;
}

export type EnrollmentIdentityFailure =
  | "not-configured" | "attempt" | "redirect" | "expired" | "cancelled"
  | "id-token" | "provider-subject" | "local-session" | "workspace" | "context-changed";
export type EnrollmentIdentityResult =
  | { readonly ok: true; readonly value: EnrollmentBinding }
  | { readonly ok: false; readonly reason: EnrollmentIdentityFailure };

type Context = z.infer<typeof contextWire>;
interface CurrentAccount {
  readonly workspaceId: string;
  readonly providerAccountId: string;
  readonly subject: string;
}
type AccountResult = { ok: true; value: CurrentAccount } | { ok: false; reason: "local-session" | "workspace" | "provider-subject" | "expired" | "id-token" };

function currentAccount(db: DatabaseSync, context: Context, at: number): AccountResult {
  try {
    // The signed-session reader is required in addition to this lookup. A
    // caller naming an extant session row does not authenticate its cookie.
    const row = db.prepare('SELECT s."expiresAt" FROM "session" s JOIN "user" u ON u."id" = s."userId" WHERE s."id" = ? AND s."userId" = ?')
      .get(context.session.sessionId, context.session.userId);
    const expiry = z.object({ expiresAt: expiryWire }).safeParse(row);
    if (!expiry.success) return { ok: false, reason: "local-session" };
    const numericExpiry = z.number().safeParse(expiry.data.expiresAt);
    const expiresAt = numericExpiry.success ? numericExpiry.data : Date.parse(z.string().parse(expiry.data.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= at) return { ok: false, reason: "local-session" };
    const account = resolveFollowUpAccount(db, context.session, false);
    if (account === null || account.workspaceId.length > 128) return { ok: false, reason: "workspace" };
    // BetterAuth's provider accountId is Google's linked subject. Reading
    // it needs no Calendar/Drive grant and never matches an email address.
    const provider = providerRowsWire.safeParse(db.prepare('SELECT "id", "accountId" FROM "account" WHERE "userId" = ? AND "providerId" = ?')
      .all(context.session.userId, "google"));
    if (!provider.success) return { ok: false, reason: "provider-subject" };
    return { ok: true, value: { workspaceId: account.workspaceId,
      providerAccountId: provider.data[0].id, subject: provider.data[0].accountId } };
  } catch {
    return { ok: false, reason: "local-session" };
  }
}

function sameContext(left: Context, right: Context): boolean {
  return left.session.userId === right.session.userId && left.session.sessionId === right.session.sessionId
    && left.attempt.id === right.attempt.id && left.attempt.nonce === right.attempt.nonce
    && left.attempt.clientKey === right.attempt.clientKey && left.attempt.platform === right.attempt.platform
    && left.attempt.redirect === right.attempt.redirect && left.attempt.expiresAt === right.attempt.expiresAt;
}

/** Produces only the existing W2 binding. Missing deployment trust, Google
 * audience or the selected platform's callback refuses without JWT work.
 * Constructing this resolver does not enable enrollment or wire a route. */
export function createEnrollmentIdentityResolver(
  configuration: EnrollmentIdentityConfiguration | null | undefined,
  dependencies: EnrollmentIdentityDependencies,
): (idToken: string, signal?: AbortSignal) => Promise<EnrollmentIdentityResult> {
  // Parse into fresh objects so mutating the caller's configuration while
  // verification awaits cannot silently change the accepted trust binding.
  const config = configurationWire.safeParse(configuration);
  const verify = config.success ? createGoogleIdTokenVerifier(config.data.clientId, dependencies.keyResolver) : null;
  const now = dependencies.now ?? Date.now;
  return async (idToken, signal) => {
    if (!config.success || verify === null) return { ok: false, reason: "not-configured" };
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    const read = async (): Promise<Context | null> => {
      try {
        const parsed = contextWire.safeParse(await dependencies.context());
        return parsed.success ? parsed.data : null;
      } catch { return null; }
    };
    const initial = await read();
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    if (initial === null) return { ok: false, reason: "attempt" };
    const approvedRedirect = config.data.trusted.approvedRedirects[initial.attempt.platform];
    if (!approvedRedirect.trim() || initial.attempt.redirect !== approvedRedirect) return { ok: false, reason: "redirect" };
    const at = now();
    if (!Number.isFinite(at) || initial.attempt.expiresAt <= at) return { ok: false, reason: "expired" };
    const account = currentAccount(dependencies.db, initial, at);
    if (!account.ok) return account;
    if (!nonempty.max(64 * 1024).safeParse(idToken).success) return { ok: false, reason: "id-token" };
    let subject: string;
    let tokenExpiresAt: number;
    try {
      subject = await verify(idToken, initial.attempt.nonce);
      // Decode only the exact bytes that the real verifier just accepted.
      // Retain its signed expiry for the subsequent signed-session await.
      tokenExpiresAt = z.number().finite().positive().parse(decodeJwt(idToken).exp) * 1000;
    }
    catch { return { ok: false, reason: signal?.aborted ? "cancelled" : "id-token" }; }
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    // Check the database immediately after token verification, then again
    // after re-authenticating the signed session/held attempt. Every await
    // is followed by current cancellation, expiry and account checks.
    const check = (): AccountResult => {
      const checkedAt = now();
      if (!Number.isFinite(checkedAt) || initial.attempt.expiresAt <= checkedAt) return { ok: false, reason: "expired" };
      if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= checkedAt) return { ok: false, reason: "id-token" };
      return currentAccount(dependencies.db, initial, checkedAt);
    };
    const verifiedAccount = check();
    if (!verifiedAccount.ok) return verifiedAccount;
    const current = await read();
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    if (current === null || !sameContext(initial, current)) return { ok: false, reason: "context-changed" };
    const finalAccount = check();
    if (!finalAccount.ok) return finalAccount;
    if (finalAccount.value.workspaceId !== account.value.workspaceId
      || finalAccount.value.providerAccountId !== account.value.providerAccountId
      || finalAccount.value.subject !== account.value.subject
      || verifiedAccount.value.workspaceId !== account.value.workspaceId
      || verifiedAccount.value.providerAccountId !== account.value.providerAccountId
      || verifiedAccount.value.subject !== account.value.subject) return { ok: false, reason: "context-changed" };
    if (subject !== finalAccount.value.subject) return { ok: false, reason: "provider-subject" };
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    const binding = enrollmentBindingWire.safeParse({
      cloudSubject: subject, cloudIssuer: config.data.trusted.issuer, cloudAuthority: config.data.trusted.issuer,
      workspaceId: finalAccount.value.workspaceId, clientKey: initial.attempt.clientKey,
      localOwnerId: initial.session.userId, localSessionId: initial.session.sessionId, cloudSessionValid: true,
    });
    return binding.success ? { ok: true, value: binding.data } : { ok: false, reason: "provider-subject" };
  };
}
