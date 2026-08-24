// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) stay in SettingsPanel — this
// is the stuff shared by every bot: who you are, your keys, and the
// machine your bots can borrow.
import { useEffect, useRef, useState } from "react";
import { Coins, CreditCard, Download, KeyRound, Monitor, Palette, Plug, Search, ShieldCheck, Smartphone, Terminal, User, Volume2, X, Cloud } from "lucide-react";
import { useStore, api, type AppSettingsSection } from "@/state/store";
import { useAuth } from "@/lib/auth";
import { ApiKeyRow } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { CompanionSection } from "./CompanionSection";
import { Card } from "./SettingsPrimitives";
import { SkinPicker } from "./SkinPicker";
import { UsageSection } from "./UsageSection";
import { BillingSection } from "./BillingSection";
import { VoiceSettings } from "./VoiceSettings";
import { ProvidersSection } from "./ProvidersSection";
import { McpServersSection } from "./McpServersSection";
import { AuditPanel, type AuditPage } from "./AuditPanel";
import { cn } from "@/lib/cn";

const SECTIONS: Array<{ id: AppSettingsSection; label: string; icon: typeof User; keywords: string[] }> = [
  { id: "general", label: "General", icon: User, keywords: ["profile", "name", "email", "account", "updates", "turn cap", "diagnostics"] },
  { id: "appearance", label: "Appearance", icon: Palette, keywords: ["skin", "theme", "colors", "dark mode"] },
  { id: "connections", label: "Connections", icon: KeyRound, keywords: ["keys", "api", "composio", "box", "connected apps", "opensandbox", "muster cloud"] },
  { id: "engines", label: "Engines", icon: Terminal, keywords: ["models", "claude", "grok", "cli", "xai", "opencode"] },
  { id: "providers", label: "Providers", icon: Cloud, keywords: ["provider api keys", "llm", "deepseek", "openai", "anthropic"] },
  { id: "mcp", label: "MCP Servers", icon: Plug, keywords: ["mcp", "tools", "stdio", "servers"] },
  { id: "companion", label: "Companion", icon: Smartphone, keywords: ["phone", "mobile", "ios", "pair"] },
  { id: "computer", label: "Local VM", icon: Monitor, keywords: ["vm", "virtual machine", "desktop", "sandbox", "isolation"] },
  { id: "voice", label: "Voice", icon: Volume2, keywords: ["tts", "speech", "elevenlabs", "speak"] },
  { id: "usage", label: "Usage", icon: Coins, keywords: ["tokens", "cost", "spend", "history"] },
  { id: "billing", label: "Billing", icon: CreditCard, keywords: ["subscription", "payment", "plan", "invoice"] },
];

/** Live filter for the section nav. The label and a handful of aliases both
 * match, so "theme" finds Appearance and "phone" finds Companion. */
function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  return [section.label, ...section.keywords].some((part) => part.toLowerCase().includes(query));
}

/** Name + email, persisted to /api/config {profile} on blur. Pre-fills from
 * the signed-in account when the local profile override hasn't been set
 * yet, so a freshly created account doesn't show a blank name/email box. */
function ProfileFields() {
  const { state, dispatch } = useStore();
  const { user: authUser } = useAuth();
  // /api/config's profile.name/email are always strings, never omitted
  // (server/index.ts's configStatus() sends "" when unset) — so this must
  // be `||`, not `??`: nullish coalescing never falls through on "".
  const [name, setName] = useState(state.config?.profile?.name || authUser?.name || "");
  const [email, setEmail] = useState(state.config?.profile?.email || authUser?.email || "");
  useEffect(() => {
    setName(state.config?.profile?.name || authUser?.name || "");
    setEmail(state.config?.profile?.email || authUser?.email || "");
  }, [state.config?.profile?.name, state.config?.profile?.email, authUser?.name, authUser?.email]);

  const save = () => {
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((r) => r.json())
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder="Your name" className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        className={inputClass}
      />
    </div>
  );
}

/** Sign-out — only rendered when there's an actual authenticated session
 * (cloud/self-hosted auth). The desktop-local no-auth mode has no session
 * to sign out of, so this stays hidden there rather than showing a button
 * that does nothing useful. Previously there was no sign-out control
 * anywhere in the UI at all, even though useAuth().signOut() already
 * existed and worked — this was a real, reachable dead end for anyone who
 * signed in and wanted to sign out or switch accounts. */
function AccountSection() {
  const { user, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  return (
    <Card title="Account" subtitle={user.email}>
      <button
        onClick={async () => {
          setBusy(true);
          try {
            await signOut();
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        className="w-fit rounded-lg border border-hairline/40 bg-inset px-3.5 py-2 text-[13.5px] text-ink transition-colors hover:bg-raised disabled:opacity-60"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </Card>
  );
}

function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? "Checking…"
      : s?.status === "available"
        ? `${s.version} available`
        : s?.status === "downloading"
          ? `Downloading ${Math.round(s.percent ?? 0)}%`
          : s?.status === "downloaded"
            ? `${s.version} ready — restart to apply`
            : s?.status === "error"
              ? `Check failed: ${s.message ?? "unknown error"}`
              : "You're on the latest version we know of.";
  return (
    <Card title="Updates" subtitle={label}>
      <button
        onClick={() => {
          if (s?.status === "available") return void updater.download();
          if (s?.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={s?.status === "checking" || s?.status === "downloading"}
        className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
      >
        {s?.status === "available"
          ? "Download"
          : s?.status === "downloaded"
            ? "Restart and install"
            : "Check for updates"}
      </button>
    </Card>
  );
}

/** The Audit section is earned, not permanent: one cheap probe decides
 * whether the selected bot has any decisions to show. A bot with an empty
 * ledger gets no nav item at all — a trust surface with nothing to trust
 * yet shouldn't look broken. */
function useAuditBotId(): string | null {
  const { state } = useStore();
  const selectedBotId = state.bots.find((b) => b.id === state.selectedId)?.id ?? null;
  const [auditBotId, setAuditBotId] = useState<string | null>(null);
  useEffect(() => {
    setAuditBotId(null);
    if (!selectedBotId) return;
    let cancelled = false;
    void api(`/api/bots/${selectedBotId}/audit?limit=1`)
      .then((page: AuditPage) => {
        if (!cancelled && page.entries.length > 0) setAuditBotId(selectedBotId);
      })
      .catch(() => {}); // unreachable server / desktop-local: hide the section cleanly
    return () => {
      cancelled = true;
    };
  }, [selectedBotId]);
  return auditBotId;
}

/** Channel turn cap — the one server-side knob in this modal. Saved on blur
 * or Enter; clamped client-side so a typo saves something legal instead of
 * surfacing a 400 from the config schema. */
function ChannelTurnCapCard() {
  const { state, dispatch } = useStore();
  const savedMinutes = state.config?.channels?.turnCapMinutes ?? 5;
  const [minutes, setMinutes] = useState(String(savedMinutes));
  useEffect(() => {
    setMinutes(String(savedMinutes));
  }, [savedMinutes]);

  const save = () => {
    const parsed = Number.parseInt(minutes, 10);
    const clamped = Number.isFinite(parsed) ? Math.min(120, Math.max(1, parsed)) : savedMinutes;
    if (clamped === savedMinutes) return;
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channels: { turnCapMinutes: clamped } }),
    })
      .then((r) => r.json())
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
  };

  return (
    <Card title="Channel turns" subtitle="Every bot turn in a channel stops after this many minutes. Direct chats are untouched — they already stop when the bot goes quiet.">
      <label className="flex items-center gap-3 text-[13.5px] text-ink-secondary">
        Turn limit (minutes)
        <input
          type="number"
          min={1}
          max={120}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="w-24 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink focus:border-hairline focus:outline-none"
        />
      </label>
    </Card>
  );
}

/** Downloads GET /api/diagnostics verbatim as a JSON file. The server has
 * already redacted everything — the client just names the download. */
function DiagnosticsCard() {
  const [busy, setBusy] = useState(false);
  const exportDiagnostics = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/diagnostics");
      if (!res.ok) return;
      const blob = new Blob([await res.text()], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `muster-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      /* unreachable server — nothing to export */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Diagnostics" subtitle="Versions, configuration flags (booleans only) and a redacted log tail. Safe to attach to a bug report.">
      <button
        onClick={() => void exportDiagnostics()}
        disabled={busy}
        className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-3.5 py-2 text-[13.5px] text-ink transition-colors hover:bg-raised disabled:opacity-60"
      >
        <Download size={15} />
        {busy ? "Exporting…" : "Export Diagnostics"}
      </button>
    </Card>
  );
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const section = state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);
  const auditBotId = useAuditBotId();
  // Audit sits before Billing; present only when the selected bot has history.
  const sections = [...SECTIONS];
  if (auditBotId)
    sections.splice(sections.length - 1, 0, { id: "audit", label: "Audit", icon: ShieldCheck, keywords: ["decisions", "ledger", "history"] });

  // Section nav search: typing filters live, Esc clears first. When the
  // current section is filtered out, jump to the first match so the right
  // pane never shows a section the list no longer offers.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visibleSections = sections.filter((entry) => sectionMatches(entry, q));
  useEffect(() => {
    if (visibleSections.some((entry) => entry.id === section)) return;
    const first = visibleSections[0];
    if (first) dispatch({ type: "toggleAppSettings", open: true, section: first.id });
  }, [dispatch, q, section]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  return (
    <div
      // Above the onboarding wizard (z-50): the wizard's "Add a provider key"
      // shortcut opens this modal mid-onboarding.
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="flex h-[560px] w-full max-w-[860px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        {/* section nav */}
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3">
          <div id="app-settings-title" className="px-2 pb-2 pt-1 text-[15px] font-semibold text-ink">
            Settings
          </div>
          <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-control/70 px-2.5 py-1.5">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (query) setQuery("");
                else dispatch({ type: "toggleAppSettings", open: false });
              }}
              placeholder="Search"
              aria-label="Search settings"
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          {visibleSections.length === 0 && (
            <div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary">Nothing matches “{query.trim()}”</div>
          )}
          {visibleSections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]",
                section === id ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-[15px] font-semibold text-ink">
              {sections.find((s) => s.id === section)?.label}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label="Close settings"
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === "general" && (
              <>
                <Card title="Profile" subtitle="Shown in the sidebar. Saved as you go.">
                  <ProfileFields />
                </Card>
                <ChannelTurnCapCard />
                <DiagnosticsCard />
                <AccountSection />
                <UpdatesRow />
              </>
            )}

            {section === "appearance" && (
              <Card title="Appearance" subtitle="Applies instantly and is remembered on this machine.">
                <SkinPicker />
              </Card>
            )}

            {section === "connections" && (
              <Card
                title="Connections"
                subtitle="Connected apps work automatically in the installed app. Other optional service keys stay on this computer."
              >
                <div className="flex flex-col gap-4">
                  {state.config?.composio.mode === "managed" ? (
                    <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                      Connected apps service is ready
                    </div>
                  ) : null}
                  <ApiKeyRow section="box" />
                  <ApiKeyRow section="opensandbox" />
                  <ApiKeyRow section="musterCloud" />
                  <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                    <summary className="cursor-pointer text-[13px] text-ink-secondary">Self-host connected apps</summary>
                    <div className="mt-3">
                      <ApiKeyRow section="composio" />
                    </div>
                  </details>
                </div>
              </Card>
            )}

            {section === "engines" && (
              <>
                <Card
                  title="Engine API keys"
                  subtitle="Enable a cloud engine by pasting its API key — no CLI install needed."
                >
                  <div className="flex flex-col gap-4">
                    <ApiKeyRow section="xai" />
                    <ApiKeyRow section="opencodeGo" />
                  </div>
                </Card>
                <Card title="Engine CLIs" subtitle="Which binary each engine runs. Saved as you go.">
                  <EnginesSettings />
                </Card>
              </>
            )}

            {section === "providers" && (
              <Card
                title="Provider API keys"
                subtitle="Paste a key for any provider — they're stored locally and never leave this machine."
              >
                <ProvidersSection />
              </Card>
            )}

            {section === "mcp" && <McpServersSection />}

            {section === "companion" && <CompanionSection />}

            {section === "voice" && <VoiceSettings />}

            {section === "computer" && <LocalComputerSection />}

            {section === "usage" && <UsageSection />}

            {section === "audit" && auditBotId && (
              <Card title="Audit" subtitle="Every action this bot takes gets decided before it happens. Newest first.">
                <AuditPanel botId={auditBotId} />
              </Card>
            )}

            {section === "billing" && <BillingSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
