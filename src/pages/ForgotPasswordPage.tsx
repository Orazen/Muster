import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AuthShell, authInputCls, authButtonCls, authCardBox } from "@/components/AuthShell";

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
    <AuthShell
      title="Reset your password"
      subtitle="We'll email you a link to choose a new one."
      footer={
        <>
          Remembered it?{" "}
          <Link to="/sign-in" className="auth-link">
            Sign in
          </Link>
        </>
      }
    >
        {!capabilities.passwordReset ? (
          <div className={authCardBox}>
            Password reset is not available here. Contact the person who runs this
            workspace, or return to sign in and use a connected provider.
          </div>
        ) : sent ? (
          <div className={authCardBox} role="status">
            <p className="font-medium">Check your inbox.</p>
            <p className="mt-2">
              If an account exists for <span className="font-medium">{email}</span>, a reset link
              is on its way. It expires in an hour.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="auth-notice auth-error" role="alert">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="email" className="auth-label">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={authInputCls}
                placeholder="you@example.com"
              />
            </div>

            <button type="submit" disabled={loading} className={authButtonCls}>
              {loading ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}
    </AuthShell>
  );
}
