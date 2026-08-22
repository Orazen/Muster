import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Menu, LogOut } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsPanel } from "@/components/PluginsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { RoutinesPage } from "@/components/RoutinesPage";
import { NoEngines } from "@/components/NoEngines";
import { CommandPalette } from "@/components/CommandPalette";
import { NotificationStack } from "@/components/NotificationStack";
import { MusterbotMark } from "@/components/MusterbotMark";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AuthGate } from "@/components/AuthGate";
import { LandingPage } from "@/pages/LandingPage";
import { LoginPage } from "@/pages/LoginPage";
import { SignupPage } from "@/pages/SignupPage";
import { ForgotPasswordPage } from "@/pages/ForgotPasswordPage";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";
import { Onboarding } from "@/components/Onboarding";
import { PairPage } from "@/pages/PairPage";

function SignOutButton() {
  const { signOut } = useAuth();
  return (
    <button
      type="button"
      onClick={() => signOut()}
      className="fixed bottom-4 right-4 z-50 flex items-center gap-1.5 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-raised hover:text-ink md:hidden"
      aria-label="Sign out"
    >
      <LogOut size={14} />
      Sign out
    </button>
  );
}

function Shell() {
  const { state, dispatch } = useStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [firstRun, setFirstRun] = useState(true);
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

  return (
    <div className="flex h-full flex-col">
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
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main
          className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-6 overflow-hidden bg-app text-ink-secondary"
          style={{ background: "linear-gradient(180deg, #f9f9f9 0%, #fdf3e7 100%)" }}
        >
          {/* musterbot-style empty roster scene: the animated mark carries the screen */}
          <MusterbotMark size={280} />
          <div className="text-[15px] font-medium text-[#0a0a0c]">
            {state.connected ? "Your roster is empty — muster your first teammate" : "Connecting to the bot server…"}
          </div>
          {state.connected && (
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "general" })}
              className="rounded-lg bg-[#f0460e] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(240,70,14,.28)] transition-all hover:-translate-y-px hover:bg-[#f0460e]/90"
            >
              New bot
            </button>
          )}
          {!state.connected && (
            <div className="text-[12px]">
              Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
            </div>
          )}
          <span aria-hidden="true" className="mt-auto pb-6 text-[11px] uppercase tracking-[0.42em] text-[#f08a24]" style={{ fontWeight: 700 }}>
            Muster
          </span>
        </main>
      )}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {state.computerOpen && bot && <ComputerPanel bot={bot} />}
      {state.inspectorOpen && bot && <InspectorPanel bot={bot} />}
      {state.appSettingsOpen && <SettingsModal />}
      {state.pluginsOpen && <PluginsPanel />}
      <CommandPalette />
      <NotificationStack />
      {firstRun && <Onboarding onDone={() => setFirstRun(false)} />}
      </div>
      <SignOutButton />
    </div>
  );
}

function AppShell() {
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}

// The marketing landing page ("/") is meant for a browser visitor who has
// never used Muster — feature copy, download buttons for every platform,
// GitHub links. The packaged desktop app is a completely different
// audience: someone who already downloaded and opened Muster, on a window
// that only ever shows this one app. Rendering the same marketing page
// there (as this route did unconditionally before) meant every desktop
// launch needed an extra click through content the user had already acted
// on just by opening the app. window.ogb only exists inside Electron's
// preload bridge — that's the same signal every other desktop-vs-browser
// check in this codebase already uses (src/lib/desktop.ts).
function RootRoute() {
  const { user, loading } = useAuth();
  // window.ogb only exists inside Electron's preload bridge; the browser
  // bundle renders this route without it.
  if (window.ogb) {
    if (loading) return null;
    return <Navigate to={user ? "/app" : "/sign-in"} replace />;
  }
  return <LandingPage />;
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
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/app/*" element={<AuthGate><AppShell /></AuthGate>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
