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
          <Link to="/sign-in" className="font-medium text-[#ff7a45] hover:text-[#f0460e]">
            Sign in
          </Link>
        </>
      }
    >
        {!capabilities.passwordReset ? (
          <div className={authCardBox}>
            Password reset isn't available on this deployment — no email transport is configured.
            Ask whoever runs this instance to set <code className="text-[#f5f5f5]">RESEND_API_KEY</code>,
            or sign in with a provider instead.
          </div>
        ) : sent ? (
          <div className={authCardBox}>
            <p className="text-[#f5f5f5]">Check your inbox.</p>
            <p className="mt-2">
              If an account exists for <span className="text-[#f5f5f5]">{email}</span>, a reset link
              is on its way. It expires in an hour.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className={authCardBox} role="alert">
                <span className="text-[#ff8f6b]">{error}</span>
              </div>
            )}

            <div>
              <label htmlFor="email" className="mb-1 block text-[13px] font-medium text-[#a1a1a6]">
                Email
              </label>
              <input
                id="email"
                type="email"
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
