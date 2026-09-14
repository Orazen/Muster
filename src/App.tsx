import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Menu } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsPanel } from "@/components/PluginsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { BrowserPanel } from "@/components/BrowserPanel";
import { FleetOrb } from "@/components/FleetOrb";
import { InspectorPanel } from "@/components/InspectorPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { RoutinesPage } from "@/components/RoutinesPage";
import { SocialView } from "@/components/SocialView";
import { NoEngines } from "@/components/NoEngines";
import { CommandPalette } from "@/components/CommandPalette";
import { ShortcutsSheet } from "@/components/ShortcutsSheet";
import { NotificationStack } from "@/components/NotificationStack";
import { MusterBloom } from "@/components/MusterBloom";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AuthGate } from "@/components/AuthGate";
import { LoginPage } from "@/pages/LoginPage";
import { ProjectScout } from "@/components/ProjectScout";
import { SignupPage } from "@/pages/SignupPage";
import { ForgotPasswordPage } from "@/pages/ForgotPasswordPage";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, serverGateDone } from "@/lib/analytics";
import { installGazeTracking } from "@/lib/musterbot/gaze";
import { PairPage } from "@/pages/PairPage";
import { ClaimPage } from "@/pages/ClaimPage";
import { DesktopShell } from "@/components/os/DesktopShell";
import { resolveBotChatHandoff } from "@/state/bot-chat-route";

function Shell() {
  const { state, dispatch } = useStore();
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const consumedHandoff = useRef<string | null>(null);
  const handoff = resolveBotChatHandoff(location.search, user?.id, state.rosterHydrated, state.bots);
  useEffect(() => {
    const intent = `${location.key}:${location.search}`;
    const resolved = resolveBotChatHandoff(location.search, user?.id, state.rosterHydrated, state.bots);
    if (resolved.kind !== "consume" || consumedHandoff.current === intent) return;
    consumedHandoff.current = intent;
    if (resolved.selectedId) dispatch({ type: "select", id: resolved.selectedId });
    // Consume invalid targets too, so a future roster/account change cannot
    // unexpectedly activate an old URL. Preserve unrelated query and hash.
    navigate({ pathname: location.pathname, search: resolved.search, hash: location.hash }, { replace: true });
  }, [location.key, location.search, location.pathname, location.hash, user?.id, state.rosterHydrated, state.bots, dispatch, navigate]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [scoutOpen, setScoutOpen] = useState(false);
  const [firstRun, setFirstRun] = useState(true);
  // Web audit 2026-08-23: the wizard must not render until the identity is
  // resolved — its dismissal is persisted under the per-user gate key, and
  // rendering earlier let a pre-auth Escape write the legacy key while the
  // wizard kept reappearing for the signed-in account on every reload.
  // The wizard gate decides ONCE per session. `user` flickers (better-auth
  // refetches flip it to undefined and back), and re-deriving the per-user
  // gate key on every render flipped the key between legacy and real id —
  // the dismissed wizard resurrected mid-session, covering the whole app
  // ("Step 1 of 6" over a chat you were typing into). A session-sticky
  // decision keeps dismissal sticky; reloads still re-check per account.
  // The check consults the SERVER flag first (the gate follows the
  // account across Google/email sign-ins and browsers), then falls back
  // to this browser's cached key; onboarding persists to both.
  const [gateDecision, setGateDecision] = useState<"pending" | "show" | "hide">("pending");
  // one global pointer listener feeds every bot avatar's eyes (gaze.ts)
  useEffect(() => {
    installGazeTracking();
  }, []);
  useEffect(() => {
    if (gateDecision !== "pending" || authLoading || !user) return;
    let cancelled = false;
    void serverGateDone().then((serverDone) => {
      if (!cancelled) setGateDecision(serverDone || emailGateDone(user.id) ? "hide" : "show");
    });
    return () => {
      cancelled = true;
    };
  }, [authLoading, user, gateDecision]);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);

  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((i) => i.snapshot.state === "available");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // "?" outside any text field opens the shortcut cheat sheet — and ⌘/
      // works everywhere, inputs included, mirroring the palette's ⌘K.
      if (mod && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (
        !mod &&
        e.key === "?" &&
        e.target instanceof HTMLElement &&
        !["INPUT", "TEXTAREA"].includes(e.target.tagName) &&
        !e.target.isContentEditable
      ) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, dispatch]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.activeView, state.pluginsOpen, state.settingsOpen]);

  if (handoff.kind === "wait" || (handoff.kind === "consume" && handoff.selectedId && handoff.selectedId !== state.selectedId)) {
    return <main className="flex h-full items-center justify-center p-6 text-ink-secondary" role="status">Opening bot conversation…</main>;
  }

  return (
    <div className="flex h-full flex-col">
      {/* ambient wash under everything — what the glass panels refract */}
      <div className="glass-ambient" aria-hidden="true" />
      <UpdateBanner />
      <div className="relative flex min-h-0 flex-1">
      <button
        type="button"
        ref={menuButtonRef}
        aria-label="Open bot list"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="absolute left-3 top-3 z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden"
      >
        <Menu size={18} />
      </button>
      {drawerOpen && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      <Sidebar
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />
      {state.activeView === "routines" ? (
        <RoutinesPage />
      ) : state.activeView === "social" ? (
        /* Social works without engines on purpose: profiles and friendships
           are identity, not inference — a hosted account with no BYOK key can
           still introduce its teammates. */
        <SocialView />
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main
          className="glass-shell-main flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-6 overflow-hidden text-ink-secondary"
        >
          {/* musterbot-style empty roster scene: the interactive bloom carries
              the screen — eyes follow the pointer, a click pops */}
          <MusterBloom size={280} mood={state.connected ? "happy" : "thinking"} />
          <div className="text-[15px] font-medium text-ink">
            {state.connected ? "Your roster is empty — muster your first teammate" : "Connecting to the bot server…"}
          </div>
          {state.connected && (
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "general" })}
                className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_color-mix(in_srgb,var(--color-accent)_28%,transparent)] transition-all hover:-translate-y-px hover:brightness-110"
              >
                New bot
              </button>
              {scoutOpen ? (
                <ProjectScout onDone={() => setScoutOpen(false)} />
              ) : (
                <button
                  onClick={() => setScoutOpen(true)}
                  className="text-[13px] text-ink-secondary underline decoration-hairline underline-offset-4 transition-colors hover:text-ink"
                >
                  or scout a project folder for a suggested team
                </button>
              )}
            </div>
          )}
          {!state.connected && (
            <div className="max-w-xs text-center text-[12px]">
              {/* the pnpm hint only means anything in a dev checkout — the
                  packaged app bundles the server, so a lost connection there
                  is a restart problem, not a terminal problem */}
              {import.meta.env.DEV ? (
                <>
                  Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
                </>
              ) : (
                <>Reconnecting… if this stays stuck, quit Muster and reopen it (another app may be using its local port).</>
              )}
            </div>
          )}
          <span aria-hidden="true" className="mt-auto pb-6 text-[11px] uppercase tracking-[0.42em] text-accent opacity-70" style={{ fontWeight: 700 }}>
            Muster
          </span>
        </main>
      )}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {state.computerOpen && bot && <ComputerPanel bot={bot} />}
      {state.browserPanelOpen && bot && <BrowserPanel bot={bot} onClose={() => dispatch({ type: "toggleBrowserPanel", open: false })} />}
      {state.inspectorOpen && bot && <InspectorPanel bot={bot} />}
      {state.appSettingsOpen && <SettingsModal />}
      {state.pluginsOpen && <PluginsPanel />}
      <CommandPalette />
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <NotificationStack />
      {gateDecision === "show" && firstRun && (
        <Onboarding
          onDone={() => {
            setFirstRun(false);
            setGateDecision("hide");
          }}
        />
      )}
      </div>
      {/* In flow so fleet attention never sits over Send or an approval. */}
      <FleetOrb />
    </div>
  );
}

function AccountStore({ children, readSelectedMessages = true }: { children: ReactNode; readSelectedMessages?: boolean }) {
  const { user } = useAuth();
  if (!user) return null;
  // A changed identity gets fresh state and closes the prior account's SSE
  // subscription before its pending hydration can reach this provider.
  return <StoreProvider key={user.id} accountId={user.id} readSelectedMessages={readSelectedMessages}>{children}</StoreProvider>;
}

function AppShell() {
  return (
    <DesktopCapabilitiesProvider>
      <AccountStore>
        <Shell />
      </AccountStore>
    </DesktopCapabilitiesProvider>
  );
}

// Public marketing is served statically. React's root is also the packaged
// desktop entry and must wait for a confirmed session before redirecting.
function RootRoute() {
  return <AuthGate><Navigate to="/app" replace /></AuthGate>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<RootRoute />} />
          <Route path="/sign-in" element={<LoginPage />} />
          <Route path="/sign-up" element={<SignupPage />} />
          <Route path="/pair" element={<AuthGate><PairPage /></AuthGate>} />
          <Route path="/claim" element={<ClaimPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/app/*" element={<AuthGate><AppShell /></AuthGate>} />
          <Route path="/os" element={<AuthGate><AccountStore readSelectedMessages={false}><DesktopShell /></AccountStore></AuthGate>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
