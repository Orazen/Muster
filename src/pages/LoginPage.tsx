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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const result = await signIn(email, password);
    setLoading(false);
    if (result.error) {
      setError(result.error);
    } else {
      navigate("/app");
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
