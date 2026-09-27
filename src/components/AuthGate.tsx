import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Loader2 } from "lucide-react";
import { AuthShell, authButtonCls } from "./AuthShell";
import { authGateReturnPath, stashPairReturn, takeStashedPairReturn } from "@/lib/auth-navigation";

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
    // A /pair deep link carries its code in the fragment, and a fragment
    // must not be copied into `next` — a query string lands in access logs
    // and the code is a live 5-minute credential. The stash carries the
    // full return path across the round trip instead.
    const carried = location.pathname === "/pair" && location.hash;
    const next = encodeURIComponent(
      carried ? stashPairReturn(location.pathname, location.hash) : authGateReturnPath(location),
    );
    return <Navigate to={`/sign-in?next=${next}`} replace />;
  }

  // Back from sign-in: restore the stashed fragment before the page reads
  // it, synchronously through the URL so the mount sees the carried code.
  if (location.pathname === "/pair" && !location.hash) {
    const stashed = takeStashedPairReturn();
    const hash = stashed?.slice(stashed.indexOf("#"));
    if (hash) globalThis.history?.replaceState(null, "", `${location.pathname}${hash}`);
  }

  return <>{children}</>;
}
