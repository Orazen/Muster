import { z } from "zod";

import type { JsonValue } from "./schema.ts";

export const SEED_CARD_PURPOSE = "onboarding-v1";
export const MAX_SEED_ANSWER_LENGTH = 4000;
export const SEED_CARD_TITLE = "What do you mostly want help with?";
export const SEED_CARD_SUBTITLE = "Pick whatever's closest; we can always expand from there.";
export const SEED_CARD_OPTIONS = ["Work & projects", "Writing & research", "Life admin", "A bit of everything"] as const;
export const SEED_GREETING_PATTERN = /^Hey — I'm .+\. Nice to meet you\.$/u;
export const seedAnswerStatusSchema = z.enum(["recorded", "starting", "started", "not-started", "uncertain"]);
export type SeedAnswerStatus = z.infer<typeof seedAnswerStatusSchema>;
export type SeedAnswerFinishStatus = Exclude<SeedAnswerStatus, "recorded" | "starting">;
export const seedAnswerReceiptSchema = z.object({
  messageId: z.string().min(1),
  attempt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  status: seedAnswerStatusSchema,
  error: z.string().optional(),
}).strict();
export type SeedAnswerReceipt = z.infer<typeof seedAnswerReceiptSchema>;
export interface SeedAnswerState<TMessage> {
  cardMessage: TMessage;
  userMessage: TMessage | null;
}
export interface SeedAnswerResult<TMessage> {
  outcome: "recorded" | "already-recorded";
  cardMessage: TMessage;
  userMessage: TMessage;
}
export interface SeedAnswerClaim<TMessage> {
  outcome: "claimed" | "already-claimed";
  cardMessage: TMessage;
  userMessage: TMessage;
}

export class SeedAnswerError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "SeedAnswerError";
    this.status = status;
  }
}

export const seedAnswerTextSchema = z.string().max(MAX_SEED_ANSWER_LENGTH).refine((answer) => answer.trim().length > 0);
/** Whitespace is validated, never normalized: the selected/custom text is the user's record. */
export function validateSeedAnswer(answer: JsonValue | undefined): string {
  const parsed = seedAnswerTextSchema.safeParse(answer);
  if (!parsed.success) throw new SeedAnswerError(400, "answer must be nonblank text of at most 4000 characters");
  return parsed.data;
}

export function createOnboardingCard() {
  return {
    purpose: SEED_CARD_PURPOSE,
    title: SEED_CARD_TITLE,
    subtitle: SEED_CARD_SUBTITLE,
    options: [...SEED_CARD_OPTIONS],
  };
}

/** Only the common wire fields needed to recognize a seed, usable by web clients. */
export interface SeedCardMessage {
  id: string;
  role: string;
  kind: string;
  parentId?: string | null;
  text?: string;
  from?: { botId?: string; name?: string; color?: string } | null;
  card?: {
    title: string;
    subtitle?: string | null;
    options: readonly string[];
    purpose?: string;
    requestId?: string;
    tool?: string;
    allowKey?: string;
    held?: string;
  } | null;
}

/** Legacy recognition is a bounded shape/position heuristic, not new provenance. */
export function isRecognizedSeedCard(messages: readonly SeedCardMessage[], message: SeedCardMessage): boolean {
  const card = message.card;
  if (message.role !== "bot" || message.kind !== "options" || !card) return false;
  if (card.requestId !== undefined || card.tool !== undefined || card.allowKey !== undefined || card.held !== undefined) return false;
  if (message.from !== undefined) return false;
  const canonical = createOnboardingCard();
  if (card.title !== canonical.title || card.subtitle !== canonical.subtitle || !Array.isArray(card.options)
    || card.options.length !== canonical.options.length || card.options.some((option, index) => option !== canonical.options[index])) return false;
  if (card.purpose === SEED_CARD_PURPOSE) return true;
  if (card.purpose !== undefined) return false;
  const greeting = messages[0];
  return messages[1]?.id === message.id && greeting?.role === "bot" && greeting.kind === "text"
    && greeting.parentId == null && message.parentId === greeting.id && greeting.from === undefined
    && SEED_GREETING_PATTERN.test(greeting.text ?? "");
}
