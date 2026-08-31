import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Loader2 } from "lucide-react";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-app">
        <Loader2 size={20} className="animate-spin text-ink-secondary" />
      </div>
    );
  }

  if (!user) {
    // `next` carries the destination through sign-in so deep links like
    // /pair survive the auth round trip.
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/sign-in?next=${next}`} replace />;
  }

  return <>{children}</>;
}
