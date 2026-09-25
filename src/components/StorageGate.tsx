// Hosted setup currently requires explicit Drive consent. This is a connection
// prerequisite, not evidence of account-scoped backup or automatic cloud sync.
import { useEffect, useState } from "react";
import { z } from "zod";

import { api, useStore } from "@/state/store";

const consentUrl = z.object({ url: z.string().url() });

export function StorageGate() {
  const { state, dispatch } = useStore();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const gate = state.config?.storageGate;
  const active = gate?.required === true && gate.satisfied === false;
  // The server reports whether a Drive credential pair exists on this install.
  // Without one, /api/workspace/google/connect answers 501
  // ACCOUNT_DRIVE_UNAVAILABLE, so the button would be a control that can never
  // work. An older server sends no `options`, and we keep showing Drive then.
  const driveAvailable = gate?.options?.googleDrive.available ?? true;

  // The Drive callback redirects back to /app?drive=connected|connect-failed.
  // The store fetches /api/config once at boot, so a return from the consent
  // round-trip re-reads it here; the param is then cleaned from the address.
  useEffect(() => {
    if (!active) return;
    const params = new URLSearchParams(window.location.search);
    const drive = params.get("drive");
    if (!drive) return;
    if (drive === "connect-failed") setError("Drive connection was not completed. Use the Google account linked to this sign-in and try again.");
    params.delete("drive");
    const rest = params.toString();
    window.history.replaceState(null, "", `/app${rest ? `?${rest}` : ""}`);
    void api("/api/config").then((config) => dispatch({ type: "configStatus", config }));
  }, [active, dispatch]);

  if (!active) return null;

  // With no Drive credentials there is no action this screen could offer, and
  // an aria-modal dialog with no dismissable control is a trap, not a gate —
  // it hid the whole app behind a wall the user could neither pass nor
  // escape. So the unavailable case is a dismissible notice, not a modal. The
  // gate itself is unaffected: the server refuses this account's durable
  // writes with STORAGE_GATE_REQUIRED either way.
  if (!driveAvailable) {
    if (dismissed) return null;
    return (
      <div className="fixed inset-x-0 top-0 z-[70] flex justify-center p-3" role="status">
        <div className="w-full max-w-lg rounded-2xl border border-hairline/40 bg-card p-4 text-ink shadow-2xl">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.3em] text-accent opacity-80">One-time setup</div>
          <h2 className="text-[15px] font-semibold">Storage setup is not available on this deployment</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
            This Muster server has no Google Drive credentials configured, so Drive cannot be connected from here. Your
            workspace is stored on Muster&rsquo;s server and nothing has been lost. Ask whoever runs this server to add
            Drive credentials, or connect from the desktop app. Until then, creating and saving work stays unavailable on
            this account.
          </p>
          <button
            onClick={() => setDismissed(true)}
            className="mt-3 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const { url } = consentUrl.parse(await api("/api/workspace/google/connect"));
      window.location.href = url;
    } catch (e) {
      setConnecting(false);
      setError(e instanceof Error ? e.message : "Could not reach Google — try again.");
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Connect your storage">
      <div className="w-full max-w-md rounded-2xl bg-card p-7 text-ink shadow-2xl">
        <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.3em] text-accent opacity-80">One-time setup</div>
        <h1 className="text-xl font-semibold text-ink">Connect your Google Drive</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-ink-secondary">
          Allow Muster to use its private folder in your Google Drive. This connects storage; it does not start automatic backups or sync. Your web workspace is still stored on Muster’s server.
        </p>
        <button
          onClick={() => void connect()}
          disabled={connecting}
          className="mt-5 flex w-full items-center justify-center gap-2.5 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_color-mix(in_srgb,var(--color-accent)_28%,transparent)] transition-all hover:-translate-y-px hover:brightness-110 disabled:opacity-60"
        >
          <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4"><path fill="currentColor" d="M21.35 11.1H12v2.9h5.35c-.5 2.5-2.6 3.9-5.35 3.9a5.9 5.9 0 1 1 0-11.8c1.5 0 2.85.55 3.9 1.45l2.15-2.15A9 9 0 1 0 12 21c5.2 0 8.65-3.65 8.65-8.8 0-.6-.1-1.1-.3-1.1z"/></svg>
          {connecting ? "Opening Google…" : "Connect Google Drive"}
        </button>
        <p className="mt-3 text-[12px] text-ink-secondary">
          Full encrypted backup and restore are currently available from the desktop app. Keep your backup passphrase somewhere safe.
        </p>
        {error && <p role="alert" className="mt-3 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink">{error}</p>}
        <p className="mt-4 border-t border-hairline pt-3 text-[11.5px] text-ink-secondary">
          Google sign-in and Calendar access do not grant Drive access. Existing connections may need this separate consent again.
        </p>
      </div>
    </div>
  );
}
