import { createAuthClient } from "better-auth/client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createSessionRecovery, INITIAL_SESSION, SESSION_UNAVAILABLE, type SessionPayload } from "./session-recovery";
import { authDestination } from "./auth-navigation";

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
}

const NO_CAPABILITIES: AuthCapabilities = {
  emailVerification: false,
  passwordReset: false,
  socialProviders: [],
  googleOnlySignup: false,
  cloudPairing: false,
  pairingCloudUrl: null,
};

interface AuthContextType {
  user: AuthUser | null;
  session: AuthSession | null;
  loading: boolean;
  sessionError: string | null;
  retrySession: () => Promise<boolean>;
  capabilities: AuthCapabilities;
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

  useEffect(() => {
    void recovery.refresh();
    void fetchCapabilities();
    return recovery.cancel;
  }, [recovery]);

  /** Ask the server which optional flows exist, so the UI never offers a
   *  button that cannot work — a "forgot password" link that silently drops
   *  the mail is worse than no link. */
  async function fetchCapabilities() {
    try {
      const base = window.location.origin;
      const res = await fetch(`${base}/api/auth-capabilities`, { credentials: "include" });
      if (!res.ok) return;
      // SAFETY: /api/auth-capabilities serves the AuthCapabilities shape or a
      // non-2xx status (rejected above); every field below is coerced
      // individually, so an unexpected payload only hides optional flows.
      const data = (await res.json()) as Partial<AuthCapabilities>;
      setCapabilities({
        emailVerification: Boolean(data.emailVerification),
        passwordReset: Boolean(data.passwordReset),
        socialProviders: Array.isArray(data.socialProviders) ? data.socialProviders : [],
        googleOnlySignup: Boolean(data.googleOnlySignup),
        cloudPairing: Boolean(data.cloudPairing),
        desktopOAuth: Boolean(data.desktopOAuth),
        pairingCloudUrl: data.pairingCloudUrl ?? null,
      });
    } catch {
      // Server too old or unreachable — leave every optional flow hidden.
    }
  }

  async function retrySession() {
    void fetchCapabilities();
    const checked = await recovery.refresh();
    return checked?.status === "ready" && Boolean(checked.user);
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
