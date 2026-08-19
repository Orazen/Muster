import { createAuthClient } from "better-auth/client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// The server always serves the API from the same origin/port as the UI
// (both dev proxy and the packaged/hosted server put them together), so
// same-origin is correct here. Hardcoding a port breaks any deployment
// that isn't literally on :8799 (custom OMB_PORT, reverse proxies, etc.).
export const authClient = createAuthClient({
  baseURL: window.location.origin,
});

interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  image?: string | null;
}

interface AuthSession {
  id: string;
  userId: string;
  expiresAt: Date;
  token: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Which optional auth features the server actually has wired up. */
export interface AuthCapabilities {
  /** Email verification is enforced (needs a mail transport). */
  emailVerification: boolean;
  /** "Forgot password" can deliver a mail, so the link is worth showing. */
  passwordReset: boolean;
  /** Configured social providers, e.g. ["github", "google"]. */
  socialProviders: string[];
}

const NO_CAPABILITIES: AuthCapabilities = {
  emailVerification: false,
  passwordReset: false,
  socialProviders: [],
};

interface AuthContextType {
  user: AuthUser | null;
  session: AuthSession | null;
  loading: boolean;
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
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState<AuthCapabilities>(NO_CAPABILITIES);

  useEffect(() => {
    fetchSession();
    fetchCapabilities();
  }, []);

  /** Ask the server which optional flows exist, so the UI never offers a
   *  button that cannot work — a "forgot password" link that silently drops
   *  the mail is worse than no link. */
  async function fetchCapabilities() {
    try {
      const base = window.location.origin;
      const res = await fetch(`${base}/api/auth-capabilities`, { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as Partial<AuthCapabilities>;
      setCapabilities({
        emailVerification: Boolean(data.emailVerification),
        passwordReset: Boolean(data.passwordReset),
        socialProviders: Array.isArray(data.socialProviders) ? data.socialProviders : [],
      });
    } catch {
      // Server too old or unreachable — leave every optional flow hidden.
    }
  }

  async function fetchSession() {
    try {
      const base = window.location.origin;
      const res = await fetch(`${base}/api/auth/session`, { credentials: "include" });
      const data = await res.json();
      if (data?.user) {
        setUser(data.user);
        setSession(data.session);
      }
    } catch {
      // session endpoint unreachable or no session
    } finally {
      setLoading(false);
    }
  }

  async function signIn(email: string, password: string): Promise<{ error?: string }> {
    try {
      const res = await authClient.signIn.email({ email, password });
      if (res.error) return { error: res.error.message ?? "Sign in failed" };
      await fetchSession();
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Sign in failed" };
    }
  }

  async function signUp(name: string, email: string, password: string): Promise<{ error?: string }> {
    try {
      const res = await authClient.signUp.email({ name, email, password });
      if (res.error) return { error: res.error.message ?? "Sign up failed" };
      await fetchSession();
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Sign up failed" };
    }
  }

  async function signOut() {
    await authClient.signOut();
    setUser(null);
    setSession(null);
  }

  /** Hand off to an OAuth provider. On success the browser is redirected, so
   *  this only ever returns to report a failure. */
  async function signInWithProvider(provider: string): Promise<{ error?: string }> {
    try {
      const res = await authClient.signIn.social({
        provider: provider as Parameters<typeof authClient.signIn.social>[0]["provider"],
        callbackURL: `${window.location.origin}/app`,
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
        redirectTo: `${window.location.origin}/reset-password`,
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
