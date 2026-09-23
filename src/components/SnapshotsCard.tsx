// Automatic snapshots (B1, DESIGN §11): a verified snapshot nightly when a
// Drive connection + trusted passphrase store exist — "the passphrase-store
// decision is the gate, flagged" — plus a manual run and the retention
// ladder shown verbatim (7 recent / 7 daily / 4 weekly / 6 monthly by
// default) with the invariant stated where the operator reads it: the last
// known-healthy recovery point is never deleted.
//
// The wire reports passphrase EXISTENCE only — this card never sees a
// stored value. Exported helpers (reply schema, gate sentences, retention
// formatting) are pure so the node-side test can pin them without a DOM.
import { Camera, KeyRound, Loader2, Moon, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { cn } from "@/lib/cn";
import {
  createWorkspaceRequestScope,
  readWorkspaceCapability,
  readWorkspaceReply,
  workspaceResponse,
  type WorkspaceRequest,
} from "@/lib/workspace-capability";

const retentionCountsReply = z.object({
  recent: z.number().int().min(0),
  daily: z.number().int().min(0),
  weekly: z.number().int().min(0),
  monthly: z.number().int().min(0),
}).strict();

const policyReply = z.object({
  nightlyEnabled: z.boolean(),
  retention: retentionCountsReply,
}).strict();

const storeReply = z.object({
  status: z.enum(["available", "unavailable"]),
  hasPassphrase: z.boolean(),
}).strict();

const healthReply = z.object({
  snapshotId: z.string().min(1),
  name: z.string().min(1),
  verifiedAt: z.number(),
}).strict().nullable();

const outcome = z.enum(["success", "failed", "skipped"]);

/** The policy view the server's snapshot routes answer. Policy and store
 * are strict (this card's contract); runs and history pass through so a
 * server-side bookkeeping addition never breaks the card. */
export const snapshotsPolicyReply = z.object({
  policy: policyReply,
  store: storeReply,
  driveConnected: z.boolean(),
  health: healthReply,
  runs: z.object({
    lastAttemptAt: z.number().nullable(),
    lastAttemptReason: z.string().nullable(),
    lastSuccessAt: z.number().nullable(),
    lastError: z.string().nullable(),
    lastOutcome: outcome.nullable(),
    lastDetail: z.string().nullable(),
    consecutiveFailures: z.number().int(),
  }).passthrough(),
  history: z.array(z.object({
    at: z.number(),
    reason: z.string(),
    outcome,
    detail: z.string(),
  }).passthrough()),
  nextNightlyAt: z.number(),
});

export type SnapshotsPolicyView = z.infer<typeof snapshotsPolicyReply>;

const storedReply = z.object({ stored: z.literal(true) });
const runReply = z.object({
  ok: z.literal(true),
  snapshotId: z.string().min(1),
  name: z.string().min(1),
  pruned: z.number().int(),
  pruneFailed: z.number().int(),
}).passthrough();

/** Retention exactly as configured — DESIGN names the buckets, not counts,
 * so the card always shows the operator the counts actually in effect. */
export function formatRetentionCounts(counts: { recent: number; daily: number; weekly: number; monthly: number }): string {
  return `${counts.recent} recent · ${counts.daily} daily · ${counts.weekly} weekly · ${counts.monthly} monthly`;
}

/** The §11 gate in the runner's own order — Drive, then store availability,
 * then an actual stored passphrase. Toggling nightly OFF is a choice, not a
 * missing gate requirement, so it never appears here. */
export function snapshotsGateMissing(view: SnapshotsPolicyView): string | null {
  if (!view.driveConnected) return "Connect Google Drive — automatic snapshots need a Drive connection to write to.";
  if (view.store.status !== "available") return "No trusted passphrase store exists on this computer — automatic snapshots stay off until one does.";
  if (!view.store.hasPassphrase) return "Store a snapshot passphrase below — the passphrase-store decision is the gate on automatic snapshots.";
  return null;
}

type Step =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

function when(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function SnapshotsCard() {
  const [view, setView] = useState<SnapshotsPolicyView | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [ready, setReady] = useState(false);
  const busyRef = useRef(false);
  const [requests] = useState(createWorkspaceRequestScope);
  const busy = step.kind === "busy";

  const refreshPolicy = useCallback(async () => {
    const request = requests.beginStatus();
    if (!request) return;
    try {
      const value = await readWorkspaceReply(request, "/api/workspace/snapshots/policy", undefined, snapshotsPolicyReply);
      if (value) request.commit(() => setView(value));
    } catch {
      /* the policy view is advisory — action buttons carry the real errors */
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
        if (cap) request.commit(() => setReady(cap.workspaceBackupAvailable));
        // Hosted: the wall 403s the policy route — never probe deeper than
        // the status route (same containment as PortableBackupCard).
        if (cap?.workspaceBackupAvailable) void refreshPolicy();
      } catch {
        /* fail closed: no card actions until capability is confirmed */
      } finally {
        request.finish();
      }
    })();
    return () => {
      requests.dispose();
    };
  }, [requests, refreshPolicy]);

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
      void refreshPolicy();
    }
  };

  const toggleNightly = (enabled: boolean) =>
    run(enabled ? "Enabling nightly snapshots…" : "Pausing nightly snapshots…", async (request) => {
      const value = await readWorkspaceReply(
        request, "/api/workspace/snapshots/policy", JSON.stringify({ nightlyEnabled: enabled }), snapshotsPolicyReply,
      );
      if (!value) return null;
      request.commit(() => setView(value));
      return enabled ? "Nightly snapshots on." : "Nightly snapshots paused.";
    });

  const snapshotNow = () =>
    run("Taking a snapshot now…", async (request) => {
      // a closed gate answers 409 and a failed ship 502 — both arrive here
      // as the server's honest error text on the step line
      const data = await readWorkspaceReply(request, "/api/workspace/snapshots/run", "{}", runReply);
      if (!data) return null;
      const prune = data.pruned > 0 ? ` Retention pruned ${data.pruned} older file(s).` : "";
      return `Snapshot uploaded and verified on round trip.${prune}`;
    });

  const storePassphrase = () =>
    run("Storing the passphrase…", async (request) => {
      if (passphrase.length < 8) throw new Error("Passphrase must be at least 8 characters");
      const data = await readWorkspaceReply(
        request, "/api/workspace/snapshots/passphrase", JSON.stringify({ passphrase }), storedReply,
      );
      if (!data) return null;
      request.commit(() => setPassphrase(""));
      return "Passphrase stored — with Drive connected, the automatic-snapshot gate is met.";
    });

  const clearPassphrase = () =>
    run("Clearing the stored passphrase…", async (request) => {
      const response = await workspaceResponse(request, "/api/workspace/snapshots/passphrase", undefined, undefined, "DELETE");
      if (!response) return null;
      return "Stored passphrase cleared.";
    });

  const button =
    "flex items-center gap-1.5 rounded-lg bg-raised px-2.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40";
  const accent = cn(button, "text-accent font-medium");
  const input =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  if (!ready || view === null) return null;
  const gate = snapshotsGateMissing(view);

  return (
    <section aria-label="Automatic snapshots" className="rounded-xl border border-hairline/40 bg-card p-3">
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
        <Moon size={14} className="text-accent" /> Automatic snapshots
      </div>
      <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
        A verified snapshot every night at 02:00 local time when Google Drive is connected and a passphrase is
        stored — each one round-trips (upload → download → verify) before it counts. Retention keeps{" "}
        {formatRetentionCounts(view.policy.retention)} and never deletes the last known-healthy recovery point.
        Restores still go through the portable-backup flow below.
      </div>

      {gate !== null && (
        <div className="mt-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-[12px] leading-relaxed text-ink" role="status">
          <span className="font-medium">Flagged gate:</span> {gate}
        </div>
      )}

      <label className="mt-2.5 flex items-center gap-2 text-[12.5px] text-ink">
        <input
          type="checkbox"
          checked={view.policy.nightlyEnabled}
          disabled={busy}
          onChange={(e) => void toggleNightly(e.target.checked)}
        />
        Nightly snapshots ({when(view.nextNightlyAt)} is the next window)
      </label>

      <div className="mt-1.5 text-[12px] text-ink-secondary">
        {view.health !== null
          ? `Last verified recovery point: ${when(view.health.verifiedAt)} — ${view.health.name}`
          : "No verified snapshot yet."}
      </div>
      {view.runs.lastDetail !== null && view.runs.lastDetail !== "" && (
        <div className="text-[12px] text-ink-secondary">Last attempt: {view.runs.lastDetail}</div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void snapshotNow()} className={accent}>
          <Camera size={13} /> Snapshot now
        </button>
        <button type="button" disabled={busy} onClick={() => void refreshPolicy()} className={button}>
          <RefreshCw size={13} /> Refresh
        </button>
        {view.store.hasPassphrase && (
          <button type="button" disabled={busy} onClick={() => void clearPassphrase()} className={button}>
            <KeyRound size={13} /> Clear stored passphrase
          </button>
        )}
      </div>

      <input
        disabled={busy}
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Snapshot passphrase (8+ characters)"
        aria-label="Snapshot passphrase"
        autoComplete="off"
        className={cn(input, "mt-2.5")}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void storePassphrase()} className={button}>
          <KeyRound size={13} /> {view.store.hasPassphrase ? "Replace stored passphrase" : "Store passphrase"}
        </button>
        <span className="text-[12px] text-ink-secondary">
          {view.store.hasPassphrase
            ? "Stored in this computer's passphrase store — this card only ever sees a yes/no."
            : "Nothing is stored yet — Muster never displays a stored passphrase."}
        </span>
      </div>

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
