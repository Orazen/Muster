// Muster OS — a desktop-style shell over the agent roster. The dock holds
// one app icon per visible bot plus a Rooms icon; opening an icon raises
// that window in a small window manager — several windows can be open at
// once, the last-clicked sits on top, and clicking a focused window's
// dock icon minimizes it until the icon is clicked again. All data is the
// shared store, so busy/activity truth updates live over the same SSE
// stream the chat view listens to.
import { useEffect, useState } from "react";
import { ArrowLeft, Users } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { AgentAvatar } from "@/components/Avatar";
import { MusterbotMark } from "@/components/MusterbotMark";
import { activityLabel, AgentWindow } from "@/components/os/AgentWindow";
import { RoomsWindow } from "@/components/os/RoomsWindow";
import "./os.css";
import "./os-tokens.css";
import "./rooms.css";

/** Which app a window shows. Agent windows are keyed by bot id, so one
 * bot has exactly one window; rooms are a singleton app. */
type WindowTarget =
  | { kind: "agent"; botId: string }
  | { kind: "rooms" };

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
        id: target.kind === "agent" ? `window-${target.botId}` : "window-rooms",
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
  // open-but-unfocused → raise, focused → minimize.
  const dockClick = (target: WindowTarget) => {
    const id = target.kind === "agent" ? `window-${target.botId}` : "window-rooms";
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
        <Clock />
      </header>
      <main className="os-body">
        {bots.length === 0 && <div className="os-empty">Your roster is empty — muster a teammate from the app.</div>}
        <div className="os-windows">
          {windows.map((win, index) => {
            const focused = focusedId === win.id;
            const zIndex = 10 + index;
            if (win.target.kind === "rooms") {
              return (
                <RoomsWindow
                  key={win.id}
                  focused={focused}
                  minimized={win.minimized}
                  zIndex={zIndex}
                  cascade={win.cascade}
                  onFocus={() => focusWindow(win.id)}
                  onMinimize={() => minimizeWindow(win.id)}
                  onClose={() => closeWindow(win.id)}
                />
              );
            }
            if (win.target.kind !== "agent") return null;
            const botId = win.target.botId;
            const bot = bots.find((b) => b.id === botId);
            if (!bot) return null;
            return (
              <AgentWindow
                key={win.id}
                bot={bot}
                engineName={engineFor(bot)}
                focused={focused}
                minimized={win.minimized}
                zIndex={zIndex}
                cascade={win.cascade}
                onFocus={() => focusWindow(win.id)}
                onMinimize={() => minimizeWindow(win.id)}
                onClose={() => closeWindow(win.id)}
              />
            );
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
          <button
            type="button"
            className="os-dock-item"
            aria-label="Rooms"
            aria-expanded={windows.some((w) => w.target.kind === "rooms" && !w.minimized)}
            onClick={() => dockClick({ kind: "rooms" })}
          >
            <span className="os-dock-icon">
              <Users size={22} />
            </span>
            <span className="os-dock-name">Rooms</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
