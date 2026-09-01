// Muster OS — a desktop-style shell over the agent roster. The dock holds
// one app icon per visible bot with a live status dot; opening an icon
// raises a centered agent window (activity, model, "Open chat"). All data
// is the shared store, so busy/activity truth updates live over the same
// SSE stream the chat view listens to.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { AgentAvatar } from "@/components/Avatar";
import { MusterbotMark } from "@/components/MusterbotMark";
import { RoomsPanel } from "@/components/os/RoomsPanel";
import "./os.css";
import "./os-tokens.css";
import "./rooms.css";

/** Short human label for what a bot is doing right now. Mirrors the
 * sidebar's preview priority: waiting-on-you outranks busy. */
function activityLabel(bot: Bot): string {
  if (bot.activity === "waiting-on-you") return "Waiting for you…";
  if (bot.busy) return "Working…";
  if (bot.activity === "no-signal") return "No signal";
  if (bot.activity === "dead") return "Offline";
  return "Idle";
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return <span className="os-clock">{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>;
}

interface AgentWindowProps {
  bot: Bot;
  engineName: string | null;
  onClose: () => void;
}

/** The centered "window" an open dock icon raises. Escape closes; the
 * close button receives focus on open so keyboard users start inside. */
function AgentWindow({ bot, engineName, onClose }: AgentWindowProps) {
  const navigate = useNavigate();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const openChat = () => {
    navigate("/app");
  };

  return (
    <div
      className="os-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="os-window" role="dialog" aria-modal="true" aria-label={`${bot.name} agent window`}>
        <div className="os-window-titlebar">
          <span className="os-window-title">{bot.name}</span>
          <button
            ref={closeRef}
            type="button"
            className="os-window-close"
            aria-label={`Close ${bot.name} window`}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        <div className="os-window-body">
          <div className="os-window-hero">
            <AgentAvatar color={bot.color} character={bot.character} state={bot.busy ? "working" : "idle"} size={52} label={bot.name} />
            <div className="min-w-0">
              <div className="os-window-name">{bot.name}</div>
              <div className="os-window-role">{bot.title}</div>
            </div>
          </div>
          <div className="os-window-activity">{activityLabel(bot)}</div>
          <div className="os-window-meta">
            <span className="os-chip">{engineName ?? bot.modelSelection.model}</span>
            <span className="os-chip">{bot.modelSelection.model}</span>
          </div>
          <button type="button" className="os-open-chat" onClick={openChat}>
            Open chat
            <ArrowLeft size={14} style={{ transform: "rotate(180deg)" }} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Full-screen desktop view of the roster. Route: /os. */
export function DesktopShell() {
  const { state } = useStore();
  const [openBotId, setOpenBotId] = useState<string | null>(null);
  const bots = state.bots.filter((b) => !b.hidden);
  const openBot = openBotId ? (bots.find((b) => b.id === openBotId) ?? null) : null;
  const engineFor = (bot: Bot) =>
    state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.displayName ?? null;

  return (
    <div className="os-desktop">
      <header className="os-topbar">
        <div className="os-mark">
          <MusterbotMark size={20} />
          Muster
        </div>
        <Clock />
      </header>
      <main className="os-body">
        {bots.length === 0 && <div className="os-empty">Your roster is empty — muster a teammate from the app.</div>}
        <RoomsPanel />
        {openBot && (
          <AgentWindow bot={openBot} engineName={engineFor(openBot)} onClose={() => setOpenBotId(null)} />
        )}
        <button
          type="button"
          className="os-exit"
          onClick={() => {
            window.history.back();
          }}
        >
          <ArrowLeft size={13} />
          Back to app
        </button>
      </main>
      <nav className="os-dock" aria-label="Agent dock">
        <div className="os-dock-list">
          {bots.map((bot) => (
            <button
              key={bot.id}
              type="button"
              className="os-dock-item"
              aria-label={`${bot.name} — ${activityLabel(bot)}`}
              aria-expanded={openBotId === bot.id}
              onClick={() => setOpenBotId(bot.id)}
            >
              <span className="os-dock-icon">
                <AgentAvatar color={bot.color} character={bot.character} state={bot.busy ? "working" : "idle"} size={38} label={bot.name} />
              </span>
              <span className="os-status-dot" data-busy={bot.busy ? "true" : "false"} />
              <span className="os-dock-name">{bot.name}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
