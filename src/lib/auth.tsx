import { createAuthClient } from "better-auth/client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export const authClient = createAuthClient({
  baseURL: `${window.location.protocol}//${window.location.hostname}:8799`,
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

interface AuthContextType {
  user: AuthUser | null;
  session: AuthSession | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (name: string, email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSession();
  }, []);

  async function fetchSession() {
    try {
      const base = `${window.location.protocol}//${window.location.hostname}:8799`;
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

  return (
    <AuthContext.Provider value={{ user, session, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
