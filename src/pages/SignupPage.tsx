import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AuthShell, authCardBox } from "@/components/AuthShell";

/** Two ways to create an account, neither hidden behind the other:
 *   1. Continue with Google — one tap where OAuth creds are configured.
 *   2. Email + password — always available; the server may still close
 *      sign-ups (SIGNUPS_CLOSED / allowlist) and its error is shown here.
 * The old version was Google-only: deployments without OAuth creds showed
 * an operator-facing env-var note and no way to create an account at all. */
export function SignupPage() {
  const { capabilities, signInWithProvider, signUp } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") ?? "/app";
  const [error, setError] = useState("");
  const [googlePending, setGooglePending] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const googleConfigured = capabilities.socialProviders.includes("google");

  async function handleEmailSignUp(e?: React.FormEvent) {
    e?.preventDefault();
    setError("");
    if (!name.trim() || !email.trim() || password.length < 8) {
      setError("your name, email and a password of at least 8 characters");
      return;
    }
    setEmailBusy(true);
    try {
      const result = await signUp(name.trim(), email.trim(), password);
      if (result.error) {
        setError(result.error);
        return;
      }
      // Attribution: an invite link (/sign-up?ref=CODE) redeems after the
      // account exists — both sides get Pro days. Failures are silent:
      // a bad or exhausted code must not block joining.
      const ref = params.get("ref");
      if (ref) {
        await fetch("/api/referral/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ code: ref }),
        }).catch(() => {});
      }
      navigate(next.startsWith("/") ? next : "/app");
    } catch {
      setError("could not reach the server");
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <AuthShell
      title="Muster your team"
      subtitle={googleConfigured ? "One tap with Google and your first agent is minutes away." : "Create your account — your first agent is minutes away."}
      footer={
        <button
          type="button"
          onClick={() => navigate(`/sign-in?next=${encodeURIComponent(next)}`)}
          className="font-medium text-[#ff7a45] hover:text-[#f0460e]"
        >
          Back to sign in
        </button>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className={authCardBox} role="alert">
            <span className="text-[#ff8f6b]">{error}</span>
          </div>
        )}

        {googleConfigured && (
          <button
            type="button"
            disabled={googlePending}
            onClick={async () => {
              setGooglePending(true);
              const result = await signInWithProvider("google");
              setGooglePending(false);
              if (result.error) setError(result.error);
              else {
                const ref = params.get("ref");
                if (ref) {
                  await fetch("/api/referral/redeem", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ code: ref }),
                  }).catch(() => {});
                }
                navigate(next.startsWith("/") ? next : "/app");
              }
            }}
            className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-gray-200 bg-white py-2.5 text-sm font-semibold text-[#1f1f1f] shadow-sm transition-all hover:bg-gray-50 disabled:opacity-50"
          >
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
              <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01-2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
            </svg>
            {googlePending ? "Connecting…" : "Continue with Google"}
          </button>
        )}

        <form
          onSubmit={(e) => void handleEmailSignUp(e)}
          className="space-y-2.5 rounded-xl border border-neutral-300 bg-white p-4 shadow-sm"
        >
          {googleConfigured && (
            <p className="text-center text-[12px] font-medium text-neutral-700">or create an account with email</p>
          )}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            aria-label="Your name"
            autoComplete="name"
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-black placeholder:text-neutral-400 focus:border-[#f0460e]/60 focus:outline-none focus:ring-1 focus:ring-[#f0460e]/50"
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-label="Email"
            autoComplete="email"
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-black placeholder:text-neutral-400 focus:border-[#f0460e]/60 focus:outline-none focus:ring-1 focus:ring-[#f0460e]/50"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (8+ characters)"
            aria-label="Password"
            autoComplete="new-password"
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-black placeholder:text-neutral-400 focus:border-[#f0460e]/60 focus:outline-none focus:ring-1 focus:ring-[#f0460e]/50"
          />
          <button
            type="submit"
            disabled={emailBusy}
            className="w-full rounded-lg bg-[#1f1f1f] py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1f1f1f]/90 disabled:opacity-50"
          >
            {emailBusy ? "Creating account…" : "Create account"}
          </button>
        </form>

        {!googleConfigured && (
          <p className="text-center text-[12px] text-neutral-500">
            Google sign-in isn't configured on this deployment — set GOOGLE_CLIENT_ID and
            GOOGLE_CLIENT_SECRET to enable it alongside email.
          </p>
        )}
      </div>
    </AuthShell>
  );
}
