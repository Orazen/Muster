import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api } from "@/state/store";
import { CalendarAgenda } from "./CalendarAgenda";

const statusSchema = z.object({ configured: z.boolean(), connected: z.boolean(), requiresSignIn: z.boolean().optional() });
type CalendarStatus = z.infer<typeof statusSchema>;

/** Personal Calendar grants are separate from installation-wide connectors. */
export function CalendarConnection() {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const callbackFailed = new URLSearchParams(window.location.search).get("calendar") === "failed";

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api("/api/calendar/status").then((result) => {
      const parsed = statusSchema.safeParse(result);
      if (!parsed.success) throw new Error("Calendar status is unavailable. Please retry.");
      if (alive) { setStatus(parsed.data); setError(null); }
    }).catch((cause) => {
      if (alive) { setStatus(null); setError(cause instanceof Error ? cause.message : "Could not check Calendar. Please retry."); }
    }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [attempt]);

  async function changeConnection() {
    if (pending.current || busy || !status || status.requiresSignIn) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    let navigating = false;
    try {
      if (status.connected) {
        const result = await api("/api/calendar/connection", { method: "DELETE" });
        if (result.ok !== true) throw new Error("Could not disconnect Calendar. Please retry.");
        setStatus({ ...status, connected: false });
      } else {
        const result = await api("/api/calendar/connect", { method: "POST" });
        const target = z.string().url().refine((value) => {
          const url = new URL(value);
          return url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth"
            && !url.username && !url.password;
        }).safeParse(result.url);
        if (!target.success) throw new Error("Could not open Calendar consent. Please retry.");
        // Preserve the session's cookie jar, including inside Electron.
        window.location.assign(target.data);
        navigating = true;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update Calendar. Please retry.");
    } finally {
      if (!navigating) { pending.current = false; setBusy(false); }
    }
  }

  return (
    <section aria-label="Personal Google Calendar" className="mb-5 min-w-0 rounded-xl border border-hairline/50 bg-raised/30 p-4 text-[12.5px]">
      <h3 className="text-[14px] font-medium text-ink">Personal Google Calendar</h3>
      <p className="mt-1 text-ink-secondary">For your signed-in account, separate from installation app connections. This connection requests read-only access and does not change events.</p>
      <p className="mt-2 text-ink-secondary" role="status">{busy ? "Checking or updating Calendar…" : status?.requiresSignIn ? "Sign in to connect your personal Calendar." : status?.connected ? "Calendar connected" : status && !status.configured ? "Calendar connection is unavailable on this server." : status ? "Calendar not connected" : "Calendar status unknown"}</p>
      {callbackFailed && !status?.connected && <p className="mt-2 text-warning">Calendar consent did not finish. You can try connecting again.</p>}
      {error && <p role="alert" className="mt-2 break-words text-danger">{error}</p>}
      {!status && !busy && <button className="mt-3 rounded-lg bg-raised px-3 py-2 text-ink" onClick={() => setAttempt((value) => value + 1)}>Retry Calendar status</button>}
      {status?.requiresSignIn && <a href="/sign-in?next=%2Fapp" className="mt-3 inline-block rounded-lg bg-raised px-3 py-2 text-ink">Sign in for Calendar</a>}
      {status && !status.requiresSignIn && (status.configured || status.connected) && <button disabled={busy} onClick={() => void changeConnection()} className="mt-3 rounded-lg bg-raised px-3 py-2 text-ink disabled:opacity-40">{status.connected ? "Disconnect Calendar here" : "Connect Google Calendar"}</button>}
      {status?.connected && !status.requiresSignIn && <p className="mt-2 text-ink-secondary">Disconnecting removes Calendar access from Muster. It does not revoke Google’s combined permission grant or disconnect your Drive backup.</p>}
      {status?.connected && !status.requiresSignIn && !busy && <CalendarAgenda />}
    </section>
  );
}
