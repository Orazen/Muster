import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Copy, Check } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { MusterbotMark } from "@/components/MusterbotMark";

/** Cloud side of the desktop pairing bridge: a signed-in cloud user shows
 * this code to their desktop app, which redeems it for a local session.
 * One live code per user; generating again kills the old one. */
export function PairPage() {
  const { user } = useAuth();
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const generate = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/pair/create", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "could not generate a code");
        return;
      }
      setCode(String(body.code ?? ""));
      setExpiresAt(Number.isFinite(body.expiresAt) ? body.expiresAt : null);
    } catch {
      setError("could not reach the server");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void generate();
  }, [generate]);

  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const expired = secondsLeft === 0 && Boolean(expiresAt);

  return (
    <div className="flex min-h-screen items-center justify-center bg-app px-4">
      <div className="w-full max-w-md text-center">
        <Link to="/" className="inline-flex items-center gap-2 text-ink">
          <MusterbotMark size={48} />
          <span className="text-xl font-semibold tracking-tight">Muster</span>
        </Link>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-ink">Pair your desktop app</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
          Open Muster Desktop, choose <span className="font-medium text-ink">Continue with Google</span>, then type
          this code there. It expires in five minutes and works once.
        </p>

        <div className="mt-6 rounded-xl border border-hairline bg-panel p-6">
          {error ? (
            <div className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
          ) : (
            <>
              <button
                onClick={copy}
                title="Copy code"
                className="group mx-auto flex items-center gap-3 rounded-lg px-4 py-2 hover:bg-raised"
              >
                <span className="font-mono text-4xl font-semibold tracking-[0.3em] text-ink">
                  {code || "····"}
                </span>
                {copied ? <Check size={16} className="text-success" /> : <Copy size={16} className="text-ink-secondary opacity-0 transition-opacity group-hover:opacity-100" />}
              </button>
              <div className="mt-3 flex items-center justify-center gap-2 text-[12.5px] text-ink-secondary">
                {busy ? (
                  "Generating…"
                ) : expired ? (
                  <>Expired.</>
                ) : (
                  <>Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</>
                )}
                <button
                  onClick={() => void generate()}
                  disabled={busy}
                  className="inline-flex items-center gap-1 font-medium text-accent hover:text-accent/80 disabled:opacity-50"
                >
                  <RefreshCw size={12} className={busy ? "animate-spin" : ""} /> New code
                </button>
              </div>
            </>
          )}
        </div>

        <p className="mt-6 text-sm text-ink-secondary">
          Signed in as <span className="font-medium text-ink">{user?.email}</span>.
        </p>
      </div>
    </div>
  );
}
