import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Star } from "lucide-react";

export function ForgotPasswordPage() {
  const { requestPasswordReset, capabilities } = useAuth();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const result = await requestPasswordReset(email);
    setLoading(false);
    // Deliberately shows the same confirmation whether or not the address is
    // registered — otherwise this page becomes an account-enumeration oracle.
    if (result.error) setError(result.error);
    else setSent(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link to="/" className="inline-flex items-center gap-2 text-ink">
            <Star size={28} className="text-accent fill-accent" />
            <span className="text-xl font-semibold tracking-tight">Muster</span>
          </Link>
          <h1 className="mt-6 text-2xl font-bold text-ink">Reset your password</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            We'll email you a link to choose a new one.
          </p>
        </div>

        {!capabilities.passwordReset ? (
          <div className="rounded-xl border border-hairline bg-panel p-6 text-sm text-ink-secondary">
            Password reset isn't available on this deployment — no email transport is configured.
            Ask whoever runs this instance to set <code className="text-ink">RESEND_API_KEY</code>,
            or sign in with a provider instead.
          </div>
        ) : sent ? (
          <div className="rounded-xl border border-hairline bg-panel p-6">
            <p className="text-sm text-ink">Check your inbox.</p>
            <p className="mt-2 text-sm text-ink-secondary">
              If an account exists for <span className="text-ink">{email}</span>, a reset link is on
              its way. It expires in an hour.
            </p>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="space-y-4 rounded-xl border border-hairline bg-panel p-6"
          >
            {error && (
              <div className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
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

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {loading ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-ink-secondary">
          Remembered it?{" "}
          <Link to="/sign-in" className="font-medium text-accent hover:text-accent/80">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
