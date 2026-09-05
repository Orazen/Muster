// One bot's decision journal (the why-journal, server/why-journal.ts):
// each settled run states what it was trying to do and the key choices it
// made along the way — the WHY layer beside the Audit tab's WHAT layer.
// Newest first, grouped by day like the audit ledger. Bots that never
// learned the WHY prompt suffix simply have no entries: the section shows
// an honest empty state, not an error.
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";

interface WhyDecision {
  text: string;
}

interface WhyEntry {
  runId: string;
  /** ms epoch — ordering key, newest first. */
  at: number;
  intent: string | null;
  decisions: WhyDecision[];
  outcome: "done" | "failed" | "partial";
  /** ARC reasoning-agent fields: what the run assumed, what it learned. */
  hypothesis?: string | null;
  findings?: string | null;
}

const OUTCOME_STYLE = {
  done: { dot: "bg-success", label: "Done" },
  partial: { dot: "bg-warning", label: "Partial" },
  failed: { dot: "bg-danger", label: "Failed" },
} as const;

/** Today / Yesterday / a real date — same grouping style as the audit rows. */
function dayLabel(atMs: number): string {
  const day = new Date(atMs);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function timeLabel(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function WhyPanel({ botId }: { botId: string }) {
  const [entries, setEntries] = useState<WhyEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setLoading(true);
    void api(`/api/bots/${botId}/why?limit=50`)
      .then((page: { entries: WhyEntry[] }) => {
        if (!cancelled) setEntries(page.entries);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [botId]);

  if (!loading && entries.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-ink-secondary">
        When this bot runs a routine, it journals what it was trying to do and the choices it made. No runs journaled yet.
      </p>
    );
  }

  const groups: Array<{ label: string; entries: WhyEntry[] }> = [];
  for (const entry of entries) {
    const label = dayLabel(entry.at);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">{group.label}</span>
            <span className="h-px flex-1 bg-hairline/40" />
          </div>
          {group.entries.map((entry) => (
            <WhyRow key={entry.runId} entry={entry} />
          ))}
        </div>
      ))}
    </div>
  );
}

function WhyRow({ entry }: { entry: WhyEntry }) {
  const style = OUTCOME_STYLE[entry.outcome];
  return (
    <div className="flex items-start gap-2.5 rounded-lg px-1 py-1.5">
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", style.dot)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-medium text-ink">{entry.intent ?? "No stated intent"}</span>
          <span className="shrink-0 text-[11.5px] text-ink-secondary">{timeLabel(entry.at)}</span>
        </div>
        {entry.decisions.length > 0 && (
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
            {entry.decisions.map((d, i) => (
              <li key={i} className="text-[12.5px] leading-relaxed text-ink-secondary">
                {d.text}
              </li>
            ))}
          </ul>
        )}
        {(entry.hypothesis || entry.findings) && (
          <div className="mt-1 flex flex-col gap-0.5 rounded-lg bg-inset px-2.5 py-1.5">
            {entry.hypothesis && (
              <div className="text-[12px] leading-relaxed text-ink-secondary">
                <span className="font-medium text-ink">Assumed:</span> {entry.hypothesis}
              </div>
            )}
            {entry.findings && (
              <div className="text-[12px] leading-relaxed text-ink-secondary">
                <span className="font-medium text-ink">Learned:</span> {entry.findings}
              </div>
            )}
          </div>
        )}
        <div className="mt-0.5 text-[12px] text-ink-secondary">{style.label}</div>
      </div>
    </div>
  );
}
