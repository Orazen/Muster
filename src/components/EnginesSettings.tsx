// Engines and accounts — connect the AI tools that power your bots. One row
// per engine: its mark, what account it runs as, whether it is Ready or Needs
// setup, and its version. The Ready / Needs setup split is the same split the
// model picker's rail uses (access === "custom" is Local), so the two surfaces
// never disagree about which group an engine is in.
//
// The per-engine CLI override from before is still here: expanding a row
// reveals the detected-binary dropdown and a manual path input. It is folded
// behind the row rather than shown inline because the common case is "is this
// engine ready", not "which binary does it run".
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, TriangleAlert } from "lucide-react";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { EngineSetup, needsSignIn } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";
import { cn } from "@/lib/cn";

interface ProbeResult {
  ok: boolean;
  version?: string;
  message?: string;
}

/** Ready means the driver reported an available snapshot. Everything else —
 * unavailable, or never probed — reads as Needs setup, which is the only
 * other state the panel can act on. */
function isReady(instance: InstanceInfo): boolean {
  return instance.snapshot.state === "available";
}

/** What the row's primary action is. An installed-but-unsigned-in engine is
 * one sign-in from Ready, so its action is adding the account — a different
 * job from pointing the row at a different binary. */
export function rowAction(instance: InstanceInfo): "add-account" | "configure" | "set-up" {
  if (needsSignIn(instance)) return "add-account";
  return isReady(instance) ? "configure" : "set-up";
}

/** The subtitle under an engine's name: the account it runs as when the
 * engine reports one, otherwise the driver's default binary or a plain
 * description of how it is configured. */
function accountLine(instance: InstanceInfo): string {
  const reason = instance.snapshot.reason;
  if (!isReady(instance) && reason) return reason;
  if (instance.snapshot.authenticated === false) return "Needs sign-in";
  if (instance.cli) return instance.cli;
  if (instance.cliDefault) return instance.cliDefault;
  return instance.access === "custom" ? "Bring your own model" : "Managed account";
}

function CustomPicker({ instance, cliDefault, onClose, onSaved }: {
  instance: InstanceInfo;
  cliDefault?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<string[] | null>(instance.cliCandidates ?? null);
  // `selected` starts EMPTY, never at instance.cli: a wrapper override
  // ("/ag claude agp") has no matching <option>, and a select whose value
  // points at a missing option renders the placeholder while still holding
  // the ghost value — the form would look empty yet refuse to save.
  const [selected, setSelected] = useState<string>("");
  const [manual, setManual] = useState<string>(
    instance.cli && !(instance.cliCandidates ?? []).includes(instance.cli) ? instance.cli : "",
  );
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    api(`/api/cli-candidates?name=${encodeURIComponent(cliDefault ?? "")}`)
      .then(({ candidates: found }: { candidates: string[] }) => {
        setCandidates(found);
        if (!instance.cli) return;
        if (found.includes(instance.cli)) setSelected(instance.cli);
        else setManual(instance.cli);
      })
      .catch(() => setCandidates((prev) => prev ?? []));
  }, [cliDefault, instance.cli]);

  const value = manual.trim() || selected;
  const dirty = value !== (instance.cli ?? "");
  const busy = probing || saving;

  useEffect(() => {
    setProbe(null);
  }, [value]);

  const persist = () => {
    if (busy || !value || !dirty) return;
    setSaving(true);
    setError(null);
    const committed = value;
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cli: committed }),
    })
      .then(() => Promise.resolve(onSaved()).catch(() => {}))
      .then(onClose)
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const save = () => {
    if (busy || !value || !dirty) return;
    setProbing(true);
    setError(null);
    api("/api/cli-test", {
      method: "POST",
      body: JSON.stringify({ cli: value, driver: instance.driverKind }),
    })
      .then((result: ProbeResult) => {
        setProbe(result);
        if (result.ok) persist();
      })
      .catch((e) => setError(e.message))
      .finally(() => setProbing(false));
  };

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {candidates !== null && candidates.length > 0 && (
        <div className="relative">
          <select
            value={manual.trim() ? "" : selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setManual("");
            }}
            aria-label={`${instance.displayName} detected CLI`}
            disabled={busy}
            className="w-full appearance-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 pr-8 font-mono text-[12px] text-ink focus:border-hairline focus:outline-none disabled:opacity-50"
          >
            <option value="">Select a detected binary…</option>
            {candidates.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
        </div>
      )}
      <input
        type="text"
        value={manual}
        onChange={(e) => setManual(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (!value || !dirty) return;
          save();
        }}
        placeholder={candidates?.length ? "Enter path manually…" : "/absolute/path/to/cli"}
        aria-label={`${instance.displayName} custom CLI path`}
        spellCheck={false}
        disabled={busy}
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50"
      />
      {probe && !probe.ok && probe.message && (
        <div role="alert" className="flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-warning">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>
            Test failed — {probe.message}
            {" "}Register this path anyway?
          </span>
        </div>
      )}
      {probe?.ok && probe.version && (
        <div className="text-[12px] text-success">Test passed — {probe.version}</div>
      )}
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        {probe && !probe.ok ? (
          <>
            <button
              onClick={() => setProbe(null)}
              disabled={busy}
              className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
            >
              Edit path
            </button>
            <button
              onClick={() => persist()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-danger hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : "Save anyway"}
            </button>
          </>
        ) : (
          <button
            onClick={save}
            disabled={busy || !value || !dirty}
            className={cn(
              "flex w-[72px] items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px]",
              "bg-raised text-ink hover:bg-raised-hover",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
          </button>
        )}
      </div>
    </div>
  );
}

function EngineRow({ instance }: { instance: InstanceInfo }) {
  const { refreshInstances } = useStore();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpenFor = useRef<string | null>(null);
  const ready = isReady(instance);

  useEffect(() => {
    if (wasOpenFor.current !== null && wasOpenFor.current !== instance.cli) {
      setOpen(false);
    }
    wasOpenFor.current = instance.cli ?? null;
  }, [instance.cli]);

  const reset = () => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cli: "" }),
    })
      .then(() => Promise.resolve(refreshInstances()).catch(() => {}))
      .catch((e) => setError(e.message))
      .finally(() => setSwitching(false));
  };

  return (
    <div className="border-b border-hairline/25 py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset">
          <ProviderMark driverKind={instance.driverKind} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] text-ink">{instance.displayName}</div>
          <div className="mt-0.5 truncate text-[12px] text-ink-secondary" title={accountLine(instance)}>
            {accountLine(instance)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className={cn("text-[12px]", ready ? "text-success" : "text-warning")}>
            {ready ? "Ready" : "Needs setup"}
          </span>
          {instance.snapshot.version && (
            <span className="font-mono text-[11.5px] text-ink-secondary">{instance.snapshot.version}</span>
          )}
      {rowAction(instance) === "set-up" && (
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="rounded-lg bg-raised px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover"
        >
          Set up
        </button>
      )}
      {rowAction(instance) !== "set-up" && (
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "rounded-lg px-2.5 py-1 text-[12px]",
            rowAction(instance) === "add-account" ? "bg-accent text-ink hover:brightness-110" : "bg-raised text-ink hover:bg-raised-hover",
          )}
        >
          {rowAction(instance) === "add-account" ? "Add account" : "Configure"}
        </button>
      )}
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${instance.displayName} options`}
            className="rounded p-1 text-ink-secondary hover:bg-raised/50 hover:text-ink"
          >
            <ChevronDown size={13} className={cn("transition-transform", open && "rotate-180")} />
          </button>
        </div>
      </div>
      {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
      {open && (
        <div className="mt-1 pl-10">
          {/* Account first: an engine that is installed but not signed in is
              one sign-in away from Ready, and that is a different job from
              pointing the row at a different binary. The embedded card is the
              same EngineSetup the model picker uses, so the two surfaces can
              never disagree about how to add the account. */}
          {needsSignIn(instance) && (
            <div className="mb-2">
              <EngineSetup instance={instance} />
            </div>
          )}
          {instance.cli && (
            <div className="mb-1.5 flex items-center gap-2 text-[12px] text-ink-secondary">
              <span className="truncate font-mono text-accent" title={instance.cli}>{instance.cli}</span>
              <button
                onClick={reset}
                disabled={switching}
                className="shrink-0 text-[11.5px] text-ink-secondary hover:text-ink disabled:opacity-50"
              >
                {switching ? "Resetting…" : "Reset"}
              </button>
            </div>
          )}
          <CustomPicker
            instance={instance}
            cliDefault={instance.cliDefault}
            onClose={() => setOpen(false)}
            onSaved={refreshInstances}
          />
        </div>
      )}
    </div>
  );
}

function EngineGroup({ label, rows }: { label: string; rows: InstanceInfo[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-1">
      <EngineGroupLabel>{label} · {rows.length} engine{rows.length === 1 ? "" : "s"}</EngineGroupLabel>
      <div className="mt-1.5">
        {rows.map((i) => (
          <EngineRow key={i.instanceId} instance={i} />
        ))}
      </div>
    </div>
  );
}

export function EnginesSettings() {
  const { state, refreshInstances } = useStore();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every KNOWN-driver instance has cliDefault; unknown-driver shadows have
  // neither unless an override was set. Including them keeps a Reset-able row
  // (and a Set CLI… path) for engines the running build doesn't recognize.
  const rows = state.instances.filter(
    (i) => i.cli !== undefined || i.cliDefault !== undefined || i.snapshot.state !== "available",
  );
  // Ready first — an engine that works is the answer to "what can I use",
  // and the ones that need setup are the call to action underneath it.
  const ready = rows.filter(isReady);
  const needsSetup = rows.filter((i) => !isReady(i));

  const checkAgain = () => {
    if (checking) return;
    setChecking(true);
    setError(null);
    Promise.resolve(refreshInstances())
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setChecking(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-[13px] leading-relaxed text-ink-secondary">
          Connect the AI tools that power your bots. Accounts, setup, and updates—all in one place.
        </div>
        <button
          onClick={checkAgain}
          disabled={checking}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-50"
        >
          {checking && <Loader2 size={13} className="animate-spin" />}
          Check again
        </button>
      </div>
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}

      {rows.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">No engines detected yet.</div>
      ) : (
        <>
          <EngineGroup label="Ready" rows={ready} />
          <EngineGroup label="Needs setup" rows={needsSetup} />
        </>
      )}

      <div className="text-[12px] leading-relaxed text-ink-secondary">
        Expand an engine to point it at a specific binary — a versioned build, a wrapper script, or an
        absolute path. Saving reloads providers and interrupts any running turns.
      </div>
    </div>
  );
}