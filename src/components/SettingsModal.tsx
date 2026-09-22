// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) stay in SettingsPanel — this
// is the stuff shared by every bot: who you are, your keys, and the
// machine your bots can borrow.
import { useEffect, useRef, useState } from "react";
import { Brain, Building2, Coins, Download, FlaskConical, KeyRound, Monitor, Network, NotebookPen, Palette, Plug, Search, ShieldCheck, Smartphone, Terminal, User, Volume2, X, Cloud, Vault } from "lucide-react";
import { useStore, api, type AppSettingsSection } from "@/state/store";
import { clearOnboardingGate } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import { ApiKeyRow } from "./ApiKeys";
import { TelegramChatChannelCard, WorkspaceSyncCard } from "./WorkspaceSyncCard";
import { PortableBackupCard } from "./PortableBackupCard";
import { useUpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { CompanionSection } from "./CompanionSection";
import { RemoteAccessSection } from "./RemoteAccessSection";
import { Card } from "./SettingsPrimitives";
import { SkinPicker } from "./SkinPicker";
import { UsageSection } from "./UsageSection";
import { InviteSection } from "./InviteSection";
import { ProviderHealthSection } from "./ProviderHealthSection";
import { VaultSection } from "./VaultSection";
import { ManageDevicesCard } from "./ManageDevicesCard";
import { VoiceSettings } from "./VoiceSettings";
import { ProvidersSection } from "./ProvidersSection";
import { ConnectedWorkspacesSection } from "./ConnectedWorkspacesSection";
import { McpServersSection } from "./McpServersSection";
import { AuditPanel } from "./AuditPanel";
import { WhyPanel } from "./WhyPanel";
import { cn } from "@/lib/cn";
import { TeamContextDraft } from "@/lib/team-context-draft";
import "./settings-modal.css";

const SECTIONS: Array<{ id: AppSettingsSection; label: string; icon: typeof User; keywords: string[] }> = [
  { id: "general", label: "General", icon: User, keywords: ["profile", "name", "email", "account", "updates", "turn cap", "diagnostics"] },
  { id: "workspaces", label: "Connected workspaces", icon: Building2, keywords: ["workspace", "cloud", "hosted", "vps", "server", "connect", "pair", "switch", "local", "address"] },
  { id: "organisation", label: "Organisation", icon: Building2, keywords: ["company", "team", "org", "models", "gateway", "policy", "members"] },
  { id: "brain", label: "Brain", icon: Brain, keywords: ["brain", "team context", "shared knowledge", "memory", "brief", "goals"] },
  { id: "appearance", label: "Appearance", icon: Palette, keywords: ["skin", "theme", "colors", "dark mode"] },
  { id: "experimental", label: "Experimental", icon: FlaskConical, keywords: ["labs", "beta", "flags", "preview", "unstable"] },
  { id: "connections", label: "Connections", icon: KeyRound, keywords: ["keys", "api", "composio", "box", "connected apps", "opensandbox", "muster cloud"] },
  { id: "engines", label: "Engines", icon: Terminal, keywords: ["models", "claude", "grok", "cli", "xai", "opencode"] },
  { id: "providers", label: "Providers", icon: Cloud, keywords: ["provider api keys", "llm", "deepseek", "openai", "anthropic"] },
  { id: "mcp", label: "MCP Servers", icon: Plug, keywords: ["mcp", "tools", "stdio", "servers"] },
  { id: "companion", label: "Companion", icon: Smartphone, keywords: ["phone", "mobile", "ios", "pair"] },
  { id: "remoteAccess", label: "Remote access", icon: Network, keywords: ["remote", "pair", "phone", "computer", "tailscale", "wifi", "https", "troubleshooting"] },
  { id: "computer", label: "Local VM", icon: Monitor, keywords: ["vm", "virtual machine", "desktop", "sandbox", "isolation"] },
  { id: "voice", label: "Voice", icon: Volume2, keywords: ["tts", "speech", "elevenlabs", "speak"] },
  { id: "usage", label: "Usage", icon: Coins, keywords: ["tokens", "cost", "spend", "history"] },
  { id: "vault", label: "Vault", icon: Vault, keywords: ["backup", "restore", "telegram", "google", "vaultgram"] },
];

/** Live filter for the section nav. The label and a handful of aliases both
 * match, so "theme" finds Appearance and "phone" finds Companion. */
function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  return [section.label, ...section.keywords].some((part) => part.toLowerCase().includes(query));
}

/** The user-owned team brief. Saved to /api/team-context and injected into
 * every bot's system prompt as read-only shared context — agents cannot
 * edit it, only the user writes through this card. */
function TeamContextCard() {
  const [editor] = useState(() => new TeamContextDraft(
    async () => {
      const body: { text?: string } = await api("/api/team-context");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- decode the text field of an untyped API response.
      return typeof body?.text === "string" ? body.text : "";
    },
    async (text) => { await api("/api/team-context", { method: "PUT", body: JSON.stringify({ text }) }); },
  ));
  const [draft, setDraft] = useState(editor.state);
  const { text, status, error } = draft;

  useEffect(() => {
    const unsubscribe = editor.subscribe(setDraft);
    void editor.load();
    return unsubscribe;
  }, [editor]);

  return (
    <Card
      title="Shared brain"
      subtitle="Everything every bot should know — goals, conventions, links, preferences. Read-only to bots; only you can edit it here."
    >
      <textarea
        aria-label="Shared brain"
        aria-busy={status === "loading"}
        disabled={status === "loading" || status === "load-error"}
        value={text}
        onChange={(event) => editor.edit(event.target.value)}
        onBlur={() => void editor.save()}
        rows={6}
        maxLength={24_000}
        placeholder={status === "loading" ? "Loading shared brain…" : status === "load-error" ? "Load your saved brief before editing." : "e.g. We ship under the Orazen brand. Deploy days are Tue/Thu. Never email clients directly."}
        className="w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent disabled:cursor-wait disabled:opacity-60"
      />
      <div className="mt-1 text-[12px] text-ink-secondary" role={status === "error" || status === "load-error" ? "alert" : status === "idle" ? undefined : "status"}>
        {status === "loading" ? "Loading…" : status === "load-error" ? `Could not load shared brain: ${error}` : status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "error" ? `Could not save: ${error}` : `${text.length}/24,000 characters`}
      </div>
      {status === "load-error" && <button type="button" onClick={() => void editor.load()}
        className="mt-2 min-h-9 rounded-lg border border-hairline/60 px-3 py-1.5 text-[13px] text-ink hover:bg-raised">Retry load</button>}
      {status === "error" && <button type="button" onClick={() => void editor.save()}
        className="mt-2 min-h-9 rounded-lg border border-hairline/60 px-3 py-1.5 text-[13px] text-ink hover:bg-raised">Retry save</button>}
    </Card>
  );
}

/** Name + email, persisted to /api/config {profile} on blur. Pre-fills from
 * the signed-in account when the local profile override hasn't been set
 * yet, so a freshly created account doesn't show a blank name/email box. */
/** The benchmark's "Replay welcome tour": the 7-step walkthrough (engines,
 * permissions, phone, your first teammate) is account-gated, so replaying it
 * means clearing that gate on the server + this browser, then reloading. */
function TourCard() {
  const { user: authUser } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <Card
      title="First-run tour"
      subtitle="The walkthrough: engines, permissions, phone, and your first teammate. You can replay it any time."
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void clearOnboardingGate(authUser?.id).then(() => {
            window.location.href = "/app";
          });
        }}
        className="rounded-lg bg-raised px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-raised-hover disabled:opacity-50"
      >
        {busy ? "Preparing…" : "Replay welcome tour"}
      </button>
    </Card>
  );
}

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
      <label className="space-y-1.5 text-[13px] text-ink-secondary">Name
        <input aria-label="Your name" value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder="Your name" className={inputClass} />
      </label>
      <label className="space-y-1.5 text-[13px] text-ink-secondary">Email
      <input
        type="email"
        aria-label="Profile email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        className={inputClass}
      />
      </label>
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
  const [error, setError] = useState("");
  if (!user) return null;

  return (
    <Card title="Account" subtitle={user.email}>
      <button
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await signOut();
          } catch {
            setError("Couldn’t finish signing out. Please try again.");
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        className="w-fit rounded-lg border border-hairline/40 bg-inset px-3.5 py-2 text-[13.5px] text-ink transition-colors hover:bg-raised disabled:opacity-60"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {error && <p role="alert" className="mt-2 text-sm text-ink-secondary">{error}</p>}
    </Card>
  );
}

/** One human, several Google identities — this card folds the extras in.
 * Step 1 runs on the account you KEEP (mint a code), step 2 on the one you
 * are retiring (spend the code). Vault keys and bot ownership migrate; the
 * retired identity's sign-in stops working. */
function MergeAccountsCard() {
  const { user } = useAuth();
  const [code, setCode] = useState("");
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  if (!user) return null;

  const mint = async () => {
    setBusy(true);
    setNote("");
    try {
      // SAFETY: /api/account/merge/start is this repo's own endpoint; it replies {token}.
      const r = (await api("/api/account/merge/start", { method: "POST" })) as { token: string };
      setCode(r.token);
    } catch {
      setNote("Could not start a merge — is this a cloud deployment?");
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    if (!paste.trim()) return;
    setBusy(true);
    setNote("");
    try {
      // SAFETY: /api/account/merge/complete is this repo's own endpoint; its
      // reply shape is the merge summary rendered below.
      const r = (await api("/api/account/merge/complete", {
        method: "POST",
        body: JSON.stringify({ token: paste.trim() }),
      })) as { movedKeys: string[]; keptKeys: string[]; botsReassigned: number; targetEmail: string };
      setPaste("");
      setNote(
        `Merged into ${r.targetEmail} — ${r.movedKeys.length} key(s) moved, ${r.keptKeys.length} kept, ${r.botsReassigned} bot(s) reassigned. Reload to see everything together.`,
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Merge another account"
      subtitle={`Fold an older sign-in (${user.email} keeps everything)`}
    >
      <div className="space-y-3 text-[13px] text-ink/80">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={mint}
            disabled={busy}
            className="rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 transition-colors hover:bg-raised disabled:opacity-60"
          >
            Generate merge code for this account
          </button>
          {code && (
            <code className="rounded bg-inset px-2 py-1 font-mono text-[12px]">{code}</code>
          )}
        </div>
        <p className="text-ink/60">
          Sign in with the other account (in another browser), open this same settings page, and paste the code there.
          Valid 15 minutes, works once.
        </p>
        <div className="flex gap-2">
          <input
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="Paste a merge code from your other account"
            aria-label="Merge code from other account"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[13px]"
          />
          <button
            onClick={complete}
            disabled={busy || !paste.trim()}
            className="w-fit rounded-lg border border-hairline/40 bg-inset px-3.5 py-2 transition-colors hover:bg-raised disabled:opacity-60"
          >
            Merge
          </button>
        </div>
        {note && <p className="text-ink/70">{note}</p>}
      </div>
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
function useAuditBotId(): { botId: string | null; reachable: boolean } {
  const { state } = useStore();
  const selectedBotId = state.bots.find((b) => b.id === state.selectedId)?.id ?? null;
  const [audit, setAudit] = useState<{ botId: string | null; reachable: boolean }>({ botId: null, reachable: false });
  useEffect(() => {
    setAudit({ botId: null, reachable: false });
    if (!selectedBotId) return;
    let cancelled = false;
    void api(`/api/bots/${selectedBotId}/audit?limit=1`)
      .then(() => {
        // Reachable beats non-empty: an empty ledger used to hide the nav
        // item entirely, which read as "the feature is missing". Now the
        // section appears with an honest empty state instead.
        if (!cancelled) setAudit({ botId: selectedBotId, reachable: true });
      })
      .catch(() => {}); // unreachable server / desktop-local: hide the section cleanly
    return () => {
      cancelled = true;
    };
  }, [selectedBotId]);
  return audit;
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

/** Self-hosted VPS — the only stored value is an SSH config alias. ssh(1)
 * resolves host/key/agent from ~/.ssh itself; Muster never sees credentials.
 * The reachability line pings the remote Docker daemon through the alias. */
function VpsCard() {
  const { state, dispatch } = useStore();
  const savedAlias = state.config?.vps?.sshAlias ?? "";
  const [alias, setAlias] = useState(savedAlias);
  const [reach, setReach] = useState<"idle" | "checking" | "up" | "down">("idle");
  useEffect(() => {
    setAlias(savedAlias);
  }, [savedAlias]);

  const save = () => {
    const next = alias.trim();
    if (next === savedAlias) return;
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vps: { sshAlias: next } }),
    })
      .then((r) => r.json())
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
    setReach("idle");
  };

  const checkReachable = async () => {
    if (!alias.trim() || reach === "checking") return;
    setReach("checking");
    try {
      // SAFETY: /api/vps/status is this repo's own endpoint; it replies {daemonUp}.
      const res = await fetch("/api/vps/status", { headers: { "content-type": "application/json" } });
      // SAFETY: /api/vps/status is this repo's own endpoint; it replies {daemonUp}.
      const body = (await res.json().catch(() => null)) as { daemonUp?: boolean } | null;
      setReach(body?.daemonUp ? "up" : "down");
    } catch {
      setReach("down");
    }
  };

  return (
    <Card
      title="Self-hosted VPS"
      subtitle="Optional SSH config alias for your own Linux VPS as a bot computer. Muster uses your normal SSH config and agent; it does not store keys or passwords. The remote host needs Docker."
    >
      <div className="flex items-center gap-3 text-[13.5px] text-ink-secondary">
        <input
          value={alias}
          placeholder="my-vps"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setAlias(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="w-44 rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[13px] text-ink focus:border-hairline focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void checkReachable()}
          disabled={!alias.trim() || reach === "checking"}
          className="rounded-lg border border-hairline/40 px-3 py-2 text-[12.5px] text-ink-secondary hover:text-ink disabled:opacity-40"
        >
          {reach === "checking" ? "Checking…" : "Test connection"}
        </button>
        {reach === "up" && <span className="text-[12.5px] text-success">Connected</span>}
        {reach === "down" && (
          <span className="text-[12.5px] text-danger">Not reachable — check ~/.ssh/config</span>
        )}
      </div>
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
  const contentRef = useRef<HTMLDivElement>(null);
  const audit = useAuditBotId();
  const auditBotId = audit.botId;

  // Audit sits before Billing; present whenever the endpoint answers — an
  // empty ledger shows its honest empty state instead of hiding the feature.
  const sections = [...SECTIONS];
  if (audit.reachable && auditBotId) {
    sections.splice(sections.length - 1, 0, { id: "audit", label: "Audit", icon: ShieldCheck, keywords: ["decisions", "ledger", "history"] });
    sections.splice(sections.length - 1, 0, { id: "why", label: "Why", icon: NotebookPen, keywords: ["journal", "decisions", "intent", "reasoning", "runs"] });
  }

  // Section nav search: typing filters live, Esc clears first. When the
  // current section is filtered out, jump to the first match so the right
  // pane never shows a section the list no longer offers.
  const [query, setQuery] = useState("");
  // Muster Connector runtime fields: write-only — GET /api/config reports
  // configured, never the values, so the inputs start empty by design.
  const [openConnectorUrl, setOpenConnectorUrl] = useState("");
  const [openConnectorToken, setOpenConnectorToken] = useState("");
  const [openConnectorBusy, setConnectorBusy] = useState(false);
  const [connectorSaved, setConnectorSaved] = useState(false);
  const [connectorError, setConnectorError] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const visibleSections = sections.filter((entry) => sectionMatches(entry, q));
  useEffect(() => {
    if (visibleSections.some((entry) => entry.id === section)) return;
    const first = visibleSections[0];
    if (first) dispatch({ type: "toggleAppSettings", open: true, section: first.id });
  }, [dispatch, q, section]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

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
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0 && element.tabIndex >= 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === dialog || active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === dialog || active === last || !dialog.contains(active))) {
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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-3 sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className="settings-dialog flex h-[min(760px,calc(100dvh-24px))] w-full max-w-[920px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none sm:h-[min(680px,calc(100dvh-48px))] sm:flex-row"
      >
        {/* section nav */}
        <nav aria-label="Settings sections" className="hidden min-h-0 w-[200px] shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3 sm:flex">
          <div className="px-2 pb-2 pt-1 text-[15px] font-semibold text-ink">
            Settings
          </div>
          <div className="mb-1.5 flex shrink-0 items-center gap-2 rounded-lg bg-control/70 px-2.5 py-1.5">
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
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {visibleSections.length === 0 && (
            <div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary">Nothing matches “{query.trim()}”</div>
          )}
          {visibleSections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]",
                section === id ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
          </div>
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-hairline/40 px-4 py-3 sm:px-5">
            <span className="text-base font-semibold text-ink sm:hidden">Settings</span>
            <span className="hidden text-base font-semibold text-ink sm:block">
              {sections.find((s) => s.id === section)?.label}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label="Close settings"
              className="flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <label className="mx-4 my-3 flex shrink-0 items-center gap-3 text-sm text-ink-secondary sm:hidden">
            Section
            <select aria-label="Settings section" value={section}
              onChange={(event) => {
                const selected = sections.find((entry) => entry.id === event.target.value);
                if (selected) {
                  setQuery("");
                  dispatch({ type: "toggleAppSettings", open: true, section: selected.id });
                }
              }}
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-hairline bg-inset px-3 text-sm font-medium text-ink">
              {sections.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>

          <div ref={contentRef} className="settings-content flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-5 sm:px-5 sm:pt-4">
            {section === "brain" && (
              <>
                <TeamContextCard />
                <Card title="How bots use the Brain" subtitle="Every bot reads this shared brief on every turn — it is how your whole roster stays on the same page.">
                  <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-secondary">
                    <li>Put company facts, goals, conventions, links, and standing preferences here.</li>
                    <li>Bots can read it but never edit it — only you write through this panel.</li>
                    <li>Each bot also keeps its own private memory in its workspace; the Brain is the team-wide layer above that.</li>
                  </ul>
                </Card>
              </>
            )}
            {section === "workspaces" && <ConnectedWorkspacesSection />}

            {section === "organisation" && (
              <Card title="Organisation" subtitle="Company-wide defaults shared by everyone on this workspace.">
                <div className="text-[13px] leading-relaxed text-ink-secondary">
                  A company model is one provider account the whole organisation runs through, so
                  individual bots do not each carry their own key. Until a company gateway is
                  connected, configure engines and keys under Engines and Providers as usual.
                </div>
              </Card>
            )}

            {section === "experimental" && (
              <Card title="Experimental" subtitle="Features still being tested. Off unless you turn them on.">
                <div className="text-[13px] leading-relaxed text-ink-secondary">
                  Nothing experimental is enabled on this build yet.
                </div>
              </Card>
            )}
            {section === "general" && (
              <>
                <Card title="Profile" subtitle="Shown in the sidebar. Saved as you go.">
                  <ProfileFields />
                </Card>
                <TourCard />
                <ChannelTurnCapCard />
                <VpsCard />
                <DiagnosticsCard />
                <AccountSection />
                <MergeAccountsCard />
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
                  {state.config?.openConnector?.configured ? (
                    <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                      Muster Connector runtime is ready — your own connected-apps backend
                    </div>
                  ) : state.config?.composio.mode === "managed" ? (
                    <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                      Connected apps service is ready
                    </div>
                  ) : null}
                  <ApiKeyRow section="box" />
                  <ApiKeyRow section="opensandbox" />
                  <ApiKeyRow section="musterCloud" />
                  <ApiKeyRow section="hiNew" />
                  <WorkspaceSyncCard />
                  <TelegramChatChannelCard />
                  <PortableBackupCard />
                  <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                    <summary className="cursor-pointer text-[13px] text-ink-secondary">Muster Connector — your own connected-apps runtime</summary>
                    <div className="mt-3 flex flex-col gap-3">
                      <p className="text-[12px] text-ink-secondary">
                        Point Muster at a self-hosted OpenConnector runtime and every connected app — catalog, OAuth, actions and agent tools — runs through your own branding and your own infrastructure.
                      </p>
                      <label className="flex flex-col gap-1">
                        <span className="text-[12px] text-ink-secondary">Runtime URL</span>
                        <input
                          value={openConnectorUrl}
                          onChange={(event) => setOpenConnectorUrl(event.target.value)}
                          placeholder="https://connector.example.com"
                          className="rounded-md border border-hairline bg-app px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[12px] text-ink-secondary">Runtime token</span>
                        <input
                          type="password"
                          value={openConnectorToken}
                          onChange={(event) => setOpenConnectorToken(event.target.value)}
                          placeholder="Runtime token from your OpenConnector install"
                          className="rounded-md border border-hairline bg-app px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
                        />
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          className="rounded-md bg-raised px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
                          disabled={openConnectorBusy}
                          onClick={() => {
                            setConnectorError(null);
                            setConnectorSaved(false);
                            setConnectorBusy(true);
                            const payload: Record<string, string> = {};
                            if (openConnectorUrl.trim()) payload.url = openConnectorUrl.trim();
                            if (openConnectorToken.trim()) payload.token = openConnectorToken.trim();
                            api("/api/config", { method: "POST", body: JSON.stringify({ openConnector: payload }) })
                              .then(() => setConnectorSaved(true))
                              .catch((e: Error) => setConnectorError(e instanceof Error ? e.message : String(e)))
                              .finally(() => setConnectorBusy(false));
                          }}
                        >
                          {openConnectorBusy ? "Saving…" : "Save runtime"}
                        </button>
                        {connectorSaved && <span className="text-[12px] text-success">Saved. The catalog now comes from your runtime.</span>}
                        {connectorError && <span role="alert" className="text-[12px] text-danger">{connectorError}</span>}
                      </div>
                    </div>
                  </details>
                  <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                    <summary className="cursor-pointer text-[13px] text-ink-secondary">Self-host connected apps (Composio)</summary>
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
                subtitle="Paste a key for any provider — each entry becomes an engine your bots pick from in their model selector."
              >
                <ProvidersSection />
              </Card>
            )}

            {section === "mcp" && <McpServersSection />}

            {section === "companion" && <CompanionSection />}

            {section === "remoteAccess" && <RemoteAccessSection />}

            {section === "voice" && <VoiceSettings />}

            {section === "computer" && <LocalComputerSection />}

            {section === "usage" && <UsageSection />}
            {section === "usage" && <ProviderHealthSection />}
            {section === "usage" && <InviteSection />}
            {section === "vault" && (
              <>
                <VaultSection />
                <ManageDevicesCard />
              </>
            )}

            {section === "audit" && audit.botId && (
              <Card title="Audit" subtitle="Every action this bot takes gets decided before it happens. Newest first.">
                <AuditPanel botId={audit.botId} />
              </Card>
            )}

            {section === "why" && audit.botId && (
              <Card title="Why" subtitle="Each journaled run states what it was trying to do and the choices it made. Newest first.">
                <WhyPanel botId={audit.botId} />
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
