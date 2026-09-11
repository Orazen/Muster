import { z } from "zod";
import { seedAnswerTextSchema, type SeedAnswerFinishStatus } from "./seed-card.ts";
import type { Message, Store } from "./store.ts";

const threadIdSchema = z.string().min(1).max(128).regex(/^[\w-]+$/);
export const seedAnswerInputSchema = z.object({ threadId: threadIdSchema, answer: seedAnswerTextSchema }).strict();
export const seedStartInputSchema = z.object({
  threadId: threadIdSchema,
  expectedAttempt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
}).strict();
export const seedStatusInputSchema = z.object({ threadId: threadIdSchema }).strict();

export interface SeedTurnOptions {
  threadId: string;
  userMessage: Message;
  onDispatched: () => void;
  onDispatchError: (message: string, uncertain?: boolean) => void;
}
export type SeedTurnStart = (botId: string, text: string, options: SeedTurnOptions) => Promise<void>;
export type SeedDispatchStore = Pick<Store,
  "answerSeedCard" | "claimSeedAnswerDispatch" | "finishSeedAnswerDispatch" | "seedAnswerStatus" | "messagesFor"
>;

export interface SeedDispatchReceipt {
  ok: true;
  outcome: "recorded" | "already-recorded" | "starting" | "already-requested";
  cardMessage: Message;
  userMessage: Message;
}

function reportPersistenceError(error: Error): void {
  console.error("[onboarding] Could not persist task startup status:", error.message);
}

/** Durable recording and attempt claims live in Store. This coordinator owns
 * only the first dispatch and explicit retry; reading or replaying an answer
 * never starts another turn. A process restart cannot replay this closure. */
export class SeedAnswerDispatcher {
  private readonly store: SeedDispatchStore;
  private readonly startTurn: SeedTurnStart;
  private readonly reportError: (error: Error) => void;
  constructor(
    store: SeedDispatchStore,
    startTurn: SeedTurnStart,
    reportError: (error: Error) => void = reportPersistenceError,
  ) {
    this.store = store;
    this.startTurn = startTurn;
    this.reportError = reportError;
  }

  answer(botId: string, threadId: string, cardId: string, answer: string): SeedDispatchReceipt {
    const recorded = this.store.answerSeedCard(botId, threadId, cardId, answer);
    if (recorded.outcome === "already-recorded") return { ok: true, ...recorded };
    return this.start(botId, threadId, cardId, 0);
  }

  start(botId: string, threadId: string, cardId: string, expectedAttempt: number): SeedDispatchReceipt {
    const claimed = this.store.claimSeedAnswerDispatch(botId, threadId, cardId, expectedAttempt);
    if (claimed.outcome === "already-claimed") {
      return { ok: true, outcome: "already-requested", cardMessage: claimed.cardMessage, userMessage: claimed.userMessage };
    }
    const attempt = claimed.cardMessage.card!.seedAnswer!.attempt;
    void this.launch(botId, threadId, cardId, attempt, claimed.userMessage);
    const current = this.store.messagesFor(threadId).find((message) => message.id === cardId);
    return { ok: true, outcome: "starting", cardMessage: current ?? claimed.cardMessage, userMessage: claimed.userMessage };
  }

  private async launch(botId: string, threadId: string, cardId: string, attempt: number, userMessage: Message): Promise<void> {
    const finish = (status: SeedAnswerFinishStatus, error?: string) => {
      try {
        this.store.finishSeedAnswerDispatch(threadId, cardId, attempt, status, error);
      } catch (failure) {
        // Failure to save a receipt cannot undo or interrupt an accepted turn.
        // Keep its durable starting marker; never manufacture a retryable failure.
        this.reportError(failure instanceof Error ? failure : new Error("Could not save task startup status."));
      }
    };
    try {
      await this.startTurn(botId, userMessage.text!, {
        threadId, userMessage,
        onDispatched: () => finish("started"),
        onDispatchError: (message, uncertain) => finish(uncertain ? "uncertain" : "not-started", message),
      });
    } catch (failure) {
      // startTurn throws only from its pre-driver setup. Its background driver
      // path reports separately whether invocation could already have had effects.
      finish("not-started", failure instanceof Error ? failure.message : "The task could not start.");
    }
  }
}
