import type { TaskUsage } from "@/state/store";
import { formatTokens, formatUsd } from "@/lib/usage";
import { StatRow } from "@/components/ui/stat-row";

export function TaskUsageStats({ usage }: { usage?: TaskUsage }) {
  if (!usage) {
    return (
      <section aria-label="Task usage" className="min-w-0">
        <p className="text-sm leading-relaxed text-ink-secondary">
          Usage has not been recorded for this task yet.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Task usage" className="min-w-0 space-y-3">
      <p className="text-xs leading-relaxed text-ink-secondary">
        Totals across this task’s settled turns.
      </p>
      <div className="grid min-w-0 grid-cols-2 gap-3">
        <StatRow title="Settled turns" value={usage.turns} />
        <StatRow title="Total tokens" value={formatTokens(usage.input + usage.output)} />
      </div>
      <p className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm leading-relaxed">
        <span className="text-ink-secondary">Reported cost</span>
        <span className="min-w-0 font-medium tabular-nums text-ink [overflow-wrap:anywhere]">
          {usage.costUsd == null ? "Not reported" : formatUsd(usage.costUsd)}
        </span>
      </p>
    </section>
  );
}
