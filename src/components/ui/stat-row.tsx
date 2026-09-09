/**
 * Adapted from GAIA UI StatRow, Copyright (c) 2026 The Experience Company.
 * Source: https://github.com/theexperiencecompany/gaia-ui/blob/14e20153ff1fa89897e2e90aa13eb17c69d4b156/registry/new-york/ui/stat-row.tsx
 * Upstream commit: 14e20153ff1fa89897e2e90aa13eb17c69d4b156 (MIT).
 * Full license: public/third-party-notices.txt, included in application builds.
 * Adaptations: Lucide icons, Muster tokens, semantic metrics, and narrow layouts.
 */
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { cn } from "@/lib/cn";

export type StatRowProps = {
  title: string;
  value: string | number;
  unit?: string;
  trend?: "up" | "down" | "neutral";
  trendLabel?: string;
};

const TREND_STYLES = {
  up: "text-success",
  down: "text-danger",
  neutral: "text-ink-secondary",
};

export function StatRow(props: StatRowProps) {
  const TrendIcon = props.trend === "up" ? ArrowUp : props.trend === "down" ? ArrowDown : ArrowRight;

  return (
    <dl className="flex h-full min-w-0 flex-col justify-between gap-2 rounded-2xl border border-hairline/60 bg-card p-4 text-ink">
      <dt className="text-xs leading-relaxed text-ink-secondary [overflow-wrap:anywhere]">
        {props.title}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <span className="min-w-0 text-2xl font-semibold leading-tight tabular-nums [overflow-wrap:anywhere] sm:text-3xl">
          {props.value}
        </span>
        {props.unit && (
          <span className="min-w-0 text-sm text-ink-secondary [overflow-wrap:anywhere]">
            {props.unit}
          </span>
        )}
      </dd>
      {props.trend && props.trendLabel && (
        <dd className={cn("flex min-w-0 items-start gap-1 text-xs font-medium", TREND_STYLES[props.trend])}>
          <TrendIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{props.trendLabel}</span>
        </dd>
      )}
    </dl>
  );
}
