// Manual backups for a local installation. The server receives the passphrase
// and encrypts the bundle using both it and this installation's secret.
// The current format does not include conversation history or support moving
// a workspace to another installation. Hosted deployments reject these routes.
import { Download, HardDriveDownload, Loader2, Send, Upload } from "lucide-react";
import { useState, useEffect } from "react";

import { api } from "@/state/store";
import { cn } from "@/lib/cn";

type SyncStep =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export function WorkspaceSyncCard() {
  const [passphrase, setPassphrase] = useState("");
  const [step, setStep] = useState<SyncStep>({ kind: "idle" });
  const [showTelegram, setShowTelegram] = useState(false);
  const [botToken, setBotToken] = useState("");
  // null = unknown yet; false shows the connect button (sign-in is
  // basic-scope by design, so Drive is granted here, not at login).
  // lastPush feeds the "Last backed up" line the card renders.
  const [drive, setDrive] = useState<boolean | null>(null);
  const [lastPush, setLastPush] = useState<{ at: number; channel: string } | null>(null);
  const busy = step.kind === "busy";

  useEffect(() => {
    let alive = true;
    api("/api/workspace/google/status")
      .then((r: { drive: boolean; lastPush: { at: number; channel: string } | null }) => {
        if (!alive) return;
        setDrive(r.drive);
        setLastPush(r.lastPush);
      })
      .catch(() => alive && setDrive(null));
    return () => { alive = false; };
  }, []);

  const run = async (label: string, fn: () => Promise<string>) => {
    setStep({ kind: "busy", label });
    try {
      const message = await fn();
      setStep({ kind: "done", message });
    } catch (e) {
      setStep({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const exportLocal = () =>
    run("Exporting…", async () => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      // SAFETY: own endpoint; the reply is {payload, counts}.
      const data = (await api("/api/workspace/export", {
        method: "POST",
        body: JSON.stringify({ passphrase }),
      })) as { payload: string };
      const blob = new Blob([data.payload], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `muster-workspace-${new Date().toISOString().slice(0, 10)}.enc`;
      a.click();
      URL.revokeObjectURL(url);
      return "Workspace exported — keep the file and the passphrase safe.";
    });

  const restoreLocal = (file: File) =>
    run("Restoring…", async () => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      const payload = await file.text();
      // SAFETY: own endpoint; the reply is {restored:{...counts}}.
      const data = (await api("/api/workspace/restore", {
        method: "POST",
        body: JSON.stringify({ passphrase, payload }),
      })) as { restored: { botsRestored: number; memoryFilesRestored: number } };
      window.location.reload();
      return `Restored ${data.restored.botsRestored} bots, ${data.restored.memoryFilesRestored} memory files.`;
    });

  const googlePush = () =>
    run("Pushing to your Google Drive…", async () => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      await api("/api/workspace/google/push", {
        method: "POST",
        body: JSON.stringify({ passphrase }),
      });
      return "Backup saved to Muster's application folder in your Google Drive.";
    });

  const googlePull = () =>
    run("Pulling from your Google Drive…", async () => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      // SAFETY: own endpoint; the reply is {restored:{...counts}}.
      const data = (await api("/api/workspace/google/pull", {
        method: "POST",
        body: JSON.stringify({ passphrase }),
      })) as { restored: { botsRestored: number; memoryFilesRestored: number } };
      window.location.reload();
      return `Restored ${data.restored.botsRestored} bots, ${data.restored.memoryFilesRestored} memory files from your Drive.`;
    });

  const connectTelegram = () =>
    run("Connecting Telegram…", async () => {
      const token = botToken.trim();
      if (!token) throw new Error("Paste the bot token from @BotFather first");
      // SAFETY: own endpoint; the reply is {connected, bot, chat}.
      const data = (await api("/api/workspace/telegram/connect", {
        method: "POST",
        body: JSON.stringify({ botToken: token }),
      })) as { bot: string; chat: string };
      setBotToken("");
      setShowTelegram(false);
      return `Connected to ${data.bot}. You can now save a backup to the ${data.chat} chat.`;
    });

  const telegramPush = () =>
    run("Sending to your Telegram…", async () => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      await api("/api/workspace/telegram/push", {
        method: "POST",
        body: JSON.stringify({ passphrase }),
      });
      return "Encrypted backup sent to your Telegram chat.";
    });

  const telegramPull = () =>
    run("Restoring from your Telegram…", async () => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      // SAFETY: own endpoint; the reply is {restored:{...counts}}.
      const data = (await api("/api/workspace/telegram/pull", {
        method: "POST",
        body: JSON.stringify({ passphrase }),
      })) as { restored: { botsRestored: number; memoryFilesRestored: number } };
      window.location.reload();
      return `Restored ${data.restored.botsRestored} bots, ${data.restored.memoryFilesRestored} memory files from your Telegram chat.`;
    });

  const input =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  const button =
    "flex items-center gap-1.5 rounded-lg bg-raised px-2.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40";

  return (
    <div className="rounded-xl border border-hairline/40 bg-card p-3">
      <div className="text-[13px] font-medium text-ink">Workspace backup</div>
      <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
        Save teammate profiles, groups, and memory from a local desktop install. Conversation
        history and provider connections are not included. This backup format restores to the
        same installation only; it does not sync devices automatically.
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
        Workspace backups are available on local desktop installs only for now.
      </p>

      <input
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Backup passphrase (8+ characters)"
        aria-label="Backup passphrase"
        autoComplete="off"
        className={cn(input, "mt-2.5")}
      />

      {lastPush && (
        <p className="mt-2 text-[12.5px] text-ink-secondary">
          Last backed up to {lastPush.channel === "google-drive" ? "Google Drive" : "Telegram"} ·{" "}
          {new Date(lastPush.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void exportLocal()} className={button}>
          <Download size={13} /> Export file
        </button>
        <label className={cn(button, "cursor-pointer")}>
          <Upload size={13} /> Restore file…
          <input
            type="file"
            disabled={busy}
            accept=".enc,text/plain"
            aria-label="Restore from file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void restoreLocal(f);
            }}
          />
        </label>
        <span className="mx-1 w-px self-stretch bg-hairline/40" aria-hidden="true" />
        {/* Drive needs its own grant: sign-in is basic-scope on purpose, so
            first-time users connect here — one consent, then the buttons
            below work. */}
        {drive === false && (
          <a href="/api/workspace/google/connect" className={cn(button, "text-accent font-medium")}>
            <HardDriveDownload size={13} /> Connect Google Drive…
          </a>
        )}
        {/* Requires a Google Drive grant on this installation. Desktop pairing
            alone does not transfer the web account's Drive grant. */}
        <button type="button" disabled={busy} onClick={() => void googlePush()} className={cn(button, "text-accent font-medium")}>
          <Upload size={13} /> Back up to Drive
        </button>
        <button type="button" disabled={busy} onClick={() => void googlePull()} className={cn(button, "text-accent font-medium")}>
          <HardDriveDownload size={13} /> Restore from Drive
        </button>
        <span className="mx-1 w-px self-stretch bg-hairline/40" aria-hidden="true" />
        <button type="button" disabled={busy} onClick={() => void telegramPush()} className={cn(button, "text-accent font-medium")}>
          <Send size={13} /> Back up to Telegram
        </button>
        <button type="button" disabled={busy} onClick={() => void telegramPull()} className={cn(button, "text-accent font-medium")}>
          <HardDriveDownload size={13} /> Restore from Telegram
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setShowTelegram((v) => !v)}
          className={button}
          title="Connect a Telegram bot chat for manual backups"
        >
          Connect Telegram…
        </button>
      </div>

      {showTelegram && (
        <div className="mt-2 rounded-lg border border-hairline/40 bg-inset p-2.5">
          <div className="text-[12px] leading-relaxed text-ink-secondary">
            In Telegram, message <strong>@BotFather</strong> → <code>/newbot</code>, copy the token, then open your new bot and
            send it <code>/start</code>. Paste the token here — Muster finds your chat automatically.
          </div>
          <div className="mt-2 flex gap-2">
            <input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="1234567890:AA…"
              aria-label="Telegram bot token"
              autoComplete="off"
              className={input}
            />
            <button type="button" disabled={busy} onClick={() => void connectTelegram()} className={cn(button, "text-accent font-medium")}>
              Connect
            </button>
          </div>
        </div>
      )}

      {step.kind === "busy" && (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-secondary">
          <Loader2 size={13} className="animate-spin" /> {step.label}
        </div>
      )}
      {step.kind === "done" && <div className="mt-2 text-[12px] text-success">{step.message}</div>}
      {step.kind === "error" && <div role="alert" className="mt-2 text-[12px] text-danger">{step.message}</div>}
      {step.kind === "idle" && (
        <div className="mt-2 text-[11px] leading-snug text-ink-secondary">
          Keep this installation and its settings, along with your backup file and passphrase.
          Reinstalling without the original settings can make a backup unreadable. Drive requires
          an existing Google Drive connection on this install. Telegram backups are sent only
          when you choose Back up to Telegram.
        </div>
      )}
    </div>
  );
}
