import { z } from "zod";

/** The grant receipt confirms a preference save, not a provider decision. */
export const APPROVAL_ACTION_VERSION = 1;

export interface ApprovalGrantInput {
  allowKey?: unknown;
  expectedThreadId?: unknown;
  requestId?: unknown;
  cardId?: unknown;
}

interface ApprovalGrantBot {
  threadId: string;
  alwaysAllow?: string[];
}

interface ApprovalGrantMessage {
  id: string;
  role: string;
  kind: string;
  card?: {
    requestId?: string;
    tool?: string;
    allowKey?: string;
    answered?: string;
    dismissed?: boolean;
  };
}

export interface ApprovalGrantReceipt {
  threadId: string;
  requestId: string;
  cardId: string;
  allowKey: string;
}

export interface PreparedApprovalGrant {
  alwaysAllow: string[];
  grant?: ApprovalGrantReceipt;
}

const idSchema = z.string().min(1).max(128).regex(/^[\w-]+$/);
// Providers choose request IDs; unlike path IDs they may contain punctuation
// or Unicode. Validate the raw string without rewriting its correlation key.
const requestIdSchema = z.string().max(4096).refine((value) => value.trim().length > 0);
const allowKeySchema = z.string().min(1);
const tupleSchema = z.object({ expectedThreadId: idSchema, requestId: requestIdSchema, cardId: idSchema });

export class ApprovalGrantError extends Error {
  readonly status: 400 | 409;

  constructor(status: 400 | 409, message: string) {
    super(message);
    this.name = "ApprovalGrantError";
    this.status = status;
  }
}

/** Pure validation: callers must patch synchronously after this returns.
 * Legacy callers retain their whole-transcript lookup. Guarded callers bind
 * all three identifiers to one permission card on the current active path. */
export function prepareApprovalGrant(
  body: ApprovalGrantInput,
  bot: ApprovalGrantBot,
  messages: readonly ApprovalGrantMessage[],
  activePath: readonly ApprovalGrantMessage[],
): PreparedApprovalGrant {
  const key = allowKeySchema.safeParse(body.allowKey);
  if (!key.success) throw new ApprovalGrantError(400, "allowKey required");
  const guarded = ["expectedThreadId", "requestId", "cardId"].some((field) => Object.hasOwn(body, field));
  const parsed = guarded ? tupleSchema.safeParse(body) : null;
  if (parsed && !parsed.success) {
    throw new ApprovalGrantError(400, "expectedThreadId, requestId and cardId must all be valid identifiers");
  }
  const tuple = parsed?.data;
  if (tuple && tuple.expectedThreadId !== bot.threadId) {
    throw new ApprovalGrantError(409, "This conversation changed. Review its current approval before saving a grant.");
  }
  const candidates = tuple ? activePath : messages;
  const pending = candidates.find((message) => {
    const card = message.card;
    return message.role === "bot" && message.kind === "options" && card?.requestId && card.tool?.trim()
      && !card.answered && card.dismissed !== true && card.allowKey === key.data
      && (!tuple || (message.id === tuple.cardId && card.requestId === tuple.requestId));
  });
  if (!pending) {
    throw new ApprovalGrantError(409, "that grant is not on a pending approval for this bot");
  }
  const alwaysAllow = [...new Set(bot.alwaysAllow ?? [])];
  if (!alwaysAllow.includes(key.data)) {
    if (alwaysAllow.length >= 200) {
      throw new ApprovalGrantError(409, "This bot has reached its saved grant limit. Remove a grant before adding another.");
    }
    alwaysAllow.push(key.data);
  }
  if (!tuple) return { alwaysAllow };
  return {
    alwaysAllow,
    grant: { threadId: bot.threadId, requestId: tuple.requestId, cardId: tuple.cardId, allowKey: key.data },
  };
}
