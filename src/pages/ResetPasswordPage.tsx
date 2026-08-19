import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Star } from "lucide-react";

/** Must match minPasswordLength in server/auth.ts. */
const MIN_PASSWORD_LENGTH = 12;

export function ResetPasswordPage() {
  const { resetPassword } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    // Checked here as well as server-side so the failure is immediate rather
    // than a round trip.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }

    setLoading(true);
    const result = await resetPassword(token, password);
    setLoading(false);
    if (result.error) setError(result.error);
    else navigate("/sign-in?reset=done");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link to="/" className="inline-flex items-center gap-2 text-ink">
            <Star size={28} className="text-accent fill-accent" />
            <span className="text-xl font-semibold tracking-tight">Muster</span>
          </Link>
          <h1 className="mt-6 text-2xl font-bold text-ink">Choose a new password</h1>
        </div>

        {!token ? (
          <div className="rounded-xl border border-hairline bg-panel p-6 text-sm text-ink-secondary">
            This link is missing its reset token, or it has already been used.{" "}
            <Link to="/forgot-password" className="font-medium text-accent hover:text-accent/80">
              Request a new one
            </Link>
            .
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
              <label
                htmlFor="password"
                className="mb-1 block text-sm font-medium text-ink-secondary"
              >
                New password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-ink placeholder-ink-secondary/50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="••••••••••••"
              />
              <p className="mt-1 text-xs text-ink-secondary">
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
            </div>

            <div>
              <label htmlFor="confirm" className="mb-1 block text-sm font-medium text-ink-secondary">
                Confirm password
              </label>
              <input
                id="confirm"
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-ink placeholder-ink-secondary/50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="••••••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {loading ? "Saving…" : "Set new password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
