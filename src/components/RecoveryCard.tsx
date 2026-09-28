// New-device recovery — the Puffo pattern, told honestly. A fresh install
// with (almost) no roster offers to pull the last portable backup right
// where you are, instead of hunting through Settings. There is no relay and
// no live device-to-device share in Muster — the user's own Drive or
// Telegram IS the bus, so the copy says exactly that, and a staged restore
// still applies at next launch (server/restore-apply.ts).
import { HardDriveDownload, Loader2, Settings2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";

import { cn } from "@/lib/cn";
import {
  createWorkspaceRequestScope,
  readWorkspaceCapability,
  readWorkspaceReply,
} from "@/lib/workspace-capability";

const DISMISS_KEY = "muster:recovery-dismissed";

const v2StageReply = z.object({
  staged: z.literal(true),
  restartRequired: z.literal(true),
  reconsentRequired: z.array(z.unknown()).default([]),
});

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Which Drive transport a restore should use. Two exist and they are not
 *  interchangeable: the account route reads THIS user's own grant, so it is the
 *  one that can find a backup pushed from another machine, while the v2 route
 *  reads the installation's `driveSync.refreshToken` and answers "Google Drive
 *  is not connected yet" on a host that never connected one.
 *
 *  `connected` is null until the capability answers, and the card renders the
 *  button disabled in that window — guessing here would be the same class of
 *  bug this exists to fix, so the unknown case is the caller's to handle.
 *
 *  Exported so the choice is testable: a component that fetches in an effect
 *  and renders six buttons has no seam, and the route it picks is the entire
 *  defect. */
export function driveRestoreRoute(connected: boolean | null): string {
  return connected ? "/api/workspace/google/pull" : "/api/workspace/v2/drive/pull";
}

export function RecoveryCard() {
  const [ready, setReady] = useState(false);
  /** Whether the signed-in account has its own Drive grant, as opposed to the
   *  installation-wide one. Null until the capability answers. */
  const [accountDriveConnected, setAccountDriveConnected] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  const [requests] = useState(createWorkspaceRequestScope);

  useEffect(() => {
    requests.activate();
    void (async () => {
      const request = requests.beginStatus();
      if (!request) return;
      try {
        const cap = await readWorkspaceCapability(request);
        // Keep the whole capability: the Drive button needs to know whether
        // the ACCOUNT is connected, which is a different transport from the
        // installation one. Throwing it away is what made this card always call
        // the wrong route.
        if (cap) request.commit(() => {
          setReady(cap.workspaceBackupAvailable);
          setAccountDriveConnected(cap.accountDrive.connected);
        });
      } catch {
        /* fail closed — no card off an unconfirmed capability */
      } finally {
        request.finish();
      }
    })();
    return () => requests.dispose();
  }, [requests]);

  if (!ready || dismissed()) return null;

  const pull = (label: string, path: string) =>
    void (async () => {
      if (passphrase.length < 8) {
        setNote({ error: true, text: "Enter the backup passphrase (8+ characters) first." });
        return;
      }
      const request = requests.beginOperation();
      if (!request) return;
      setBusy(label);
      setNote(null);
      try {
        const data = await readWorkspaceReply(request, path, JSON.stringify({ passphrase, confirm: true }), v2StageReply);
        if (data) {
          request.commit(() =>
            setNote({
              error: false,
              text: "Backup recovered and staged — quit and reopen Muster to apply it. Your current data is kept as a safety copy.",
            }),
          );
        }
      } catch (e) {
        request.commit(() => setNote({ error: true, text: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(null);
        request.finish();
      }
    })();

  const pickFile = (file: File) =>
    void (async () => {
      if (passphrase.length < 8) {
        setNote({ error: true, text: "Enter the backup passphrase (8+ characters) first." });
        return;
      }
      const request = requests.beginOperation();
      if (!request) return;
      setBusy("Reading the file…");
      setNote(null);
      try {
        const payload = await file.text();
        const data = await readWorkspaceReply(
          request, "/api/workspace/v2/restore", JSON.stringify({ passphrase, payload, confirm: true }), v2StageReply,
        );
        if (data) {
          request.commit(() =>
            setNote({
              error: false,
              text: "Backup recovered and staged — quit and reopen Muster to apply it. Your current data is kept as a safety copy.",
            }),
          );
        }
      } catch (e) {
        request.commit(() => setNote({ error: true, text: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(null);
        request.finish();
      }
    })();

  const button =
    "flex items-center gap-1.5 rounded-lg bg-raised px-2.5 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-40";
  const input =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  return (
    <div className="mx-1 mt-1 rounded-xl border border-accent/30 bg-accent/8 p-3">
      <p className="text-[13px] font-semibold text-ink">Recover your workspace</p>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
        This device is new. If you've backed up from another machine, Muster can pull your last
        portable backup from your own Drive or Telegram right now — it applies when you reopen the app.
      </p>
      <input
        type="password"
        disabled={busy !== null}
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Backup passphrase"
        aria-label="Recovery passphrase"
        autoComplete="off"
        className={cn(input, "mt-2")}
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {/* Two Drive transports exist and they are not interchangeable. The
            account-linked route reads THIS user's own grant, so it is the one
            that can find a backup they pushed from another machine; the v2
            route reads the installation's `driveSync.refreshToken` and answers
            "Google Drive is not connected yet" on a host that never connected
            one. Before this, a user with a perfectly good account grant was
            told Drive was not connected — by a card whose only job is to get
            their backup back. */}
        <button
          type="button"
          disabled={busy !== null || accountDriveConnected === null}
          onClick={() =>
            pull("Pulling from Drive…", driveRestoreRoute(accountDriveConnected))
          }
          className={button}
          title={accountDriveConnected
            ? "Restore from this account's own Google Drive"
            : "Restore from this installation's Google Drive connection"}
        >
          <HardDriveDownload size={12} /> Drive
        </button>
        <button type="button" disabled={busy !== null} onClick={() => pull("Pulling from Telegram…", "/api/workspace/v2/telegram/pull")} className={button}>
          <Upload size={12} /> Telegram
        </button>
        <label className={cn(button, busy !== null ? "opacity-40" : "cursor-pointer")}>
          <Upload size={12} /> File…
          <input
            type="file"
            disabled={busy !== null}
            accept=".musterbackup,.enc,text/plain"
            aria-label="Recover from backup file"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) pickFile(f);
            }}
          />
        </label>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            try {
              localStorage.setItem(DISMISS_KEY, "1");
            } catch {
              /* dismissal is best-effort */
            }
            setReady(false);
          }}
          className={cn(button, "text-ink-secondary")}
        >
          <Settings2 size={12} /> Later
        </button>
      </div>
      {busy && (
        <p className="mt-2 flex items-center gap-2 text-[12px] text-ink-secondary">
          <Loader2 size={12} className="animate-spin" /> {busy}
        </p>
      )}
      {note && (
        <p role={note.error ? "alert" : "status"} className={cn("mt-2 text-[12px] leading-snug", note.error ? "text-danger" : "text-success")}>
          {note.text}
        </p>
      )}
      <p className="mt-2 text-[11px] leading-snug text-ink-secondary/70">
        No backup yet? Set one up any time in Settings → Connections — without it, losing this
        machine loses your team.
      </p>
    </div>
  );
}
