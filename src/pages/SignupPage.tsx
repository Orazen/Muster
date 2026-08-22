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

          <SocialSignIn action="Sign up" />

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
