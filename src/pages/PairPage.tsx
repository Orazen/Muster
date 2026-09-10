import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { AuthShell, authButtonCls, authInputCls } from "@/components/AuthShell";
import { PairingFlow, pairingSecondsLeft } from "@/lib/pairing-flow";

/** Cloud pairing codes retain their value until they expire or are used. */
export function PairPage() {
  const { user } = useAuth();
  return <PairCodeView key={user?.id} email={user?.email ?? ""} />;
}

function PairCodeView({ email }: { email: string }) {
  const [flow] = useState(() => new PairingFlow());
  const [state, setState] = useState(flow.state);
  const [now, setNow] = useState(Date.now);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubscribe = flow.subscribe(setState);
    void flow.start();
    return unsubscribe;
  }, [flow]);

  useEffect(() => {
    if (!state.pairing) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [state.pairing]);

  const seconds = state.pairing ? pairingSecondsLeft(state.pairing.expiresAt, now) : 0;
  const expired = state.pairing !== null && seconds === 0;
  const busy = state.status === "idle" || state.status === "loading";
  const usable = state.status === "ready" && !expired && state.pairing !== null;
  const refreshLabel = busy ? "Getting your code…" : state.status === "error" ? "Try again" : expired ? "Get a new code" : "Refresh code";

  const copy = async () => {
    setNow(Date.now());
    if (await flow.copy() === "manual") {
      codeInput.current?.focus();
      codeInput.current?.select();
    }
  };

  return (
    <AuthShell
      title="Connect your desktop"
      subtitle="Open Muster Desktop and enter this code in its pairing field."
      footer={<><p className="break-all">Signed in as {email}.</p><Link to="/app">Back to your workspace</Link></>}
    >
      <div className="flex flex-col gap-3">
      {state.error && <div className="auth-notice auth-error" role="alert">{state.error}</div>}
      <label htmlFor="pairing-code" className="text-sm font-medium">Pairing code</label>
      <input
        ref={codeInput} id="pairing-code" className={authInputCls}
        style={{ textAlign: "center", fontFamily: "monospace", fontSize: "clamp(20px, 5vw, 28px)", letterSpacing: "0.12em" }}
        value={usable ? state.pairing?.code ?? "" : ""}
        placeholder={expired ? "Expired" : busy ? "Loading…" : "Unavailable"}
        readOnly disabled={!usable} autoComplete="off" spellCheck={false}
        aria-describedby="pairing-status" onFocus={(event) => event.currentTarget.select()}
      />
      <p id="pairing-status" className="text-sm" style={{ color: "var(--auth-muted)" }}>
        {busy ? "Getting your pairing code…" : state.status === "error" ? "Refresh to confirm your current code." : expired ? "This code expired. Get a new one to continue." : `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}. Works once.`}
      </p>
      <button type="button" className={authButtonCls} disabled={!usable || state.copy === "copying"} onClick={() => void copy()}>
        {state.copy === "copied" && usable ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
        {state.copy === "copying" && usable ? "Copying…" : state.copy === "copied" && usable ? "Copied" : "Copy code"}
      </button>
      {state.copy === "manual" && usable && <p role="status" className="auth-notice">Copy is unavailable here. The code is selected so you can copy it manually.</p>}
      {state.copy === "copied" && usable && <span role="status" className="sr-only">Pairing code copied.</span>}
      <button type="button" disabled={busy} onClick={() => void flow.refresh()} className="auth-google">
        <RefreshCw size={16} className={busy ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden="true" />{refreshLabel}
      </button>
      <div className="auth-notice">Refreshing keeps the same live code. Once it expires or is used, refresh to get a new one.</div>
      </div>
    </AuthShell>
  );
}
