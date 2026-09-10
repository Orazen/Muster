// App settings → Usage → Provider health: the per-subscription dashboard.
// Orca's killer feature, adapted: "which of my providers is getting hot,
// what has each one spent" — computed entirely from local data (task
// usage + recorded rate-limit hits), never by scraping provider APIs.
import { useEffect, useState } from "react";
import { Card } from "./SettingsPrimitives";
import { formatTokens, formatUsd } from "@/lib/usage";

interface ProviderRow {
  provider: string;
  instances: Array<{ instanceId: string; state: string; bots: string[] }>;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  rateLimitHits24h: number;
  lastHitAt: number | null;
}

/** Health label from local signals only. Subscription providers can't be
 * queried for a real remaining quota, so "hot" means: rate-limited in the
 * last 24h. */
interface HealthVerdict {
  label: string;
  tone: "ok" | "hot" | "idle";
}

function health(row: ProviderRow): HealthVerdict {
  if (row.rateLimitHits24h > 0) return { label: "rate-limited recently", tone: "hot" };
  if (row.turns === 0) return { label: "no traffic yet", tone: "idle" };
  return { label: "healthy", tone: "ok" };
}

const TONE_CLASS = {
  ok: "text-emerald-400",
  hot: "text-amber-400",
  idle: "text-ink-secondary",
} satisfies Record<HealthVerdict["tone"], string>;

function sinceCaption(at: number | null): string {
  if (at === null) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface DoctorEngine {
  instanceId: string;
  engine: string;
  ok: boolean;
  checks: DoctorCheck[];
  repair: string | null;
}

/** One row of the repair route's {actions: [{action, ok, detail}]} reply. */
interface RepairOutcome {
  action: string;
  ok: boolean;
  detail: string;
}

/** TinyFish's doctor pattern, applied to engines: a versioned report that
 * separates "binary reachable" from "models loaded" and names an ordered
 * repair per unhealthy engine. The executor half runs only the auto-safe
 * action (re-registering instances from the vault) via the repair route. */
export function ProviderHealthSection() {
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [error, setError] = useState("");
  const [doctor, setDoctor] = useState<DoctorEngine[] | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairOutcomes, setRepairOutcomes] = useState<RepairOutcome[] | null>(null);

  async function refreshDoctor(): Promise<DoctorEngine[]> {
    const r = await fetch("/api/engines/doctor");
    // SAFETY: the route's documented shape is {schemaVersion, engines};
    // anything else resolves to an empty report below.
    const body = (await r.json()) as { engines?: DoctorEngine[] };
    const engines = body.engines ?? [];
    setDoctor(engines);
    return engines;
  }

  async function runDoctor(): Promise<void> {
    setDoctorBusy(true);
    try {
      await refreshDoctor();
    } catch {
      setDoctor([]);
    } finally {
      setDoctorBusy(false);
    }
  }

  async function autoRepair(): Promise<void> {
    setRepairBusy(true);
    setRepairOutcomes(null);
    try {
      const r = await fetch("/api/engines/doctor/repair", { method: "POST" });
      // SAFETY: the route's documented shape is {actions: RepairOutcome[]};
      // anything else resolves to an empty list below.
      const body = (await r.json()) as { actions?: RepairOutcome[] };
      setRepairOutcomes(body.actions ?? []);
    } catch {
      setRepairOutcomes([{ action: "reload-instances", ok: false, detail: "could not reach the server" }]);
    } finally {
      setRepairBusy(false);
      // The point of the repair is a better doctor report — show it.
      await runDoctor();
    }
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch("/api/usage/providers");
        if (!r.ok) {
          if (alive) setError("unavailable");
          return;
        }
        // SAFETY: the route's documented shape is {providers: ProviderRow[]};
        // anything else resolves to an empty list below.
        const body = (await r.json()) as { providers?: ProviderRow[] };
        if (alive) setRows(body.providers ?? []);
      } catch {
        if (alive) setError("could not reach the server");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Card
      title="Provider health"
      subtitle="Spend and rate-limit pressure per provider family, from your own turn history. Subscription engines report an equivalent, not a charge."
    >
      {error ? (
        <div className="text-[13px] text-ink-secondary">{error}</div>
      ) : !rows ? (
        <div className="text-[13px] text-ink-secondary">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">
          No providers yet — figures appear once a bot runs on an engine.
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="hidden grid-cols-[1fr_auto_auto_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary sm:grid">
            <span>Provider</span>
            <span className="text-right">Turns</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">Cost</span>
            <span className="text-right">Health</span>
          </div>
          {rows.map((row) => {
            const h = health(row);
            return (
              <div
                key={row.provider}
                className="grid grid-cols-3 items-start gap-3 border-b border-hairline/20 py-3 text-[13px] sm:grid-cols-[1fr_auto_auto_auto_auto] sm:items-center sm:gap-x-5 sm:py-2"
              >
                <span className="col-span-3 min-w-0 sm:col-span-1">
                  <span className="font-medium capitalize text-ink">{row.provider}</span>
                  <span className="block truncate text-[11.5px] text-ink-secondary">
                    {row.instances.length} instance{row.instances.length > 1 ? "s" : ""} ·{" "}
                    {row.instances.flatMap((i) => i.bots).slice(0, 3).join(", ")}
                    {row.instances.flatMap((i) => i.bots).length > 3 ? "…" : ""}
                  </span>
                </span>
                <span className="tabular-nums text-ink-secondary sm:text-right">
                  <span className="mb-1 block text-[11px] text-ink-secondary sm:hidden">Turns</span>
                  {row.turns}
                </span>
                <span className="tabular-nums text-ink sm:text-right">
                  <span className="mb-1 block text-[11px] text-ink-secondary sm:hidden">Tokens</span>
                  {formatTokens(row.tokensIn + row.tokensOut)}
                </span>
                <span className="tabular-nums text-ink sm:text-right">
                  <span className="mb-1 block text-[11px] text-ink-secondary sm:hidden">Cost</span>
                  {row.costUsd === null ? <span className="text-ink-secondary">—</span> : formatUsd(row.costUsd)}
                </span>
                <span className={`col-span-3 text-[12px] font-medium sm:col-span-1 sm:text-right ${TONE_CLASS[h.tone]}`}>
                  <span className="mr-2 text-ink-secondary sm:hidden">Health</span>
                  {h.label}
                  {h.tone === "hot" && row.lastHitAt !== null && (
                    <span className="block text-[11px] font-normal text-ink-secondary">{sinceCaption(row.lastHitAt)}</span>
                  )}
                </span>
              </div>
            );
          })}
          <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
            "Rate-limited recently" means a turn hit the provider's cap in the last 24h — Muster automatically re-pointed
            those bots at another provider where one was available.
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void runDoctor()}
              disabled={doctorBusy}
              className="rounded-lg border border-hairline/60 px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-40"
            >
              {doctorBusy ? "Checking…" : "Run doctor"}
            </button>
            <button
              type="button"
              onClick={() => void autoRepair()}
              disabled={repairBusy}
              className="rounded-lg border border-hairline/60 px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-40"
            >
              {repairBusy ? "Repairing…" : "Auto-repair"}
            </button>
          </div>
          {repairOutcomes && repairOutcomes.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {repairOutcomes.map((outcome) => (
                <div key={outcome.action} className="text-[12px] leading-relaxed">
                  <span className={outcome.ok ? "text-emerald-400" : "text-amber-400"}>
                    {outcome.ok ? "✓" : "!"}
                  </span>{" "}
                  <span className="font-medium capitalize text-ink">{outcome.action}</span>
                  <span className="text-ink-secondary"> — {outcome.detail}</span>
                </div>
              ))}
            </div>
          )}
            {doctor && (
              <div className="mt-2 space-y-1.5">
                {doctor.map((engine) => (
                  <div key={engine.instanceId} className="text-[12px] leading-relaxed">
                    <span className={engine.ok ? "text-emerald-400" : "text-amber-400"}>
                      {engine.ok ? "✓" : "!"}
                    </span>{" "}
                    <span className="font-medium capitalize text-ink">{engine.engine}</span>
                    {engine.checks
                      .filter((c) => !c.ok)
                      .map((c) => (
                        <span key={c.name} className="text-ink-secondary">
                          {" "}
                          — {c.name}: {c.detail}
                        </span>
                      ))}
                    {engine.repair && <div className="pl-4 text-ink-secondary">Repair: {engine.repair}</div>}
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
    </Card>
  );
}
