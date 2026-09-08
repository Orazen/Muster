import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MusterbotMark } from "@/components/MusterbotMark";

/** Self-host claim front door: the QR `muster up` prints encodes
 * /claim#CODE. The phone lands here with no session — the code IS the
 * credential. Redeeming swaps it for an owner session cookie and drops the
 * user straight into the console. Single-use, 10-minute TTL (server side). */
export function ClaimPage() {
  const [state, setState] = useState<"claiming" | "done" | "error">("claiming");
  const [error, setError] = useState("");

  const claim = useCallback(async (code: string) => {
    try {
      const res = await fetch("/api/pair/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setState("done");
        // Hard navigation, not <navigate>: AuthProvider cached "no session"
        // when this page mounted (the claim cookie didn't exist yet). A full
        // reload makes it re-fetch with the cookie now in place.
        setTimeout(() => window.location.replace("/app"), 900);
      } else {
        setState("error");
        setError(String(body?.error ?? "this code could not be redeemed"));
      }
    } catch {
      setState("error");
      setError("could not reach the server");
    }
  }, []);

  useEffect(() => {
    const code = decodeURIComponent(window.location.hash.replace(/^#/, "")).trim();
    if (!code) {
      setState("error");
      setError("no claim code in this link — run `muster up` and scan the QR again");
      return;
    }
    // history.replaceState so a reload doesn't re-post a (now consumed) code.
    history.replaceState(null, "", window.location.pathname);
    void claim(code);
  }, [claim]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-app px-4">
      <div className="w-full max-w-md text-center">
        <Link to="/" className="inline-flex items-center gap-2 text-ink">
          <MusterbotMark size={48} />
          <span className="text-xl font-semibold tracking-tight">Muster</span>
        </Link>

        <div className="mt-8 rounded-xl border border-hairline bg-panel p-8">
          {state === "claiming" && (
            <>
              <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-hairline border-t-accent" />
              <h1 className="mt-5 text-xl font-bold tracking-tight text-ink">Opening your console…</h1>
              <p className="mt-3 text-sm leading-relaxed text-ink-secondary">
                Redeeming this phone against the server on your machine.
              </p>
            </>
          )}
          {state === "done" && (
            <>
              <h1 className="text-xl font-bold tracking-tight text-ink">You're in.</h1>
              <p className="mt-3 text-sm leading-relaxed text-ink-secondary">
                This phone now runs your Muster fleet. Taking you to the console…
              </p>
            </>
          )}
          {state === "error" && (
            <>
              <h1 className="text-xl font-bold tracking-tight text-ink">That didn't work</h1>
              <div className="mt-4 rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
              <p className="mt-4 text-sm leading-relaxed text-ink-secondary">
                Codes expire in 5 minutes and work once. Run <span className="font-mono text-ink">muster up</span> again
                for a fresh QR.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
