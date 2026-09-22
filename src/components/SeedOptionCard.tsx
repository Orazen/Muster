import { useEffect, useSyncExternalStore } from "react";
import { useStore, type OptionCardData } from "@/state/store";
import { seedCardKey, seedCardWriteBlocker, type SeedCardActionState, type SeedCardReference } from "@/state/seed-card-session";
import { ApprovalWhyDetails } from "./ApprovalWhyDetails";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export function SeedOptionCard({ reference, card, hotkeys }: {
  reference: SeedCardReference;
  card: OptionCardData;
  hotkeys: boolean;
}) {
  const { seedCards, state } = useStore();
  const actions = useSyncExternalStore(seedCards.subscribe, seedCards.getSnapshot, seedCards.getSnapshot);
  const action = actions[seedCardKey(reference)] ?? seedCards.action(reference);
  const writeBlocked = seedCardWriteBlocker(state, reference);
  const canAnswer = !action.pending && !card.answered && !card.seedAnswer && !writeBlocked;
  useEffect(() => {
    if (!hotkeys || !canAnswer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]")) return;
      const index = LETTERS.indexOf(event.key.toUpperCase());
      if (index < 0 || index >= card.options.length) return;
      event.preventDefault();
      void seedCards.answer(reference, card.options[index]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys, canAnswer, seedCards, reference, card.options]);
  return <SeedOptionCardView card={card} action={action} hotkeys={hotkeys} writeBlocked={writeBlocked}
    onEdit={(draft) => seedCards.edit(reference, draft)}
    onAnswer={(answer) => { void seedCards.answer(reference, answer); }}
    onCheck={() => { void seedCards.check(reference); }}
    onStart={() => { void seedCards.start(reference); }} />;
}

export function SeedOptionCardView({ card, action, hotkeys = false, writeBlocked = null, onEdit, onAnswer, onCheck, onStart }: {
  card: OptionCardData;
  action: SeedCardActionState;
  hotkeys?: boolean;
  writeBlocked?: string | null;
  onEdit: (draft: string) => void;
  onAnswer: (answer: string) => void;
  onCheck: () => void;
  onStart: () => void;
}) {
  const receipt = card.seedAnswer;
  const canAnswer = !card.answered && !receipt && !writeBlocked;
  const pending = action.pending !== null;
  const canStart = !writeBlocked && (receipt?.status === "recorded" || receipt?.status === "not-started");
  const buttonClass = "min-h-10 rounded-lg border border-hairline/50 px-3 py-2 text-sm text-ink hover:bg-raised disabled:opacity-50 [overflow-wrap:anywhere]";
  return <section aria-label="Getting started question" className="w-full min-w-0 max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4 [overflow-wrap:anywhere]">
    <h3 className="text-[16px] font-semibold text-ink">{card.title}</h3>
    <p className="mt-0.5 text-[14px] text-ink-secondary">{card.subtitle}</p>
    {card.why && <ApprovalWhyDetails why={card.why} />}
    {card.rehearsal && <p className="mt-2 text-xs text-ink-secondary">{card.rehearsal.summary}</p>}
    <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
      {card.options.map((option, index) => <button key={option} type="button" disabled={pending || !canAnswer}
        onClick={() => onAnswer(option)}
        className={`flex min-h-11 w-full items-start gap-3 px-3 py-3 text-left text-[15px] text-ink disabled:cursor-default disabled:opacity-50 ${index ? "border-t border-hairline/40" : ""} ${card.answered === option ? "bg-raised" : "enabled:hover:bg-raised/60"}`}>
        <span title={hotkeys && canAnswer && !pending ? `Press ${LETTERS[index]}` : undefined}
          className="flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-xs text-ink-secondary">{LETTERS[index]}</span>
        <span className="min-w-0">{option}</span>
      </button>)}
    </div>
    {canAnswer && <form onSubmit={(event) => { event.preventDefault(); if (!pending && action.draft.trim()) onAnswer(action.draft); }} className="mt-3 flex min-w-0 flex-col gap-2">
      <label className="text-sm text-ink-secondary">Your own answer
        <textarea aria-label="Your own answer" value={action.draft} maxLength={4000}
          onChange={(event) => onEdit(event.target.value)} rows={3}
          className="mt-1 w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
          placeholder="Type your own answer" />
      </label>
      <button type="submit" disabled={pending || !action.draft.trim()} className={`${buttonClass} self-start`}>Send answer</button>
    </form>}
    {card.answered !== undefined && <p className="mt-3 whitespace-pre-wrap text-sm text-ink"><span className="font-medium">Saved answer: </span>{card.answered}</p>}
    {receipt && <div role="status" className="mt-3 text-sm text-ink-secondary">
      {receipt.status === "recorded" && <p>Answer recorded. The task has not started.</p>}
      {receipt.status === "starting" && <p>Answer recorded. Start requested; waiting for confirmation.</p>}
      {receipt.status === "started" && <p>Answer recorded. The task started; follow its progress in this conversation.</p>}
      {receipt.status === "not-started" && <p>Answer recorded. The task did not start. Resolve the issue below, then start the saved task.</p>}
      {receipt.status === "uncertain" && <p>Answer recorded. The start result could not be confirmed. Check status and review this conversation before sending another task.</p>}
      {receipt.error && <p className="mt-1 whitespace-pre-wrap">{receipt.error}</p>}
    </div>}
    {pending && <p role="status" className="mt-3 text-sm text-ink-secondary">{action.pending === "check" ? "Checking saved status…" : action.pending === "start" ? "Requesting task start…" : "Recording your answer…"}</p>}
    {writeBlocked && <p className="mt-3 text-sm text-ink-secondary">{writeBlocked}</p>}
    {action.error && <p role="alert" className="mt-3 whitespace-pre-wrap text-sm text-danger">{action.error}</p>}
    {(receipt || action.error || writeBlocked) && <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" onClick={onCheck} disabled={pending} className={buttonClass}>Check status</button>
      {canStart && <button type="button" onClick={onStart} disabled={pending} className={buttonClass}>Start saved task</button>}
      {canAnswer && action.error && action.lastAnswer !== undefined && <button type="button" onClick={() => onAnswer(action.lastAnswer!)} disabled={pending} className={buttonClass}>Retry same answer</button>}
    </div>}
  </section>;
}

export function UnavailableSeedCard({ card, botId }: { card: OptionCardData; botId?: string }) {
  const sendable = Boolean(botId && card.answered);
  if (card.dismissed) return null;
  return <section aria-label="Saved question" className="w-full min-w-0 max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4 [overflow-wrap:anywhere]">
    <h3 className="font-semibold text-ink">{card.title}</h3>
    <p className="mt-1 text-sm text-ink-secondary">{card.subtitle}</p>
    <ul className="mt-3 space-y-2 text-sm text-ink">{card.options.map((option, index) => <li key={`${index}:${option}`}>{option}</li>)}</ul>
    {card.answered !== undefined && <p className="mt-3 whitespace-pre-wrap text-sm text-ink">Saved answer: {card.answered}</p>}
    {/* Transcript-ack absorption: without a receipt this card is a record,
        not a prompt — it confirms the saved question continues in the
        conversation instead of dead-ending with "cannot be answered". */}
    <p role="status" className="mt-3 text-sm text-ink-secondary">Saved — this question continues in the conversation.</p>
    {/* The answer may have been recorded without its task ever starting (an
        older client's split write). A dead-end card strands that intent —
        offer to send it as an ordinary message instead. */}
    {sendable && <UnavailableSeedSend botId={botId!} answer={card.answered!} />}
  </section>;
}

/** Store-bound tail of the recovery affordance — split out so the plain
 * card still server-renders without a store provider. */
function UnavailableSeedSend({ botId, answer }: { botId: string; answer: string }) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((candidate) => candidate.id === botId);
  if (!bot || bot.busy) return null;
  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "send", botId, text: answer })}
      className="mt-3 min-h-10 rounded-lg border border-hairline/50 px-3 py-2 text-sm text-ink hover:bg-raised"
    >
      Send “{answer}” to {bot.name}
    </button>
  );
}
