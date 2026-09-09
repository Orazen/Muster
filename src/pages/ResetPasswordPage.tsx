import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AuthShell, authButtonCls, authCardBox } from "@/components/AuthShell";

import { AuthPasswordField } from "@/components/AuthPasswordField";
import { AUTH_PASSWORD_MIN_LENGTH } from "@/lib/auth-navigation";

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
    if (password.length < AUTH_PASSWORD_MIN_LENGTH) {
      setError(`Use at least ${AUTH_PASSWORD_MIN_LENGTH} characters.`);
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
      subtitle="Choose a new password to get back to your workspace."
    >
        {!token ? (
          <div className={authCardBox}>
            This link is missing its reset token, or it has already been used.{" "}
            <Link to="/forgot-password" className="auth-link">
              Request a new one
            </Link>
            .
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="auth-notice auth-error" role="alert">
                {error}
              </div>
            )}

            <AuthPasswordField id="password" label="New password" value={password} onChange={setPassword}
              autoComplete="new-password" minLength={AUTH_PASSWORD_MIN_LENGTH}
              hint={`Use at least ${AUTH_PASSWORD_MIN_LENGTH} characters.`} />
            <AuthPasswordField id="confirm" label="Confirm password" value={confirm} onChange={setConfirm}
              autoComplete="new-password" />

            <button type="submit" disabled={loading} className={authButtonCls}>
              {loading ? "Saving…" : "Set new password"}
            </button>
          </form>
        )}
    </AuthShell>
  );
}
