// Pending approval, ported from the upstream pattern: an approval does
// not sit in the transcript waiting to be noticed — it takes over the
// composer. The prompt is disabled, a strip above it says exactly what
// is being asked, and the send row is replaced by the decisions.
//
// Faithful details worth keeping: one at a time with an "n of N" counter,
// the detail printed raw in a monospace block that is NEVER truncated
// (it scrolls instead), and the buttons ordered least-destructive-last so
// the primary action sits under your thumb.
import { ApprovalWhyDetails } from "./ApprovalWhyDetails";
import { memo } from "react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

interface ApprovalLabels {
  [tool: string]: string;
}

export interface Pending {
  message: Message;
  requestId: string;
  tool: string;
  /** the narrow grant "always allow" writes, computed server-side */
  allowKey?: string;
  detail: string;
  held?: string;
  /** certify-lite evidence: this bot's past with this tool */
  why?: NonNullable<Message["card"]>["why"];
  rehearsal?: NonNullable<Message["card"]>["rehearsal"];
  history?: NonNullable<Message["card"]>["history"];
  /** grounded desktop controls: the human's tappable choice list */
  suggestions?: NonNullable<Message["card"]>["suggestions"];
}

/** Open approvals on a thread, oldest first — answered/dismissed drop out. */
export function pendingApprovals(messages: Message[]): Pending[] {
  return messages
    .filter((m) => m.kind === "options" && m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed)
    .map((m) => ({
      message: m,
      requestId: m.card!.requestId!,
      tool: m.card!.tool!,
      allowKey: m.card!.allowKey,
      detail: m.card!.subtitle,
      held: m.card!.held,
      history: m.card!.history,
      rehearsal: m.card!.rehearsal,
      why: m.card!.why,
      suggestions: m.card!.suggestions,
    }));
}

/** The ONE action a grounded-suggestion tap dispatches — a named contract,
 * so the "tap = the existing respond route" claim is checkable at the type
 * level and not just at run time. */
export interface GroundedSuggestionAction {
  type: "decideRequest";
  threadId: string;
  requestId: string;
  behavior: "allow";
  message: string;
}

/** The respond action a grounded-suggestion tap produces: the SAME existing
 * decideRequest path Allow uses, carrying the exact target the human chose.
 * Their agent-contract rule, kept — "a failed exact ID must not fall back to
 * a nearby label". Exported so the "tap = existing respond path, never a new
 * execution route" contract is unit-testable without a DOM. */
export function suggestionAction(
  suggestion: NonNullable<Pending["suggestions"]>[number],
  threadId: string,
  requestId: string,
): GroundedSuggestionAction {
  return {
    type: "decideRequest",
    threadId,
    requestId,
    behavior: "allow",
    message: `Grounded target chosen by the human: ${suggestion.id} — ${suggestion.label} [${suggestion.source}] (${suggestion.actionKind}). Act on this exact target; a failed exact ID must not fall back to a nearby label.`,
  };
}

function label(tool: string): string {
  const nice: ApprovalLabels = {
    Bash: "Command approval requested",
    shell: "Command approval requested",
    Read: "File-read approval requested",
    Write: "File-change approval requested",
    Edit: "File-change approval requested",
    edit: "File-change approval requested",
  };
  return nice[tool] ?? "Approval requested";
}

export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  pending,
  count,
  index,
}: {
  pending: Pending;
  count: number;
  index: number;
}) {
  return (
    <div className="rounded-t-2xl border-b border-hairline/50 bg-raised/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink-secondary">Pending approval</span>
        {count > 1 && (
          <span className="rounded-full bg-raised px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary">
            {index + 1} of {count}
          </span>
        )}
        <span className="text-[13px] text-ink">{label(pending.tool)}</span>
        <span className="font-mono text-[11px] text-ink-secondary">{pending.tool}</span>
      </div>
      {/* never truncated — long commands wrap and scroll */}
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink">
        {pending.detail}
      </pre>
      {pending.history && pending.history.total > 0 && (
        <div
          className={cn(
            "mt-2 rounded-lg px-2.5 py-1.5 text-[12px] leading-snug",
            pending.history.lastDecision === "denied" ? "bg-warning/10 text-warning" : "bg-inset text-ink-secondary",
          )}
          title="How this bot's past went with this tool — evidence, not a verdict"
        >
          {pending.history.summary}
        </div>
      )}
      {pending.why && <ApprovalWhyDetails why={pending.why} />}
      {pending.rehearsal && (
        <p className="mt-2 text-[12px] text-ink-secondary">{pending.rehearsal.summary}</p>
      )}
      {pending.suggestions?.length ? (
        <p className="mt-2 text-[12px] text-ink-secondary">
          Grounded controls detected on screen are offered below — pick the exact target you want; a failed exact ID must not fall back to a nearby label.
        </p>
      ) : null}
      {pending.held && <div className="mt-2 text-[12px] text-warning">{pending.held}</div>}
    </div>
  );
});

export function PendingApprovalActions({
  pending,
  threadId,
  bot,
  onCancelTurn,
  cancelPending = false,
}: {
  pending: Pending;
  threadId: string;
  /** who asked — "always allow" is remembered against them */
  bot?: Bot;
  onCancelTurn: () => void;
  cancelPending?: boolean;
}) {
  const { dispatch } = useStore();
  const decide = (behavior: "allow" | "deny", always = false) =>
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? "Denied by the user." : undefined,
      alwaysAllow: always && bot && pending.allowKey ? { botId: bot.id, key: pending.allowKey } : undefined,
    });
  // A grounded suggestion is a CHOICE, not an auto-allow: the human taps the
  // exact control they want, and the answer travels the same respond route
  // Allow does. Nothing here runs the action itself.
  const suggest = (suggestion: NonNullable<Pending["suggestions"]>[number]) =>
    dispatch(suggestionAction(suggestion, threadId, pending.requestId));

  const base = "rounded-full px-3.5 py-1.5 text-[13.5px] transition-colors";
  return (
    <div className="flex flex-col items-end gap-1 px-2 py-2">
      {pending.suggestions?.length ? (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span className="text-[11px] uppercase tracking-[0.14em] text-ink-secondary">Grounded controls</span>
          {pending.suggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              onClick={() => suggest(suggestion)}
              title={`${suggestion.source} · ${suggestion.actionKind} — answers this ask and names the exact target`}
              className={cn(base, "border border-accent/40 text-ink hover:bg-raised")}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button onClick={onCancelTurn} disabled={cancelPending} aria-busy={cancelPending} className={cn(base, "text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50")}>
          Cancel turn
        </button>
        <button
          onClick={() => decide("deny")}
          className={cn(base, "border border-danger/40 text-danger hover:bg-danger/10")}
        >
          Deny
        </button>
        {bot && pending.allowKey && (
          <button
            onClick={() => decide("allow", true)}
            title={`Stop asking ${bot.name} about ${pending.allowKey}`}
            className={cn(base, "border border-hairline/50 text-ink hover:bg-raised")}
          >
            Always allow
          </button>
        )}
        <button
          onClick={() => decide("allow")}
          className={cn(base, "bg-accent font-medium text-white hover:brightness-110")}
        >
          Allow once
        </button>
      </div>
    </div>
  );
}
