import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AuthShell, authCardBox, authInputCls, authButtonCls } from "@/components/AuthShell";

import { AuthPasswordField } from "@/components/AuthPasswordField";
import { authDestination } from "@/lib/auth-navigation";

/** Three ways in, on web and in the packaged desktop app alike:
 *   1. Continue with Google        — direct OAuth on deployments with creds;
 *                                    on the DESKTOP this becomes the cloud
 *                                    handoff: the browser does Google against
 *                                    muster.orazen.online, the app receives
 *                                    the identity over loopback (no codes)
 *   2. Pairing code bridge         (desktop fallback for the same flow)
 *   3. Email + password            (always available; sign-up lives at /sign-up)
 * Whatever a deployment lacks renders as a last resort rather than bricking
 * the install — no path here is ever hidden behind another one. */
export function LoginPage() {
  const { capabilities, signInWithProvider, signIn, user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = authDestination(params.get("next"));
  const [error, setError] = useState("");
  const [googlePending, setGooglePending] = useState(false);

  // OAuth failures bounce back here as /sign-in?authError=<code> (the server
  // rewrites better-auth's /api/auth/error). state_mismatch is by far the
  // common one: the state cookie lives 5 minutes, so a Google chooser left
  // open past that expires the attempt — the fix is simply trying again.
  const authError = params.get("authError");
  const authErrorHint =
    authError === "state_mismatch"
      ? "That sign-in expired. Please try again."
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

  // Desktop OAuth handoff: after the system browser finishes Google on the
  // cloud and bounces back to /oauth/finish, THAT page signs us in by
  // setting the session cookie. From here we just watch get-session until
  // a user materializes, then hard-navigate like pairing does.
  const [oauthWaiting, setOauthWaiting] = useState(false);

  useEffect(() => {
    if (!oauthWaiting) return;
    let alive = true;
    const started = Date.now();
    const tick = async () => {
      try {
        const r = await fetch("/api/auth/get-session", { credentials: "include" });
        // SAFETY: get-session's success body is better-auth's session JSON
        // ({user: {...}, ...}); non-JSON or error bodies resolve null and
        // the poll simply continues.
        if (r.ok && ((await r.json().catch(() => null)) as { user?: unknown } | null)?.user) {
          if (!alive) return;
          setOauthWaiting(false);
          window.location.href = next;
          return;
        }
      } catch {
        /* local server restarting or offline — keep polling */
      }
      if (alive && Date.now() - started > 180_000) {
        setOauthWaiting(false);
        setError("sign-in took too long — please start again");
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [oauthWaiting, next]);

  async function handleEmailSignIn(e?: React.FormEvent) {
    e?.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setEmailBusy(true);
    try {
      const result = await signIn(email.trim(), password);
      if (result.error) {
        setError(result.error);
        return;
      }
      navigate(next);
    } catch {
      setError("Could not reach the server. Please try again.");
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
      window.location.href = next;
    } catch {
      setError("Could not reach the local server. Please try again.");
    } finally {
      setPairBusy(false);
    }
  }

  const googleConfigured = capabilities.socialProviders.includes("google");
  // On the packaged app there are no OAuth secrets locally; the Google
  // button routes through the cloud handoff instead of better-auth here.
  const desktopOAuthHandoff = Boolean(capabilities.desktopOAuth) && !googleConfigured;

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to pick up where your team left off."
      footer={<>New to Muster? <Link to={`/sign-up?next=${encodeURIComponent(next)}`} className="auth-link">Create an account</Link></>}>
      <div className="auth-stack">
        {authErrorHint && (
          <div role="alert" className="auth-notice auth-error">
            {authErrorHint}
          </div>
        )}
        {!authLoading && user && (
          <div className={`flex flex-col gap-2.5 ${authCardBox}`}>
            <span>
              Already signed in as <span className="font-semibold">{user.email}</span>.
            </span>
            <span className="flex gap-3 text-xs">
              <button
                type="button"
                onClick={() => navigate(next)}
                className="auth-link"
              >
                Continue as {user.name?.split(" ")[0] || "this user"}
              </button>
              <button
                type="button"
                onClick={async () => {
                  await signOut();
                }}
                className="auth-link"
              >
                Use another account
              </button>
            </span>
          </div>
        )}
        {error && (
          <div className="auth-notice auth-error" role="alert">
            {error}
          </div>
        )}

        {(googleConfigured || desktopOAuthHandoff) && (
          <button
            type="button"
            disabled={googlePending || oauthWaiting}
            onClick={async () => {
              setError("");
              if (desktopOAuthHandoff) {
                const cloud = (capabilities.pairingCloudUrl ?? "https://muster.orazen.online").replace(/\/$/, "");
                const url = `${cloud}/desktop-auth/start?redirect=${encodeURIComponent(window.location.origin)}`;
                if (window.ogb?.openExternal) window.ogb.openExternal(url);
                else window.open(url, "_blank", "noopener");
                setOauthWaiting(true);
                return;
              }
              setGooglePending(true);
              const result = await signInWithProvider("google");
              // success navigates away; reaching here means it failed
              setGooglePending(false);
              if (result.error) setError(result.error);
            }}
            className="auth-google"
          >
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
              <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
            </svg>
            {oauthWaiting ? "Finish in your browser…" : googlePending ? "Connecting…" : "Continue with Google"}
          </button>
        )}

        {(googleConfigured || desktopOAuthHandoff) && <div className="auth-divider">or use your email</div>}
        <form onSubmit={(e) => void handleEmailSignIn(e)} className="auth-form">
          <div>
            <label htmlFor="email" className="auth-label">Email address</label>
            <input id="email" name="email" type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
              autoComplete="email" className={authInputCls} />
          </div>
          <AuthPasswordField id="password" value={password} onChange={setPassword} autoComplete="current-password" />
          {capabilities.passwordReset && <div className="auth-recovery"><Link to="/forgot-password" className="auth-link">Forgot password?</Link></div>}
          <button type="submit" disabled={emailBusy} className={authButtonCls}>
            {emailBusy ? "Signing in…" : "Sign in with email"}
          </button>
        </form>

        {capabilities.cloudPairing && (
          <form className="auth-pair" onSubmit={(event) => {
            event.preventDefault();
            if (!pairBusy && pairCode.trim().length >= 4) void handlePair();
          }}>
            <p className="auth-hint">
              Sign in once on muster.orazen.online with Google, then type the
              code it shows here. Codes last five minutes.
            </p>
            <div className="auth-pair-row">
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
                className={authInputCls}
              />
              <button
                type="submit"
                disabled={pairBusy || pairCode.trim().length < 4}
                className={authButtonCls}
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
              className="auth-link"
            >
              Open muster.orazen.online/pair ↗
            </button>
          </form>
        )}


      </div>
    </AuthShell>
  );
}
