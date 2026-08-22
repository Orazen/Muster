import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { SocialSignIn } from "@/components/SocialSignIn";
import { AuthShell, authInputCls, authButtonCls, authCardBox } from "@/components/AuthShell";

export function SignupPage() {
  const { signUp, capabilities } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const googlePrimary = capabilities.socialProviders.includes("google");
  const [showEmail, setShowEmail] = useState(!googlePrimary);
  const [googlePending, setGooglePending] = useState(false);
  const { signInWithProvider } = useAuth();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    const result = await signUp(name, email, password);
    setLoading(false);
    if (result.error) {
      setError(result.error);
    } else {
      navigate("/app");
    }
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Muster your own team of AI agents — each with memory, a model, and a real computer."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/sign-in" className="font-medium text-[#ff7a45] hover:text-[#f0460e]">
            Sign in
          </Link>
        </>
      }
    >
        {capabilities.googleOnlySignup ? (
          <div className="space-y-4 p-6">
            <SocialSignIn action="Sign up" />
            <p className="text-center text-[13px] text-[#a1a1a6]">
              New accounts on this deployment sign up with Google.
            </p>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className={authCardBox} role="alert">
              <span className="text-[#ff8f6b]">{error}</span>
            </div>
          )}

          {googlePrimary ? (
            <>
              <button
                type="button"
                disabled={googlePending}
                onClick={async () => {
                  setGooglePending(true);
                  const result = await signInWithProvider("google");
                  setGooglePending(false);
                  if (result.error) setError(result.error);
                }}
                className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-white py-3 text-sm font-semibold text-[#1f1f1f] shadow-[0_1px_2px_rgba(255,255,255,.1)] transition-transform hover:-translate-y-px hover:bg-white/90 disabled:opacity-50"
              >
                <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
                  <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
                  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
                </svg>
                {googlePending ? "Connecting…" : "Continue with Google"}
              </button>
              {!showEmail && (
                <button
                  type="button"
                  onClick={() => setShowEmail(true)}
                  className="w-full text-center text-[13px] font-medium text-[#a1a1a6] transition-colors hover:text-[#f5f5f5]"
                >
                  Continue with email instead
                </button>
              )}
            </>
          ) : (
            <SocialSignIn action="Sign up" />
          )}

          <div>
            <label htmlFor="name" className="mb-1 block text-[13px] font-medium text-[#a1a1a6]">
              Name
            </label>
            <input
              id="name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={authInputCls}
              placeholder="Your name"
            />
          </div>

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

          <div>
            <label htmlFor="password" className="mb-1 block text-[13px] font-medium text-[#a1a1a6]">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={authInputCls}
              placeholder="8+ characters"
            />
          </div>

          <button type="submit" disabled={loading} className={authButtonCls}>
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>
        )}
    </AuthShell>
  );
}
