import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { stashReferral, useAuth } from "@/lib/auth";
import { authDestination } from "@/lib/auth-navigation";

/** Shared account entry for web and Electron. Starting OAuth is not proof of
 * a session: the provider callback (or a confirmed local session) completes it. */
export function GoogleSignIn({ next, ref, onError }: { next: string; ref?: string | null; onError: (message: string) => void }) {
  const { capabilities, signInWithProvider, signOut } = useAuth();
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [pairFallback, setPairFallback] = useState(false);
  const launching = useRef(false);
  const attempt = useRef(0);
  /** The live handoff attempt: what the start URL carries and what a give-up
   * must withdraw. The verifier never appears here — the local server keeps
   * it (server/desktop-attempts.ts) and releases it only to the proven
   * finish exchange. */
  const pendingAttempt = useRef<{ state: string } | null>(null);
  const configured = capabilities.socialProviders.includes("google");
  const handoff = Boolean(capabilities.desktopOAuth) && !configured;

  const cancelAttempt = () => {
    const live = pendingAttempt.current;
    pendingAttempt.current = null;
    if (!live) return;
    void fetch("/oauth/attempt/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: live.state }),
    }).catch(() => undefined);
  };

  useEffect(() => () => { attempt.current += 1; cancelAttempt(); }, []);

  useEffect(() => {
    if (!waiting) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      cancelAttempt();
      setWaiting(false);
      onError("Sign-in took too long. Please try again or use a pairing code.");
    }, 180_000);
    async function poll() {
      try {
        const response = await fetch("/api/auth/get-session", {
          credentials: "include", signal: controller.signal,
        });
        const session = response.ok ? await response.json().catch(() => null) : null;
        if (active && session?.user?.id) {
          active = false;
          clearTimeout(deadline);
          window.location.assign(authDestination(next));
          return;
        }
      } catch { /* A temporary local-server failure can recover within the deadline. */ }
      if (active) timer = setTimeout(() => void poll(), 1500);
    }
    void poll();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
    };
  }, [waiting, next, onError]);

  if (!configured && !handoff) return null;

  async function start() {
    if (launching.current || waiting) return;
    launching.current = true;
    const currentAttempt = ++attempt.current;
    setPending(true);
    setPairFallback(false);
    onError("");
    try {
      if (!handoff) {
        // Hold the referral across the redirect. The OAuth return carries only the callback path,
        // so without this a first-account Google signup from a referral link silently drops the
        // code on the one path most likely to be a new account. Redeemed later, and only once a
        // session is confirmed.
        stashReferral(ref ?? null);
        const result = await signInWithProvider("google");
        if (currentAttempt === attempt.current && result.error) onError(result.error);
        return;
      }
      // A previous local session must not satisfy this new account's poll.
      // The initial session lookup may still be pending, so React's user
      // snapshot is not sufficient to decide whether a cookie exists.
      await signOut();
      if (currentAttempt !== attempt.current) return;
      // Same reason as the web path: the handoff returns to the workspace, not to an auth page.
      stashReferral(ref ?? null);
      // Mint the per-attempt binding first: the local server keeps the PKCE
      // verifier and only releases it to the proven finish exchange. The
      // challenge rides the start URL; the state comes back on the finish
      // fragment so a stale or cancelled attempt cannot install a session.
      const redirect = window.location.origin;
      let binding: { state: string; codeChallenge: string } | null = null;
      try {
        const begin = await fetch("/oauth/attempt/begin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect }),
        });
        if (!begin.ok) throw new Error("attempt begin failed");
        // SAFETY: /oauth/attempt/begin answers exactly {state, codeChallenge}
        // (server/index.ts); both fields are server-minted opaque strings.
        binding = (await begin.json()) as { state: string; codeChallenge: string };
      } catch {
        if (currentAttempt === attempt.current) onError("Could not start Google sign-in. Please try again.");
        return;
      }
      if (currentAttempt !== attempt.current) {
        cancelAttempt();
        return;
      }
      pendingAttempt.current = { state: binding.state };
      const cloud = (capabilities.pairingCloudUrl ?? "https://muster.today").replace(/\/$/, "");
      const url = `${cloud}/desktop-auth/start?redirect=${encodeURIComponent(redirect)}&next=${encodeURIComponent(authDestination(next))}&state=${encodeURIComponent(binding.state)}&code_challenge=${encodeURIComponent(binding.codeChallenge)}&code_challenge_method=S256`;
      if (window.ogb?.openAuthHandoff) {
        if (!await window.ogb.openAuthHandoff(url)) throw new Error("handoff unavailable");
      } else if (window.ogb?.openExternal) {
        // Older shells cannot share system-browser cookies with Electron.
        // Use the explicit code bridge instead of polling forever.
        if (!await window.ogb.openExternal(`${cloud}/pair`)) throw new Error("browser unavailable");
        if (currentAttempt === attempt.current) setPairFallback(true);
        return;
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      if (currentAttempt === attempt.current) setWaiting(true);
    } catch {
      cancelAttempt();
      if (currentAttempt === attempt.current) onError("Could not open Google sign-in. Please try again.");
    } finally {
      launching.current = false;
      if (currentAttempt === attempt.current) setPending(false);
    }
  }

  return <div className="auth-google-entry">
    <button type="button" disabled={pending || waiting} onClick={() => void start()} className="auth-google">
      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
        <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
        <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
      </svg>
      {waiting ? "Finish Google sign-in…" : pending ? "Connecting…" : "Continue with Google"}
    </button>
    {waiting && <div className="auth-handoff-status" role="status">
      <p className="auth-hint">Complete sign-in in the window that opened, then return here.</p>
      <button className="auth-link" type="button" onClick={() => { cancelAttempt(); setWaiting(false); }}>Cancel waiting</button>
    </div>}
    {pairFallback && <div className="auth-handoff-status" role="status">
      <p className="auth-hint">Finish sign-in in your browser, then use its pairing code to connect this app.</p>
      <Link className="auth-link" to={`/sign-in?next=${encodeURIComponent(authDestination(next))}#connect`}>Enter pairing code</Link>
    </div>}
  </div>;
}
