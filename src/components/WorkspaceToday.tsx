import { useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ArrowUpRight, CalendarDays, ChevronRight, ListChecks, MessageSquare, Monitor, PencilLine } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { appendDraft, useDraft } from "@/lib/drafts";
import { WorkspaceBrandMark } from "./WorkspaceBrandMark";
import { useStore, visibleMessages, type Bot, type Message } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import "./workspace-today.css";

interface WorkspaceTodayProps {
  onOpenCalendar: () => void;
  onOpenDevices: () => void;
}

function messagePreview(message: Message | undefined): string {
  if (!message) return "Open the conversation to begin.";
  if (message.card) return message.card.title;
  if (message.connector) return message.connector.label;
  if (message.kind === "screen") return "A computer screenshot is available.";
  if (message.tool) return message.tool.spoken || message.tool.name;
  return message.text?.trim() || "Open the conversation to continue.";
}

function botStatus(bot: Bot, last: Message | undefined, delivery: string | undefined) {
  if (delivery === "unknown") return { label: "Check outcome", attention: true };
  if (delivery === "checking") return { label: "Checking delivery", attention: false };
  if (bot.activity === "waiting-on-you") return { label: "Needs you", attention: true };
  if (bot.activity === "no-signal") return { label: "No signal", attention: true };
  if (bot.activity === "dead") return { label: "Stopped", attention: true };
  if (bot.busy || bot.activity === "working") return { label: "Working", attention: false };
  if (last?.tool?.ok === false) return { label: "Needs attention", attention: true };
  if (bot.unread) return { label: "Unread", attention: false };
  return { label: "Conversation", attention: false };
}

/** A read-only overview. Preparing text only appends to the existing local
 * composer draft; sending and all permission decisions stay in the chat. */
export function WorkspaceToday({ onOpenCalendar, onOpenDevices }: WorkspaceTodayProps) {
  const { state, dispatch } = useStore();
  const { user } = useAuth();
  const [text, setText] = useDraft(`today:${user?.id ?? "unavailable"}`);
  const [chosenBotId, setChosenBotId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const preparing = useRef(false);
  const bots = state.bots.filter((bot) => !bot.hidden);
  const defaultBot = bots.find((bot) => bot.id === state.selectedId)
    ?? bots.find((bot) => bot.chiefOfStaff)
    ?? bots[0];
  // An explicitly chosen assistant disappearing must not silently redirect
  // the user's draft into another conversation.
  const target = chosenBotId === null ? defaultBot : bots.find((bot) => bot.id === chosenBotId);
  const recent = useMemo(() => state.bots.filter((bot) => !bot.hidden).map((bot) => {
    const last = visibleMessages(bot).at(-1);
    const deliveries = Object.values(state.messageDelivery).filter((item) => item.threadId === bot.threadId);
    const delivery = deliveries.some((item) => item.state === "unknown") ? "unknown"
      : deliveries.some((item) => item.state === "checking") ? "checking" : undefined;
    return { bot, last, status: botStatus(bot, last, delivery) };
  }).sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0)), [state.bots, state.messageDelivery]);
  const needsAttention = recent.filter((item) => item.status.attention);
  const reviewTarget = needsAttention[0]?.bot ?? target ?? recent[0]?.bot;
  const now = new Date();
  const greeting = now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening";
  const firstName = user?.name?.trim().split(/\s+/)[0];

  function prepare(event: FormEvent) {
    event.preventDefault();
    if (preparing.current || !user || !target || !text.trim()) return;
    preparing.current = true;
    appendDraft(`bot:${target.id}`, text.trim());
    setText("");
    dispatch({ type: "select", id: target.id });
  }

  function captureIdea() {
    input.current?.focus();
    setNotice("Capture your idea below. It stays a draft until you send it in the conversation.");
  }

  return (
    <main className="workspace-today" aria-label="Today workspace">
      <div className="wt-grid">
        <div className="wt-main">
          <header className="wt-greeting">
            <WorkspaceBrandMark size={66} label="Muster" />
            <p className="wt-date">{now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
            <h1>{greeting}{firstName ? `, ${firstName}` : ""}<span>.</span></h1>
            <p>A little more clarity. One useful next step.</p>
          </header>

          <div className="wt-actions" aria-label="Get started">
            <button type="button" className="wt-action" aria-label="Plan my day" onClick={onOpenCalendar}>
              <span className="wt-action-icon"><CalendarDays size={19} aria-hidden="true" /></span>
              <strong>Plan my day</strong><span>Review Calendar and prepare a plan</span><ArrowUpRight className="wt-action-arrow" size={15} aria-hidden="true" />
            </button>
            <button type="button" className="wt-action" aria-label="Capture idea" onClick={captureIdea} disabled={!user}>
              <span className="wt-action-icon wt-amber"><PencilLine size={19} aria-hidden="true" /></span>
              <strong>Capture idea</strong><span>Keep a thought for your assistant</span><ArrowUpRight className="wt-action-arrow" size={15} aria-hidden="true" />
            </button>
            <button type="button" className="wt-action" aria-label="Review work" disabled={!reviewTarget} onClick={() => reviewTarget && dispatch({ type: "select", id: reviewTarget.id })}>
              <span className="wt-action-icon wt-mint"><ListChecks size={19} aria-hidden="true" /></span>
              <strong>Review work</strong><span>{needsAttention.length ? `${needsAttention.length} ${needsAttention.length === 1 ? "conversation needs" : "conversations need"} a look` : "Continue an existing conversation"}</span><ArrowUpRight className="wt-action-arrow" size={15} aria-hidden="true" />
            </button>
          </div>

          <form className="wt-composer" onSubmit={prepare}>
            <label className="sr-only" htmlFor="today-request">Request for your assistant</label>
            <textarea id="today-request" ref={input} value={text} rows={3} maxLength={12_000} disabled={!user} placeholder="What would make today a little easier?" onChange={(event) => { preparing.current = false; setText(event.target.value); setNotice(""); }} />
            <div className="wt-composer-footer">
              <label className="wt-recipient" htmlFor="today-recipient"><span>Draft for</span>
                <select id="today-recipient" value={target?.id ?? ""} disabled={!bots.length || !user} onChange={(event) => setChosenBotId(event.target.value)}>
                  {!target && <option value="">{bots.length ? "Choose an assistant" : "No assistant yet"}</option>}
                  {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                </select>
              </label>
              <button type="submit" className="wt-primary" disabled={!user || !target || !text.trim()}>Prepare draft <ArrowRight size={15} aria-hidden="true" /></button>
            </div>
          </form>
          <p className="wt-composer-note">Adds to your existing draft. Nothing is sent until you review and send it in the conversation.</p>
          {notice && <p className="wt-notice" role="status">{notice}</p>}

          <section className="wt-recent" aria-labelledby="today-recent-title">
            <div className="wt-section-heading"><h2 id="today-recent-title">Pick up where you left off</h2><span>{state.rosterHydrated ? `${bots.length} ${bots.length === 1 ? "assistant" : "assistants"}` : "Loading…"}</span></div>
            {!state.rosterHydrated ? (
              <div className="wt-empty" role="status"><MessageSquare size={21} aria-hidden="true" /><p>Loading your conversations…</p></div>
            ) : !recent.length ? (
              <div className="wt-empty"><MessageSquare size={23} aria-hidden="true" /><h3>Your next conversation starts here.</h3><p>Add an assistant from the sidebar to prepare a draft. You can open Calendar now to check its connection.</p></div>
            ) : (
              <ul className="wt-recent-list">
                {recent.slice(0, 5).map(({ bot, last, status }) => <li key={bot.id}>
                  <button type="button" aria-label={`Open conversation with ${bot.name}`} onClick={() => dispatch({ type: "select", id: bot.id })}>
                    <AgentAvatar color={bot.color} character={bot.character} seed={bot.id} size={34} animated={false} trackPointer={false} />
                    <span className="wt-conversation"><strong>{bot.name}</strong><span>{messagePreview(last)}</span></span>
                    <span className={`wt-status${status.attention ? " wt-needs-you" : ""}`}>{status.label}</span><ChevronRight size={15} className="wt-row-arrow" aria-hidden="true" />
                  </button>
                </li>)}
              </ul>
            )}
          </section>
          <p className="wt-bottom-note"><WorkspaceBrandMark size={17} />One assistant. Your next step, in reach.</p>
        </div>

        <aside className="wt-context" aria-label="Workspace context">
          <section className="wt-context-section">
            <div className="wt-context-title"><CalendarDays size={16} aria-hidden="true" /><h2>Make room for your day</h2></div>
            <p>Open your Calendar connection to review the day and prepare a planning draft.</p>
            <button type="button" className="wt-text-button" onClick={onOpenCalendar}>Open Calendar <ArrowUpRight size={14} aria-hidden="true" /></button>
            <p className="wt-small-note">Calendar access is checked there. No events change when you prepare a draft.</p>
          </section>
          <section className="wt-context-section">
            <div className="wt-context-title"><Monitor size={16} aria-hidden="true" /><h2>Your workspace</h2></div>
            <p>Review remote-access and pairing options for this workspace.</p>
            <button type="button" className="wt-text-button" onClick={onOpenDevices}>Devices <ArrowRight size={14} aria-hidden="true" /></button>
            <p className="wt-small-note">Signing in does not grant a device permission to act.</p>
          </section>
          <p className="wt-connection" role="status"><span className={state.connected ? "wt-connection-dot wt-connected" : "wt-connection-dot"} aria-hidden="true" />{state.connected ? "Connected to workspace" : state.rosterHydrated ? "Reconnecting · activity may be out of date" : "Connecting to workspace"}</p>
        </aside>
      </div>
    </main>
  );
}
