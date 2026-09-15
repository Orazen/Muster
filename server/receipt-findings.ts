// Deterministic post-run findings for job receipts (the future-agi /
// traceroot "detectors" concept, reduced to what needs no model call).
//
// A receipt proves work happened; findings say how it went, from signals
// already in the transcript — no LLM-as-judge, no cost, nothing that
// could hallucinate a verdict. Three honest detectors:
//   1. failed tool calls (count + up to three distinct names)
//   2. a run that ended waiting on the human (unanswered card)
//   3. a long silence mid-run (the engine stalled or the machine slept)
// Absence of findings renders as "clean run" — the receipt never stays
// silent about silence.

/** The slice of a transcript message the detectors read. */
export interface FindingMessage {
  role: string;
  kind: string;
  text?: string;
  at?: number;
  tool?: { name: string; ok?: boolean };
}

const STALL_MS = 10 * 60_000;

export function receiptFindings(messages: FindingMessage[]): string[] {
  const findings: string[] = [];

  const failed = messages.filter((m) => m.kind === "activity" && m.tool && m.tool.ok === false);
  if (failed.length > 0) {
    // Error-chip names are whole sentences ("error: …"); tool names are
    // identifiers. Keep at most three, preferring identifiers.
    const names = [...new Set(failed.map((m) => m.tool!.name.replace(/^error:\s*/, "").slice(0, 48)))];
    findings.push(`${failed.length} failed step${failed.length === 1 ? "" : "s"}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? " …" : ""}`);
  }

  const lastCard = messages.map((m, i) => ({ m, i })).reverse().find(({ m }) => m.kind === "options");
  if (lastCard) {
    const answeredAfter = messages.slice(lastCard.i + 1).some((m) => m.role === "user" && m.kind === "text" && m.text?.trim());
    if (!answeredAfter) findings.push("ended waiting on you — a question or approval went unanswered");
  }

  let longestGap = 0;
  for (let i = 1; i < messages.length; i += 1) {
    const gap = (messages[i]?.at ?? 0) - (messages[i - 1]?.at ?? 0);
    if (gap > longestGap) longestGap = gap;
  }
  if (longestGap > STALL_MS) {
    findings.push(`paused ~${Math.round(longestGap / 60_000)} min mid-run (stall or sleep)`);
  }

  return findings;
}
