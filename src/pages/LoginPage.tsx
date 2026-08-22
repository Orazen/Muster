import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { SocialSignIn } from "@/components/SocialSignIn";
import { Star } from "lucide-react";

export function LoginPage() {
  const { signIn, capabilities, user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const justReset = params.get("reset") === "done";
  const next = params.get("next") ?? "/app";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // desktop pairing bridge: code typed from muster.orazen.online/pair
  const [pairCode, setPairCode] = useState("");
  const [pairBusy, setPairBusy] = useState(false);

  async function handlePair() {
    setError("");
    setPairBusy(true);
    try {
      const res = await fetch("/api/pair/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pairCode.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "pairing failed");
        return;
      }
      // the session cookie is set — reload auth state by hard-navigating
      window.location.href = next.startsWith("/") ? next : "/app";
    } catch {
      setError("could not reach the local server");
    } finally {
      setPairBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const result = await signIn(email, password);
    setLoading(false);
    if (result.error) {
      setError(result.error);
    } else {
      navigate(next.startsWith("/") ? next : "/app");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link to="/" className="inline-flex items-center gap-2 text-ink">
            <Star size={28} className="text-accent fill-accent" />
            <span className="text-xl font-semibold tracking-tight">Muster</span>
          </Link>
          <h1 className="mt-6 text-2xl font-bold text-ink">Sign in to your account</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            Welcome back. Sign in to access your agents.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-hairline bg-panel p-6">
          {!authLoading && user && (
            <div className="flex flex-col gap-2.5 rounded-lg bg-accent/10 px-4 py-3 text-sm text-ink">
              <span>
                Already signed in as <span className="font-semibold">{user.email}</span>.
              </span>
              <span className="flex gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => navigate("/app")}
                  className="font-semibold text-accent hover:text-accent/80"
                >
                  Continue as {user.name?.split(" ")[0] || "this user"}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await signOut();
                    setEmail("");
                  }}
                  className="text-ink-secondary hover:text-ink"
                >
                  Use another account
                </button>
              </span>
            </div>
          )}
          {justReset && (
            <div className="rounded-lg bg-accent/10 px-4 py-3 text-sm text-ink">
              Password updated. Sign in with your new one.
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
          )}

          <SocialSignIn action="Sign in" />

          {capabilities.cloudPairing && (
            // deliberately NOT a <form>: this sits inside the sign-in form,
            // and nested forms are illegal HTML that break the outer submit
            <div className="space-y-2.5 rounded-xl border border-hairline bg-inset p-4">
              <button
                type="button"
                onClick={() => {
                  const url = `${(capabilities.pairingCloudUrl ?? "").replace(/\/$/, "")}/pair`;
                  if (window.ogb?.openExternal) window.ogb.openExternal(url);
                  else window.open(url, "_blank", "noopener");
                }}
                className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-hairline bg-panel py-2.5 text-sm font-medium text-ink transition-colors hover:bg-raised"
              >
                <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
                  <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
                  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
                </svg>
                Continue with Google
              </button>
              <p className="text-center text-[12px] leading-relaxed text-ink-secondary">
                Opens muster.orazen.online — sign in there and type the code it shows:
              </p>
              <div className="flex gap-2">
                <input
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value.toUpperCase())}
                  placeholder="PAIRING CODE"
                  aria-label="Pairing code"
                  maxLength={8}
                  autoComplete="off"
                  className="w-full rounded-lg border border-hairline bg-panel px-3 py-2 font-mono text-sm uppercase tracking-[0.25em] text-ink placeholder:text-ink-secondary/50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <button
                  type="button"
                  onClick={() => void handlePair()}
                  disabled={pairBusy || pairCode.trim().length < 4}
                  className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                >
                  {pairBusy ? "…" : "Connect"}
                </button>
              </div>
            </div>
          )}

          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-ink-secondary">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-ink placeholder-ink-secondary/50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label htmlFor="password" className="block text-sm font-medium text-ink-secondary">
                Password
              </label>
              {capabilities.passwordReset && (
                <Link
                  to="/forgot-password"
                  className="text-xs font-medium text-accent hover:text-accent/80"
                >
                  Forgot?
                </Link>
              )}
            </div>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-ink placeholder-ink-secondary/50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-ink-secondary">
          Don't have an account?{" "}
          <Link to="/sign-up" className="font-medium text-accent hover:text-accent/80">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
