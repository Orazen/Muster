// Transcript export + reply-quote formatting — the OMB-parity chat
// affordances, in Muster's own shape.
//
// Export downloads the visible transcript (the bot's full active branch) as a
// Markdown file: one line per message with role, timestamp, and text as
// authored (no re-rendering). Client-side only — the server already holds
// every byte; this just shapes them for a download.
//
// Reply quote builds the composer prefill for "reply to this message": a
// compact blockquote of the original, collapsed to its first meaningful
// lines, that the user types under. Prefill rides the same per-thread draft
// store the composer already uses, so it survives a thread switch like any
// typed draft.

/** Structural slice of a transcript message — everything export and quote
 * rendering needs. Local on purpose: a client lib must not reach into the
 * server's store module, or the web typecheck graph drags server code
 * (with its node-flavored settings) into every `tsc -b` run. The server's
 * Message is assignable to this by shape. */
export interface TranscriptMessage {
  kind: "text" | "options" | "activity" | "screen" | "connector" | "compaction" | "privacy";
  text?: string;
  tool?: { name: string; ok?: boolean };
}

/** The exported transcript's header: bot name, task, exported-at. */
export function transcriptHeader(botName: string, taskLabel: string, exportedAt: Date = new Date()): string {
  return [
    `# Conversation with ${botName}`,
    taskLabel ? `**Task:** ${taskLabel}` : "",
    `**Exported:** ${exportedAt.toLocaleString()}`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** One transcript line: `**You** · 14:03 — text` / `**Bot** …`, activity
 * messages collapsed to an italic tool line, empty text skipped. */
export function transcriptLine(message: TranscriptMessage, at: Date, who: string): string | null {
  switch (message.kind) {
    case "text":
      return message.text?.trim() ? `${who} · ${formatClock(at)} —\n\n${message.text.trim()}\n` : null;
    case "activity":
      return message.tool ? `*${who} · ${formatClock(at)} — ${message.tool.name}${message.tool.ok === false ? " (failed)" : ""}*\n` : null;
    case "compaction":
      return `*${who} · ${formatClock(at)} — context compacted*\n`;
    default:
      // options/screen/connector/privacy cards are interactive artifacts;
      // exporting their bytes would be noise, their existence is the fact.
      return `*${who} · ${formatClock(at)} — ${message.kind} card*\n`;
  }
}

function formatClock(at: Date): string {
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Download `content` as a Markdown file named after the bot + date. */
export function downloadTranscript(content: string, botName: string): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = botName.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "conversation";
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safe}-${stamp}.md`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The longest run of non-empty lines worth quoting (OMB collapses long
 * quotes to a few lines so the prefill never dwarfs the reply). */
const QUOTE_MAX_LINES = 4;
const QUOTE_MAX_CHARS = 280;

/** Composer prefill for "reply to this message": blockquote of the
 * original's opening lines, then a blank line for the reply. */
export function replyQuote(original: string): string {
  const lines = original
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length >= QUOTE_MAX_LINES || chars + line.length > QUOTE_MAX_CHARS) {
      kept.push("…");
      break;
    }
    kept.push(line);
    chars += line.length;
  }
  const quoted = kept.map((line) => `> ${line}`).join("\n");
  return `${quoted}\n\n`;
}
