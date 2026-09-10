import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import { AuthShell, authButtonCls } from "@/components/AuthShell";
import { ClaimFlow } from "@/lib/claim-flow";

/** Self-host claim front door: the QR `muster up` prints encodes
 * /claim#CODE. The phone lands here with no session — the code IS the
 * credential. Redeeming swaps it for an owner session cookie and drops the
 * user straight into the console. Single-use, five-minute TTL (server side). */
export function ClaimPage() {
  // Capture before removing the fragment. Construction never submits a code.
  const [flow] = useState(() => new ClaimFlow(window.location.hash));
  const [state, setState] = useState(flow.state);

  useEffect(() => {
    const unsubscribe = flow.subscribe(setState);
    // Remove even malformed credentials, preserving router state and query.
    history.replaceState(history.state, "", window.location.pathname + window.location.search);
    void flow.start();
    return unsubscribe;
  }, [flow]);

  useEffect(() => {
    if (state.status !== "done") return;
    // Reload AuthProvider with the new session cookie. Leaving this page
    // cancels the redirect so it cannot pull the user back into the console.
    const redirect = window.setTimeout(() => window.location.replace("/app"), 900);
    return () => window.clearTimeout(redirect);
  }, [state.status]);

  return (
    <AuthShell
      title={state.status === "claiming" ? "Opening your console…" : state.status === "done" ? "You’re connected" : "This link didn’t work"}
      subtitle="Connect this device to the Muster server hosting your fleet."
      footer={<><a href="/app">Open console</a><span aria-hidden="true"> · </span><Link to="/sign-in">Sign in instead</Link></>}
    >
      {state.status === "claiming" && (
        <div className="auth-notice flex items-center gap-3" role="status">
          <LoaderCircle size={20} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <span>Connecting to your server. Keep this page open for a moment.</span>
        </div>
      )}
      {state.status === "done" && (
        <>
          <div className="auth-notice" role="status">This device is connected. Taking you to your console…</div>
          <a href="/app" className={authButtonCls}>Continue to console</a>
        </>
      )}
      {state.status === "error" && (
        <>
          <div className="auth-error" role="alert">{state.message}</div>
          {state.retryable && <button type="button" className={authButtonCls} onClick={() => void flow.retry()}>Try again</button>}
          <div className="auth-notice">Run <code>muster up</code> on the computer hosting your fleet and scan the newest QR. Links expire after five minutes and can be used once.</div>
        </>
      )}
    </AuthShell>
  );
}
