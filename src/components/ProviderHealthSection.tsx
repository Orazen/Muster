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

export function ProviderHealthSection() {
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [error, setError] = useState("");

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
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
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
                className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-5 border-b border-hairline/20 py-2 text-[13px]"
              >
                <span className="min-w-0">
                  <span className="font-medium capitalize text-ink">{row.provider}</span>
                  <span className="block truncate text-[11.5px] text-ink-secondary">
                    {row.instances.length} instance{row.instances.length > 1 ? "s" : ""} ·{" "}
                    {row.instances.flatMap((i) => i.bots).slice(0, 3).join(", ")}
                    {row.instances.flatMap((i) => i.bots).length > 3 ? "…" : ""}
                  </span>
                </span>
                <span className="text-right tabular-nums text-ink-secondary">{row.turns}</span>
                <span className="text-right tabular-nums text-ink">{formatTokens(row.tokensIn + row.tokensOut)}</span>
                <span className="text-right tabular-nums text-ink">
                  {row.costUsd === null ? <span className="text-ink-secondary">—</span> : formatUsd(row.costUsd)}
                </span>
                <span className={`text-right text-[12px] font-medium ${TONE_CLASS[h.tone]}`}>
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
        </div>
      )}
    </Card>
  );
}
