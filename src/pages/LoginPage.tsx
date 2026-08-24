import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AuthShell, authCardBox } from "@/components/AuthShell";

/** Three ways in, on web and in the packaged desktop app alike:
 *   1. Continue with Google        (when the deployment has OAuth configured)
 *   2. Pairing code bridge         (desktop; code minted on the cloud /pair)
 *   3. Email + password            (always available; sign-up lives at /sign-up)
 * Whatever a deployment lacks renders as a last resort rather than bricking
 * the install — no path here is ever hidden behind another one. */
export function LoginPage() {
  const { capabilities, signInWithProvider, signIn, user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") ?? "/app";
  const [error, setError] = useState("");
  const [googlePending, setGooglePending] = useState(false);

  // OAuth failures bounce back here as /sign-in?authError=<code> (the server
  // rewrites better-auth's /api/auth/error). state_mismatch is by far the
  // common one: the state cookie lives 5 minutes, so a Google chooser left
  // open past that expires the attempt — the fix is simply trying again.
  const authError = params.get("authError");
  const authErrorHint =
    authError === "state_mismatch"
      ? "That sign-in took too long and expired. One more tap and you're in."
      : authError
        ? `Sign-in failed (${authError}). Please try again.`
        : "";

  // desktop pairing bridge: code typed from muster.orazen.online/pair
  const [pairCode, setPairCode] = useState("");
  const [pairBusy, setPairBusy] = useState(false);

  // email + password: first-class path, not a fallback
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);

  async function handleEmailSignIn(e?: React.FormEvent) {
    e?.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("enter your email and password");
      return;
    }
    setEmailBusy(true);
    try {
      const result = await signIn(email.trim(), password);
      if (result.error) {
        setError(result.error);
        return;
      }
      navigate(next.startsWith("/") ? next : "/app");
    } catch {
      setError("could not reach the server");
    } finally {
      setEmailBusy(false);
    }
  }

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

  const googleConfigured = capabilities.socialProviders.includes("google");

  return (
    <AuthShell title="Welcome back" subtitle="One tap and your team of agents is waiting.">
      <div className="space-y-4">
        {authErrorHint && (
          <div role="alert" className="rounded-lg border border-[#7a3b12] bg-[#2a1a10] px-3 py-2 text-sm text-[#ffb27d]">
            {authErrorHint}
          </div>
        )}
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
                }}
                className="text-[#a1a1a6] hover:text-[#f5f5f5]"
              >
                Use another account
              </button>
            </span>
          </div>
        )}
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
              // success navigates away; reaching here means it failed
              setGooglePending(false);
              if (result.error) setError(result.error);
            }}
            className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-gray-200 bg-white py-2.5 text-sm font-semibold text-[#1f1f1f] shadow-sm transition-all hover:bg-gray-50 disabled:opacity-50"
          >
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
              <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
            </svg>
            {googlePending ? "Connecting…" : "Continue with Google"}
          </button>
        )}

        <form
          onSubmit={(e) => void handleEmailSignIn(e)}
          className="space-y-2.5 rounded-xl border border-neutral-300 bg-white p-4 shadow-sm"
        >
          <p className="text-center text-[12px] font-medium text-neutral-700">or continue with email</p>
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
            placeholder="Password"
            aria-label="Password"
            autoComplete="current-password"
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-black placeholder:text-neutral-400 focus:border-[#f0460e]/60 focus:outline-none focus:ring-1 focus:ring-[#f0460e]/50"
          />
          <button
            type="submit"
            disabled={emailBusy}
            className="w-full rounded-lg bg-[#1f1f1f] py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1f1f1f]/90 disabled:opacity-50"
          >
            {emailBusy ? "Signing in…" : "Sign in with email"}
          </button>
          <button
            type="button"
            onClick={() => navigate(`/sign-up?next=${encodeURIComponent(next)}`)}
            className="w-full text-center text-[12px] font-medium text-[#f0460e] hover:text-[#f0460e]/80"
          >
            New here? Create an account
          </button>
        </form>

        {capabilities.cloudPairing && (
          // deliberately NOT inside a <form>: nested forms are illegal HTML.
          // This bridge is how the packaged desktop app signs in with Google:
          // authenticate on the web, type the one-time code here.
          <div className="space-y-2.5 rounded-xl border border-neutral-300 bg-white p-4 shadow-sm">
            <p className="text-center text-[12px] font-medium leading-relaxed text-neutral-700">
              Sign in once on muster.orazen.online with Google, then type the
              code it shows here. Codes last five minutes.
            </p>
            <div className="flex gap-2">
              <input
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value.toUpperCase())}
                placeholder="PAIRING CODE"
                aria-label="Pairing code"
                // Why. 8 fits generated codes, but any longer server-side code
                // truncated SILENTLY here and read as "isn't valid" forever.
                // Headroom costs nothing; wrong codes still fail loudly.
                maxLength={12}
                autoComplete="off"
                className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm uppercase tracking-[0.25em] text-black placeholder:text-neutral-400 focus:border-[#f0460e]/60 focus:outline-none focus:ring-1 focus:ring-[#f0460e]/50"
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

            <button
              type="button"
              onClick={() => {
                const url = `${(capabilities.pairingCloudUrl ?? "https://muster.orazen.online").replace(/\/$/, "")}/pair`;
                if (window.ogb?.openExternal) window.ogb.openExternal(url);
                else window.open(url, "_blank", "noopener");
              }}
              className="text-center text-[12px] font-medium text-[#f0460e] hover:text-[#f0460e]/80"
            >
              Open muster.orazen.online/pair ↗
            </button>
          </div>
        )}

        {!googleConfigured && !capabilities.cloudPairing && (
          <p className={`text-center text-[12px] ${authCardBox}`}>
            This deployment has no Google sign-in configured — ask whoever runs it to set
            GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
          </p>
        )}
      </div>
    </AuthShell>
  );
}
