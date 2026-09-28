// One-place setup and lifecycle for the shared, isolated Local VM, plus the
// desktop isolation setting (shared singleton vs one desktop per bot).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Circle,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Wrench,
} from "lucide-react";
import { Card, CommandLine } from "./SettingsPrimitives";
import { RaisedButton } from "./ui/raised-button";
import { cn } from "@/lib/cn";
import {
  LOCAL_VM_STAGE_LABELS, localVmInstallManager, localVmNeedsRecreate, localVmSetupReady,
  requestLocalVmStatus, runLocalVmSetup,
  type LocalVmAction as Action, type LocalVmStatus as Status, type LocalVmSetupStage,
} from "@/lib/local-vm-setup";

type PendingAction = Action | "configure";
// Multiple failed-turn cards can mount the hook at once. Never race their writes.
let localVmActionInFlight = false;

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
          done ? "bg-success/20 text-success" : "border border-hairline/50 text-ink-secondary",
        )}
      >
        {done ? <Check size={12} /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[14px]", done ? "text-ink-secondary line-through" : "text-ink")}>{title}</div>
        {!done && children && <div className="mt-2 flex flex-col items-start gap-2">{children}</div>}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  pending,
  children,
  onClick,
  danger = false,
}: {
  action: Action;
  pending: PendingAction | null;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  // Primary actions are GAIA's raised button — the glossy tactile CTA;
  // destructive stays a flat danger chip.
  if (danger) {
    return (
      <button
        onClick={onClick}
        disabled={pending !== null}
        className="flex items-center gap-1.5 rounded-lg bg-danger/15 px-3 py-1.5 text-[12.5px] font-medium text-danger hover:bg-danger/20 disabled:opacity-50"
      >
        {pending === action && <Loader2 size={13} className="animate-spin" />}
        {children}
      </button>
    );
  }
  return (
    <RaisedButton size="sm" onClick={onClick} disabled={pending !== null} className="text-[12.5px]">
      {pending === action && <Loader2 size={13} className="animate-spin" />}
      {children}
    </RaisedButton>
  );
}

type IsolationMode = NonNullable<Status["mode"]>;
const MAX_DESKTOPS_MIN = 1;
const MAX_DESKTOPS_MAX = 16;

function clampMaxDesktops(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.min(MAX_DESKTOPS_MAX, Math.max(MAX_DESKTOPS_MIN, Math.trunc(value)));
}

/** One lifecycle controller for both setup surfaces. Status polling may recover
 * its own read error, but only an explicit retry clears an action failure. */
export function useLocalVmSetup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [stage, setStage] = useState<LocalVmSetupStage | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const operation = useRef(false);
  const pollController = useRef<AbortController | null>(null);

  const read = useCallback(async (signal?: AbortSignal) => {
    const current = await requestLocalVmStatus(undefined, signal);
    if (!signal?.aborted) {
      setStatus(current);
      setStatusError(null);
    }
    return current;
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        if (!operation.current && !localVmActionInFlight) {
          const controller = new AbortController();
          pollController.current = controller;
          await read(controller.signal);
        }
      } catch (e) {
        if (active && !(e instanceof DOMException && e.name === "AbortError")) {
          setStatus(null);
          setStatusError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      pollController.current?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [read, refreshKey]);

  const runExclusive = useCallback(async (action: PendingAction, work: () => Promise<void>) => {
    // React state updates do not take effect synchronously; the ref closes the
    // same-frame double-click and auto/manual overlap before any network call.
    if (operation.current) return;
    if (localVmActionInFlight) {
      setActionError("Another Local VM setup action is still running. Wait, then re-check.");
      return;
    }
    operation.current = true;
    localVmActionInFlight = true;
    pollController.current?.abort();
    setPending(action);
    setActionError(null);
    try {
      await work();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      operation.current = false;
      localVmActionInFlight = false;
      setPending(null);
      setStage(null);
      setLoading(false);
    }
  }, []);

  const post = useCallback(async (action: Exclude<Action, "recreate">) => {
    const current = await requestLocalVmStatus(action);
    setStatus(current);
  }, []);

  const act = useCallback(async (action: Action) => {
    if (operation.current || localVmActionInFlight) return;
    if (action === "remove" && !window.confirm("Delete the Local VM? Files and browser sign-ins in its durable workspace will remain.")) return;
    if (action === "recreate" && !window.confirm("Replace the existing Local VM with the pinned image and safety limits? Files and browser sign-ins in its durable workspace will remain.")) return;
    await runExclusive(action, async () => {
      if (action === "recreate") {
        await post("remove");
        await post("run");
      } else await post(action);
      await read();
    });
  }, [post, read, runExclusive]);

  const runAutoSetup = useCallback(() => runExclusive("run", async () => {
    await runLocalVmSetup({ read, post, onStage: setStage });
  }), [post, read, runExclusive]);

  const saveIsolation = useCallback((mode: IsolationMode, maxInstances: number) => runExclusive("configure", async () => {
    const response = await fetch("/api/config", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ localVm: { mode, maxInstances } }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Saving failed (${response.status})`);
    await read();
  }), [read, runExclusive]);

  return {
    status, loading, pending, stage, error: actionError ?? statusError, act, runAutoSetup, saveIsolation,
    refresh: () => {
      if (operation.current) return;
      setActionError(null);
      setLoading(true);
      setRefreshKey((key) => key + 1);
    },
  };
}

/** Compact one-click setup embedded wherever a failed turn points at the
 * Local VM: shows the live status and the same auto-setup chain the full
 * Settings section offers, in a card a fraction of the size. */
export function LocalVmQuickSetup() {
  const { status, loading, pending, stage, error, runAutoSetup, refresh } = useLocalVmSetup();
  const ready = status ? localVmSetupReady(status) : false;
  const canAutoSetup = Boolean(status && (status.runtime || status.runtime_install?.installable)) && !ready;
  const perBot = status?.mode === "perBot";
  return (
    <div className="mt-3 w-full rounded-xl border border-hairline/50 bg-panel/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px]",
            ready ? "bg-success/15 text-success" : "bg-raised text-ink-secondary",
          )}
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : ready ? <Check size={12} /> : <Circle size={9} />}
          {loading ? "Checking…" : !status ? "Status unavailable" : ready ? (perBot ? "Ready for per-bot desktops" : "Local VM ready") : (status.problem ?? "Not ready")}
        </span>
        {canAutoSetup && (
          <button
            onClick={() => void runAutoSetup()}
            disabled={pending !== null}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {pending !== null ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={12} />}
            {stage ? LOCAL_VM_STAGE_LABELS[stage] : "Set up automatically"}
          </button>
        )}
      </div>
      {status && !ready && !status.runtime && status.runtime_install?.installable && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          Install Podman with {localVmInstallManager(status)}. First setup downloads the desktop and may take several minutes.
          {status.platform === "win32" && " Windows may ask permission to install Podman; WSL 2 and a restart may be required."}
        </div>
      )}
      {error && <div role="alert" className="mt-2 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">{error}</div>}
      {!loading && (error || !status) && <button onClick={refresh} disabled={pending !== null} className="mt-2 text-[12px] text-accent">Re-check</button>}
      {!canAutoSetup && !loading && status && !ready && !status.runtime && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          Install a container runtime first — App Settings → Local VM has the one-line command.
        </div>
      )}
    </div>
  );
}

/** Radio pair + cap input persisted to /api/config {localVm}. The server
 * refuses a per-bot → shared switch while bots still hold their own desktops,
 * so its error text is surfaced verbatim here. */
function DesktopIsolationCard({ status, busy, save }: {
  status: Status | null;
  busy: boolean;
  save: (mode: IsolationMode, maxInstances: number) => Promise<void>;
}) {
  const [mode, setMode] = useState<IsolationMode>("shared");
  const [maxInstances, setMaxInstances] = useState(4);
  const [hydrated, setHydrated] = useState(false);
  const [editingMax, setEditingMax] = useState(false);
  // Poll refreshes must not stomp in-progress edits.
  useEffect(() => {
    if (!status?.mode || busy || editingMax) return;
    setMode(status.mode);
    setMaxInstances(status.max_instances ?? 4);
    setHydrated(true);
  }, [status?.mode, status?.max_instances, busy, editingMax]);

  const options: Array<{ value: IsolationMode; label: string; detail: string }> = [
    {
      value: "shared",
      label: "Shared",
      detail: "One desktop all bots lease one at a time — cheapest, and everyone sees the same screen.",
    },
    {
      value: "perBot",
      label: "Per-bot",
      detail:
        "Each bot gets its own dedicated desktop — container, workspace, viewer and lease. Desktops are created when a bot starts working and recycled after 8 idle hours.",
    },
  ];

  return (
    <Card
      title="Isolation"
      subtitle="Choose whether bots share one Local VM or each gets their own. Every desktop is capped at 4 GB memory and 2 CPUs."
    >
      <div className="flex flex-col gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors",
              mode === option.value ? "border-accent/50 bg-accent/5" : "border-hairline/40 hover:bg-raised",
            )}
          >
            <input
              type="radio"
              name="desktop-isolation"
              className="mt-0.5 accent-[var(--color-accent)]"
              checked={mode === option.value}
              disabled={busy || !hydrated}
              onChange={() => {
                setMode(option.value);
                void save(option.value, clampMaxDesktops(maxInstances));
              }}
            />
            <span className="min-w-0">
              <span className="block text-[13.5px] text-ink">{option.label}</span>
              <span className="block text-[12px] leading-relaxed text-ink-secondary">{option.detail}</span>
            </span>
          </label>
        ))}
        <div className="flex items-center gap-3 pl-1 pt-1">
          <label htmlFor="max-per-bot-desktops" className={cn("text-[13px]", mode === "perBot" ? "text-ink" : "text-ink-secondary")}>
            Maximum per-bot desktops
          </label>
          <input
            id="max-per-bot-desktops"
            type="number"
            min={MAX_DESKTOPS_MIN}
            max={MAX_DESKTOPS_MAX}
            step={1}
            value={maxInstances}
            disabled={busy || !hydrated}
            onFocus={() => setEditingMax(true)}
            onBlur={() => {
              setEditingMax(false);
              const clamped = clampMaxDesktops(maxInstances);
              setMaxInstances(clamped);
              if (clamped !== (status?.max_instances ?? 4)) void save(mode, clamped);
            }}
            onChange={(e) => setMaxInstances(e.target.valueAsNumber)}
            className="w-20 rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-center text-[13px] text-ink focus:border-hairline focus:outline-none disabled:opacity-50"
          />
          {busy && <Loader2 size={13} className="animate-spin text-ink-secondary" />}
        </div>
      </div>
    </Card>
  );
}

export function LocalComputerSection() {
  const { status, loading, pending, stage, error, act, runAutoSetup, saveIsolation, refresh } = useLocalVmSetup();
  const autoSetupRunning = stage !== null;
  const c = status?.commands;
  const perBot = status?.mode === "perBot";
  const ready = status ? localVmSetupReady(status) : false;
  const existing = Boolean(status && status.container !== "missing");
  const needsRecreate = Boolean(status && !perBot && localVmNeedsRecreate(status));
  const installManager = status ? localVmInstallManager(status) : "Homebrew";
  const unavailable = !loading && !status;
  const host = status?.platform === "darwin" ? "Mac" : "computer";

  return (
    <>
      <DesktopIsolationCard status={status} busy={pending !== null} save={saveIsolation} />
      <Card
        title="Local VM"
        subtitle={perBot
          ? `Cua Linux desktops on this ${host}, created separately for each bot and recycled after 8 hours without activity.`
          : `A shared Cua Linux sandbox on this ${host} for bots to browse and work in — isolated, backed by one durable workspace, and automatically recycled after 8 hours without activity.`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
              ready ? "bg-success/15 text-success" : "bg-raised text-ink-secondary",
            )}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : ready ? <Check size={12} /> : <Circle size={9} />}
            {loading ? "Checking…" : unavailable ? "Status unavailable" : ready ? (perBot ? "Ready for per-bot desktops" : "Ready") : (status?.problem ?? "Not ready")}
          </span>
          <button
            onClick={refresh}
            disabled={loading || pending !== null}
            className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={12} /> Re-check
          </button>
          {ready && !perBot && (
            <a
              href={status?.viewer_url ?? c?.view}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-raised"
            >
              <ExternalLink size={12} /> Watch screen
            </a>
          )}
        </div>
        {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      </Card>

      <Card title="Setup" subtitle="First setup downloads and builds the Cua desktop and may take several minutes. Keep Muster open while it finishes.">
        <div className="flex flex-col gap-4">
          {status?.runtime_install?.installable && !status?.runtime && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-accent/25 bg-accent/5 px-3.5 py-3">
              <div className="text-[13px] text-ink-secondary">
                No runtime installed — Muster can install Podman via {installManager}, then {perBot ? "prepare desktops for each bot" : "prepare the desktop and start the VM"}.
              </div>
              <button
                onClick={() => void runAutoSetup()}
                disabled={autoSetupRunning || pending !== null}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {autoSetupRunning && <Loader2 size={13} className="animate-spin" />}
                {stage ? LOCAL_VM_STAGE_LABELS[stage] : "Set up automatically"}
              </button>
            </div>
          )}
          {status?.runtime && !ready && !needsRecreate && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-accent/25 bg-accent/5 px-3.5 py-3">
              <div className="text-[13px] text-ink-secondary">
                Runtime installed — start it and prepare {perBot ? "desktops for each bot" : "the Local VM"} in one step.
              </div>
              <button
                onClick={() => void runAutoSetup()}
                disabled={autoSetupRunning || pending !== null}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {autoSetupRunning && <Loader2 size={13} className="animate-spin" />}
                {stage ? LOCAL_VM_STAGE_LABELS[stage] : "Set up automatically"}
              </button>
            </div>
          )}
          <Step n={1} title="Install a container runtime" done={Boolean(status?.runtime)}>
            <div className="text-[13px] leading-relaxed text-ink-secondary">
              Podman and Colima are free. Docker Desktop may require a paid licence for larger companies and government use.
              {status?.platform === "win32" && " Windows may ask permission to install Podman; WSL 2 and a restart may be required."}
            </div>
            {status?.runtime_install?.installable && !status?.runtime && (
              <div className="flex items-center gap-2">
                <ActionButton action="runtimeInstall" pending={pending} onClick={() => void act("runtimeInstall")}>
                  Install Podman with {installManager}
                </ActionButton>
              </div>
            )}
            {!status?.runtime && status?.runtime_install?.reason && !status.runtime_install.installable && (
              <div className="text-[12.5px] text-ink-secondary">{status.runtime_install.reason}</div>
            )}
            {c?.install ? (
              <CommandLine command={c.install} />
            ) : (
              <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
                Open the Podman installation guide
              </a>
            )}
          </Step>

          <Step
            n={2}
            title={status?.runtime && !status.daemonUp ? `Open and start ${status.runtime}` : "Start the container runtime"}
            done={Boolean(status?.daemonUp)}
          >
            {!status?.runtime ? null : (
              <>
                {
                  // Every case except docker-on-linux is a plain user-level
                  // command (launch a GUI app, start a VM manager) — Muster
                  // can just run it. docker-on-linux needs sudo, a password
                  // prompt Muster has no way to satisfy programmatically, so
                  // that one case still shows the command to run by hand.
                  !(status?.runtime === "docker" && status?.platform === "linux") ? (
                    <ActionButton action="runtimeStart" pending={pending} onClick={() => void act("runtimeStart")}>
                      Start {status?.runtime}
                    </ActionButton>
                  ) : c?.runtimeStart ? (
                    <CommandLine command={c.runtimeStart} />
                  ) : (
                    <div className="text-[13px] text-ink-secondary">Open the installed runtime and start its engine, then re-check.</div>
                  )
                }
                {c?.runtimeStart && !(status?.runtime === "docker" && status?.platform === "linux") && (
                  <details className="text-[12px] text-ink-secondary">
                    <summary className="cursor-pointer">Show command</summary>
                    <div className="mt-2"><CommandLine command={c.runtimeStart} /></div>
                  </details>
                )}
              </>
            )}
          </Step>

          <Step n={3} title="Prepare the Cua desktop (one-time download and build)" done={Boolean(status?.image)}>
            {status?.daemonUp && (
              <ActionButton action="pull" pending={pending} onClick={() => void act("pull")}>Prepare Cua desktop</ActionButton>
            )}
            {c?.pull && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show base-image download</summary><div className="mt-2"><CommandLine command={c.pull} /></div></details>}
          </Step>

          {perBot ? (
            <div className="text-[13px] text-ink-secondary">Each bot’s desktop is created automatically when its first turn needs it.</div>
          ) : <Step n={4} title={needsRecreate ? "Replace the older or unsafe VM" : "Create and start the Local VM"} done={ready}>
            {needsRecreate ? (
              <>
                <div className="flex gap-2 text-[13px] text-warning">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>{status?.problem}</span>
                </div>
                {status?.image ? (
                  <ActionButton action="recreate" pending={pending} onClick={() => void act("recreate")} danger>
                    <RotateCcw size={13} /> Delete and recreate
                  </ActionButton>
                ) : (
                  <div className="text-[13px] text-ink-secondary">Prepare the pinned Cua desktop above before replacing this VM.</div>
                )}
              </>
            ) : status?.container === "stopped" ? (
              <ActionButton action="start" pending={pending} onClick={() => void act("start")}>Start Local VM</ActionButton>
            ) : status?.container === "running" ? (
              <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> Waiting for the desktop…</div>
            ) : status?.image ? (
              <ActionButton action="run" pending={pending} onClick={() => void act("run")}>Create Local VM</ActionButton>
            ) : null}
            {c?.run && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show command</summary><div className="mt-2"><CommandLine command={c.run} /></div></details>}
          </Step>}
        </div>
      </Card>

      {unavailable && (
        <Card>
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>Muster could not inspect the container runtime. Re-check, or review the app logs.</span>
          </div>
        </Card>
      )}

      <Card
        title="Safety and storage"
        subtitle={`Cua Driver operates only the VM's desktop. Exactly one private host folder is mounted at ${status?.workspace_guest_path ?? "/home/cua/workspace"}; files and browser profiles there survive VM replacement, while everything elsewhere in the VM remains disposable. The password-protected viewer is available only on this machine. Docker and Podman runs are limited to 4 GB memory, 2 CPUs and 512 processes; all Linux capabilities are dropped except the two the desktop supervisor needs to switch to its unprivileged user. The VM can still reach the internet. ${perBot ? "Each bot uses its own desktop." : "Bots share it one at a time."}`}
      >
        {existing && !perBot && (
          <div className="flex flex-wrap gap-2">
            {status?.container === "running" && (
              <ActionButton action="stop" pending={pending} onClick={() => void act("stop")}>
                <Square size={12} /> Stop
              </ActionButton>
            )}
            <ActionButton action="remove" pending={pending} onClick={() => void act("remove")} danger>
              <Trash2 size={12} /> Delete VM
            </ActionButton>
          </div>
        )}
        <div className="mt-3 break-all text-[11px] text-ink-secondary">
          {status?.platform === "darwin" && status.runtime === "podman" && <>A new Podman machine uses 6 GB memory and 2 CPUs. · </>}
          Durable workspace: {status?.workspace_path ?? "not created"} ·{" "}
          Cua Driver: {status?.driver_version ?? "0.20.0"} · Local image: {status?.image_ref ?? "not prepared"}
          {status?.base_image_ref ? <> · Base: {status.base_image_ref}</> : null}
        </div>
      </Card>
    </>
  );
}
