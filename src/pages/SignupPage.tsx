import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { SocialSignIn } from "@/components/SocialSignIn";
import { Star } from "lucide-react";

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
    <div className="flex min-h-screen items-center justify-center bg-app px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link to="/" className="inline-flex items-center gap-2 text-ink">
            <Star size={28} className="text-accent fill-accent" />
            <span className="text-xl font-semibold tracking-tight">Muster</span>
          </Link>
          <h1 className="mt-6 text-2xl font-bold text-ink">Create your account</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            Get started with your own team of AI agents.
          </p>
        </div>

        {capabilities.googleOnlySignup ? (
          <div className="space-y-4 rounded-xl border border-hairline bg-panel p-6">
            <SocialSignIn action="Sign up" />
            <p className="text-center text-[13px] text-ink-secondary">
              New accounts on this deployment sign up with Google.
            </p>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-hairline bg-panel p-6">
          {error && (
            <div className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
          )}

          <SocialSignIn action="Sign up" />

          <div>
            <label htmlFor="name" className="mb-1 block text-sm font-medium text-ink-secondary">
              Name
            </label>
            <input
              id="name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-ink placeholder-ink-secondary/50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="Your name"
            />
          </div>

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
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-ink-secondary">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-ink placeholder-ink-secondary/50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="8+ characters"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>
        )}

        <p className="mt-6 text-center text-sm text-ink-secondary">
          Already have an account?{" "}
          <Link to="/sign-in" className="font-medium text-accent hover:text-accent/80">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
