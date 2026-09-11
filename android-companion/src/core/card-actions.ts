import type { ViewedConversation } from "./store";
import { isCardPending, isPermissionCard, type Message, type OptionCard, type RequestBehavior, type RequestOutcome } from "./types";

export type { RequestOutcome } from "./types";
export type CardAction = { kind: "allow" | "deny" | "always" } | { kind: "answer"; text: string };

export interface CardReference {
  target: ViewedConversation;
  messageId: string;
  requestId: string;
  signature: string;
}

export interface CardActionState {
  reference: CardReference;
  phase: "pending" | "failed" | "settled";
  message: string | null;
  outcome: RequestOutcome | null;
  grantSaved: boolean;
}

export function cardReference(target: ViewedConversation, message: Message): CardReference | null {
  const card = message.card;
  if (message.kind !== "options" || message.role !== "bot" || !card?.requestId?.trim()) return null;
  return {
    target: { ...target }, messageId: message.id, requestId: card.requestId,
    // A live request can change its question/permission without changing a
    // message ID. Settlement alone keeps the original action identity.
    signature: JSON.stringify([
      card.title, card.subtitle ?? null, card.options, card.tool ?? null,
      card.held ?? null, card.allowKey ?? null, message.from?.botId ?? null,
    ]),
  };
}

export function cardActionKey(reference: CardReference): string {
  const { target, messageId, requestId } = reference;
  return JSON.stringify([target.kind, target.id, target.threadId, messageId, requestId]);
}

export function cardDecision(card: OptionCard, action: CardAction): { behavior: RequestBehavior; message?: string } | null {
  if (!isCardPending(card) || !card.requestId?.trim()) return null;
  if (isPermissionCard(card)) {
    if (action.kind === "allow" || action.kind === "always") return { behavior: "allow" };
    return action.kind === "deny" ? { behavior: "deny" } : null;
  }
  // Labels such as "Allow" and "Deny" remain literal question answers.
  return action.kind === "answer" && action.text.trim()
    ? { behavior: "answer", message: action.text } : null;
}

export function outcomeMessage(outcome: RequestOutcome): string {
  switch (outcome) {
    case "allowed-once": return "Allowed once.";
    case "rejected": return "Denied.";
    case "answered": return "Answer delivered.";
    case "unavailable": return "This request is no longer available. Your response was not delivered.";
  }
}
