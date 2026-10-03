// The one home for "is Google configured on this install" and for the
// sign-in scope list. Google sign-in and the account-linked Drive connect
// share a single env credential pair (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
// — env only, never literals) but deliberately never a single consent:
// sign-in stays basic-scope, the Drive connect asks for drive.appdata in its
// own separate round trip (docs/plans/local-first-architecture-plan-
// 2026-09-23.md, phases 5 and 7). Keeping both predicates here means the
// social-provider advertisement, the Drive capability answer, and the two
// redirect tests can never drift into disagreeing about what is configured.

/**
 * Basic identity scopes for SIGN-IN only. A Drive scope must never appear
 * here: Drive connect is a separate, deliberate consent step, so a user can
 * see and decline it rather than having it bundled into first-run sign-in.
 *
 * Scope sensitivity is NOT uniform across drive.*: drive.appdata,
 * drive.appfolder, drive.install and drive.file are NON-SENSITIVE, while
 * auth/drive, drive.readonly and drive.metadata are restricted. Do not
 * generalise from one to the other.
 * https://developers.google.com/workspace/drive/api/guides/api-specific-auth
 *
 * Note that GOOGLE_DRIVE_SCOPE below is deliberately the restricted
 * auth/drive string: it is a namespace prefix for the drive-scope predicate,
 * not a scope this app requests.
 */
export const GOOGLE_SIGNIN_SCOPES = ["openid", "email", "profile"] as const;

const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/**
 * True for any Google Drive scope (drive, drive.file, drive.appdata,
 * drive.readonly, …) and for no lookalike outside that namespace. The
 * sign-in redirect must never carry one — this is the predicate the
 * redirect-scope tests use to prove it.
 */
export function isDriveScope(scope: string): boolean {
  return scope === GOOGLE_DRIVE_SCOPE || scope.startsWith(`${GOOGLE_DRIVE_SCOPE}.`);
}

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * The credential pair, or null. Trims both halves, and a half pair counts
 * as absent: a half-configured provider would advertise a sign-in button
 * (or a Drive connect button) that can only ever fail. `env` is a
 * parameter so tests can pin the truth table without mutating the process.
 */
export function googleCredentials(env: NodeJS.ProcessEnv = process.env): GoogleCredentials | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Capability gate for the account-linked Drive connect. Same pair as
 * sign-in on purpose: an install without credentials must not advertise
 * `accountDrive.available` (a connect button whose consent URL could never
 * be built) and must answer a direct connect attempt with the exact
 * unavailable body instead of a broken redirect.
 */
export function googleDriveConnectConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return googleCredentials(env) !== null;
}
