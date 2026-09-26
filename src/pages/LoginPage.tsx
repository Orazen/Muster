import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { useAuth } from "@/lib/auth";
import { AuthShell, authCardBox, authInputCls, authButtonCls } from "@/components/AuthShell";

import { AuthPasswordField } from "@/components/AuthPasswordField";
import { GoogleSignIn } from "@/components/GoogleSignIn";
import { EmailOtpSignIn } from "@/components/EmailOtpSignIn";
import { authDestination } from "@/lib/auth-navigation";

/** Account sign-in and device connection share a page, but remain separate actions. */
export function LoginPage() {
  const { capabilities, signIn, user, loading: authLoading, signOut, sessionError, retrySession } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = authDestination(params.get("next"));
  const [error, setError] = useState("");
  const submitting = useRef(false);

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

  // desktop pairing bridge: code typed from muster.today/pair
  const [pairCode, setPairCode] = useState("");
  const [pairBusy, setPairBusy] = useState(false);

  // email + password: first-class path, not a fallback
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);

  async function handleEmailSignIn(e?: React.FormEvent) {
    e?.preventDefault();
    if (submitting.current) return;
    setError("");
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    submitting.current = true;
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
      submitting.current = false;
      setEmailBusy(false);
    }
  }

  async function handlePair() {
    if (submitting.current) return;
    submitting.current = true;
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
        const failure = z.object({ error: z.string().min(1) }).safeParse(body);
        setError(failure.success ? failure.data.error : "Could not connect this app. Check the code and try again.");
        return;
      }
      // the session cookie is set — reload auth state by hard-navigating
      window.location.href = next;
    } catch {
      setError("Could not reach the local server. Please try again.");
    } finally {
      submitting.current = false;
      setPairBusy(false);
    }
  }

  const googleConfigured = capabilities.socialProviders.includes("google");
  // On the packaged app there are no OAuth secrets locally; the Google
  // button routes through the cloud handoff instead of better-auth here.
  const desktopOAuthHandoff = Boolean(capabilities.desktopOAuth) && !googleConfigured;

  return (
    <AuthShell title="Your day, with Muster." subtitle="Sign in to your workspace. Your next good idea starts here."
      footer={<>New to Muster? <Link to={`/sign-up?next=${encodeURIComponent(next)}`} className="auth-link">Create an account</Link></>}>
      <div className="auth-stack">
        {sessionError && <div className="auth-notice auth-error" role="alert">
          <p>{sessionError}</p>
          <button type="button" className="auth-link" onClick={() => void retrySession()}>Check sign-in again</button>
        </div>}
        {authErrorHint && (
          <div role="alert" className="auth-notice auth-error">
            {authErrorHint}
          </div>
        )}
        {!authLoading && !sessionError && user && (
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
                  setError("");
                  try { await signOut(); }
                  catch { setError("Couldn’t finish signing out. Please try again."); }
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

        <GoogleSignIn next={next} onError={setError} />

        {(googleConfigured || desktopOAuthHandoff) && <div className="auth-divider">or use your email</div>}
        {capabilities.emailOtp && <EmailOtpSignIn next={next} />}
        <details className={`auth-password-option${capabilities.emailOtp ? "" : " auth-password-default"}`} open={capabilities.emailOtp ? undefined : true}>
          <summary hidden={!capabilities.emailOtp}>Use a password instead</summary>
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
        </details>

        {capabilities.cloudPairing && (
          <form id="connect" className="auth-pair" onSubmit={(event) => {
            event.preventDefault();
            if (!pairBusy && pairCode.trim().length >= 4) void handlePair();
          }}>
            <h2 className="auth-pair-title">Connect this app</h2>
            <p className="auth-hint">
              Already use Muster on the web? Open the pairing page, sign in,
              and enter its code here. Codes last five minutes.
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
                const url = `${(capabilities.pairingCloudUrl ?? "https://muster.today").replace(/\/$/, "")}/pair`;
                if (window.ogb?.openExternal) window.ogb.openExternal(url);
                else window.open(url, "_blank", "noopener");
              }}
              className="auth-link"
            >
              Get a pairing code ↗
            </button>
          </form>
        )}


      </div>
    </AuthShell>
  );
}
