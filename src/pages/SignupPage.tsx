import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { AuthShell, authInputCls, authButtonCls } from "@/components/AuthShell";

import { GoogleSignIn } from "@/components/GoogleSignIn";
import { AuthPasswordField } from "@/components/AuthPasswordField";
import { authDestination, AUTH_PASSWORD_MIN_LENGTH } from "@/lib/auth-navigation";

/**
 * Redeems a referral code, and only ever after a session is confirmed.
 *
 * Three properties are deliberate:
 *
 *  - **After a session.** The server answers `401 sign in before redeeming a referral code` without
 *    one, so an early call would attribute the referral to nobody and lose it.
 *  - **Never blocks sign-in.** A referral is a bonus, not an entitlement. A rejected code, a server
 *    that cannot allocate, or an unreachable network must not strand someone who has just created an
 *    account. Every outcome is returned so a caller can report it without failing.
 *  - **A rejection is reported, not swallowed.** The previous version discarded the response
 *    entirely, so an invalid code was indistinguishable from a redeemed one and nobody could tell a
 *    lost referral from a working one.
 *
 * Exported from this page because it is where the referral concern already lived. It belongs in a
 * shared auth helper beside `authDestination`; that file is not in this slice's claim, so the move is
 * proposed rather than made here.
 */
export type ReferralOutcome = "skipped" | "redeemed" | "rejected" | "unreachable";

export async function redeemReferral(ref: string | null): Promise<ReferralOutcome> {
  if (!ref) return "skipped";
  try {
    const response = await fetch("/api/referral/redeem", {
      method: "POST", headers: { "content-type": "application/json" },
      credentials: "include", body: JSON.stringify({ code: ref }),
    });
    return response.ok ? "redeemed" : "rejected";
  } catch {
    return "unreachable";
  }
}

/** Builds a query string that keeps `ref` alongside `next`, so a referral survives navigation. */
export function withReferral(path: string, next: string, ref: string | null): string {
  const query = new URLSearchParams({ next });
  if (ref) query.set("ref", ref);
  return `${path}?${query.toString()}`;
}

/** Two ways to create an account, neither hidden behind the other:
 *   1. Continue with Google — one tap where OAuth creds are configured.
 *   2. Email + password — always available; the server may still close
 *      sign-ups (SIGNUPS_CLOSED / allowlist) and its error is shown here.
 * The old version was Google-only: deployments without OAuth creds showed
 * an operator-facing env-var note and no way to create an account at all. */
export function SignupPage() {
  const { capabilities, signUp, sessionError, retrySession } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = authDestination(params.get("next"));
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const googleConfigured = capabilities.socialProviders.includes("google");

  async function continueToWorkspace() {
    // Only redeem after a confirmed session, including recovery from a
    // successful account creation whose session check was unavailable.
    // A rejected referral must not stop someone reaching the workspace they just created.
    await redeemReferral(params.get("ref"));
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
      footer={<>Already have an account? <Link to={withReferral("/sign-in", next, params.get("ref"))} className="auth-link">Sign in</Link></>}>
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

        <GoogleSignIn next={next} onError={setError} />

        {(googleConfigured || capabilities.desktopOAuth) && <div className="auth-divider">or use your email</div>}
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
