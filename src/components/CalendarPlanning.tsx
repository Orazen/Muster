import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { api, useStore } from "@/state/store";
import { useAuth } from "@/lib/auth";
import { appendDraft } from "@/lib/drafts";

const responseSchema = z.object({ calendarId: z.string(), date: z.string(), timeZone: z.string(), draft: z.string().trim().min(1).max(32_000) });
const commitmentSchema = z.array(z.object({ title: z.string().trim().min(1).max(200), minutes: z.number().int().min(5).max(240) })).min(1).max(3);

/** Preparing a plan changes only the selected bot's unsent composer draft. */
export function CalendarPlanning({ calendarId, date, timeZone }: { calendarId: string; date: string; timeZone: string }) {
  const { state, dispatch } = useStore();
  const { user } = useAuth();
  const [botId, setBotId] = useState(() => state.bots.find((bot) => bot.id === state.selectedId)?.id ?? state.bots[0]?.id ?? "");
  const [workStart, setWorkStart] = useState("09:00");
  const [workEnd, setWorkEnd] = useState("17:00");
  const [commitments, setCommitments] = useState([{ title: "", minutes: 30 }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const live = useRef({ userId: user?.id, bots: state.bots });
  live.current = { userId: user?.id, bots: state.bots };
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { generation.current++; pending.current = false; setBusy(false); }, [user?.id]);
  function invalidate() { generation.current++; pending.current = false; setBusy(false); setError(null); }
  async function prepare() {
    if (pending.current) return;
    const parsed = commitmentSchema.safeParse(commitments);
    if (!parsed.success || !/^\d{2}:\d{2}$/.test(workStart) || !/^\d{2}:\d{2}$/.test(workEnd) || workStart >= workEnd) {
      setError("Enter one to three commitments of 5–240 minutes and a work window ending after it starts."); return;
    }
    if (!state.bots.some((bot) => bot.id === botId)) { setError("Choose an available bot for your draft."); return; }
    const request = ++generation.current;
    const userId = user?.id;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await api("/api/calendar/plan", { method: "POST", body: JSON.stringify({ calendarId, date, timeZone, workStart, workEnd, commitments: parsed.data }) });
      if (request !== generation.current || userId !== live.current.userId) return;
      const response = responseSchema.safeParse(result);
      if (!response.success || response.data.calendarId !== calendarId || response.data.date !== date || response.data.timeZone !== timeZone) throw new Error("Could not prepare a complete planning draft. Please retry.");
      if (!live.current.bots.some((bot) => bot.id === botId)) throw new Error("That bot is no longer available. Choose another bot.");
      appendDraft(`bot:${botId}`, response.data.draft);
      dispatch({ type: "select", id: botId });
      dispatch({ type: "togglePlugins", open: false });
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : "Could not prepare your draft. Please retry.");
    } finally {
      if (request === generation.current) { pending.current = false; setBusy(false); }
    }
  }
  const inputClass = "mt-1 block w-full min-w-0 max-w-full rounded-lg border border-hairline bg-raised px-2 py-2 text-ink";
  return <div className="mt-4 min-w-0 space-y-3 border-t border-hairline/50 pt-3" aria-label="Plan your day">
    <h4 className="font-medium text-ink">Plan your day</h4>
    <p className="text-ink-secondary">List commitments in priority order. We’ll refresh this day and add a proposal to your bot’s draft. Review it before sending; calendar events stay unchanged.</p>
    <label className="block min-w-0 text-ink-secondary">Work starts<input type="time" className={inputClass} value={workStart} onChange={(event) => { invalidate(); setWorkStart(event.target.value); }} /></label>
    <label className="block min-w-0 text-ink-secondary">Work ends<input type="time" className={inputClass} value={workEnd} onChange={(event) => { invalidate(); setWorkEnd(event.target.value); }} /></label>
    {commitments.map((commitment, index) => <div key={index} className="min-w-0 space-y-2">
      <label className="block min-w-0 text-ink-secondary">Commitment {index + 1}<input className={inputClass} maxLength={200} value={commitment.title} onChange={(event) => { invalidate(); setCommitments((items) => items.map((item, i) => i === index ? { ...item, title: event.target.value } : item)); }} /></label>
      <label className="block min-w-0 text-ink-secondary">Minutes for commitment {index + 1}<input type="number" min={5} max={240} step={1} className={inputClass} value={commitment.minutes} onChange={(event) => { invalidate(); setCommitments((items) => items.map((item, i) => i === index ? { ...item, minutes: Number(event.target.value) } : item)); }} /></label>
      {commitments.length > 1 && <button className="text-ink-secondary" onClick={() => { invalidate(); setCommitments((items) => items.filter((_, i) => i !== index)); }}>Remove commitment {index + 1}</button>}
    </div>)}
    {commitments.length < 3 && <button className="rounded-lg bg-raised px-3 py-2 text-ink" onClick={() => { invalidate(); setCommitments((items) => [...items, { title: "", minutes: 30 }]); }}>Add commitment</button>}
    <label className="block min-w-0 text-ink-secondary">Draft for bot<select className={inputClass} value={botId} onChange={(event) => { invalidate(); setBotId(event.target.value); }}><option value="">Select a bot</option>{state.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
    <button disabled={busy || !botId} className="rounded-lg bg-raised px-3 py-2 text-ink disabled:opacity-40" onClick={() => void prepare()}>Prepare planning draft</button>
    {busy && <p role="status" className="text-ink-secondary">Preparing planning draft…</p>}
    {error && <p role="alert" className="break-words text-danger">{error}</p>}
  </div>;
}
