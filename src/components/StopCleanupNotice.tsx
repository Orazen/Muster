import type { StopCleanupAction } from "@/state/stop-cleanup-session";

/** Kept outside the transient global error banner and outside busy-only UI. */
export function StopCleanupNotice({ action, threadId, onRetry, onReview, onDismiss }: {
  action: StopCleanupAction;
  threadId: string;
  onRetry: () => void;
  onReview: () => void;
  onDismiss: () => void;
}) {
  const recovery = action.recovery;
  if (!recovery) return null;
  const pending = Boolean(action.pending);
  return (
    <div className="mx-auto w-full min-w-0 max-w-[900px] px-5">
      <div role="alert" aria-label="Stop needs attention" aria-busy={pending}
        className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-ink [overflow-wrap:anywhere]">
        <p className="font-medium">Stop needs attention</p>
        <p className="mt-1">{recovery.message}</p>
        {recovery.receipt ? (
          <p className="mt-1 text-ink-secondary">Retry only clears the earlier queued handoffs. It cannot stop a newer turn.</p>
        ) : (
          <p className="mt-1 text-ink-secondary">Review the current conversation and task before choosing Stop again.</p>
        )}
        {recovery.threadId !== threadId && <p className="mt-1 text-ink-secondary">This notice belongs to an earlier task for this bot.</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {recovery.receipt && <button type="button" onClick={onRetry} disabled={pending}
            className="min-h-9 rounded-lg border border-danger/30 px-3 py-1.5 font-medium text-danger hover:bg-danger/10 disabled:opacity-50">
            {action.pending === "cleanup" ? "Retrying cleanup…" : "Retry stop cleanup"}
          </button>}
          <button type="button" onClick={onReview} disabled={pending}
            className="min-h-9 rounded-lg border border-border px-3 py-1.5 hover:bg-raised disabled:opacity-50">Review current conversation</button>
          <button type="button" onClick={onDismiss} disabled={pending}
            className="min-h-9 rounded-lg px-3 py-1.5 text-ink-secondary hover:bg-raised disabled:opacity-50">Dismiss</button>
        </div>
      </div>
    </div>
  );
}
