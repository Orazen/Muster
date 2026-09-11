import type { Message } from "@/state/store";

/** An unresolved welcome startup recovers through its versioned card action.
 * Ordinary regenerate would fork the saved user message and lose that receipt. */
export function canRegenerateSavedTurn(messages: readonly Pick<Message, "card">[], userMessageId: string | undefined): boolean {
  if (!userMessageId) return false;
  return !messages.some(({ card }) => card?.seedAnswer?.messageId === userMessageId && card.seedAnswer.status !== "started");
}
