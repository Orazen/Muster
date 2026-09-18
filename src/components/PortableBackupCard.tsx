// Portable full backup (v2) — everything an install is, in one encrypted
// file that survives the machine: teammates, rooms, complete transcripts,
// memory, routines, goals, approval history and the social graph, sealed
// under the passphrase ALONE. Provider keys and connection grants never
// enter the bundle, and a restored workspace never acts on its own:
// routines come back switched off and goals stopped until you say go.
//
// Restores stage while Muster runs and apply at the next launch — the
// server replaces the whole covered set atomically at boot, with a safety
// copy of what was there before.
import { CloudUpload, Download, HardDriveDownload, Loader2, RotateCcw, Send, ShieldCheck, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { cn } from "@/lib/cn";
import {
  createWorkspaceRequestScope,
  readWorkspaceCapability,
  readWorkspaceReply,
  type WorkspaceRequest,
} from "@/lib/workspace-capability";

const countsSchema = z.object({
  files: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  threads: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});

const v2ExportReply = z.object({
  payload: z.string().min(1),
  counts: countsSchema,
  skipped: z.array(z.object({ path: z.string(), reason: z.string() }).passthrough()).default([]),
  skippedTruncated: z.boolean().default(false),
});

const reconsentSchema = z.array(
  z.object({ botId: z.string(), restoredId: z.string(), reason: z.string() }).passthrough(),
);

const v2StageReply = z.object({
  staged: z.literal(true),
  restartRequired: z.literal(true),
  reconsentRequired: reconsentSchema,
  counts: countsSchema.nullable().optional(),
});

const v2StatusReply = z.object({
  pending: z.object({
    createdAt: z.number(),
    source: z.string(),
    reconsentRequired: reconsentSchema.default([]),
  }).nullable(),
  receipt: z.object({
    appliedAt: z.number(),
    status: z.enum(["committed", "failed", "rolled-back", "refused"]),
    source: z.string(),
    error: z.string().optional(),
    blocked: z.array(z.object({ path: z.string(), detail: z.string() })).optional(),
    reconsentRequired: reconsentSchema.default([]),
  }).nullable(),
});

const connectUrlReply = z.object({ url: z.string().url() });
const uploadedReply = z.object({ uploaded: z.string().min(1), counts: countsSchema.nullable().optional() });

type Step =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

function when(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function PortableBackupCard() {
  const [passphrase, setPassphrase] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [ready, setReady] = useState(false);
  const [accountDrive, setAccountDrive] = useState<{ available: boolean; connected: boolean } | null>(null);
  const [status, setStatus] = useState<z.infer<typeof v2StatusReply> | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const busyRef = useRef(false);
  const [requests] = useState(createWorkspaceRequestScope);
  const busy = step.kind === "busy";

  const refreshStatus = useCallback(async () => {
    const request = requests.beginStatus();
    if (!request) return;
    try {
      const value = await readWorkspaceReply(request, "/api/workspace/v2/status", undefined, v2StatusReply);
      if (value) request.commit(() => setStatus(value));
    } catch {
      /* status is advisory — the action buttons carry the real errors */
    } finally {
      request.finish();
    }
  }, [requests]);

  useEffect(() => {
    requests.activate();
    void (async () => {
      const request = requests.beginStatus();
      if (!request) return;
      try {
        const cap = await readWorkspaceCapability(request);
        if (cap) request.commit(() => {
          setReady(cap.workspaceBackupAvailable);
          setAccountDrive(cap.accountDrive);
        });
        // Backup is unavailable here (hosted) — never probe deeper: the
        // v2 status route is local-install-only, so a request to it can
        // only produce a confusing 403 console error.
        if (cap?.workspaceBackupAvailable) void refreshStatus();
      } catch {
        /* fail closed: no card actions until capability is confirmed */
      } finally {
        request.finish();
      }
    })();
    return () => {
      requests.dispose();
    };
  }, [requests, refreshStatus]);

  const run = async (label: string, fn: (request: WorkspaceRequest) => Promise<string | null>) => {
    if (!ready || busyRef.current) return;
    const request = requests.beginOperation();
    if (!request) return;
    busyRef.current = true;
    setStep({ kind: "busy", label });
    try {
      const message = await fn(request);
      if (message !== null) request.commit(() => setStep({ kind: "done", message }));
    } catch (error) {
      request.commit(() => setStep({ kind: "error", message: error instanceof Error ? error.message : String(error) }));
    } finally {
      busyRef.current = false;
      request.finish();
      void refreshStatus();
    }
  };

  const needPassphrase = () => {
    if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
  };

  const download = (text: string, name: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const exportFile = () =>
    run("Building your full backup…", async (request) => {
      needPassphrase();
      const data = await readWorkspaceReply(request, "/api/workspace/v2/export", JSON.stringify({ passphrase }), v2ExportReply);
      if (!data) return null;
      request.commit(() => download(data.payload, `muster-backup-${new Date().toISOString().slice(0, 10)}.musterbackup`));
      return `Everything sealed: ${data.counts.threads} threads, ${data.counts.messages} messages, ${data.counts.files} files.`;
    });

  const stageResult = (data: z.infer<typeof v2StageReply>): string => {
    const extra = data.reconsentRequired.length
      ? ` ${data.reconsentRequired.length} teammate(s) will need permission re-approval after the restart.`
      : "";
    return `Restore staged — quit and reopen Muster to apply it.${extra}`;
  };

  const restoreFile = (file: File) =>
    run("Verifying the bundle…", async (request) => {
      needPassphrase();
      const payload = await file.text();
      const data = await readWorkspaceReply(
        request, "/api/workspace/v2/restore", JSON.stringify({ passphrase, payload, confirm: true }), v2StageReply,
      );
      if (!data) return null;
      request.commit(() => { setConfirmReplace(false); setPendingFile(null); });
      return stageResult(data);
    });

  const drivePush = () =>
    run("Sending your full backup to Drive…", async (request) => {
      needPassphrase();
      const data = await readWorkspaceReply(request, "/api/workspace/v2/drive/push", JSON.stringify({ passphrase }), v2ExportReply.pick({ counts: true }));
      if (!data) return null;
      return `Drive holds it now: ${data.counts.threads} threads, ${data.counts.messages} messages.`;
    });

  const drivePull = () =>
    run("Pulling the bundle from Drive…", async (request) => {
      needPassphrase();
      const data = await readWorkspaceReply(request, "/api/workspace/v2/drive/pull", JSON.stringify({ passphrase }), v2StageReply);
      if (!data) return null;
      return stageResult(data);
    });

  // The signed-in user's own Google account: one drive.appdata consent, the
  // refresh token stored on their account row, ciphertext-only transport.
  // The connect route reads state only (it issues a signed consent URL), so
  // this is a GET — a POST here never reaches the route (404 from the
  // session gate's family matcher) and the card would report a dead end.
  const connectGoogle = () =>
    run("Opening Google's consent page…", async (request) => {
      const data = await readWorkspaceReply(request, "/api/workspace/google/connect", undefined, connectUrlReply);
      if (!data) return null;
      window.location.href = data.url;
      return null;
    });

  const accountPush = () =>
    run("Sending your full backup to your Google Drive…", async (request) => {
      needPassphrase();
      const data = await readWorkspaceReply(request, "/api/workspace/google/push", JSON.stringify({ passphrase }), uploadedReply);
      if (!data) return null;
      return `Your Drive holds it now: ${data.counts?.threads ?? "?"} threads, ${data.counts?.messages ?? "?"} messages.`;
    });

  const accountPull = () =>
    run("Pulling the bundle from your Google Drive…", async (request) => {
      needPassphrase();
      const data = await readWorkspaceReply(request, "/api/workspace/google/pull", JSON.stringify({ passphrase }), v2StageReply);
      if (!data) return null;
      return stageResult(data);
    });

  const telegramPush = () =>
    run("Sending your full backup to Telegram…", async (request) => {
      needPassphrase();
      const data = await readWorkspaceReply(request, "/api/workspace/v2/telegram/push", JSON.stringify({ passphrase }), v2ExportReply.pick({ counts: true }));
      if (!data) return null;
      return `Your chat has it: ${data.counts.threads} threads, ${data.counts.messages} messages.`;
    });

  const telegramPull = () =>
    run("Pulling the bundle from Telegram…", async (request) => {
      needPassphrase();
      const data = await readWorkspaceReply(request, "/api/workspace/v2/telegram/pull", JSON.stringify({ passphrase }), v2StageReply);
      if (!data) return null;
      return stageResult(data);
    });

  const discard = () =>
    run("Discarding the staged restore…", async (request) => {
      const data = await readWorkspaceReply(request, "/api/workspace/v2/restore/discard", "{}", z.object({ discarded: z.literal(true) }));
      if (!data) return null;
      return "Staged restore discarded.";
    });

  const button =
    "flex items-center gap-1.5 rounded-lg bg-raised px-2.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40";
  const accent = cn(button, "text-accent font-medium");
  const input =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  if (!ready) return null;

  return (
    <section aria-label="Full portable backup" className="rounded-xl border border-hairline/40 bg-card p-3">
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
        <ShieldCheck size={14} className="text-accent" /> Full portable backup
      </div>
      <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
        Everything in one encrypted file: teammates, rooms, complete chats, memory, routines,
        goals and approval history. The passphrase alone opens it — restore on any Muster install,
        even after the machine is gone. Keys and connection grants never leave this computer, and
        restored routines stay switched off until you re-enable them.
      </div>

      {status?.pending && (
        <div className="mt-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-[12px] leading-relaxed text-ink">
          <div>
            A restore staged from {status.pending.source} at {when(status.pending.createdAt)} is waiting.
            Quit and reopen Muster to apply it — your current data is kept as a safety copy.
          </div>
          <button type="button" disabled={busy} onClick={() => void discard()} className={cn(button, "mt-1.5")}>
            <X size={12} /> Discard staged restore
          </button>
        </div>
      )}
      {!status?.pending && status?.receipt && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          Last restore ({status.receipt.source}, {when(status.receipt.appliedAt)}):{" "}
          {status.receipt.status === "committed" ? "applied" : `${status.receipt.status}${status.receipt.error ? ` — ${status.receipt.error}` : ""}${status.receipt.blocked?.length ? ` — ${status.receipt.blocked[0].detail}` : ""}`}
          {status.receipt.reconsentRequired.length > 0 && status.receipt.status === "committed" && (
            <> — {status.receipt.reconsentRequired.length} teammate(s) need permission re-approval</>
          )}
        </div>
      )}

      <input
        disabled={busy}
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Backup passphrase (8+ characters)"
        aria-label="Portable backup passphrase"
        autoComplete="off"
        className={cn(input, "mt-2.5")}
      />

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void exportFile()} className={button}>
          <Download size={13} /> Back up everything to file
        </button>
        <label className={cn(button, busy ? "opacity-40" : "cursor-pointer")}>
          <Upload size={13} /> Restore from file…
          <input
            type="file"
            disabled={busy}
            accept=".musterbackup,.enc,text/plain"
            aria-label="Restore from portable backup file"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) { setPendingFile(f); setConfirmReplace(false); }
            }}
          />
        </label>
        <span className="mx-1 w-px self-stretch bg-hairline/40" aria-hidden="true" />
        <button type="button" disabled={busy} onClick={() => void drivePush()} className={accent}>
          <Upload size={13} /> Drive
        </button>
        <button type="button" disabled={busy} onClick={() => void drivePull()} className={accent}>
          <HardDriveDownload size={13} /> Restore from Drive
        </button>
        {accountDrive?.available && (
          accountDrive.connected ? (
            <>
              <button type="button" disabled={busy} onClick={() => void accountPush()} className={accent}>
                <CloudUpload size={13} /> My Google Drive
              </button>
              <button type="button" disabled={busy} onClick={() => void accountPull()} className={accent}>
                <HardDriveDownload size={13} /> Restore from my Drive
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => void connectGoogle()} className={accent} title="Grant your Google account's private app folder for portable backups">
              <CloudUpload size={13} /> Connect my Google Drive
            </button>
          )
        )}
        <button type="button" disabled={busy} onClick={() => void telegramPush()} className={accent}>
          <Send size={13} /> Telegram
        </button>
        <button type="button" disabled={busy} onClick={() => void telegramPull()} className={accent}>
          <HardDriveDownload size={13} /> Restore from Telegram
        </button>
      </div>

      {pendingFile && (
        <div className="mt-2 rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-[12px] leading-relaxed text-ink">
          <div>
            Restoring <strong>{pendingFile.name}</strong> replaces the teammates, rooms and chats
            this computer currently has (a safety copy is kept). Connections and permissions will
            need re-approval.
          </div>
          <label className="mt-1.5 flex items-center gap-2">
            <input type="checkbox" checked={confirmReplace} onChange={(e) => setConfirmReplace(e.target.checked)} />
            I understand — replace this installation from the backup
          </label>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              disabled={busy || !confirmReplace}
              onClick={() => void restoreFile(pendingFile)}
              className={cn(button, "bg-danger/20 text-ink font-medium")}
            >
              <RotateCcw size={12} /> Stage restore
            </button>
            <button type="button" disabled={busy} onClick={() => { setPendingFile(null); setConfirmReplace(false); }} className={button}>
              Cancel
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
    </section>
  );
}
