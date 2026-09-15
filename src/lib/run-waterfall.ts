// Per-step waterfall for a grouped tool run — the traceroot pattern,
// distilled. A tool run's messages carry only report timestamps (`at`), so
// a step's span is honestly modeled as "time from the previous report to
// this one" — the wait that report ended. That gives a Gantt whose bars
// sum to the run's wall-clock span, which is exactly what a reader scans
// for: which step ate the time.
//
// Pure and dependency-free so the layout math is contract-tested; the
// component renders rows from the returned shape.

export interface WaterfallStep {
  /** stable React key — the message id. */
  id: string;
  /** tool name as reported, e.g. "mcp__muster-computer__click". */
  name: string;
  ok: boolean | undefined; // undefined = still running
  /** ms from the run's start to this step's report. */
  offsetMs: number;
  /** ms this step's report ended (0 for the first step). */
  durationMs: number;
  /** 0..100 width of the bar within the run span. */
  widthPct: number;
  /** 0..100 left inset of the bar within the run span. */
  leftPct: number;
  /** true when the step is the newest and has no report yet. */
  inProgress: boolean;
}

export interface Waterfall {
  totalMs: number;
  steps: WaterfallStep[];
}

/** Minimum visible bar: a 0ms step still needs a sliver to be scannable. */
const MIN_WIDTH_PCT = 1.5;

/** Shorten provider tool names for the label column: strip the MCP prefix
 * and the server segment, keep the verb. */
export function stepLabel(name: string): string {
  const parts = name.split("__");
  return parts.length > 1 ? parts[parts.length - 1] : name;
}

/** Build the waterfall from a run's tool messages (already ordered).
 * `now` is injectable so the in-progress tail is testable. */
export function buildRunWaterfall(
  items: Array<{ id: string; name: string; ok: boolean | undefined; at: number }>,
  now = Date.now(),
): Waterfall | null {
  if (items.length < 2) return null; // one step has no interesting shape
  const start = items[0]?.at ?? 0;
  const lastReport = items[items.length - 1]?.at ?? start;
  // A trailing step with no report yet is still running: extend the span to
  // NOW so its bar grows honestly instead of pulsing a fake duration.
  const tailRunning = items[items.length - 1]?.ok === undefined;
  const totalMs = Math.max(0, (tailRunning ? Math.max(now, lastReport) : lastReport) - start);
  if (totalMs < 1000) return null; // sub-second runs are noise, same rule as the pill
  const steps: WaterfallStep[] = items.map((item, index) => {
    const offsetMs = Math.max(0, item.at - start);
    const durationMs = index === 0 ? offsetMs : Math.max(0, item.at - (items[index - 1]?.at ?? item.at));
    const isLast = index === items.length - 1;
    const rawWidth = isLast && tailRunning ? Math.max(0, now - item.at) : durationMs;
    // Percent units throughout; a nonzero step always gets a visible sliver.
    // Width is decided first, then the bar is inset so a sliver at the right
    // edge is shifted into view rather than clamped to zero.
    const widthPct = totalMs === 0 ? 0 : Math.min(Math.max((rawWidth / totalMs) * 100, rawWidth > 0 ? MIN_WIDTH_PCT : 0), 100);
    const leftPct = Math.max(0, Math.min(totalMs === 0 ? 0 : (offsetMs / totalMs) * 100, 100 - widthPct));
    return {
      id: item.id,
      name: item.name,
      ok: item.ok,
      offsetMs,
      durationMs: rawWidth,
      widthPct,
      leftPct,
      inProgress: isLast && tailRunning,
    };
  });
  return { totalMs, steps };
}

/** Human duration for the bar tooltip: 1.2s / 4m 08s / 1h 02m. */
export function formatStepDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
