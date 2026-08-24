// One bot's trust ledger, rendered as a timeline: every action that was
// gated, and who or what decided it. Newest first, grouped by day, each row
// carrying its verdict as a colored dot — green you allowed, red you denied,
// amber a rule that fired without you.
//
// The section exists only for bots with history: SettingsModal probes the
// endpoint for a single entry first, so an empty ledger costs one cheap
// fetch and no nav item — never a permanent empty tab.
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";

type AuditDecision = "approved" | "denied" | "auto";

interface AuditEntry {
  id: string;
  /** ms epoch */
  at: number;
  action: string;
  decision: AuditDecision;
  rule?: string;
  summary: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextBefore?: string;
}

interface DecisionStyle {
  dot: string;
  label: string;
}

const DECISION_STYLE = {
  approved: { dot: "bg-success", label: "You allowed" },
  denied: { dot: "bg-danger", label: "You denied" },
  auto: { dot: "bg-warning", label: "Rule fired" },
} satisfies Record<AuditDecision, DecisionStyle>;

/** Today / Yesterday / a real date — the same grouping the rows are cut by. */
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

interface DayGroup {
  label: string;
  entries: AuditEntry[];
}

function groupByDay(entries: AuditEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const label = dayLabel(entry.at);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

export function AuditPanel({ botId }: { botId: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null); // next page's ?before
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setCursor(null);
    setLoading(true);
    void api(`/api/bots/${botId}/audit`)
      .then((page: AuditPage) => {
        if (cancelled) return;
        setEntries(page.entries);
        setCursor(page.nextBefore ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [botId]);

  const loadOlder = () => {
    if (!cursor) return;
    const before = cursor;
    void api(`/api/bots/${botId}/audit?before=${encodeURIComponent(before)}`)
      .then((page: AuditPage) => {
        setEntries((current) => [...current, ...page.entries]);
        setCursor(page.nextBefore ?? null);
      })
      .catch(() => {});
  };

  if (!loading && entries.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-ink-secondary">
        Every action this bot takes gets decided here — approvals you made, rules that fired. Nothing yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {groupByDay(entries).map((group) => (
        <div key={group.label} className="flex flex-col gap-2">
          {/* day separator */}
          <div className="flex items-center gap-3">
            <span className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">{group.label}</span>
            <span className="h-px flex-1 bg-hairline/40" />
          </div>
          {group.entries.map((entry) => (
            <AuditRow key={entry.id} entry={entry} />
          ))}
        </div>
      ))}
      {cursor && (
        <button
          onClick={loadOlder}
          className="w-fit rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Load earlier decisions
        </button>
      )}
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const style = DECISION_STYLE[entry.decision];
  return (
    <div className="flex items-start gap-2.5 rounded-lg px-1 py-1.5">
      {/* verdict dot */}
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", style.dot)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-[12.5px] text-ink">{entry.action}</span>
          <span className="shrink-0 text-[11.5px] text-ink-secondary">{timeLabel(entry.at)}</span>
        </div>
        {entry.summary && (
          <pre className="mt-0.5 max-h-16 overflow-hidden whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink-secondary">
            {entry.summary}
          </pre>
        )}
        <div className="mt-0.5 text-[12px] text-ink-secondary">{entry.rule ?? style.label}</div>
      </div>
    </div>
  );
}
