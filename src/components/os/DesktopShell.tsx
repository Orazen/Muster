// Muster OS — a desktop-style shell over the agent roster. The dock holds
// one app icon per visible bot plus a Rooms icon; opening an icon raises
// that window in a small window manager — several windows can be open at
// once, the last-clicked sits on top, and clicking a focused window's
// dock icon minimizes it until the icon is clicked again. All data is the
// shared store, so busy/activity truth updates live over the same SSE
// stream the chat view listens to.
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { AgentAvatar } from "@/components/Avatar";
import { MusterbotMark } from "@/components/MusterbotMark";
import { activityLabel, AgentWindow } from "@/components/os/AgentWindow";
import { RoomsWindow } from "@/components/os/RoomsWindow";
import { OS_SINGLETON_APPS } from "@/components/os/app-manifests";
import "./os.css";
import "./os-tokens.css";
import "./rooms.css";

/** Which app a window shows. Agent windows are keyed by bot id, so one
 * bot has exactly one window; singleton apps are keyed by their manifest
 * id (src/components/os/app-manifests.ts) — one window per app, ever. */
type WindowTarget =
  | { kind: "agent"; botId: string }
  | { kind: "app"; appId: string };

/** One entry in the desktop's window stack. Array order is z-order — the
 * last non-minimized entry is the focused window. Minimized windows stay
 * mounted so their drag geometry and inner state survive a restore. */
interface OpenWindow {
  id: string;
  target: WindowTarget;
  minimized: boolean;
  cascade: number;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return <span className="os-clock">{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>;
}

/** Ambient presence (the OmaBot steal): who's waiting on you, longest wait
 * first, as a glanceable topbar element. "Waiting" = an approval card,
 * question, or blocked action is holding a bot's turn open — the one state
 * where a human answer unblocks real work. Clicking a name opens its
 * window. Nothing here pulls or notifies: it only answers a glance. */
function Presence({ bots, onOpen }: { bots: Bot[]; onOpen: (botId: string) => void }) {
  const waiting = bots
    .filter((b) => b.activity === "waiting-on-you")
    .sort((a, b) => (a.unread === b.unread ? 0 : a.unread ? -1 : 1));
  if (waiting.length === 0) return null;
  return (
    <div className="os-presence" role="status" aria-label={`${waiting.length} bots waiting on you`}>
      <span className="os-presence-count">{waiting.length}</span>
      {waiting.map((bot) => (
        <button
          key={bot.id}
          type="button"
          className="os-presence-chip"
          onClick={() => onOpen(bot.id)}
          title={`${bot.name} is waiting on you`}
        >
          {bot.name}
        </button>
      ))}
    </div>
  );
}

/** Full-screen desktop view of the roster. Route: /os. */
export function DesktopShell() {
  const { state } = useStore();
  const [windows, setWindows] = useState<OpenWindow[]>([]);
  const bots = state.bots.filter((b) => !b.hidden);
  const engineFor = (bot: Bot) =>
    state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.displayName ?? null;

  // Focus follows the stack: the topmost window that isn't minimized.
  const focusedId = [...windows].reverse().find((w) => !w.minimized)?.id ?? null;

  // A bot hidden from the roster takes its window with it. Returning the
  // same array when nothing changed keeps this from re-render looping.
  useEffect(() => {
    setWindows((current) => {
      const visible = (target: WindowTarget) =>
        target.kind === "agent" ? state.bots.some((b) => b.id === target.botId && !b.hidden) : true;
      const next = current.filter((w) => visible(w.target));
      return next.length === current.length ? current : next;
    });
  }, [state.bots]);

  const openWindow = (target: WindowTarget) => {
    setWindows((current) => [
      ...current,
      {
        id: target.kind === "agent" ? `window-${target.botId}` : `window-${target.appId}`,
        target,
        minimized: false,
        // Stagger each new window so stacked windows cascade visibly.
        cascade: current.length % 6,
      },
    ]);
  };

  const focusWindow = (id: string) => {
    setWindows((current) => {
      const target = current.find((w) => w.id === id);
      if (!target) return current;
      return [...current.filter((w) => w.id !== id), { ...target, minimized: false }];
    });
  };

  const minimizeWindow = (id: string) => {
    setWindows((current) => current.map((w) => (w.id === id ? { ...w, minimized: true } : w)));
  };

  const closeWindow = (id: string) => {
    setWindows((current) => current.filter((w) => w.id !== id));
  };

  // Dock behavior mirrors a taskbar: closed → open, minimized → restore,
  // open-but-unfocused → raise, focused → minimize. Singleton app targets
  // are keyed by the manifest id; agent targets carry the bot id.
  const dockClick = (target: WindowTarget) => {
    const id = target.kind === "agent" ? `window-${target.botId}` : `window-${target.appId}`;
    const existing = windows.find((w) => w.id === id);
    if (!existing) {
      openWindow(target);
    } else if (existing.minimized || focusedId !== id) {
      focusWindow(id);
    } else {
      minimizeWindow(id);
    }
  };

  return (
    <div className="os-desktop">
      <header className="os-topbar">
        <div className="os-mark">
          <MusterbotMark size={20} />
          Muster
        </div>
        <Presence bots={bots} onOpen={(botId) => dockClick({ kind: "agent", botId })} />
        <Clock />
      </header>
      <main className="os-body">
        {bots.length === 0 && <div className="os-empty">Your roster is empty — muster a teammate from the app.</div>}
        <div className="os-windows">
          {windows.map((win, index) => {
            const focused = focusedId === win.id;
            const zIndex = 10 + index;
            const windowProps = {
              focused,
              minimized: win.minimized,
              zIndex,
              cascade: win.cascade,
              onFocus: () => focusWindow(win.id),
              onMinimize: () => minimizeWindow(win.id),
              onClose: () => closeWindow(win.id),
            };
            if (win.target.kind === "app") {
              if (win.target.appId === "rooms") return <RoomsWindow key={win.id} {...windowProps} />;
              return null;
            }
            if (win.target.kind !== "agent") return null;
            const botId = win.target.botId;
            const bot = bots.find((b) => b.id === botId);
            if (!bot) return null;
            return <AgentWindow key={win.id} bot={bot} engineName={engineFor(bot)} {...windowProps} />;
          })}
        </div>
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
              aria-expanded={windows.some((w) => w.target.kind === "agent" && w.target.botId === bot.id && !w.minimized)}

              onClick={() => dockClick({ kind: "agent", botId: bot.id })}
            >
              <span className="os-dock-icon">
                <AgentAvatar color={bot.color} character={bot.character} state={bot.busy ? "working" : "idle"} size={38} label={bot.name} />
              </span>
              <span className="os-status-dot" data-busy={bot.busy ? "true" : "false"} />
              <span className="os-dock-name">{bot.name}</span>
            </button>
          ))}
          {OS_SINGLETON_APPS.map((app) => {
            const Icon = app.icon;
            return (
              <button
                key={app.id}
                type="button"
                className="os-dock-item"
                aria-label={app.title}
                aria-expanded={windows.some((w) => w.target.kind === "app" && w.target.appId === app.id && !w.minimized)}
                onClick={() => dockClick({ kind: "app", appId: app.id })}
              >
                <span className="os-dock-icon">
                  <Icon size={22} />
                </span>
                <span className="os-dock-name">{app.title}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
