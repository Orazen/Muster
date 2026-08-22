import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AuthShell, authCardBox } from "@/components/AuthShell";

/** Google-only sign-in. Email/password is gone from the product surface:
 * one identity provider, one button — on web and in the packaged desktop app
 * (where the pairing bridge below IS the Google path). If a deployment has
 * no Google OAuth configured, whatever providers it does have render as a
 * last resort rather than bricking the install. */
export function LoginPage() {
  const { capabilities, signInWithProvider, user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") ?? "/app";
  const [error, setError] = useState("");
  const [googlePending, setGooglePending] = useState(false);

  // desktop pairing bridge: code typed from muster.orazen.online/pair
  const [pairCode, setPairCode] = useState("");
  const [pairBusy, setPairBusy] = useState(false);

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

        <button
          type="button"
          disabled={googlePending || !googleConfigured}
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

        {capabilities.cloudPairing && (
          // deliberately NOT inside a <form>: nested forms are illegal HTML.
          // This bridge is how the packaged desktop app signs in with Google:
          // authenticate on the web, type the one-time code here.
          <div className="space-y-2.5 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
            <p className="text-center text-[12px] leading-relaxed text-[#a1a1a6]">
              Using the desktop app? Open{" "}
              <button
                type="button"
                onClick={() => {
                  const url = `${(capabilities.pairingCloudUrl ?? "").replace(/\/$/, "")}/pair`;
                  if (window.ogb?.openExternal) window.ogb.openExternal(url);
                  else window.open(url, "_blank", "noopener");
                }}
                className="font-medium text-[#ff7a45] hover:text-[#f0460e]"
              >
                muster.orazen.online/pair
              </button>{" "}
              with Google and type the code it shows:
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
