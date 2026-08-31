// Turning the inspector's two record shapes into one-line summaries. Pure
// so the panel stays a thin renderer and the labels can be tested.
import type { RuntimeEvent } from "../../server/contracts.ts";
import type { JsonObject, JsonValue } from "../../server/schema.ts";
import type { InspectorEntry, NativeRecord } from "../../server/thread-events.ts";
export type { InspectorEntry, InspectorPage, NativeRecord } from "../../server/thread-events.ts";

/** Primitive-string test without narrowing on representation: what JSON
 * decoding yields for text fields is exactly the values String() maps to
 * themselves. */
const isJsonString = <T>(value: T): value is T & string => String(value) === value;

interface FoldPreview {
  text: string;
  pendingSpace: boolean;
  overflow: boolean;
}

/** A row in the panel: adjacent content.delta events fold into one so a
 * streamed paragraph is one line, not three hundred. */
export interface InspectorRow {
  key: string;
  kind: "runtime" | "native";
  at: string;
  /** short badge — the event type, or in/out for native */
  tag: string;
  /** what happened, in one line */
  summary: string;
  /** visual weight: a turn boundary, a failure, or plain */
  tone: "boundary" | "error" | "plain";
  /** the record(s) behind the row, for the expanded view */
  data: unknown;
  /** > 1 when deltas were folded */
  count: number;
  /** bounded, incrementally normalized preview for a folded delta run */
  preview?: FoldPreview;
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const FOLD_PREVIEW_CHARS = 119;

function appendPreview(previous: FoldPreview | undefined, delta: string): FoldPreview {
  const next: FoldPreview = previous ? { ...previous } : { text: "", pendingSpace: false, overflow: false };
  if (next.overflow) return next;
  for (const char of delta) {
    if (/\s/.test(char)) {
      if (next.text) next.pendingSpace = true;
      continue;
    }
    if (next.pendingSpace) {
      if (next.text.length >= FOLD_PREVIEW_CHARS) {
        next.overflow = true;
        break;
      }
      next.text += " ";
      next.pendingSpace = false;
    }
    if (next.text.length >= FOLD_PREVIEW_CHARS) {
      next.overflow = true;
      break;
    }
    next.text += char;
  }
  return next;
}

const previewText = (preview: FoldPreview) => `${preview.text}${preview.overflow ? "…" : ""}`;

/** One-line summary produced for a runtime event row. */
export interface RuntimeSummary {
  summary: string;
  tone: InspectorRow["tone"];
}

export function summarizeRuntime(e: RuntimeEvent): RuntimeSummary {
  switch (e.type) {
    case "session.started":
      return { summary: `session ${e.sessionId ?? "(none)"}${e.model ? ` · ${e.model}` : ""}`, tone: "plain" };
    case "session.exited":
      return { summary: `session exited${e.reason ? ` · ${e.reason}` : ""}`, tone: "plain" };
    case "turn.started":
      return { summary: `turn started${e.turnId ? ` · ${e.turnId.slice(0, 8)}` : ""}`, tone: "boundary" };
    case "turn.completed": {
      const parts = [e.ok ? "turn ok" : "turn failed"];
      if (e.stopReason) parts.push(e.stopReason);
      // The event log validates cost as number-or-null, so null is the only
      // "absent" shape left to skip here.
      if (e.cost != null) parts.push(`$${e.cost.toFixed(4)}`);
      if (e.denials?.length) parts.push(`${e.denials.length} denied`);
      return { summary: parts.join(" · "), tone: e.ok ? "boundary" : "error" };
    }
    case "item.started":
      return { summary: `${e.itemType}${e.title ? `: ${clip(oneLine(e.title))}` : " started"}`, tone: "plain" };
    case "item.updated":
      return { summary: `${e.itemType} updated${e.tokens != null ? ` · ${e.tokens} tok` : ""}`, tone: "plain" };
    case "item.completed":
      if (e.itemType === "assistant_text") return { summary: `assistant: ${clip(oneLine(e.text))}`, tone: "plain" };
      return { summary: `tool ${e.ok ? "ok" : "failed"}`, tone: e.ok ? "plain" : "error" };
    case "content.delta":
      return { summary: `${e.streamKind}: ${clip(oneLine(e.delta))}`, tone: "plain" };
    case "request.opened":
      return { summary: `${e.requestType}: ${e.tool} — ${clip(oneLine(e.summary))}`, tone: "plain" };
    case "request.resolved":
      return { summary: `resolved ${e.behavior} · ${e.source}`, tone: "plain" };
    case "thread.token-usage.updated":
      return { summary: `tokens in ${e.input} · out ${e.output}`, tone: "plain" };
    case "runtime.error":
      return { summary: `${e.setup ? "setup: " : ""}${clip(oneLine(e.message))}`, tone: "error" };
    default:
      // SAFETY: the log can carry event types added upstream before this panel
      // learns them; every RuntimeEvent variant still has a type tag.
      return { summary: (e as { type: string }).type, tone: "plain" };
  }
}

/** A nested decoded-JSON object field, or undefined when the value is a
 * primitive or array. */
function nestedObject(value: JsonValue | undefined): JsonObject | undefined {
  // SAFETY: the value is decoded JSON, so an object here is a string-keyed record
  return value instanceof Object && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export function summarizeNative(r: NativeRecord): string {
  // Native lines are provider JSON decoded at the read boundary; until a
  // record shape is proven below, any field access stays defensive.
  if (!(r.msg instanceof Object)) return String(r.msg);
  // SAFETY: r.msg is JSON.parse output, so it is a plain string-keyed record
  const msg = r.msg as JsonObject;
  const method = isJsonString(msg.method) ? msg.method : undefined;
  const type = isJsonString(msg.type) ? msg.type : undefined;
  const id = msg.id !== undefined ? ` #${String(msg.id)}` : "";
  if (method) return `${method}${id}`;
  // antigravity's stream keys on `event`, with the outcome under result.status
  if (isJsonString(msg.event)) {
    const status = nestedObject(msg.result)?.status;
    return isJsonString(status) ? `${msg.event} · ${status}` : msg.event;
  }
  if (type) {
    // claude stream-json: surface the role/subtype so a user turn and an
    // assistant chunk don't both read as "message"
    const innerRole = nestedObject(msg.message)?.role;
    const role = isJsonString(innerRole) ? ` · ${innerRole}` : "";
    const subtype = isJsonString(msg.subtype) ? ` · ${msg.subtype}` : "";
    return `${type}${subtype}${role}`;
  }
  if (msg.result !== undefined) return `result${id}`;
  if (msg.error !== undefined) return `error${id}`;
  return clip(oneLine(JSON.stringify(msg)));
}

/** The event list behind a folded content.delta row. */
function foldedEvents(row: InspectorRow): RuntimeEvent[] | undefined {
  // SAFETY: only runtime content.delta rows store an array of their own events
  return Array.isArray(row.data) ? (row.data as RuntimeEvent[]) : undefined;
}

/** Entries → rows, folding runs of content.delta on the same stream. */
export function toRows(entries: InspectorEntry[]): InspectorRow[] {
  const rows: InspectorRow[] = [];
  for (const [i, entry] of entries.entries()) {
    if (entry.kind === "native") {
      rows.push({
        key: `n${i}`,
        kind: "native",
        at: entry.at,
        tag: entry.data.dir === "out" ? "→ out" : "← in",
        summary: `${entry.data.source} · ${summarizeNative(entry.data)}`,
        tone: "plain",
        data: entry.data,
        count: 1,
      });
      continue;
    }
    const e = entry.data;
    const last = rows.at(-1);
    if (e.type === "content.delta" && last?.kind === "runtime" && last.tag === "content.delta") {
      const folded = foldedEvents(last);
      const first = folded?.[0];
      if (folded && first?.type === "content.delta" && first.streamKind === e.streamKind) {
        folded.push(e);
        last.count = folded.length;
        last.preview = appendPreview(last.preview, e.delta);
        last.summary = `${e.streamKind}: ${previewText(last.preview)}`;
        continue;
      }
    }
    const { summary, tone } = summarizeRuntime(e);
    const preview = e.type === "content.delta" ? appendPreview(undefined, e.delta) : undefined;
    const streamKind = e.type === "content.delta" ? e.streamKind : undefined;
    rows.push({
      key: e.eventId || `r${i}`,
      kind: "runtime",
      at: entry.at,
      tag: e.type,
      summary: preview && streamKind ? `${streamKind}: ${previewText(preview)}` : summary,
      tone,
      data: e.type === "content.delta" ? [e] : e,
      count: 1,
      preview,
    });
  }
  return rows;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
