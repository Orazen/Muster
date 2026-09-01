// Agent window content for the OS desktop — one window per roster bot,
// several open at once. The shared WindowFrame owns drag/resize/focus
// chrome; this file adds the agent identity (avatar, live activity,
// model chips, "Open chat") from the same SSE-fed store as the dock.
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import type { Bot } from "@/state/store";
import { AgentAvatar } from "@/components/Avatar";
import { WindowFrame } from "@/components/os/Window";

/** Short human label for what a bot is doing right now. Mirrors the
 * sidebar's preview priority: waiting-on-you outranks busy. Shared with
 * the dock, which uses it for aria-labels on the same roster. */
export function activityLabel(bot: Bot): string {
  if (bot.activity === "waiting-on-you") return "Waiting for you…";
  if (bot.busy) return "Working…";
  if (bot.activity === "no-signal") return "No signal";
  if (bot.activity === "dead") return "Offline";
  return "Idle";
}

interface AgentWindowProps {
  bot: Bot;
  engineName: string | null;
  focused: boolean;
  minimized: boolean;
  zIndex: number;
  cascade: number;
  onFocus: () => void;
  onMinimize: () => void;
  onClose: () => void;
}

export function AgentWindow({
  bot,
  engineName,
  focused,
  minimized,
  zIndex,
  cascade,
  onFocus,
  onMinimize,
  onClose,
}: AgentWindowProps) {
  const navigate = useNavigate();
  const openChat = () => {
    navigate("/app");
  };

  return (
    <WindowFrame
      title={bot.name}
      ariaLabel={`${bot.name} agent window`}
      focused={focused}
      minimized={minimized}
      zIndex={zIndex}
      cascade={cascade}
      width={420}
      height={390}
      onFocus={onFocus}
      onMinimize={onMinimize}
      onClose={onClose}
    >
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
    </WindowFrame>
  );
}
