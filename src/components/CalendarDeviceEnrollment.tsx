import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api } from "@/state/store";
import { useAuth } from "@/lib/auth";

const enrollmentSchema = z.object({ enrollment: z.object({ id: z.string(), botId: z.string(), botName: z.string(), threadId: z.string(), callId: z.string(), expiresAt: z.number(), state: z.string() }) });
const calendarsSchema = z.object({ calendars: z.array(z.object({ id: z.string(), summary: z.string() })) });
const devicesSchema = z.object({ devices: z.array(z.object({ id: z.string().uuid(), label: z.string(), calendarId: z.string(), expiresAt: z.number() })) });
const okSchema = z.object({ ok: z.literal(true) });
const button = "rounded-lg bg-raised px-3 py-2 text-ink disabled:opacity-40";
const input = "mt-1 block w-full min-w-0 max-w-full rounded-lg border border-hairline bg-raised px-2 py-2 text-ink";

export function CalendarDeviceEnrollment() {
  const { user } = useAuth();
  return user ? <Enrollment key={user.id} /> : null;
}

function Enrollment() {
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<z.infer<typeof enrollmentSchema>["enrollment"] | null>(null);
  const [calendars, setCalendars] = useState<z.infer<typeof calendarsSchema>["calendars"]>([]);
  const [calendarId, setCalendarId] = useState("");
  const [label, setLabel] = useState("My Watch");
  const [devices, setDevices] = useState<z.infer<typeof devicesSchema>["devices"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { generation.current++; window.clearInterval(timer); };
  }, []);
  async function run(action: (current: () => boolean) => Promise<void>) {
    if (pending.current) return;
    const id = ++generation.current;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    const current = () => generation.current === id;
    try { await action(current); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "Calendar authorization failed. Please retry."); }
    finally { if (current()) { pending.current = false; setBusy(false); } }
  }
  async function refresh(current: () => boolean) {
    const result = devicesSchema.parse(await api("/api/calendar/devices"));
    if (current()) setDevices(result.devices);
  }
  function changeCode(value: string) {
    generation.current++; pending.current = false; setBusy(false);
    setCode(value.toUpperCase().replace(/[\s-]/g, "")); setEnrollment(null); setCalendarId(""); setCalendars([]); setNotice(null); setError(null);
  }
  const valid = /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code);
  const canApprove = enrollment?.state === "waiting" && enrollment.expiresAt > now && calendarId && label.trim();
  return <section aria-label="Watch Calendar authorization" className="mt-4 min-w-0 space-y-3 border-t border-hairline/50 pt-3">
    <h4 className="font-medium text-ink">Calendar on your Watch</h4>
    <p className="break-words text-ink-secondary">Open Calendar settings on the same computer connected to your Watch. This page: {window.location.host}. A connection on muster.today does not transfer to another computer.</p>
    <label className="block text-ink-secondary">Watch authorization code<input className={input} value={code} maxLength={16} autoComplete="off" spellCheck={false} onChange={event => changeCode(event.target.value)} /></label>
    <button className={button} disabled={busy || !valid} onClick={() => void run(async current => {
      setEnrollment(null);
      const result = enrollmentSchema.parse(await api("/api/calendar/enrollment/inspect", { method: "POST", body: JSON.stringify({ code }) }));
      if (!current()) return;
      setEnrollment(result.enrollment);
      const list = calendarsSchema.parse(await api("/api/calendar/calendars"));
      if (current()) setCalendars(list.calendars);
    })}>Inspect Watch request</button>
    {enrollment && <div className="space-y-3">
      <p className="break-words">Request for {enrollment.botName}. Expires {new Date(enrollment.expiresAt).toLocaleTimeString()}.</p>
      {enrollment.expiresAt <= now ? <p role="status">This request expired. Request a new code on your Watch.</p> : enrollment.state !== "waiting" ? <p role="status">Request status: {enrollment.state}. Check your Watch before continuing.</p> : <>
        <label className="block text-ink-secondary">Watch calendar<select className={input} value={calendarId} disabled={busy} onChange={event => setCalendarId(event.target.value)}><option value="">Select a calendar</option>{calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.summary || "Untitled calendar"}</option>)}</select></label>
        <label className="block text-ink-secondary">Authorization name<input className={input} value={label} maxLength={80} disabled={busy} onChange={event => setLabel(event.target.value)} /></label>
        <p className="text-ink-secondary">Allow read-only access to this calendar for 24 hours. Preparing a plan does not send messages or change events.</p>
        <button className={button} disabled={busy || !canApprove} onClick={() => void run(async current => {
          okSchema.parse(await api("/api/calendar/enrollment/approve", { method: "POST", body: JSON.stringify({ code, calendarId, label: label.trim() }) }));
          if (!current()) return;
          setEnrollment(null); setCode(""); setNotice("Approved. Return to your Watch to finish connecting.");
          await refresh(current);
        })}>Approve 24-hour access</button>
      </>}
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="break-words text-danger">{error}</p>}
    <button className={button} disabled={busy} onClick={() => void run(refresh)}>Refresh device authorizations</button>
    {devices?.length === 0 && <p className="text-ink-secondary">No active device authorizations.</p>}
    {devices?.map(device => <div key={device.id} className="space-y-1 rounded-lg border border-hairline p-2">
      <p className="break-words">{device.label} · {device.calendarId}</p>
      <p className="text-ink-secondary">Expires {new Date(device.expiresAt).toLocaleString()}</p>
      <button className={button} disabled={busy} aria-label={`Revoke ${device.label}`} onClick={() => void run(async current => {
        okSchema.parse(await api(`/api/calendar/devices/${device.id}`, { method: "DELETE" }));
        if (current()) { setDevices(items => items?.filter(item => item.id !== device.id) ?? null); setNotice("Authorization revoked."); }
      })}>Revoke</button>
    </div>)}
  </section>;
}
