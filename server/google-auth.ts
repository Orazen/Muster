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
 * here: drive.* is RESTRICTED at Google, and requesting it at login shows
 * every new user the "Google hasn't verified this app" interstitial. The
 * separate Drive connect consent lives in server/drive-oauth.ts and asks
 * for `openid drive.appdata` on its own.
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
