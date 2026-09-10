import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AuthShell, authInputCls, authButtonCls } from "@/components/AuthShell";

import { AuthPasswordField } from "@/components/AuthPasswordField";
import { authDestination, AUTH_PASSWORD_MIN_LENGTH } from "@/lib/auth-navigation";

/** Two ways to create an account, neither hidden behind the other:
 *   1. Continue with Google — one tap where OAuth creds are configured.
 *   2. Email + password — always available; the server may still close
 *      sign-ups (SIGNUPS_CLOSED / allowlist) and its error is shown here.
 * The old version was Google-only: deployments without OAuth creds showed
 * an operator-facing env-var note and no way to create an account at all. */
export function SignupPage() {
  const { capabilities, signInWithProvider, signUp, sessionError, retrySession } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = authDestination(params.get("next"));
  const [error, setError] = useState("");
  const [googlePending, setGooglePending] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const googleConfigured = capabilities.socialProviders.includes("google");

  async function continueToWorkspace() {
    // Only redeem after a confirmed session, including recovery from a
    // successful account creation whose session check was unavailable.
    const ref = params.get("ref");
    if (ref) {
      await fetch("/api/referral/redeem", {
        method: "POST", headers: { "content-type": "application/json" },
        credentials: "include", body: JSON.stringify({ code: ref }),
      }).catch(() => {});
    }
    navigate(next);
  }

  async function handleEmailSignUp(e?: React.FormEvent) {
    e?.preventDefault();
    if (emailBusy || rechecking || sessionError) return;
    setError("");
    if (!name.trim() || !email.trim() || password.length < AUTH_PASSWORD_MIN_LENGTH) {
      setError(`Enter your name, email, and a password of at least ${AUTH_PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    setEmailBusy(true);
    try {
      const result = await signUp(name.trim(), email.trim(), password);
      if (result.error) {
        setError(result.error);
        return;
      }
      await continueToWorkspace();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <AuthShell title="Create your account" subtitle="One workspace for your agents and their work."
      footer={<>Already have an account? <Link to={`/sign-in?next=${encodeURIComponent(next)}`} className="auth-link">Sign in</Link></>}>
      <div className="auth-stack">
        {sessionError && <div className="auth-notice auth-error" role="alert">
          <p>{sessionError}</p>
          <button type="button" className="auth-link" disabled={rechecking} onClick={async () => {
            setRechecking(true);
            setError("");
            try {
              if (await retrySession()) await continueToWorkspace();
              else setError("No active sign-in was confirmed. Check again or use Sign in to continue with an existing account.");
            } finally { setRechecking(false); }
          }}>Check sign-in again</button>
        </div>}
        {error && !sessionError && (
          <div className="auth-notice auth-error" role="alert">
            {error}
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
                navigate(next);
              }
            }}
            className="auth-google"
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

        {googleConfigured && <div className="auth-divider">or use your email</div>}
        <form onSubmit={(e) => void handleEmailSignUp(e)} className="auth-form">
          <div>
            <label htmlFor="name" className="auth-label">Your name</label>
            <input id="name" name="name" type="text" required value={name}
              onChange={(e) => setName(e.target.value)} placeholder="What should we call you?"
              autoComplete="name" className={authInputCls} />
          </div>
          <div>
            <label htmlFor="email" className="auth-label">Email address</label>
            <input id="email" name="email" type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
              autoComplete="email" className={authInputCls} />
          </div>
          <AuthPasswordField id="password" value={password} onChange={setPassword}
            autoComplete="new-password" minLength={AUTH_PASSWORD_MIN_LENGTH}
            hint={`Use at least ${AUTH_PASSWORD_MIN_LENGTH} characters.`} />
          <button type="submit" disabled={emailBusy || rechecking || Boolean(sessionError)} className={authButtonCls}>
            {emailBusy ? "Creating account…" : "Create account"}
          </button>
        </form>

      </div>
    </AuthShell>
  );
}
