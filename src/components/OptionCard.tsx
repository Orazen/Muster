import { useEffect, useState } from "react";
import { ApprovalWhyDetails } from "./ApprovalWhyDetails";
import { X } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { seedCardKey, seedCardReference } from "@/state/seed-card-session";
import { SeedOptionCard, UnavailableSeedCard } from "./SeedOptionCard";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

interface OptionCardProps {
  botId: string;
  message: Message;
  hotkeys?: boolean;
}

export function OptionCard(props: OptionCardProps) {
  const { state } = useStore();
  if (!props.message.card) return null;
  if (props.message.card.requestId) return <LiveOptionCard {...props} />;
  const reference = seedCardReference(state, props.botId, props.message.id);
  return reference ? <SeedOptionCard key={seedCardKey(reference)} reference={reference} card={props.message.card} hotkeys={props.hotkeys ?? false} />
    : <UnavailableSeedCard card={props.message.card} />;
}

function LiveOptionCard({
  botId,
  message,
  hotkeys = false,
}: {
  botId: string;
  message: Message;
  /** A–F answers the matching option. ChatView enables it only for the
   * newest pending card in the mounted transcript, so two stacked cards
   * can never race for one keypress. */
  hotkeys?: boolean;
}) {
  const { dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const card = message.card;

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
  };

  // Letter hotkeys. The handler stays out of the way of every editable
  // surface — the composer, this card's own free-text field, the find bar —
  // and of any chord with a modifier held (⌘A must stay select-all).
  useEffect(() => {
    if (!hotkeys || !card || card.dismissed || card.answered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable]")
      ) {
        return;
      }
      const index = LETTERS.indexOf(event.key.toUpperCase());
      if (index < 0 || index >= card.options.length) return;
      event.preventDefault();
      answer(card.options[index]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys, card, answer]);

  if (!card || card.dismissed) return null;

  return (
    <div className="w-full max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[16px] font-semibold text-ink">{card.title}</div>
          <div className="mt-0.5 text-[14px] text-ink-secondary">
            {card.subtitle}
          </div>
        </div>
        <button
          onClick={() =>
            dispatch({ type: "dismissCard", botId, messageId: message.id })
          }
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {card.why && <ApprovalWhyDetails why={card.why} />}
      {card.rehearsal && (
        <p className="mt-2 text-[12px] text-ink-secondary">{card.rehearsal.summary}</p>
      )}
      <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
        {card.options.map((opt, i) => (
          <button
            key={opt}
            disabled={!!card.answered}
            onClick={() => answer(opt)}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] text-ink",
              i > 0 && "border-t border-hairline/40",
              card.answered === opt
                ? "bg-raised"
                : "hover:bg-raised/60 disabled:hover:bg-transparent",
            )}
          >
            <span
              title={hotkeys && !card.answered ? `Press ${LETTERS[i]}` : undefined}
              className="flex size-6 items-center justify-center rounded-md bg-raised text-[12px] font-medium text-ink-secondary"
            >
              {LETTERS[i]}
            </span>
            {opt}
          </button>
        ))}
      </div>

      {/* a permission ask has no free-text answer — the broker only accepts
          allow/deny, so typing here used to fail silently */}
      {!card.answered && !card.tool && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && answer(custom)}
          placeholder="Type your own answer"
          className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
        />
      )}
    </div>
  );
}
