// Manual backups for a local installation. The server receives the passphrase
// and encrypts the bundle using both it and this installation's secret.
// The current format does not include conversation history or support moving
// a workspace to another installation. Hosted deployments reject these routes.
import { Download, HardDriveDownload, Loader2, Send, Upload } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";

import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import {
  createWorkspaceRequestScope,
  readWorkspaceCapability,
  readWorkspaceReply,
  type WorkspaceCapabilityState,
  type WorkspaceRequest,
} from "@/lib/workspace-capability";
import type { WorkspaceBackupCapability } from "../../server/contracts";

type SyncStep =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

const exportReply = z.object({ payload: z.string().min(1) });
const restoreReply = z.object({ restored: z.object({ botsRestored: z.number().int().nonnegative(), memoryFilesRestored: z.number().int().nonnegative() }) });
const uploadReply = z.object({ uploaded: z.string().min(1) });
const telegramReply = z.object({ connected: z.literal(true), bot: z.string(), chat: z.string() });

export function WorkspaceSyncCard() {
  const { user, session } = useAuth();
  return <WorkspaceSyncSession key={JSON.stringify([user?.id ?? null, session?.id ?? null])} />;
}

function WorkspaceSyncSession() {
  const [passphrase, setPassphrase] = useState("");
  const [step, setStep] = useState<SyncStep>({ kind: "idle" });
  const [showTelegram, setShowTelegram] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [capability, setCapability] = useState<WorkspaceCapabilityState>({ kind: "loading" });
  const capabilityRef = useRef<WorkspaceBackupCapability | null>(null);
  const [requests] = useState(createWorkspaceRequestScope);
  const busy = step.kind === "busy";
  const workspaceAllowed = capability.kind === "ready" && capability.value.workspaceBackupAvailable;
  const driveAllowed = capability.kind === "ready" && capability.value.installationDrive.operationsAvailable;

  const refreshStatus = useCallback(async () => {
    if (requests.busy) return;
    const request = requests.beginStatus();
    if (!request) return;
    capabilityRef.current = null;
    setCapability({ kind: "loading" });
    try {
      const value = await readWorkspaceCapability(request);
      if (value) request.commit(() => {
        capabilityRef.current = value;
        setCapability({ kind: "ready", value });
      });
    } catch (error) {
      request.commit(() => setCapability({ kind: "error", message: error instanceof Error ? error.message : String(error) }));
    } finally {
      request.finish();
    }
  }, [requests]);

  useLayoutEffect(() => {
    requests.activate();
    void refreshStatus();
    return () => {
      capabilityRef.current = null;
      requests.dispose();
    };
  }, [requests, refreshStatus]);

  const run = async (label: string, channel: "workspace" | "drive", fn: (request: WorkspaceRequest) => Promise<string | null>) => {
    const available = capabilityRef.current;
    if (!available?.workspaceBackupAvailable || (channel === "drive" && !available.installationDrive.operationsAvailable)) return;
    const request = requests.beginOperation();
    if (!request) return;
    setStep({ kind: "busy", label });
    try {
      const message = await fn(request);
      if (message !== null) request.commit(() => setStep({ kind: "done", message }));
    } catch (error) {
      request.commit(() => setStep({ kind: "error", message: error instanceof Error ? error.message : String(error) }));
    } finally {
      request.finish();
    }
  };

  const exportLocal = () =>
    run("Exporting…", "workspace", async (request) => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      const data = await readWorkspaceReply(request, "/api/workspace/export", JSON.stringify({ passphrase }), exportReply);
      if (!data) return null;
      request.commit(() => {
        const url = URL.createObjectURL(new Blob([data.payload], { type: "text/plain" }));
        try {
          const a = document.createElement("a");
          a.href = url;
          a.download = `muster-workspace-${new Date().toISOString().slice(0, 10)}.enc`;
          a.click();
        } finally {
          URL.revokeObjectURL(url);
        }
      });
      return "Workspace exported — keep the file and the passphrase safe.";
    });

  const restoreLocal = (file: File) =>
    run("Restoring…", "workspace", async (request) => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      const payload = await file.text();
      const data = await readWorkspaceReply(request, "/api/workspace/restore", JSON.stringify({ passphrase, payload }), restoreReply);
      if (!data) return null;
      request.commit(() => window.location.reload());
      return `Restored ${data.restored.botsRestored} bots, ${data.restored.memoryFilesRestored} memory files.`;
    });

  const googlePush = () =>
    run("Pushing to the configured Google Drive…", "drive", async (request) => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      const data = await readWorkspaceReply(request, "/api/workspace/drive/push", JSON.stringify({ passphrase }), uploadReply);
      if (!data) return null;
      return "Backup saved to Muster's application folder in the Google Drive configured on this computer.";
    });

  const googlePull = () =>
    run("Pulling from the configured Google Drive…", "drive", async (request) => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      const data = await readWorkspaceReply(request, "/api/workspace/drive/pull", JSON.stringify({ passphrase }), restoreReply);
      if (!data) return null;
      request.commit(() => window.location.reload());
      return `Restored ${data.restored.botsRestored} bots, ${data.restored.memoryFilesRestored} memory files from Drive.`;
    });

  const connectTelegram = () =>
    run("Connecting Telegram…", "workspace", async (request) => {
      const token = botToken.trim();
      if (!token) throw new Error("Paste the bot token from @BotFather first");
      const data = await readWorkspaceReply(request, "/api/workspace/telegram/connect", JSON.stringify({ botToken: token }), telegramReply);
      if (!data) return null;
      request.commit(() => { setBotToken(""); setShowTelegram(false); });
      return `Connected to ${data.bot}. You can now save a backup to the ${data.chat} chat.`;
    });

  const telegramPush = () =>
    run("Sending to your Telegram…", "workspace", async (request) => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      const data = await readWorkspaceReply(request, "/api/workspace/telegram/push", JSON.stringify({ passphrase }), uploadReply);
      if (!data) return null;
      return "Encrypted backup sent to your Telegram chat.";
    });

  const telegramPull = () =>
    run("Restoring from your Telegram…", "workspace", async (request) => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      const data = await readWorkspaceReply(request, "/api/workspace/telegram/pull", JSON.stringify({ passphrase }), restoreReply);
      if (!data) return null;
      request.commit(() => window.location.reload());
      return `Restored ${data.restored.botsRestored} bots, ${data.restored.memoryFilesRestored} memory files from your Telegram chat.`;
    });

  const input =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  const button =
    "flex items-center gap-1.5 rounded-lg bg-raised px-2.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40";

  return (
    <section aria-label="Workspace backup" className="rounded-xl border border-hairline/40 bg-card p-3">
      <div className="text-[13px] font-medium text-ink">Workspace backup</div>
      <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
        Save teammate profiles, groups, and memory from a local desktop install. Conversation
        history and provider connections are not included. This backup format restores to the
        same installation only; it does not sync devices automatically.
      </div>
      {capability.kind === "loading" && <p role="status" className="mt-2 text-[12px] text-ink-secondary">Checking backup availability…</p>}
      {capability.kind === "error" && <p role="alert" className="mt-2 text-[12px] text-danger">Backup availability could not be confirmed. {capability.message}</p>}
      {capability.kind === "ready" && (
        <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
          {!capability.value.workspaceBackupAvailable && <p>{capability.value.unavailableReason}</p>}
          {capability.value.workspaceBackupAvailable && <p>{capability.value.installationDrive.configured ? "Drive configured on this computer" : "Drive is not configured on this computer"}</p>}
          <p>Google sign-in does not connect desktop backup.</p>
        </div>
      )}
      <button type="button" disabled={busy} onClick={() => void refreshStatus()} className={cn(button, "mt-2")}>
        {capability.kind === "ready" ? "Refresh backup status" : "Retry backup status"}
      </button>

      <input
        disabled={busy || !workspaceAllowed}
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Backup passphrase (8+ characters)"
        aria-label="Backup passphrase"
        autoComplete="off"
        className={cn(input, "mt-2.5")}
      />

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy || !workspaceAllowed} onClick={() => void exportLocal()} className={button}>
          <Download size={13} /> Export file
        </button>
        <label aria-disabled={busy || !workspaceAllowed} className={cn(button, "focus-within:ring-2 focus-within:ring-accent", busy || !workspaceAllowed ? "opacity-40" : "cursor-pointer")}>
          <Upload size={13} /> Restore file…
          <input
            type="file"
            disabled={busy || !workspaceAllowed}
            accept=".enc,text/plain"
            aria-label="Restore from file"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void restoreLocal(f);
            }}
          />
        </label>
        <span className="mx-1 w-px self-stretch bg-hairline/40" aria-hidden="true" />
        <button type="button" disabled={busy || !driveAllowed} onClick={() => void googlePush()} className={cn(button, "text-accent font-medium")}>
          <Upload size={13} /> Back up to Drive
        </button>
        <button type="button" disabled={busy || !driveAllowed} onClick={() => void googlePull()} className={cn(button, "text-accent font-medium")}>
          <HardDriveDownload size={13} /> Restore from Drive
        </button>
        <span className="mx-1 w-px self-stretch bg-hairline/40" aria-hidden="true" />
        <button type="button" disabled={busy || !workspaceAllowed} onClick={() => void telegramPush()} className={cn(button, "text-accent font-medium")}>
          <Send size={13} /> Back up to Telegram
        </button>
        <button type="button" disabled={busy || !workspaceAllowed} onClick={() => void telegramPull()} className={cn(button, "text-accent font-medium")}>
          <HardDriveDownload size={13} /> Restore from Telegram
        </button>
        <button
          type="button"
          disabled={busy || !workspaceAllowed}
          onClick={() => { if (capabilityRef.current?.workspaceBackupAvailable && !requests.busy) setShowTelegram((v) => !v); }}
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
              disabled={busy || !workspaceAllowed}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="1234567890:AA…"
              aria-label="Telegram bot token"
              autoComplete="off"
              className={input}
            />
            <button type="button" disabled={busy || !workspaceAllowed} onClick={() => void connectTelegram()} className={cn(button, "text-accent font-medium")}>
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
    </section>
  );
}
