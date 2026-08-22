import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { SocialSignIn } from "@/components/SocialSignIn";
import { AuthShell, authInputCls, authButtonCls, authCardBox } from "@/components/AuthShell";

export function LoginPage() {
  const { signIn, capabilities, user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const justReset = params.get("reset") === "done";
  const next = params.get("next") ?? "/app";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // desktop pairing bridge: code typed from muster.orazen.online/pair
  const [pairCode, setPairCode] = useState("");
  const [pairBusy, setPairBusy] = useState(false);
  // Google-first: the form stays collapsed behind one primary button unless
  // this deployment has no Google provider configured.
  const googlePrimary = capabilities.socialProviders.includes("google");
  const [showEmail, setShowEmail] = useState(!googlePrimary);
  const [googlePending, setGooglePending] = useState(false);
  const { signInWithProvider } = useAuth();

  async function handlePair() {
    setError("");
    setPairBusy(true);
    try {
      const res = await fetch("/api/pair/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pairCode.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "pairing failed");
        return;
      }
      // the session cookie is set — reload auth state by hard-navigating
      window.location.href = next.startsWith("/") ? next : "/app";
    } catch {
      setError("could not reach the local server");
    } finally {
      setPairBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const result = await signIn(email, password);
    setLoading(false);
    if (result.error) {
      setError(result.error);
    } else {
      navigate(next.startsWith("/") ? next : "/app");
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to muster your team of agents."
      footer={
        <>
          Don't have an account?{" "}
          <Link to="/sign-up" className="font-medium text-[#ff7a45] hover:text-[#f0460e]">
            Sign up
          </Link>
        </>
      }
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          {!authLoading && user && (
            <div className={`flex flex-col gap-2.5 ${authCardBox}`}>
              <span>
                Already signed in as <span className="font-semibold text-[#f5f5f5]">{user.email}</span>.
              </span>
              <span className="flex gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => navigate("/app")}
                  className="font-semibold text-[#ff7a45] hover:text-[#f0460e]"
                >
                  Continue as {user.name?.split(" ")[0] || "this user"}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await signOut();
                    setEmail("");
                  }}
                  className="text-[#a1a1a6] hover:text-[#f5f5f5]"
                >
                  Use another account
                </button>
              </span>
            </div>
          )}
          {justReset && (
            <div className={authCardBox}>Password updated. Sign in with your new one.</div>
          )}
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
                  // success navigates away; reaching here means it failed
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
            <SocialSignIn action="Sign in" />
          )}

          {capabilities.cloudPairing && (
            // deliberately NOT a <form>: this sits inside the sign-in form,
            // and nested forms are illegal HTML that break the outer submit
            <div className="space-y-2.5 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
              <button
                type="button"
                onClick={() => {
                  const url = `${(capabilities.pairingCloudUrl ?? "").replace(/\/$/, "")}/pair`;
                  if (window.ogb?.openExternal) window.ogb.openExternal(url);
                  else window.open(url, "_blank", "noopener");
                }}
                className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-white/[0.1] bg-white/[0.05] py-2.5 text-sm font-medium text-[#f5f5f5] transition-colors hover:bg-white/[0.08]"
              >
                <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
                  <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
                  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
                </svg>
                Continue with Google
              </button>
              <p className="text-center text-[12px] leading-relaxed text-[#a1a1a6]">
                Opens muster.orazen.online — sign in there and type the code it shows:
              </p>
              <div className="flex gap-2">
                <input
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value.toUpperCase())}
                  placeholder="PAIRING CODE"
                  aria-label="Pairing code"
                  maxLength={8}
                  autoComplete="off"
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 font-mono text-sm uppercase tracking-[0.25em] text-[#f5f5f5] placeholder:text-[#6b6b70]/60 focus:border-[#f0460e]/60 focus:outline-none focus:ring-1 focus:ring-[#f0460e]/50"
                />
                <button
                  type="button"
                  onClick={() => void handlePair()}
                  disabled={pairBusy || pairCode.trim().length < 4}
                  className="shrink-0 rounded-lg bg-[#f0460e] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#f0460e]/90 disabled:opacity-50"
                >
                  {pairBusy ? "…" : "Connect"}
                </button>
              </div>
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

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label htmlFor="password" className="block text-[13px] font-medium text-[#a1a1a6]">
                Password
              </label>
              {capabilities.passwordReset && (
                <Link
                  to="/forgot-password"
                  className="text-xs font-medium text-[#ff7a45] hover:text-[#f0460e]"
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
              className={authInputCls}
              placeholder="••••••••"
            />
          </div>

          <button type="submit" disabled={loading} className={authButtonCls}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
    </AuthShell>
  );
}
