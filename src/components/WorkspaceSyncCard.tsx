// Workspace sync card — export/restore the workspace as one encrypted
// bundle, and connect Google Drive so the same bundle syncs between
// desktop and web installs. The passphrase never leaves the browser except
// inside the encrypted payload; Drive only ever holds ciphertext
// (docs/plans/account-sync-portable-profile.md).
import { Download, HardDriveDownload, Loader2, Upload } from "lucide-react";
import { useState } from "react";

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
  const busy = step.kind === "busy";

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

  const drivePush = () =>
    run("Pushing to Drive…", async () => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      await api("/api/workspace/drive/push", {
        method: "POST",
        body: JSON.stringify({ passphrase }),
      });
      return "Pushed to your Google Drive (app-private folder).";
    });

  const drivePull = () =>
    run("Pulling from Drive…", async () => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      // SAFETY: own endpoint; the reply is {restored:{...counts}}.
      const data = (await api("/api/workspace/drive/pull", {
        method: "POST",
        body: JSON.stringify({ passphrase }),
      })) as { restored: { botsRestored: number; memoryFilesRestored: number } };
      window.location.reload();
      return `Restored ${data.restored.botsRestored} bots, ${data.restored.memoryFilesRestored} memory files from Drive.`;
    });

  const connectDrive = () =>
    run("Connecting…", async () => {
      // SAFETY: own endpoint; reply is {url} — the Google consent URL.
      const { url } = (await api("/api/workspace/drive/url")) as { url: string };
      window.open(url, "_blank", "noopener");
      // Drive connect completes out-of-band: the user approves in Google,
      // pastes the code back on the sync page, and the next Push/Pull works.
      return "Google opened in a new tab — approve access, copy the code, and paste it below.";
    });

  const input =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  const button =
    "flex items-center gap-1.5 rounded-lg bg-raised px-2.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40";

  return (
    <div className="rounded-xl border border-hairline/40 bg-card p-3">
      <div className="text-[13px] font-medium text-ink">Workspace sync</div>
      <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
        Take your whole team — bots, memory, threads — to any install. The bundle is encrypted with
        your passphrase; Google Drive only ever holds ciphertext. API keys never sync.
      </div>

      <input
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Sync passphrase (8+ characters)"
        aria-label="Sync passphrase"
        autoComplete="off"
        className={cn(input, "mt-2.5")}
      />

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void exportLocal()} className={button}>
          <Download size={13} /> Export file
        </button>
        <label className={cn(button, "cursor-pointer")}>
          <Upload size={13} /> Restore file…
          <input
            type="file"
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
        <button type="button" disabled={busy} onClick={() => void drivePush()} className={button}>
          <Upload size={13} /> Push to Drive
        </button>
        <button type="button" disabled={busy} onClick={() => void drivePull()} className={button}>
          <HardDriveDownload size={13} /> Pull from Drive
        </button>
        <button type="button" disabled={busy} onClick={() => void connectDrive()} className={cn(button, "text-accent")}>
          Connect Drive ↗
        </button>
      </div>

      {step.kind === "busy" && (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-secondary">
          <Loader2 size={13} className="animate-spin" /> {step.label}
        </div>
      )}
      {step.kind === "done" && <div className="mt-2 text-[12px] text-success">{step.message}</div>}
      {step.kind === "error" && <div className="mt-2 text-[12px] text-danger">{step.message}</div>}
      {step.kind === "idle" && (
        <div className="mt-2 text-[11px] leading-snug text-ink-secondary">
          First time? Run Export on this install, then Connect Drive → Push. On the other install:
          Connect Drive → Pull. Same passphrase on both sides.
        </div>
      )}
    </div>
  );
}
