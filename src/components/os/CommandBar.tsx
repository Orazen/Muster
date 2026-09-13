// The OS command bar — the "Jarvis" surface. ⌘K (or the topbar mic-less
// search field) opens a floating console where a typed line routes to a
// bot and starts a real turn: plain requests go to the busiest-relevant
// default bot, "botname: do X" or @botname targets a specific one, and
// "open X" raises windows instead of prompting a model. Everything rides
// the same store dispatch the chat composer uses, so turns stream, show
// approval cards, and land receipts exactly like a typed message.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/state/store";
import { AgentAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";

interface ParsedCommand {
  /** bot the turn should go to, when resolved */
  botId: string | null;
  /** raise this app window instead of prompting a model */
  openApp: "rooms" | null;
  text: string;
  /** true when a name prefix was recognized ("jarvis:" / "@jarvis") */
  targeted: boolean;
  /** validation text when a user specifically targeted a bot by name */
  targetError?: string;
}

const COMMAND_HELP = "Ask anything — or: botname: task · @bot task · open rooms";

export function parseCommand(raw: string, bots: Array<{ id: string; name: string; chiefOfStaff?: boolean }>): ParsedCommand {
  const text = raw.trim();
  if (!text) return { botId: null, openApp: null, text, targeted: false };

  // "open rooms" / "show rooms" — window management, no model call
  if (/^(open|show)\s+rooms$/i.test(text)) return { botId: null, openApp: "rooms", text, targeted: false };

  // "botname: rest" or "@botname rest" — targeted turn
  const colon = text.match(/^([\w][\w\s-]{0,30}?)\s*[:：]\s*(.+)$/s);
  const at = text.match(/^@([\w-]{1,30})\s+(.+)$/s);
  const named = colon ?? at;
  if (named) {
    const wanted = named[1].trim().toLowerCase();
    const bot = bots.find((b) => b.name.toLowerCase() === wanted);
    if (bot) return { botId: bot.id, openApp: null, text: named[2].trim(), targeted: true };
    return {
      botId: null,
      openApp: null,
      text: named[2].trim(),
      targeted: true,
      targetError: `Could not find teammate "${named[1].trim()}". Pick one to send it to.`,
    };
  }

  // plain request → the chief of staff, else the first bot
  const preferred = bots.find((b) => b.chiefOfStaff) ?? bots[0];
  return { botId: preferred?.id ?? null, openApp: null, text, targeted: false };
}

export function CommandBar({ open, onClose, onOpenRooms }: { open: boolean; onClose: () => void; onOpenRooms: () => void }) {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const bots = state.bots.filter((b) => !b.hidden);

  useEffect(() => {
    if (open) {
      setDraft("");
      setError(null);
      // focus after mount so the transition doesn't eat the caret
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const parsed = useMemo(() => parseCommand(draft, bots), [draft, bots]);

  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return bots.slice(0, 4);
    return bots.filter((b) => b.name.toLowerCase().includes(q)).slice(0, 4);
  }, [draft, bots]);

  if (!open) return null;

  const run = () => {
    const command = parseCommand(draft, bots);
    if (!command.text) return;
    if (command.openApp === "rooms") {
      onOpenRooms();
      onClose();
      return;
    }
    if (command.targeted && command.targetError) {
      setError(command.targetError);
      return;
    }
    if (!command.botId) {
      setError("No bot to ask — muster one first.");
      return;
    }
    dispatch({ type: "send", botId: command.botId, text: command.text });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[14vh]" onPointerDown={onClose}>
      <div
        className="glass-console w-[min(560px,92vw)] rounded-2xl p-2"
        role="dialog"
        aria-label="Command console"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="os-console-glow" aria-hidden="true" />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") run();
              if (e.key === "Escape") onClose();
            }}
            placeholder={COMMAND_HELP}
            aria-label="Command"
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-transparent text-[15px] text-ink placeholder:text-ink-secondary/60 focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-hairline/60 px-1.5 py-0.5 text-[10px] text-ink-secondary">esc</kbd>
        </div>

        {error && <div className="px-3 pb-1 text-[12.5px] text-danger">{error}</div>}

        {suggestions.length > 0 && !parsed.targeted && (
          <div className="border-t border-hairline/40 px-1.5 pb-1.5 pt-1.5">
            <div className="px-1.5 pb-1 text-[10px] uppercase tracking-[0.14em] text-ink-secondary/70">
              {draft.trim() ? "Bots" : "Ask"}
            </div>
            {suggestions.map((bot) => (
              <button
                key={bot.id}
                type="button"
                onClick={() => {
                  dispatch({ type: "send", botId: bot.id, text: draft.trim() || `Status check — what are you working on?` });
                  onClose();
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised/50"
              >
                <AgentAvatar color={bot.color} character={bot.character} state={bot.busy ? "working" : "idle"} size={20} label={bot.name} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{bot.name}</span>
                <span className={cn("shrink-0 text-[11px]", bot.busy ? "text-warning" : "text-ink-secondary/70")}>
                  {bot.busy ? "working…" : "idle"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
