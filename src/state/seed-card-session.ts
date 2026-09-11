import { z } from "zod";
import type { AppState, Message } from "./store";
import { isRecognizedSeedCard, seedAnswerReceiptSchema, seedAnswerTextSchema, type SeedAnswerReceipt } from "../../server/seed-card";

export type SeedAnswer = SeedAnswerReceipt;
export interface SeedCardReference {
  botId: string;
  threadId: string;
  messageId: string;
  signature: string;
}
const cardMessageSchema = z.object({
  id: z.string().min(1), role: z.literal("bot"), kind: z.literal("options"), at: z.number(),
  parentId: z.string().nullable().optional(),
  from: z.never().optional(),
  card: z.object({
    title: z.string(), subtitle: z.string(), options: z.array(z.string()),
    purpose: z.literal("onboarding-v1").optional(),
    requestId: z.never().optional(), tool: z.never().optional(), allowKey: z.never().optional(), held: z.never().optional(),
    dismissed: z.boolean().optional(), answered: z.string().optional(), seedAnswer: seedAnswerReceiptSchema.optional(),
  }),
});
const userMessageSchema = z.object({
  id: z.string().min(1), role: z.literal("user"), kind: z.literal("text"), text: z.string(), at: z.number(),
  parentId: z.string().nullable().optional(),
});
const resultSchema = z.object({
  ok: z.literal(true),
  outcome: z.enum(["recorded", "already-recorded", "starting", "already-requested"]).optional(),
  cardMessage: cardMessageSchema,
  userMessage: userMessageSchema.nullable(),
});
export type SeedCardResult = z.infer<typeof resultSchema>;
export type SeedCardOperation = "answer" | "start" | "check";
export interface SeedCardActionState {
  draft: string;
  pending: SeedCardOperation | null;
  error: string | null;
  lastAnswer?: string;
}
const EMPTY_ACTION: SeedCardActionState = Object.freeze({ draft: "", pending: null, error: null });
export type SeedCardActions = Readonly<Record<string, SeedCardActionState>>;

export function seedCardKey(reference: SeedCardReference): string {
  return JSON.stringify([reference.botId, reference.threadId, reference.messageId, reference.signature]);
}

function signature(message: Message): string {
  const card = message.card;
  return JSON.stringify([message.id, message.parentId ?? null, card?.title, card?.subtitle, card?.options]);
}

/** Fail closed if the currently selected branch cannot be reconstructed. */
function activePath(messages: Message[], leaf: string | null | undefined): Message[] {
  if (!leaf) return messages;
  const byId = new Map(messages.map((message) => [message.id, message]));
  const visited = new Set<string>();
  const path: Message[] = [];
  let current = byId.get(leaf);
  while (current) {
    if (visited.has(current.id)) return [];
    path.push(current);
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}
function onActiveBranch(messages: Message[], leaf: string | null | undefined, id: string): boolean {
  return activePath(messages, leaf).some((message) => message.id === id);
}

export function seedCardReference(state: AppState, botId: string, messageId: string): SeedCardReference | null {
  if (!state.rosterHydrated || !state.readSelectedMessages || state.activeView !== "chat" || state.selectedId !== botId) return null;
  const bot = state.bots.find((candidate) => candidate.id === botId && !candidate.hidden);
  const message = bot?.messages.find((candidate) => candidate.id === messageId);
  if (!bot || !message || message.card?.dismissed || !isRecognizedSeedCard(bot.messages, message)
    || !onActiveBranch(bot.messages, bot.activeLeafId, messageId)) return null;
  // Older split-write clients saved only the answer text. There is no
  // durable receipt to recover or restart; keep that settlement as history.
  if (message.card?.answered !== undefined && !message.card.seedAnswer) return null;
  return { botId, threadId: bot.threadId, messageId, signature: signature(message) };
}

function currentMessage(state: AppState, reference: SeedCardReference): Message | undefined {
  const current = seedCardReference(state, reference.botId, reference.messageId);
  if (!current || seedCardKey(current) !== seedCardKey(reference)) return undefined;
  return state.bots.find((bot) => bot.id === reference.botId)?.messages.find((message) => message.id === reference.messageId);
}

/** Status remains readable after later work; only the outdated write affordances close. */
export function seedCardWriteBlocker(state: AppState, reference: SeedCardReference): string | null {
  const message = currentMessage(state, reference);
  const bot = state.bots.find((candidate) => candidate.id === reference.botId);
  if (!message?.card || !bot) return "Open the current conversation to answer this question.";
  if (bot.busy) return "This bot is working. Wait for it to finish before answering or starting this saved task.";
  const anchorId = message.card.seedAnswer?.messageId ?? message.id;
  const path = activePath(bot.messages, bot.activeLeafId);
  const anchorIndex = path.findIndex((candidate) => candidate.id === anchorId);
  if (anchorIndex < 0) return "The saved answer is not available on this branch. Check status to confirm its record.";
  if (path.slice(anchorIndex + 1).some((candidate) => candidate.role === "user")) {
    return "This conversation already contains newer work. Continue in the conversation; this earlier question can no longer start a task.";
  }
  return null;
}

/** Fold only the receipt and its linked user echo; never rewind a newer branch/reply. */
export function mergeSeedCardResult(state: AppState, reference: SeedCardReference, result: SeedCardResult): AppState {
  const current = currentMessage(state, reference);
  if (!current?.card || !matchesResult(reference, result)) return state;
  const before = current.card.seedAnswer;
  const after = result.cardMessage.card.seedAnswer;
  if (before && (!after || after.attempt < before.attempt || (after.attempt === before.attempt
    && (before.messageId !== after.messageId || progress(before.status) > progress(after.status)
      || terminal(before.status) && before.status !== after.status)))) return state;
  return {
    ...state,
    bots: state.bots.map((bot) => {
      if (bot.id !== reference.botId || bot.threadId !== reference.threadId) return bot;
      const messages = bot.messages.map((message) => message.id === reference.messageId ? {
        ...message,
        card: { ...message.card!, purpose: result.cardMessage.card.purpose ?? message.card?.purpose,
          answered: result.cardMessage.card.answered, seedAnswer: after },
      } : message);
      const echo = result.userMessage;
      const append = echo && !messages.some((message) => message.id === echo.id);
      if (append) messages.push(echo);
      return { ...bot, messages,
        activeLeafId: append && (bot.activeLeafId === echo.parentId || !bot.activeLeafId) ? echo.id : bot.activeLeafId };
    }),
  };
}

function terminal(status: SeedAnswer["status"]): boolean {
  return status === "started" || status === "not-started" || status === "uncertain";
}
function progress(status: SeedAnswer["status"]): number {
  return status === "recorded" ? 0 : status === "starting" ? 1 : 2;
}

function matchesResult(reference: SeedCardReference, result: SeedCardResult): boolean {
  if (result.cardMessage.id !== reference.messageId || signature(result.cardMessage) !== reference.signature) return false;
  const receipt = result.cardMessage.card.seedAnswer;
  if (!receipt) return result.userMessage === null && result.cardMessage.card.answered === undefined;
  return result.userMessage?.id === receipt.messageId && result.userMessage.text === result.cardMessage.card.answered;
}

interface SeedCardDependencies {
  getState: () => AppState;
  request: (url: string, init: RequestInit) => Promise<Response>;
  apply: (reference: SeedCardReference, result: SeedCardResult) => void;
}

/** One account/provider owns this small request ledger. Nothing is sent by sync/attach/edit. */
export class SeedCardSession {
  private actions: SeedCardActions = {};
  private listeners = new Set<() => void>();
  private active = false;
  private generation = 0;
  private context = "";
  private previousLeaf: string | null = null;
  private requests = new Map<string, AbortController>();
  constructor(private readonly dependencies: SeedCardDependencies) {}
  getSnapshot = (): SeedCardActions => this.actions;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  attach(): () => void {
    this.active = true;
    this.generation++;
    return () => {
      this.active = false;
      this.generation++;
      for (const controller of this.requests.values()) controller.abort();
    };
  }
  /** Called during provider render to fence navigation away and back, without publishing. */
  sync(state: AppState): void {
    const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
    const visible = bot?.messages.flatMap((message) => {
      if (message.kind !== "options" || !isRecognizedSeedCard(bot.messages, message)) return [];
      const reference = seedCardReference(state, bot.id, message.id);
      return reference ? [seedCardKey(reference)] : [];
    }) ?? [];
    const context = JSON.stringify([state.connected, state.rosterHydrated, state.selectedId, state.activeView, state.readSelectedMessages, bot?.threadId, visible]);
    if (context !== this.context) { this.context = context; this.generation++; }
    else if (bot && this.previousLeaf && this.previousLeaf !== bot.activeLeafId
      && (!bot.activeLeafId || !onActiveBranch(bot.messages, bot.activeLeafId, this.previousLeaf))) this.generation++;
    this.previousLeaf = bot?.activeLeafId ?? null;
  }
  connectionChanged(): void { this.generation++; }
  action(reference: SeedCardReference): SeedCardActionState { return this.actions[seedCardKey(reference)] ?? EMPTY_ACTION; }
  edit(reference: SeedCardReference, draft: string): void {
    if (!this.active || !currentMessage(this.dependencies.getState(), reference)) return;
    this.publish(reference, { ...this.action(reference), draft, error: null });
  }
  answer(reference: SeedCardReference, answer: string): Promise<void> { return this.run(reference, "answer", answer); }
  start(reference: SeedCardReference): Promise<void> { return this.run(reference, "start"); }
  check(reference: SeedCardReference): Promise<void> { return this.run(reference, "check"); }
  private publish(reference: SeedCardReference, action: SeedCardActionState): void {
    this.actions = { ...this.actions, [seedCardKey(reference)]: action };
    for (const listener of this.listeners) listener();
  }
  private async run(reference: SeedCardReference, operation: SeedCardOperation, answer?: string): Promise<void> {
    const physicalKey = JSON.stringify([reference.botId, reference.threadId, reference.messageId]);
    const state = this.dependencies.getState();
    const message = currentMessage(state, reference);
    if (!this.active || !message?.card || this.requests.has(physicalKey)) return;
    const receipt = message.card.seedAnswer;
    const writeBlocker = operation === "check" ? null : seedCardWriteBlocker(state, reference);
    if (writeBlocker) {
      this.publish(reference, { ...this.action(reference), error: writeBlocker });
      return;
    }
    if (operation === "answer" && !seedAnswerTextSchema.safeParse(answer).success) {
      this.publish(reference, { ...this.action(reference), error: "Enter an answer of up to 4,000 characters." });
      return;
    }
    if (operation === "answer" && message.card.answered && message.card.answered !== answer) return;
    if (operation === "start" && (!receipt || !["recorded", "not-started"].includes(receipt.status))) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.requests.set(physicalKey, controller);
    this.publish(reference, { ...this.action(reference), pending: operation, error: null,
      lastAnswer: operation === "answer" ? answer : this.action(reference).lastAnswer });
    const timer = setTimeout(() => controller.abort(), 10_000);
    let stopListening = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new Error("Request cancelled."));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      stopListening = () => controller.signal.removeEventListener("abort", onAbort);
    });
    const isCurrent = () => this.active && this.generation === generation && !!currentMessage(this.dependencies.getState(), reference);
    try {
      const base = `/api/bots/${encodeURIComponent(reference.botId)}/cards/${encodeURIComponent(reference.messageId)}/answer`;
      const url = operation === "check" ? `${base}?threadId=${encodeURIComponent(reference.threadId)}` : operation === "start" ? `${base}/start` : base;
      const exchange = this.dependencies.request(url, {
        method: operation === "check" ? "GET" : "POST", signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: operation === "check" ? undefined : JSON.stringify(operation === "start" ? { threadId: reference.threadId, expectedAttempt: receipt!.attempt } : { threadId: reference.threadId, answer }),
      }).then(async (response) => ({ response, body: await response.json().catch(() => null) }));
      const { response, body } = await Promise.race([exchange, aborted]);
      if (!response.ok) {
        const failure = z.object({ error: z.string().min(1) }).safeParse(body);
        throw new Error(failure.success ? failure.data.error : `Request failed (${response.status}).`);
      }
      const parsed = resultSchema.safeParse(body);
      if (!parsed.success || !matchesResult(reference, parsed.data)
        || operation !== "check" && (!parsed.data.outcome || !parsed.data.userMessage || !parsed.data.cardMessage.card.seedAnswer)
        || operation === "answer" && parsed.data.userMessage?.text !== answer
        || operation === "start" && parsed.data.userMessage?.id !== receipt?.messageId) {
        throw new Error("The server returned an unrecognized answer receipt.");
      }
      if (!isCurrent()) return;
      this.dependencies.apply(reference, parsed.data);
      this.publish(reference, { ...this.action(reference), pending: null, error: null });
    } catch (error) {
      if (isCurrent()) this.publish(reference, { ...this.action(reference), pending: null,
        error: `${controller.signal.aborted ? "The request timed out." : error instanceof Error ? error.message : "The request failed."} ${operation === "check" ? "Check status again when the connection recovers." : "Check status before trying again; the server may have recorded this request."}` });
    } finally {
      clearTimeout(timer);
      stopListening();
      this.requests.delete(physicalKey);
      if (this.active && !isCurrent() && this.action(reference).pending) this.publish(reference, { ...this.action(reference), pending: null });
    }
  }
}
