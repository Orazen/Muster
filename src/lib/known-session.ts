// What the app currently KNOWS about the session, for code that cannot read
// React state.
//
// Why this exists. `api()` in src/state/store.tsx bounces the browser to
// /sign-in on ANY 401 from ANY /api/* route, because an expired session used to
// 401 every hydrate call into silent `.catch()` sinks and left the user with a
// permanently empty app instead of a login page. That reasoning is sound. The
// implementation was too broad: three endpoints answer 401 to a genuinely
// signed-in user on a local install (`/api/user-keys` and both
// `/api/account/merge/*`), because `requestUserId` is only assigned under
// SELF_HOSTED. So saving a provider API key navigated you to the sign-in page
// while you were signed in, and that page then said "Already signed in as ...".
//
// The fix is not to weaken the eject — an empty app is a real failure — but to
// make it answer a question it can actually answer. `AuthProvider` already
// knows the session: `status: "ready"` with no user is the ONLY confirmed
// signed-out state. `unavailable` (a 502, a proxy HTML page, a network blip) and
// `loading` both mean "we do not know", and neither should throw the user out
// of a working session. This module is the one place that knowledge crosses
// from React into the module-level `api()` helper, which has no other way to
// reach it.
//
// Zero round trips: the value is already in memory. `AuthGate` remains the SPA
// redirector for the case React can see directly, and is unchanged.

/** `true` only when the app has positively established that nobody is signed
 *  in. Starts `false` because "not loaded yet" is not "signed out", and
 *  defaulting to true would reintroduce the very bug this replaces. */
let confirmedSignedOut = false;

/** Publish what `AuthProvider` knows. `signedIn` is `null` while loading or
 *  unavailable — both of which clear the flag, so a transient failure can never
 *  strand a signed-in user on a page that has already navigated away. */
export function noteKnownSession(signedIn: boolean | null): void {
  confirmedSignedOut = signedIn === false;
}

/** Has the app confirmed that the session is gone? Read by the 401 handlers. */
export function isSessionConfirmedSignedOut(): boolean {
  return confirmedSignedOut;
}

/** Test seam: the module is a singleton, so a test that publishes a session
 *  needs to put it back. */
export function resetKnownSession(): void {
  confirmedSignedOut = false;
}
