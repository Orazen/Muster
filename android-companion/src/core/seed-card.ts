import { z } from "zod";
import type { CompanionState } from "./store";
import type { Message, SeedAnswerReceipt, SeedCardResult } from "./types";

// The native bundle stays independent of the server build. These constants
// mirror the versioned contract documented in docs/seed-answers.md.
export const SEED_CARD_PURPOSE = "onboarding-v1";
export const SEED_CARD_TITLE = "What do you mostly want help with?";
export const SEED_CARD_SUBTITLE = "Pick whatever's closest; we can always expand from there.";
export const SEED_CARD_OPTIONS = ["Work & projects", "Writing & research", "Life admin", "A bit of everything"];
export const seedAnswerTextSchema = z.string().max(4000).refine((answer) => answer.trim().length > 0);
export const seedAnswerReceiptSchema = z.object({
  messageId: z.string().min(1), attempt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["recorded", "starting", "started", "not-started", "uncertain"]), error: z.string().optional(),
}).strict().refine((receipt) => receipt.status === "recorded" ? receipt.attempt === 0 : receipt.attempt > 0);

// Check original wire fields BEFORE the ordinary lossy decoder removes them.
export const seedWireMetadataSchema = z.object({
  role: z.literal("bot"), kind: z.literal("options"),
  parentId: z.string().nullable().optional(), from: z.null().optional(),
  card: z.object({
    title: z.string(), subtitle: z.string().optional(), options: z.array(z.string()),
    purpose: z.string().optional(), seedAnswer: seedAnswerReceiptSchema.optional(),
    answered: z.string().nullable().optional(), dismissed: z.boolean().optional(),
    requestId: z.string().optional(), tool: z.string().optional(), held: z.string().optional(), allowKey: z.string().optional(),
  }),
});

const answerCardSchema = z.object({
  title: z.literal(SEED_CARD_TITLE), subtitle: z.literal(SEED_CARD_SUBTITLE),
  options: z.array(z.string()).refine((options) => sameOptions(options)),
  purpose: z.literal(SEED_CARD_PURPOSE).optional(),
  seedAnswer: seedAnswerReceiptSchema.optional(), answered: z.string().optional(), dismissed: z.literal(false).optional(),
  requestId: z.never().optional(), tool: z.never().optional(), held: z.never().optional(), allowKey: z.never().optional(),
});
const answerMessageSchema = z.object({
  id: z.string().min(1), role: z.literal("bot"), kind: z.literal("options"), at: z.number().finite(),
  parentId: z.string().nullable().optional(), from: z.null().optional(), card: answerCardSchema,
});
const userMessageSchema = z.object({
  id: z.string().min(1), role: z.literal("user"), kind: z.literal("text"), at: z.number().finite(),
  parentId: z.string().nullable().optional(), from: z.null().optional(), text: seedAnswerTextSchema,
});
export const seedCardResultSchema = z.object({
  ok: z.literal(true),
  outcome: z.enum(["recorded", "already-recorded", "starting", "already-requested"]).optional(),
  cardMessage: answerMessageSchema, userMessage: userMessageSchema.nullable(),
}).refine((result) => {
  const card = result.cardMessage.card;
  if (!card.seedAnswer) return !result.outcome && !result.userMessage && card.answered === undefined;
  return !!result.userMessage && card.seedAnswer.messageId !== result.cardMessage.id
    && card.seedAnswer.messageId === result.userMessage.id && card.answered === result.userMessage.text;
});

function sameOptions(options: readonly string[]): boolean {
  return options.length === SEED_CARD_OPTIONS.length && options.every((option, index) => option === SEED_CARD_OPTIONS[index]);
}
function canonical(message: Message): boolean {
  const card = message.card;
  return !message.seedContextInvalid && message.role === "bot" && message.kind === "options" && !!card && !card.seedInvalid
    && message.from == null && card.requestId === undefined && card.tool === undefined && card.held === undefined && card.allowKey === undefined
    && card.title === SEED_CARD_TITLE && card.subtitle === SEED_CARD_SUBTITLE && sameOptions(card.options);
}
export function isRecognizedSeedCard(messages: readonly Message[], message: Message): boolean {
  const card = message.card;
  if (!card || !canonical(message) || card.dismissed || (card.answered != null && !card.seedAnswer)) return false;
  if (card.seedAnswer && (!seedAnswerReceiptSchema.safeParse(card.seedAnswer).success || !seedAnswerTextSchema.safeParse(card.answered).success)) return false;
  if (card.purpose === SEED_CARD_PURPOSE) return true;
  if (card.purpose !== undefined || messages[1]?.id !== message.id) return false;
  const greeting = messages[0];
  return !!greeting && !greeting.seedContextInvalid && greeting.role === "bot" && greeting.kind === "text" && greeting.from == null
    && greeting.parentId == null && message.parentId === greeting.id
    && /^Hey — I'm .+\. Nice to meet you\.$/u.test(greeting.text ?? "");
}

export function seedCardSignature(message: Message): string {
  const card = message.card;
  return JSON.stringify([message.id, message.parentId ?? null, card?.title, card?.subtitle, card?.options]);
}

/** Never use visibleTranscript's missing-leaf fallback to authorize a write. */
function activePath(state: CompanionState, threadId: string): Message[] {
  const all = state.messages[threadId] ?? [];
  const leaf = state.leaves[threadId] ?? all.at(-1)?.id;
  if (!leaf) return [];
  const byId = new Map(all.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const result: Message[] = [];
  let message = byId.get(leaf);
  while (message) {
    if (seen.has(message.id)) return [];
    seen.add(message.id);
    result.push(message);
    message = message.parentId ? byId.get(message.parentId) : undefined;
  }
  return result.reverse();
}
export function seedCardOnActiveBranch(state: CompanionState, botId: string, threadId: string, cardId: string): Message | null {
  const bot = state.bots[botId];
  if (!bot || bot.hidden || bot.threadId !== threadId) return null;
  const all = state.messages[threadId] ?? [];
  const message = activePath(state, threadId).find((candidate) => candidate.id === cardId);
  return message && isRecognizedSeedCard(all, message) ? message : null;
}
export function seedCardWriteBlocker(state: CompanionState, botId: string, threadId: string, cardId: string): string | null {
  const message = seedCardOnActiveBranch(state, botId, threadId, cardId);
  if (!message?.card) return "Open the current bot conversation to answer this question.";
  if (state.bots[botId].busy) return "This bot is working. Wait for it to finish before starting this saved task.";
  const path = activePath(state, threadId);
  const anchor = path.findIndex((candidate) => candidate.id === (message.card?.seedAnswer?.messageId ?? cardId));
  if (anchor < 0) return "The saved answer is not on this branch. Check status to confirm its record.";
  if (message.card.seedAnswer) {
    const linked = path[anchor];
    if (linked.role !== "user" || linked.kind !== "text" || linked.text !== message.card.answered) return "The saved answer could not be confirmed. Check status before starting it.";
  }
  if (path.slice(anchor + 1).some((candidate) => candidate.role === "user")) return "This conversation contains newer work. This earlier question can no longer start a task.";
  return null;
}

export function matchesSeedCardResult(card: Message, result: SeedCardResult): boolean {
  const parsed = seedCardResultSchema.safeParse(result);
  return parsed.success && card.id === result.cardMessage.id && seedCardSignature(card) === seedCardSignature(result.cardMessage);
}
function receiptProgress(receipt: SeedAnswerReceipt): number {
  return receipt.status === "recorded" ? 0 : receipt.status === "starting" ? 1 : 2;
}
/** API may finish before an older SSE patch arrives. Neither source may undo it. */
export function preserveSeedReceipt(current: Message, incoming: Message): Message {
  const before = current.card?.seedAnswer;
  if (!before || !canonical(current)) return incoming;
  const after = incoming.card?.seedAnswer;
  if (!canonical(incoming) || seedCardSignature(current) !== seedCardSignature(incoming) || !after
    || !seedAnswerReceiptSchema.safeParse(after).success || after.messageId !== before.messageId
    || incoming.card?.answered !== current.card?.answered || after.attempt < before.attempt
    || (after.attempt === before.attempt && (receiptProgress(after) < receiptProgress(before)
      || receiptProgress(before) === 2 && after.status !== before.status))) return current;
  return incoming;
}

/** Only a new direct-child echo advances the leaf; newer branches and streams survive. */
export function mergeSeedCardResult(state: CompanionState, botId: string, threadId: string, cardId: string, result: SeedCardResult): CompanionState {
  const current = seedCardOnActiveBranch(state, botId, threadId, cardId);
  if (!current?.card || !matchesSeedCardResult(current, result) || preserveSeedReceipt(current, result.cardMessage) === current) return state;
  const all = state.messages[threadId] ?? [];
  const echo = result.userMessage;
  const existing = echo ? all.find((message) => message.id === echo.id) : undefined;
  if (echo && existing && (existing.role !== "user" || existing.kind !== "text" || existing.text !== echo.text || existing.parentId !== echo.parentId)) return state;
  const card = result.cardMessage.card!;
  const next = all.map((message) => message.id === cardId ? {
    ...message, card: { ...message.card!, purpose: card.purpose ?? message.card?.purpose, answered: card.answered, seedAnswer: card.seedAnswer },
  } : message);
  if (echo && !existing) {
    const branch = activePath(state, threadId);
    const parentIndex = branch.findIndex((message) => message.id === echo.parentId);
    const cardIndex = branch.findIndex((message) => message.id === cardId);
    if (parentIndex < cardIndex) return state;
    next.push(echo);
  }
  const leaf = state.leaves[threadId] ?? all.at(-1)?.id;
  const advances = echo && !existing && echo.parentId === leaf;
  return { ...state, messages: { ...state.messages, [threadId]: next },
    leaves: advances ? { ...state.leaves, [threadId]: echo.id } : state.leaves };
}
