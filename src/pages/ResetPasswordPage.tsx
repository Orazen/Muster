import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AuthShell, authInputCls, authButtonCls, authCardBox } from "@/components/AuthShell";

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
    <AuthShell
      title="Choose a new password"
      subtitle="Pick something strong — this instance holds your agents' credentials."
    >
        {!token ? (
          <div className={authCardBox}>
            This link is missing its reset token, or it has already been used.{" "}
            <Link to="/forgot-password" className="font-medium text-[#ff7a45] hover:text-[#f0460e]">
              Request a new one
            </Link>
            .
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className={authCardBox} role="alert">
                <span className="text-[#ff8f6b]">{error}</span>
              </div>
            )}

            <div>
              <label htmlFor="password" className="mb-1 block text-[13px] font-medium text-[#a1a1a6]">
                New password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={authInputCls}
                placeholder="••••••••••••"
              />
              <p className="mt-1 text-xs text-[#a1a1a6]">
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
            </div>

            <div>
              <label htmlFor="confirm" className="mb-1 block text-[13px] font-medium text-[#a1a1a6]">
                Confirm password
              </label>
              <input
                id="confirm"
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={authInputCls}
                placeholder="••••••••••••"
              />
            </div>

            <button type="submit" disabled={loading} className={authButtonCls}>
              {loading ? "Saving…" : "Set new password"}
            </button>
          </form>
        )}
    </AuthShell>
  );
}
