import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Loader2 } from "lucide-react";
import { AuthShell, authButtonCls } from "./AuthShell";
import { authGateReturnPath } from "@/lib/auth-navigation";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, sessionError, retrySession } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-3 bg-app" role="status">
        <Loader2 size={20} className="animate-spin motion-reduce:animate-none text-ink-secondary" aria-hidden="true" />
        <span className="text-sm text-ink-secondary">Checking your sign-in…</span>
      </div>
    );
  }

  if (sessionError) {
    return <AuthShell title="Let’s reconnect" subtitle="Your sign-in check couldn’t finish.">
      <div className="auth-stack">
        <p role="alert" className="auth-notice auth-error">{sessionError}</p>
        <button type="button" className={authButtonCls} onClick={() => void retrySession()}>Try again</button>
      </div>
    </AuthShell>;
  }

  if (!user) {
    // `next` carries the destination through sign-in so deep links like
    // /pair survive the auth round trip.
    const next = encodeURIComponent(authGateReturnPath(location));
    return <Navigate to={`/sign-in?next=${next}`} replace />;
  }

  return <>{children}</>;
}
