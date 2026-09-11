// Owns one mounted companion's connection and asynchronous state boundaries.
import { APIError } from "../core/client";
import type { Connection, MusterClient } from "../core/client";
import type { PairResponse, SeedCardResult } from "../core/types";
import { isCardPending, type Message } from "../core/types";
import { cardActionKey, cardDecision, cardReference, outcomeMessage, type CardAction, type CardActionState, type CardReference } from "../core/card-actions";
import type { Frame } from "../core/frames";
import {
  acknowledgeViewed, applyFrame, hydrate, initialState, markViewed, prependPage, setCursor, visibleTranscript,
} from "../core/store";
import type { CompanionState, ViewedConversation } from "../core/store";
import { matchesSeedCardResult, mergeSeedCardResult, seedCardOnActiveBranch, seedCardSignature, seedCardWriteBlocker } from "../core/seed-card";

export type ChatTarget = ViewedConversation;

export interface PairInput {
  address: string;
  credential?: string;
  code?: string;
  deviceName?: string;
}

export type CompanionClient = Pick<MusterClient,
  "fleet" | "messages" | "events" | "sendToBot" | "sendToGroup" | "respond" | "alwaysAllow" | "markBotRead" | "markGroupRead"
  | "answerSeedCard" | "seedCardStatus" | "startSeedCard"
>;

export interface SeedReference { botId: string; threadId: string; cardId: string; signature: string }
export type SeedAction = { kind: "answer"; text: string } | { kind: "check" } | { kind: "start" };
export interface SeedActionState {
  reference: SeedReference;
  phase: "pending" | "failed" | "settled";
  operation: SeedAction["kind"];
  message: string | null;
  lastAnswer?: string;
  /** A timed-out transport may still be closing; keep the physical request single-flight. */
  inFlight?: boolean;
}
export function seedActionKey(reference: SeedReference): string {
  return JSON.stringify([reference.botId, reference.threadId, reference.cardId]);
}
export function seedReference(state: CompanionState, target: ChatTarget, message: Message): SeedReference | null {
  if (target.kind !== "bot") return null;
  const current = seedCardOnActiveBranch(state, target.id, target.threadId, message.id);
  if (!current || seedCardSignature(current) !== seedCardSignature(message)) return null;
  return { botId: target.id, threadId: target.threadId, cardId: message.id, signature: seedCardSignature(current) };
}

export interface ChatSelection { client: CompanionClient | null; target: ChatTarget }

export function currentChatTarget(
  selection: ChatSelection | null, client: CompanionClient | null, state: CompanionState,
): ChatTarget | null {
  if (!client || selection?.client !== client) return null;
  const target = selection.target;
  if (target.kind === "bot") {
    const bot = state.bots[target.id];
    return bot && !bot.hidden && bot.threadId === target.threadId ? target : null;
  }
  return state.rooms[target.id]?.threadId === target.threadId ? target : null;
}

export interface ConnectionStorage {
  load(): Promise<Connection | null>;
  save(connection: Connection | null): Promise<void>;
}

/** Shared by remounts so a late old credential write cannot overtake a
 * newer pair/unpair. Rejections do not block subsequent recovery writes. */
export class ConnectionPersistence {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: ConnectionStorage) {}

  async load(): Promise<Connection | null> {
    await this.tail;
    return this.storage.load();
  }

  write(connection: Connection | null, current: () => boolean): Promise<boolean> {
    const job = this.tail.then(async () => {
      if (!current()) return false;
      await this.storage.save(connection);
      return current();
    });
    this.tail = job.then(() => undefined, () => undefined);
    return job;
  }
}

export interface CompanionDependencies {
  persistence: ConnectionPersistence;
  createClient(connection: Connection): CompanionClient;
  pair(input: PairInput): Promise<{ connection: Connection; response: PairResponse }>;
}

export interface CompanionSnapshot {
  client: CompanionClient | null;
  state: CompanionState;
  connected: boolean;
  connecting: boolean;
  pairing: boolean;
  pairError: string | null;
  readError: { target: ChatTarget; message: string } | null;
  cardActions: Record<string, CardActionState>;
  seedActions: Record<string, SeedActionState>;
}

function emptySnapshot(): CompanionSnapshot {
  return { client: null, state: initialState(), connected: false, connecting: false, pairing: false, pairError: null, readError: null, cardActions: {}, seedActions: {} };
}

interface FleetRecovery {
  client: CompanionClient;
  generation: number;
  revision: number;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}
type RefreshResult = "applied" | "stale" | "failed" | "inactive";

interface ConversationView {
  client: CompanionClient;
  target: ChatTarget;
  generation: number;
  focus: number;
  revision: number;
  acknowledged: number;
  attempts: number;
  retry: ReturnType<typeof setTimeout> | null;
}
interface ReadAttempt {
  view: ConversationView;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  timedOut: boolean;
}
const READ_TIMEOUT_MS = 10_000;
const READ_ATTEMPTS = 3;
const readKey = (target: ChatTarget): string => JSON.stringify([target.kind, target.id, target.threadId]);

interface CardOperation {
  client: CompanionClient;
  reference: CardReference;
  generation: number;
  grantSaved: boolean;
}
const requestKey = (reference: CardReference): string => JSON.stringify([reference.target.threadId, reference.requestId]);

interface SeedOperation {
  client: CompanionClient;
  reference: SeedReference;
  generation: number;
  view: ConversationView;
  focus: number;
  kind: SeedAction["kind"];
  abort: AbortController;
  invalidated: boolean;
  timedOut: boolean;
  transportPending: boolean;
  finished: boolean;
}
const SEED_TIMEOUT_MS = 10_000;

export class CompanionSession {
  private snapshot = emptySnapshot();
  private listeners = new Set<() => void>();
  private active = false;
  private generation = 0;
  private dataRevision = 0;
  private fleetRequest = 0;
  private pageRequests = new Map<string, number>();
  private stopStream: (() => void) | null = null;
  private recovery: FleetRecovery | null = null;
  private foreground = false;
  private view: ConversationView | null = null;
  private readAttempts = new Map<string, ReadAttempt>();
  private cardRequests = new Map<string, CardOperation>();
  private seedRequests = new Map<string, SeedOperation>();

  constructor(private readonly dependencies: CompanionDependencies) {}

  getSnapshot = (): CompanionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private current(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  private update(patch: Partial<CompanionSnapshot>): void {
    if (!this.active) return;
    const previous = this.snapshot.state;
    this.snapshot = { ...this.snapshot, ...patch };
    if (patch.state) this.reconcileSeeds(previous);
    for (const listener of this.listeners) listener();
  }

  private reset(pairing = false, pairError: string | null = null): number {
    const generation = ++this.generation;
    const stop = this.stopStream;
    this.stopStream = null;
    stop?.();
    this.cancelRecovery();
    this.clearViews();
    this.cardRequests.clear();
    this.cancelSeeds();
    this.seedRequests.clear();
    this.dataRevision++;
    this.pageRequests.clear();
    this.update({ ...emptySnapshot(), pairing, pairError });
    return generation;
  }

  start = async (): Promise<void> => {
    this.active = true;
    const generation = this.reset();
    try {
      const connection = await this.dependencies.persistence.load();
      if (connection && this.current(generation)) this.activate(connection, generation);
    } catch (error) {
      if (this.current(generation)) {
        this.update({ pairError: error instanceof Error ? error.message : "Could not read the saved connection. Pair again." });
      }
    }
  };

  dispose = (): void => {
    if (!this.active) return;
    const pendingPair = this.snapshot.pairing;
    this.active = false;
    ++this.generation;
    this.stopStream?.();
    this.stopStream = null;
    this.cancelRecovery();
    this.clearViews();
    this.cardRequests.clear();
    this.cancelSeeds();
    this.seedRequests.clear();
    // Queue immediately on the shared writer, before a new mount can write.
    // An established connection remains available for normal app restarts.
    if (pendingPair) void this.dependencies.persistence.write(null, () => true).catch(() => undefined);
  };

  private activate(connection: Connection, generation: number): void {
    if (!this.current(generation)) return;
    const client = this.dependencies.createClient(connection);
    this.update({ client, connecting: true, connected: false });
    // Hydrate before opening the stream so the first snapshot cannot erase
    // events whose cursor has already been committed.
    void this.refreshWith(client, generation).then(() => {
      if (!this.current(generation)) return;
      try {
        let sawHello = false;
        const handle = client.events(
          this.snapshot.state.cursor,
          (frame) => {
            if (!this.current(generation)) return;
            if (frame.kind === "hello") {
              if (sawHello) this.cancelSeeds();
              sawHello = true;
              if (!frame.resumed) this.recoverFleet(client, generation);
              return;
            }
            const previous = this.snapshot.state;
            const state = applyFrame(previous, frame);
            if (state !== this.snapshot.state) {
              this.dataRevision++;
              this.update({ state });
            }
            this.reconcileView(frame, previous);
          },
          (cursor) => {
            if (!this.current(generation)) return;
            this.dataRevision++;
            this.update({ state: setCursor(this.snapshot.state, cursor) });
          },
          (status) => {
            if (this.current(generation)) {
              if (this.snapshot.connected && status !== "connected") this.cancelSeeds();
              if (status === "unauthorized") {
                void this.clear("Connection expired or was revoked. Pair again.");
                return;
              }
              const reconnected = status === "connected" && !this.snapshot.connected;
              this.update({ connected: status === "connected", connecting: status === "connecting" });
              if (reconnected && this.view && this.foreground) this.queueRead(this.view, true);
            }
          },
        );
        if (this.current(generation)) this.stopStream = handle.stop;
        else handle.stop();
      } catch {
        if (this.current(generation)) this.update({ connected: false, connecting: false });
      }
    });
  }

  private cancelRecovery(): void {
    const timer = this.recovery?.timer;
    if (timer != null) clearTimeout(timer);
    this.recovery = null;
  }

  private recoverFleet(client: CompanionClient, generation: number): void {
    if (this.recovery?.generation === generation) {
      this.recovery.revision++;
      return;
    }
    const recovery: FleetRecovery = { client, generation, revision: 0, attempts: 0, timer: null };
    this.recovery = recovery;
    // handleEvent commits hello's cursor after calling onFrame. Defer the
    // GET so that cursor does not invalidate its own recovery snapshot.
    void Promise.resolve().then(() => this.runRecovery(recovery));
  }

  private async runRecovery(recovery: FleetRecovery): Promise<void> {
    if (!this.current(recovery.generation) || this.recovery !== recovery) return;
    const revision = recovery.revision;
    const result = await this.refreshWith(recovery.client, recovery.generation);
    if (!this.current(recovery.generation) || this.recovery !== recovery) return;
    if (result === "applied" && revision === recovery.revision) {
      this.recovery = null;
      return;
    }
    // Keep newer SSE data intact, then retry the required snapshot. One
    // request at a time; retries back off from 250ms to a 2s ceiling.
    const delay = Math.min(250 * 2 ** Math.min(recovery.attempts++, 3), 2_000);
    recovery.timer = setTimeout(() => {
      recovery.timer = null;
      void this.runRecovery(recovery);
    }, delay);
  }

  private requestFailed(error: Error, generation: number): void {
    if (!this.current(generation)) return;
    if (error instanceof APIError && (error.status === 401 || error.status === 403)) {
      void this.clear("Connection expired or was revoked. Pair again.");
    }
  }

  private async refreshWith(client: CompanionClient, generation: number): Promise<RefreshResult> {
    const request = ++this.fleetRequest;
    const revision = this.dataRevision;
    try {
      const fleet = await client.fleet();
      if (!this.current(generation)) return "inactive";
      if (this.current(generation) && request === this.fleetRequest && revision === this.dataRevision) {
        this.dataRevision++;
        this.update({ state: hydrate(this.snapshot.state, fleet) });
        this.reconcileView("hydrate");
        return "applied";
      }
      return "stale";
    } catch (error) {
      this.requestFailed(error instanceof Error ? error : new Error("Could not refresh the fleet."), generation);
      return this.current(generation) ? "failed" : "inactive";
    }
  }

  refresh = async (): Promise<void> => {
    const client = this.snapshot.client;
    if (this.active && client) await this.refreshWith(client, this.generation);
  };

  async refreshCards(client: CompanionClient | null): Promise<void> {
    if (!this.owns(client)) return;
    const generation = this.generation;
    const result = await this.refreshWith(client, generation);
    if (!this.current(generation) || !this.owns(client)) return;
    if (result === "failed") throw new Error("Could not load the latest request status. Check your connection and try again.");
    if (result === "stale") throw new Error("The conversation changed while checking its status. Check again for the latest request.");
  }

  pair = async (input: PairInput): Promise<{ response: PairResponse } | null> => {
    if (!this.active) return null;
    const generation = this.reset(true);
    try {
      // Clear the old binding first; a failed new attempt must not restore
      // the previous account on a future boot.
      if (!await this.dependencies.persistence.write(null, () => this.current(generation))) return null;
      const { connection, response } = await this.dependencies.pair(input);
      if (!this.current(generation)) return null;
      if (!await this.dependencies.persistence.write(connection, () => this.current(generation))) return null;
      this.activate(connection, generation);
      return { response };
    } catch (error) {
      if (this.current(generation)) this.update({ pairError: error instanceof Error ? error.message : "Pairing failed" });
      return null;
    } finally {
      if (this.current(generation)) this.update({ pairing: false });
    }
  };

  private async clear(reason: string | null): Promise<void> {
    if (!this.active) return;
    const generation = this.reset(false, reason);
    try {
      // A requested deletion survives unmount. The shared writer queues it
      // now, ahead of any credentials submitted by a later pairing.
      await this.dependencies.persistence.write(null, () => true);
    } catch (error) {
      if (this.current(generation)) {
        const detail = error instanceof Error ? error.message : "Storage unavailable";
        this.update({ pairError: `Could not remove the saved connection: ${detail}` });
      }
    }
  }

  unpair = async (): Promise<void> => { await this.clear(null); };

  private owns(client: CompanionClient | null): client is CompanionClient {
    return this.active && client !== null && this.snapshot.client === client;
  }

  private activeThread(threadId: string): boolean {
    return Object.values(this.snapshot.state.bots).some((bot) => !bot.hidden && bot.threadId === threadId)
      || Object.values(this.snapshot.state.rooms).some((room) => room.threadId === threadId);
  }

  async send(client: CompanionClient | null, target: ChatTarget, text: string): Promise<boolean> {
    if (!this.owns(client) || !currentChatTarget({ client, target }, client, this.snapshot.state)) return false;
    const generation = this.generation;
    if (target.kind === "bot") await client.sendToBot(target.id, text);
    else await client.sendToGroup(target.id, text);
    return this.current(generation) && this.owns(client)
      && currentChatTarget({ client, target }, client, this.snapshot.state) !== null;
  }

  private cardMessage(client: CompanionClient | null, reference: CardReference): Message | null {
    if (!this.owns(client) || !currentChatTarget({ client, target: reference.target }, client, this.snapshot.state)) return null;
    const message = visibleTranscript(this.snapshot.state, reference.target.threadId).find((entry) => entry.id === reference.messageId);
    const current = message ? cardReference(reference.target, message) : null;
    return message && current && cardActionKey(current) === cardActionKey(reference)
      && current.signature === reference.signature ? message : null;
  }

  private viewingCard(client: CompanionClient, reference: CardReference): boolean {
    const view = this.view;
    return this.foreground && view !== null && this.currentView(view) && view.client === client
      && readKey(view.target) === readKey(reference.target);
  }

  private currentCardOperation(operation: CardOperation): boolean {
    return this.current(operation.generation) && this.owns(operation.client)
      && this.cardRequests.get(requestKey(operation.reference)) === operation;
  }

  private publishCard(operation: CardOperation, state: Omit<CardActionState, "reference" | "grantSaved">): void {
    if (!this.currentCardOperation(operation) || !this.cardMessage(operation.client, operation.reference)) return;
    this.update({ cardActions: {
      ...this.snapshot.cardActions,
      [cardActionKey(operation.reference)]: { ...state, reference: operation.reference, grantSaved: operation.grantSaved },
    } });
  }

  private roomCardOwner(reference: CardReference, message: Message): boolean {
    if (reference.target.kind !== "room") return true;
    const speaker = this.snapshot.state.rooms[reference.target.id]?.busyBotId;
    return !!speaker && message.from?.botId === speaker;
  }

  async actOnCard(client: CompanionClient | null, input: CardReference, action: CardAction): Promise<void> {
    if (!this.owns(client) || !this.viewingCard(client, input)) return;
    const message = this.cardMessage(client, input);
    const card = message?.card;
    if (!message || !card || !isCardPending(card) || this.cardRequests.has(requestKey(input))) return;
    const previous = this.snapshot.cardActions[cardActionKey(input)];
    if (previous?.phase === "settled" && previous.reference.signature === input.signature) return;
    const reference = { ...input, target: { ...input.target } };
    const operation: CardOperation = { client, reference, generation: this.generation, grantSaved: false };
    this.cardRequests.set(requestKey(reference), operation);
    const decision = cardDecision(card, action);
    try {
      if (!decision || !this.roomCardOwner(reference, message)
        || (action.kind === "always" && (reference.target.kind !== "bot" || !card.allowKey?.trim()))) {
        this.publishCard(operation, {
          phase: "failed", outcome: null,
          message: action.kind === "answer" && !action.text.trim()
            ? "Enter an answer before sending."
            : "This response does not match the current request. Check its status before responding.",
        });
        return;
      }
      this.publishCard(operation, { phase: "pending", message: null, outcome: null });
      const live = this.cardMessage(client, reference);
      if (!this.currentCardOperation(operation) || !this.viewingCard(client, reference)
        || !live?.card || !isCardPending(live.card) || !this.roomCardOwner(reference, live)) return;
      // A persistent grant is a separate mutation. Never claim it was saved or
      // release the pending permission before the computer accepts that write.
      if (action.kind === "always" && card.allowKey) {
        await client.alwaysAllow(reference.target.id, card.allowKey);
        if (!this.currentCardOperation(operation)) return;
        operation.grantSaved = true;
        this.publishCard(operation, { phase: "pending", outcome: null, message: null });
        const current = this.cardMessage(client, reference);
        if (!current?.card || !isCardPending(current.card) || !this.viewingCard(client, reference)) {
          this.publishCard(operation, {
            phase: "failed", outcome: null,
            message: "The preference was saved, but this request was not approved here. Check its status before responding.",
          });
          return;
        }
      }
      const outcome = await client.respond(reference.target.threadId, reference.requestId, decision.behavior, decision.message);
      this.publishCard(operation, { phase: "settled", outcome, message: outcomeMessage(outcome) });
    } catch (failure) {
      if (!this.currentCardOperation(operation)) return;
      const error = failure instanceof Error ? failure : new Error("Could not confirm the response.");
      if (error instanceof APIError && (error.status === 401 || error.status === 403)) {
        this.requestFailed(error, operation.generation);
        return;
      }
      const definiteFailure = error instanceof APIError && error.status >= 400 && error.status < 500 && error.status !== 408;
      const prefix = operation.grantSaved ? "The preference was saved. " : "";
      const grantFailed = action.kind === "always" && !operation.grantSaved;
      const detail = grantFailed
        ? `${definiteFailure ? "The computer rejected the preference change." : "Could not confirm whether the preference was saved."} No approval response was sent. Check the request before approving it.`
        : `${prefix}${definiteFailure ? "The response was not accepted." : "Could not confirm whether the response was delivered. Check its status before trying again."}`;
      this.publishCard(operation, {
        phase: "failed", outcome: null,
        // A proxy failure can arrive after the computer accepted the write.
        // Its generic diagnosis cannot establish why delivery is uncertain.
        message: definiteFailure ? `${detail} ${error.message}` : detail,
      });
    } finally {
      if (this.cardRequests.get(requestKey(reference)) === operation) {
        this.cardRequests.delete(requestKey(reference));
        const key = cardActionKey(reference);
        const state = this.snapshot.cardActions[key];
        // If the ask changed while awaiting transport, discard only its old
        // pending indicator. A new card/result is never overwritten.
        if (this.current(operation.generation) && state?.phase === "pending"
          && state.reference.signature === reference.signature) {
          const cardActions = { ...this.snapshot.cardActions };
          delete cardActions[key];
          this.update({ cardActions });
        }
      }
    }
  }

  private seedMessage(client: CompanionClient | null, reference: SeedReference): Message | null {
    if (!this.owns(client)) return null;
    const message = seedCardOnActiveBranch(this.snapshot.state, reference.botId, reference.threadId, reference.cardId);
    return message && seedCardSignature(message) === reference.signature ? message : null;
  }

  private currentSeedOperation(operation: SeedOperation): boolean {
    return !operation.invalidated && this.current(operation.generation) && this.owns(operation.client)
      && this.seedRequests.get(seedActionKey(operation.reference)) === operation
      && this.currentView(operation.view) && this.foreground && operation.view.focus === operation.focus
      && !!this.seedMessage(operation.client, operation.reference);
  }

  private cancelSeeds(view?: ConversationView): void {
    for (const operation of this.seedRequests.values()) {
      if (view && operation.view !== view) continue;
      operation.invalidated = true;
      operation.abort.abort();
    }
  }

  private reconcileSeeds(previous: CompanionState): void {
    for (const operation of this.seedRequests.values()) {
      const threadId = operation.reference.threadId;
      const previousLeaf = previous.leaves[threadId];
      const branchChanged = previousLeaf && previousLeaf !== this.snapshot.state.leaves[threadId]
        && !visibleTranscript(this.snapshot.state, threadId).some((message) => message.id === previousLeaf);
      if (!this.currentSeedOperation(operation) || branchChanged) {
        operation.invalidated = true;
        operation.abort.abort();
      }
    }
  }

  private publishSeed(operation: SeedOperation, phase: SeedActionState["phase"], message: string | null, answer?: string): void {
    if (!this.currentSeedOperation(operation)) return;
    const key = seedActionKey(operation.reference);
    const previous = this.snapshot.seedActions[key];
    const lastAnswer = answer ?? (previous?.reference.signature === operation.reference.signature ? previous.lastAnswer : undefined);
    this.update({ seedActions: { ...this.snapshot.seedActions, [key]: {
      reference: operation.reference, operation: operation.kind, phase, message, lastAnswer,
      inFlight: operation.transportPending,
    } } });
  }

  private async seedRequest(operation: SeedOperation, request: () => Promise<SeedCardResult>): Promise<SeedCardResult> {
    let onAbort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Saved answer request cancelled."));
      operation.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => { operation.timedOut = true; operation.abort.abort(); }, SEED_TIMEOUT_MS);
    try {
      operation.transportPending = true;
      let requestPromise: Promise<SeedCardResult>;
      try { requestPromise = request(); }
      catch (error) { operation.transportPending = false; throw error; }
      const observed = requestPromise.then((result) => {
        operation.transportPending = false;
        this.finishSeedOperation(operation);
        return result;
      }, (error) => {
        operation.transportPending = false;
        this.finishSeedOperation(operation);
        throw error;
      });
      return await Promise.race([observed, cancelled]);
    } finally {
      clearTimeout(timer);
      operation.abort.signal.removeEventListener("abort", onAbort);
    }
  }

  private finishSeedOperation(operation: SeedOperation): void {
    const key = seedActionKey(operation.reference);
    if (!operation.finished || this.seedRequests.get(key) !== operation) return;
    const state = this.snapshot.seedActions[key];
    const ownsState = this.current(operation.generation) && state?.reference.signature === operation.reference.signature;
    if (operation.transportPending) {
      if (ownsState && state.phase === "pending") this.update({ seedActions: { ...this.snapshot.seedActions, [key]: {
        ...state, phase: "failed", inFlight: true,
        message: "The previous request is still closing. Check status after it finishes.",
      } } });
      return;
    }
    this.seedRequests.delete(key);
    if (!ownsState) return;
    const seedActions = { ...this.snapshot.seedActions };
    if (state.phase === "pending") delete seedActions[key];
    else seedActions[key] = { ...state, inFlight: false };
    this.update({ seedActions });
  }

  /** Welcome answers have durable receipts, not live request IDs. Each click makes at most one request. */
  async actOnSeed(client: CompanionClient | null, input: SeedReference, action: SeedAction): Promise<void> {
    const view = this.view;
    if (!this.owns(client) || !view || !this.currentView(view) || !this.foreground
      || view.client !== client || view.target.kind !== "bot" || view.target.id !== input.botId
      || view.target.threadId !== input.threadId || this.seedRequests.has(seedActionKey(input))) return;
    const initial = this.seedMessage(client, input);
    if (!initial?.card) return;
    const reference = { ...input };
    const operation: SeedOperation = {
      client, reference, generation: this.generation, view, focus: view.focus, kind: action.kind,
      abort: new AbortController(), invalidated: false, timedOut: false,
      transportPending: false, finished: false,
    };
    const key = seedActionKey(reference);
    this.seedRequests.set(key, operation);
    try {
      if (action.kind === "answer" && (!action.text.trim() || action.text.length > 4000)) {
        this.publishSeed(operation, "failed", "Enter a nonblank answer of up to 4,000 characters.");
        return;
      }
      if (action.kind === "answer" && initial.card.answered != null && initial.card.answered !== action.text) {
        this.publishSeed(operation, "failed", "This question already has a saved answer. Check its status before continuing.");
        return;
      }
      const receipt = initial.card.seedAnswer;
      if (action.kind === "start" && (!receipt || (receipt.status !== "recorded" && receipt.status !== "not-started"))) {
        this.publishSeed(operation, "failed", "This saved task cannot be started again. Check status and review the conversation.");
        return;
      }
      this.publishSeed(operation, "pending", null, action.kind === "answer" ? action.text : undefined);
      // A subscriber may navigate, unpair or receive a new server state while pending is published.
      if (!this.currentSeedOperation(operation)) return;
      const current = this.seedMessage(client, reference);
      if (!current?.card) return;
      if (action.kind !== "check") {
        const blocked = seedCardWriteBlocker(this.snapshot.state, reference.botId, reference.threadId, reference.cardId);
        if (blocked) { this.publishSeed(operation, "failed", blocked); return; }
      }
      if (action.kind === "start" && (current.card.seedAnswer?.attempt !== receipt?.attempt || current.card.seedAnswer?.status !== receipt?.status)) {
        this.publishSeed(operation, "failed", "The saved task changed. Check its status before starting it.");
        return;
      }
      const result = await this.seedRequest(operation, () => action.kind === "answer"
        ? client.answerSeedCard(reference.botId, reference.cardId, reference.threadId, action.text, operation.abort.signal)
        : action.kind === "check"
          ? client.seedCardStatus(reference.botId, reference.cardId, reference.threadId, operation.abort.signal)
          : client.startSeedCard(reference.botId, reference.cardId, reference.threadId, receipt!.attempt, operation.abort.signal));
      if (!this.currentSeedOperation(operation)) return;
      const fresh = this.seedMessage(client, reference);
      if (!fresh || !matchesSeedCardResult(fresh, result)
        || action.kind !== "check" && (!result.outcome || !result.userMessage || !result.cardMessage.card?.seedAnswer)
        || action.kind === "answer" && result.userMessage?.text !== action.text
        || action.kind === "start" && result.userMessage?.id !== receipt?.messageId) {
        throw new Error("Your computer returned an unrecognized saved-answer receipt.");
      }
      const state = mergeSeedCardResult(this.snapshot.state, reference.botId, reference.threadId, reference.cardId, result);
      const returnedReceipt = result.cardMessage.card?.seedAnswer;
      if (returnedReceipt) {
        const currentCard = seedCardOnActiveBranch(state, reference.botId, reference.threadId, reference.cardId)?.card;
        const transcript = visibleTranscript(state, reference.threadId);
        const cardIndex = transcript.findIndex((message) => message.id === reference.cardId);
        const echoIndex = transcript.findIndex((message) => message.id === returnedReceipt.messageId);
        const echo = transcript[echoIndex];
        if (currentCard?.seedAnswer?.messageId !== returnedReceipt.messageId || currentCard.answered !== result.cardMessage.card?.answered
          || cardIndex < 0 || echoIndex <= cardIndex || !echo || echo.role !== "user" || echo.kind !== "text"
          || echo.text !== currentCard.answered || echo.parentId !== result.userMessage?.parentId) {
          throw new Error("The saved answer could not be matched to this conversation. Check its status.");
        }
      }
      if (state !== this.snapshot.state) {
        this.dataRevision++;
        this.update({ state });
      }
      this.publishSeed(operation, "settled", null);
    } catch (failure) {
      if (!this.currentSeedOperation(operation)) return;
      const error = failure instanceof Error ? failure : new Error("Could not confirm the saved answer.");
      if (error instanceof APIError && (error.status === 401 || error.status === 403)) {
        this.requestFailed(error, operation.generation);
        return;
      }
      const definite = error instanceof APIError && error.status >= 400 && error.status < 500 && error.status !== 408;
      const message = action.kind === "check"
        ? `Could not check the saved status. ${operation.timedOut ? "The request timed out." : error.message} Try checking again.`
        : definite ? `The request was not accepted. ${error.message}`
          : `${operation.timedOut ? "The request timed out. " : ""}Could not confirm the request response. Check the saved status before trying again.`;
      this.publishSeed(operation, "failed", operation.transportPending ? `${message} Waiting for the previous request to close.` : message);
    } finally {
      operation.finished = true;
      this.finishSeedOperation(operation);
    }
  }

  private viewedState(target: ChatTarget | null): void {
    const state = markViewed(this.snapshot.state, target);
    if (state !== this.snapshot.state) {
      this.dataRevision++;
      this.update({ state });
    }
  }

  private currentView(view: ConversationView): boolean {
    return this.view === view && this.current(view.generation) && this.owns(view.client)
      && currentChatTarget({ client: view.client, target: view.target }, view.client, this.snapshot.state) !== null;
  }

  private cancelRetry(view: ConversationView): void {
    if (view.retry !== null) clearTimeout(view.retry);
    view.retry = null;
  }

  private abortRead(attempt: ReadAttempt): void {
    if (attempt.timer !== null) clearTimeout(attempt.timer);
    attempt.timer = null;
    attempt.abort.abort();
  }

  private leaveView(view: ConversationView): void {
    if (this.view !== view) return;
    this.cancelSeeds(view);
    this.view = null;
    this.cancelRetry(view);
    const attempt = this.readAttempts.get(readKey(view.target));
    if (attempt?.view === view) this.abortRead(attempt);
    this.viewedState(null);
    this.update({ readError: null });
  }

  private clearViews(): void {
    if (this.view) this.leaveView(this.view);
    for (const attempt of this.readAttempts.values()) this.abortRead(attempt);
    this.readAttempts.clear();
  }

  // A lease identifies the rendered owner, not merely a reused thread ID.
  // Cleanup from an older screen cannot clear a more recent view.
  viewConversation(client: CompanionClient | null, target: ChatTarget): () => void {
    if (!this.owns(client) || !currentChatTarget({ client, target }, client, this.snapshot.state)) return () => undefined;
    if (this.view) this.leaveView(this.view);
    const view: ConversationView = {
      client, target: { ...target }, generation: this.generation, focus: 0,
      revision: 1, acknowledged: 0, attempts: 0, retry: null,
    };
    this.view = view;
    this.viewedState(this.foreground ? view.target : null);
    this.pumpRead(view);
    return () => this.leaveView(view);
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    this.cancelSeeds();
    const view = this.view;
    if (!view) return;
    if (!this.currentView(view)) { this.leaveView(view); return; }
    view.focus++;
    this.cancelRetry(view);
    const attempt = this.readAttempts.get(readKey(view.target));
    if (attempt?.view === view) this.abortRead(attempt);
    this.viewedState(foreground ? view.target : null);
    this.update({ readError: null });
    if (foreground) this.queueRead(view, true);
  }

  retryRead(client: CompanionClient | null, target: ChatTarget): void {
    const view = this.view;
    if (!view || !this.owns(client) || view.client !== client || !this.currentView(view)
      || !this.foreground || readKey(target) !== readKey(view.target)
      || this.readAttempts.has(readKey(target))) return;
    this.queueRead(view, true);
  }

  private queueRead(view: ConversationView, resetAttempts = false): void {
    if (!this.currentView(view) || !this.foreground) return;
    view.revision++;
    if (resetAttempts) {
      view.attempts = 0;
      this.cancelRetry(view);
    }
    this.pumpRead(view);
  }

  private reconcileView(reason: Frame | "hydrate", previous?: CompanionState): void {
    const view = this.view;
    if (!view) return;
    if (!this.currentView(view)) { this.leaveView(view); return; }
    if (!this.foreground) return;
    const target = view.target;
    const owner = target.kind === "bot" ? this.snapshot.state.bots[target.id] : this.snapshot.state.rooms[target.id];
    const ownerChanged = reason === "hydrate"
      || (reason.kind === "bot" && target.kind === "bot" && reason.bot.id === target.id)
      || (reason.kind === "group" && target.kind === "room" && reason.group.id === target.id);
    const newMessage = reason !== "hydrate" && reason.kind === "message"
      && reason.threadId === target.threadId && reason.message.role === "bot"
      && !previous?.messages[target.threadId]?.some((message) => message.id === reason.message.id);
    if ((ownerChanged && (owner?.unread ?? 0) > 0) || newMessage) this.queueRead(view);
  }

  private pumpRead(view: ConversationView): void {
    const key = readKey(view.target);
    if (!this.currentView(view) || !this.foreground || view.retry !== null
      || view.attempts >= READ_ATTEMPTS || view.acknowledged >= view.revision || this.readAttempts.has(key)) return;
    const attempt: ReadAttempt = { view, abort: new AbortController(), timer: null, timedOut: false };
    this.readAttempts.set(key, attempt);
    this.update({ readError: null });
    void this.runRead(attempt, key);
  }

  private async runRead(attempt: ReadAttempt, key: string): Promise<void> {
    const view = attempt.view;
    const revision = view.revision;
    const focus = view.focus;
    let abortListener: () => void = () => undefined;
    const cancelled = new Promise<void>((_resolve, reject) => {
      abortListener = () => reject(new Error(attempt.timedOut ? "The read-status request timed out." : "Read-status request cancelled."));
      attempt.abort.signal.addEventListener("abort", abortListener, { once: true });
      attempt.timer = setTimeout(() => {
        attempt.timedOut = true;
        attempt.abort.abort();
      }, READ_TIMEOUT_MS);
    });
    try {
      const request = view.target.kind === "bot"
        ? view.client.markBotRead(view.target.id, attempt.abort.signal)
        : view.client.markGroupRead(view.target.id, attempt.abort.signal);
      await Promise.race([request, cancelled]);
      if (!this.currentView(view) || !this.foreground || view.focus !== focus) return;
      view.acknowledged = revision;
      view.attempts = 0;
      this.update({ readError: null });
      // A late acceptance must not erase an unread event seen after dispatch.
      if (view.revision === revision) {
        const state = acknowledgeViewed(this.snapshot.state, view.target);
        if (state !== this.snapshot.state) {
          this.dataRevision++;
          this.update({ state });
        }
      }
    } catch (failure) {
      if (!this.currentView(view) || !this.foreground || view.focus !== focus) return;
      const error = failure instanceof Error ? failure : new Error("Could not update read status.");
      if (error instanceof APIError && (error.status === 401 || error.status === 403)) {
        this.requestFailed(error, view.generation);
        return;
      }
      const retryable = !(error instanceof APIError) || error.status === 408 || error.status === 429 || error.status >= 500;
      view.attempts = retryable ? view.attempts + 1 : READ_ATTEMPTS;
      this.update({ readError: { target: view.target, message: `Read status hasn't synced with your computer. ${error.message}` } });
      if (view.attempts < READ_ATTEMPTS) {
        view.retry = setTimeout(() => {
          view.retry = null;
          this.pumpRead(view);
        }, 500 * 2 ** (view.attempts - 1));
      }
    } finally {
      if (attempt.timer !== null) clearTimeout(attempt.timer);
      attempt.abort.signal.removeEventListener("abort", abortListener);
      if (this.readAttempts.get(key) === attempt) {
        this.readAttempts.delete(key);
        if (this.view) this.pumpRead(this.view);
      }
    }
  }

  async loadOlder(client: CompanionClient | null, threadId: string, hasMore: boolean): Promise<void> {
    if (!this.owns(client) || !hasMore || !this.activeThread(threadId)) return;
    const generation = this.generation;
    const list = this.snapshot.state.messages[threadId];
    const leaf = this.snapshot.state.leaves[threadId];
    const oldest = list?.[0]?.id;
    if (!oldest) return;
    const request = (this.pageRequests.get(threadId) ?? 0) + 1;
    this.pageRequests.set(threadId, request);
    try {
      const page = await client.messages(threadId, { before: oldest, limit: 50 });
      if (this.current(generation) && this.pageRequests.get(threadId) === request
        && this.activeThread(threadId)
        && this.snapshot.state.messages[threadId] === list && this.snapshot.state.leaves[threadId] === leaf) {
        this.dataRevision++;
        this.update({ state: prependPage(this.snapshot.state, threadId, page) });
      }
    } catch (error) {
      this.requestFailed(error instanceof Error ? error : new Error("Could not load older messages."), generation);
    }
  }
}
