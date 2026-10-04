import { createAuthClient } from "better-auth/client";
import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createSessionRecovery, INITIAL_SESSION, SESSION_UNAVAILABLE, type SessionPayload } from "./session-recovery";
import { authDestination } from "./auth-navigation";
import { sessionRecheck } from "./session-recheck";

// The server always serves the API from the same origin/port as the UI
// (both dev proxy and the packaged/hosted server put them together), so
// same-origin is correct here. Hardcoding a port breaks any deployment
// that isn't literally on :8799 (custom OMB_PORT, reverse proxies, etc.).
export const authClient = createAuthClient({
  baseURL: window.location.origin,
});

type AuthUser = SessionPayload["user"];
type AuthSession = SessionPayload["session"];

/** Which optional auth features the server actually has wired up. */
export interface AuthCapabilities {
  /** Email verification is enforced (needs a mail transport). */
  emailVerification: boolean;
  /** "Forgot password" can deliver a mail, so the link is worth showing. */
  passwordReset: boolean;
  /** Configured social providers, e.g. ["github", "google"]. */
  socialProviders: string[];
  /** Manual sign-UP is off — new accounts must use a social provider.
   * Existing accounts still sign in with a password unaffected. */
  googleOnlySignup: boolean;
  /** Desktop Google sign-in: this server knows a cloud to pair against. */
  cloudPairing: boolean;
  /** Real Google sign-in on the desktop via the cloud OAuth handoff
   * (cloud does the Google dance, identity arrives over loopback). */
  desktopOAuth?: boolean;
  /** The cloud base URL the pairing flow opens in the system browser. */
  pairingCloudUrl: string | null;
  /** Server offers email + 6-digit one-time-code sign-in (Better Auth's
   * emailOTP plugin, policy-wrapped server-side). Optional so a server
   * older than the rollout just hides the flow instead of breaking. */
  emailOtp?: boolean;
}

const NO_CAPABILITIES: AuthCapabilities = {
  emailVerification: false,
  passwordReset: false,
  socialProviders: [],
  googleOnlySignup: false,
  cloudPairing: false,
  pairingCloudUrl: null,
  emailOtp: false,
};

/**
 * How long a referral redemption may take before it is abandoned.
 *
 * A referral is a bonus, not an entitlement, so it must never be able to hold an already-authenticated
 * user on an auth page. The old code awaited `fetch` with no bound: a request that was accepted but
 * never settled left the caller awaiting forever, which is worse than a rejection — a rejection at
 * least returned. The deadline converts "never settles" into the ordinary `unreachable` outcome.
 *
 * Two independent bounds are used rather than one. An `AbortSignal` stops an implementation that
 * honours it; a real fetch does, but nothing guarantees the fetch on the other end of the seam does,
 * and a race whose only bound is a signal the transport ignores is a bound on nothing.
 */
export const REFERRAL_DEADLINE_MS = 2000;

export type ReferralOutcome = "skipped" | "redeemed" | "rejected" | "unreachable";

export interface RedeemReferralOptions {
  /** Injectable so a stalled-response test does not have to wait out the real deadline. */
  readonly deadlineMs?: number;
}

/**
 * Redeems a referral code, and only ever after a session is confirmed.
 *
 *  - **After a session.** The server answers `401 sign in before redeeming a referral code` without
 *    one, so an early call would attribute the referral to nobody and lose it.
 *  - **Never blocks sign-in.** Every outcome is returned so a caller can report it without failing,
 *    and the whole call is bounded by {@link REFERRAL_DEADLINE_MS}.
 *  - **A rejection is reported, not swallowed.** An invalid code is indistinguishable from no call
 *    only if the response is discarded; it is not.
 */
export async function redeemReferral(
  ref: string | null,
  options: RedeemReferralOptions = {},
): Promise<ReferralOutcome> {
  if (!ref) return "skipped";
  const deadlineMs = options.deadlineMs ?? REFERRAL_DEADLINE_MS;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), deadlineMs);
  let expire: () => void = () => undefined;
  const expired = new Promise<void>((resolve) => { expire = resolve; });
  const expiryTimer = setTimeout(expire, deadlineMs);
  try {
    type Settled = { timedOut: true } | { timedOut: false; response: Response | null };
    const request: Promise<Settled> = fetch("/api/referral/redeem", {
      method: "POST", headers: { "content-type": "application/json" },
      credentials: "include", body: JSON.stringify({ code: ref }),
      signal: controller.signal,
    }).then(
      (response): Settled => ({ timedOut: false, response }),
      (): Settled => ({ timedOut: false, response: null }),
    );
    const settled = await Promise.race<Settled>([
      request,
      expired.then((): Settled => ({ timedOut: true })),
    ]);
    if (settled.timedOut) return "unreachable";
    if (settled.response === null) return "unreachable";
    return settled.response.ok ? "redeemed" : "rejected";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(expiryTimer);
  }
}

/**
 * Holds a referral across the OAuth round trip.
 *
 * `src/lib/auth-navigation.ts` already owns the identical problem for pairing codes
 * (`stashPairReturn`) and its reasoning applies unchanged: the return path must not carry it in a
 * query string, so the value is stashed for the duration of one redirect instead. `ref` here rides
 * the same-tab `sessionStorage`, which survives the redirect `signIn.social` performs and is
 * scoped to the tab that started it.
 *
 * That file is outside this slice's claim, so the pair is defined beside the redemption it serves
 * and the move to `auth-navigation.ts` is proposed rather than made.
 */
const REFERRAL_STASH_KEY = "muster.referral";

export function stashReferral(ref: string | null): void {
  try {
    if (ref) globalThis.sessionStorage?.setItem(REFERRAL_STASH_KEY, ref);
    else globalThis.sessionStorage?.removeItem(REFERRAL_STASH_KEY);
  } catch {
    // storage unavailable (private mode): the referral is lost, not leaked
  }
}

/** Consumes the stashed referral: reading removes it, so a stash is one redirect old. */
export function takeStashedReferral(): string | null {
  try {
    const stashed = globalThis.sessionStorage?.getItem(REFERRAL_STASH_KEY);
    globalThis.sessionStorage?.removeItem(REFERRAL_STASH_KEY);
    return stashed || null;
  } catch {
    return null;
  }
}

/** Coerces one server payload into capabilities. `null` means the server could not answer with the
 *  shape — which the caller surfaces as a capability error rather than as "no optional flows". */
export async function requestCapabilities(
  origin: string,
  get: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<AuthCapabilities | null> {
  try {
    const res = await get(`${origin}/api/auth-capabilities`, { credentials: "include" });
    if (!res.ok) return null;
    // SAFETY: /api/auth-capabilities serves the AuthCapabilities shape or a non-2xx status
    // (rejected above); every field below is coerced individually, so an unexpected payload only
    // hides optional flows rather than breaking the sign-in page.
    const data = (await res.json()) as Partial<AuthCapabilities>;
    return {
      emailVerification: Boolean(data.emailVerification),
      passwordReset: Boolean(data.passwordReset),
      socialProviders: Array.isArray(data.socialProviders) ? data.socialProviders : [],
      googleOnlySignup: Boolean(data.googleOnlySignup),
      cloudPairing: Boolean(data.cloudPairing),
      desktopOAuth: Boolean(data.desktopOAuth),
      pairingCloudUrl: data.pairingCloudUrl ?? null,
      emailOtp: Boolean(data.emailOtp),
    };
  } catch {
    return null;
  }
}

interface AuthContextType {
  user: AuthUser | null;
  session: AuthSession | null;
  loading: boolean;
  sessionError: string | null;
  retrySession: () => Promise<boolean>;
  capabilities: AuthCapabilities;
  /** The capability endpoint could not be read, so optional flows are hidden for an unknown
   *  reason. Distinct from "this server has no optional flows": that is a fact about the server,
   *  this is a failure to find out, and a user can do something about it. */
  capabilitiesError: boolean;
  retryCapabilities: () => Promise<boolean>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (name: string, email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  signInWithProvider: (provider: string) => Promise<{ error?: string }>;
  requestPasswordReset: (email: string) => Promise<{ error?: string }>;
  resetPassword: (token: string, newPassword: string) => Promise<{ error?: string }>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState(INITIAL_SESSION);
  const [recovery] = useState(() => createSessionRecovery(setAuth));
  const { user, session } = auth;
  const loading = auth.status === "loading";
  const [capabilities, setCapabilities] = useState<AuthCapabilities>(NO_CAPABILITIES);
  const [capabilitiesError, setCapabilitiesError] = useState(false);

  // Bind the account before newly mounted workspace passive effects start
  // their API requests; a replaced binding fences requests from the old user.
  useLayoutEffect(() => sessionRecheck.register(async () => { await recovery.refresh({ background: true }); }), [recovery, user?.id]);

  useEffect(() => {
    void recovery.refresh();
    void fetchCapabilities();
    return recovery.cancel;
  }, [recovery]);

  /** Ask the server which optional flows exist, so the UI never offers a
   *  button that cannot work — a "forgot password" link that silently drops
   *  the mail is worse than no link.
   *
   *  A failure used to return early and leave the page permanently silent: the
   *  flows stayed hidden with no way to tell a server that has none from a
   *  request that never arrived. Now a failure is recorded and surfaced, so the
   *  page can offer a retry instead of a wrong answer. */
  async function fetchCapabilities(): Promise<boolean> {
    const loaded = await requestCapabilities(window.location.origin, (url, init) => fetch(url, init));
    if (!loaded) {
      setCapabilitiesError(true);
      return false;
    }
    setCapabilities(loaded);
    setCapabilitiesError(false);
    return true;
  }

  // A referral carried through Google's OAuth return arrives here: the redirect lands on the
  // workspace, not on an auth page, so nothing there can redeem it. The session is the gate the
  // server requires, so this is the first point at which redemption is both possible and correct.
  const confirmed = auth.status === "ready" && Boolean(auth.user);
  useEffect(() => {
    if (!confirmed) return;
    const stashed = takeStashedReferral();
    if (!stashed) return;
    // An auth page carrying this same code in its own URL owns it for this page load and redeems
    // it after the sign-in it just performed. Redeeming here too would spend the same code twice,
    // so the stash is dropped rather than left to fire later against a code already used.
    if (new URLSearchParams(window.location.search).get("ref") === stashed) return;
    void redeemReferral(stashed);
  }, [confirmed]);

  async function retrySession() {
    void fetchCapabilities();
    const checked = await recovery.refresh();
    return checked?.status === "ready" && Boolean(checked.user);
  }

  /** The visible retry behind the capability failure notice. Resolves true only when the server
   *  actually answered, which is the condition under which optional flows become visible again. */
  async function retryCapabilities(): Promise<boolean> {
    return fetchCapabilities();
  }

  async function signIn(email: string, password: string): Promise<{ error?: string }> {
    try {
      const res = await authClient.signIn.email({ email, password });
      if (res.error) return { error: res.error.message ?? "Sign in failed" };
      const checked = await recovery.refresh();
      if (!checked || checked.status !== "ready") return { error: SESSION_UNAVAILABLE };
      if (!checked.user) return { error: "Sign-in did not establish a session. Please try again." };
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Sign in failed" };
    }
  }

  async function signUp(name: string, email: string, password: string): Promise<{ error?: string }> {
    try {
      const res = await authClient.signUp.email({ name, email, password });
      if (res.error) return { error: res.error.message ?? "Sign up failed" };
      const checked = await recovery.refresh();
      if (!checked || checked.status !== "ready") return { error: SESSION_UNAVAILABLE };
      if (!checked.user) return { error: "Sign-up did not establish a session. Please try signing in." };
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Sign up failed" };
    }
  }

  async function signOut() {
    const result = await authClient.signOut();
    if (result.error) throw new Error(result.error.message ?? "Sign out failed");
    recovery.clear();
  }

  /** Hand off to an OAuth provider. On success the browser is redirected, so
   *  this only ever returns to report a failure.
   *
   *  Any existing session is cleared first. Without this, picking a
   *  different Google account while already signed in bounces straight back
   *  to the original account — the stale session cookie wins over the
   *  account chosen in the OAuth flow. Signing out here makes the choice
   *  real; on the sign-in page that is exactly what the user asked for. */
  async function signInWithProvider(provider: string): Promise<{ error?: string }> {
    try {
      try {
        const result = await authClient.signOut();
        if (!result.error) recovery.clear();
      } catch {
        // best effort — proceed with the OAuth handoff regardless
      }
      // SAFETY: provider arrives from the sign-in buttons rendered for the
      // configured socialProviders list ("google" today), which is exactly
      // the provider union better-auth's social() accepts.
      const res = await authClient.signIn.social({
        provider: provider as Parameters<typeof authClient.signIn.social>[0]["provider"],
        // relative, not absolute: better-auth allows relative paths for
        // callbackURL regardless of its trustedOrigins list, so this also
        // passes on deployments whose PUBLIC_BASE_URL doesn't match the
        // browser origin (self-hosts that never set OMB_PUBLIC_HOST)
        callbackURL: authDestination(new URLSearchParams(window.location.search).get("next")),
      });
      if (res.error) return { error: res.error.message ?? `Could not sign in with ${provider}` };
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : `Could not sign in with ${provider}` };
    }
  }

  async function requestPasswordReset(email: string): Promise<{ error?: string }> {
    try {
      const res = await authClient.requestPasswordReset({
        email,
        // relative for the same trustedOrigins reason as the OAuth callbackURL
        redirectTo: "/reset-password",
      });
      if (res.error) return { error: res.error.message ?? "Could not send the reset email" };
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Could not send the reset email" };
    }
  }

  async function resetPassword(token: string, newPassword: string): Promise<{ error?: string }> {
    try {
      const res = await authClient.resetPassword({ token, newPassword });
      if (res.error) return { error: res.error.message ?? "Could not reset the password" };
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Could not reset the password" };
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        sessionError: auth.status === "unavailable" ? SESSION_UNAVAILABLE : null,
        retrySession,
        capabilities,
        capabilitiesError,
        retryCapabilities,
        signIn,
        signUp,
        signOut,
        signInWithProvider,
        requestPasswordReset,
        resetPassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
