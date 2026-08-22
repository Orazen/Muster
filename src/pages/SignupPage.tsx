import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AuthShell, authCardBox } from "@/components/AuthShell";

/** Google-only sign-up: a first Google sign-in creates the account, so this
 * page is the same single tap as sign-in. Kept as its own route because the
 * landing page, marketing links and old bookmarks point at /sign-up. */
export function SignupPage() {
  const { capabilities, signInWithProvider } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [googlePending, setGooglePending] = useState(false);
  const googleConfigured = capabilities.socialProviders.includes("google");

  return (
    <AuthShell
      title="Muster your team"
      subtitle="One tap with Google and your first agent is minutes away."
      footer={
        <button
          type="button"
          onClick={() => navigate("/sign-in")}
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

        <button
          type="button"
          disabled={googlePending || !googleConfigured}
          onClick={async () => {
            setGooglePending(true);
            const result = await signInWithProvider("google");
            setGooglePending(false);
            if (result.error) setError(result.error);
            else navigate("/app");
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

        {!googleConfigured && (
          <p className={`text-center text-[12px] ${authCardBox}`}>
            This deployment has no Google sign-in configured — ask whoever runs it to set
            GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
          </p>
        )}
      </div>
    </AuthShell>
  );
}
