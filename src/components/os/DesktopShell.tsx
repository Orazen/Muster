// Muster OS — a desktop-style shell over the agent roster. The dock holds
// one app icon per visible bot plus a Rooms icon; opening an icon raises
// that window in a small window manager — several windows can be open at
// once, the last-clicked sits on top, and clicking a focused window's
// dock icon minimizes it until the icon is clicked again. All data is the
// shared store, so busy/activity truth updates live over the same SSE
// stream the chat view listens to.
import { useEffect, useState } from "react";
import { ArrowUpRight, LayoutGrid } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useStore, type Bot } from "@/state/store";
import { AgentAvatar } from "@/components/Avatar";
import { MusterbotMark } from "@/components/MusterbotMark";
import { WorkspaceHome } from "./WorkspaceHome";
import { operationalAvatarState } from "./workspace-state";
import { revealWindow, type WindowTarget, type OpenWindow } from "./window-stack";
import { botChatRoute } from "@/state/bot-chat-route";
import { activityLabel, AgentWindow } from "@/components/os/AgentWindow";
import { RoomsWindow } from "@/components/os/RoomsWindow";
import { CommandBar } from "@/components/os/CommandBar";
import { OS_SINGLETON_APPS } from "@/components/os/app-manifests";
import "./os.css";
import "./os-tokens.css";
import "./rooms.css";

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
  const { state, dispatch } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [windows, setWindows] = useState<OpenWindow[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const bots = state.bots.filter((b) => !b.hidden);
  const engineFor = (bot: Bot) =>
    state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.displayName ?? null;

  // ⌘K / Ctrl+K summons the command console from anywhere on the desktop
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setConsoleOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const openWindow = (target: WindowTarget) => setWindows((current) => revealWindow(current, target));
  const showWorkspace = () => setWindows((current) => current.map((win) => ({ ...win, minimized: true })));

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
  const dockClick = (target: WindowTarget) => setWindows((current) => revealWindow(current, target, "dock"));

  return (
    <div className="os-desktop">
      <header className="os-topbar">
        <button type="button" className="os-mark" onClick={showWorkspace} aria-label="Show workspace overview">
          <MusterbotMark size={20} />
          Muster <span>OS</span>
        </button>
        <button
          type="button"
          className="os-console-trigger"
          onClick={() => setConsoleOpen(true)}
          aria-label="Open command console"
          title="Command console (⌘K)"
        >
          <span className="os-console-glow" aria-hidden="true" />
          Ask Muster…
          <kbd>⌘K</kbd>
        </button>
        {state.connected && state.rosterHydrated && bots.some((bot) => bot.busy) && (
          <button type="button" className="os-halt" aria-label="Interrupt all running teammates" onClick={() => {
            for (const bot of bots) if (bot.busy) dispatch({ type: "interrupt", botId: bot.id });
          }}>Stop tasks</button>
        )}
        <button type="button" className="os-chat-link" aria-label="Open app" onClick={() => navigate("/app")}>
          <span>Open app</span> <ArrowUpRight size={14} />
        </button>
        <Clock />
      </header>
      <main className="os-body">
        {focusedId === null && (
          <WorkspaceHome
            bots={bots}
            connected={state.connected}
            hydrated={state.rosterHydrated}
            onOpenBot={(botId) => openWindow({ kind: "agent", botId })}
            onOpenChat={(botId) => navigate(botChatRoute(botId, location.search))}
            onAsk={() => setConsoleOpen(true)}
            onRooms={() => openWindow({ kind: "app", appId: "rooms" })}
            onApp={() => navigate("/app")}
          />
        )}
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
      </main>
      <nav className="os-dock" aria-label="Agent dock">
        <div className="os-dock-list">
          <button type="button" className="os-dock-item" aria-label="Workspace overview" aria-pressed={focusedId === null} onClick={showWorkspace}>
            <span className="os-dock-icon"><LayoutGrid size={22} /></span>
            <span className="os-dock-name">Workspace</span>
          </button>
          {bots.map((bot) => (            <button
              key={bot.id}
              type="button"
              className="os-dock-item"
              aria-label={`${bot.name} — ${state.connected ? activityLabel(bot) : "Connection lost"}`}
              aria-expanded={windows.some((w) => w.target.kind === "agent" && w.target.botId === bot.id && !w.minimized)}

              onClick={() => dockClick({ kind: "agent", botId: bot.id })}
            >
              <span className="os-dock-icon">
                <AgentAvatar color={bot.color} character={bot.character} state={operationalAvatarState(bot, state.connected)} size={38} label={bot.name} />
              </span>
              <span className="os-status-dot" data-busy={operationalAvatarState(bot, state.connected) === "working" ? "true" : "false"} />
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
      <CommandBar
        open={consoleOpen}
        onClose={() => setConsoleOpen(false)}
        onOpenRooms={() => openWindow({ kind: "app", appId: "rooms" })}
      />
    </div>
  );
}
