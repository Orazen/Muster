import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api } from "@/state/store";
import { useAuth } from "@/lib/auth";

const preferenceSchema = z.object({ enabled: z.boolean(), generation: z.number().int().nonnegative(), requiresSignIn: z.boolean().optional() });
type Preference = z.infer<typeof preferenceSchema>;

export function ProviderFallbackPreference() {
  const { user, session, loading, sessionError } = useAuth();
  // Remount synchronously when identity changes, so an old account's consent
  // cannot appear for even one render or complete a pending save in the new one.
  return <PreferenceCard key={`${user?.id ?? "anonymous"}:${session?.id ?? "none"}:${loading}:${!!sessionError}`} authPending={loading || !!sessionError} />;
}

function PreferenceCard({ authPending }: { authPending: boolean }) {
  const [preference, setPreference] = useState<Preference | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const ticket = ++request.current;
    if (!authPending) {
      setBusy(true);
      api("/api/provider-fallback").then((result) => {
        const parsed = preferenceSchema.parse(result);
        if (ticket === request.current) { setPreference(parsed); setError(null); }
      }).catch(() => {
        if (ticket === request.current) { setPreference(null); setError("Could not check automatic retry. Please retry."); }
      }).finally(() => { if (ticket === request.current) setBusy(false); });
    }
    return () => { request.current++; };
  }, [attempt, authPending]);

  async function change() {
    if (busy || pending.current || !preference || preference.requiresSignIn || authPending) return;
    const ticket = ++request.current;
    const enabled = !preference.enabled;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = preferenceSchema.parse(await api("/api/provider-fallback", { method: "PATCH", body: JSON.stringify({ enabled }) }));
      if (result.requiresSignIn || result.enabled !== enabled || result.generation < preference.generation) throw new Error("Unconfirmed preference");
      if (ticket === request.current) setPreference(result);
    } catch {
      // A failed/ambiguous write is unknown, never evidence of consent or revocation.
      if (ticket === request.current) { setPreference(null); setError("Could not confirm the change. Check the saved preference before retrying."); }
    } finally {
      if (ticket === request.current) { setBusy(false); pending.current = false; }
    }
  }

  return <section aria-label="Automatic provider retry" className="min-w-0 rounded-xl border border-hairline/40 bg-card p-3 text-[12px]">
    <h3 className="text-[13px] font-medium text-ink">Automatic provider retry</h3>
    <p className="mt-1 text-ink-secondary">Off by default: when a provider is unavailable, Muster pauses. If you enable automatic retry, your task may be sent to another connected provider and use paid credits.</p>
    <p className="mt-1 text-ink-secondary">Applies only to your account-owned providers. Shared installation providers are excluded.</p>
    <p role="status" className="mt-2 text-ink-secondary">{authPending ? "Waiting for account verification…" : busy ? "Checking or saving preference…" : preference?.requiresSignIn ? "Sign in to choose automatic provider retry." : preference ? preference.enabled ? "Automatic retry is on" : "Automatic retry is off" : "Automatic retry status unknown"}</p>
    {error && <p role="alert" className="mt-2 break-words text-danger">{error}</p>}
    {preference && !preference.requiresSignIn && <button type="button" disabled={busy || authPending} onClick={() => void change()} className="mt-3 rounded-lg bg-raised px-3 py-2 text-ink disabled:opacity-40">{preference.enabled ? "Turn off automatic retry" : "Enable automatic retry"}</button>}
    {!preference && !busy && !authPending && <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-3 rounded-lg bg-raised px-3 py-2 text-ink">Check saved preference</button>}
    {preference?.requiresSignIn && <a href="/sign-in?next=%2Fapp" className="mt-3 inline-block rounded-lg bg-raised px-3 py-2 text-ink">Sign in for automatic retry</a>}
  </section>;
}
