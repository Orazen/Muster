// Owns one mounted companion's connection and asynchronous state boundaries.
import { APIError } from "../core/client";
import type { Connection, MusterClient } from "../core/client";
import type { PairResponse } from "../core/types";
import { isCardPending, type Message } from "../core/types";
import { cardActionKey, cardDecision, cardReference, outcomeMessage, type CardAction, type CardActionState, type CardReference } from "../core/card-actions";
import type { Frame } from "../core/frames";
import {
  acknowledgeViewed, applyFrame, hydrate, initialState, markViewed, prependPage, setCursor, visibleTranscript,
} from "../core/store";
import type { CompanionState, ViewedConversation } from "../core/store";

export type ChatTarget = ViewedConversation;

export interface PairInput {
  address: string;
  credential?: string;
  code?: string;
  deviceName?: string;
}

export type CompanionClient = Pick<MusterClient,
  "fleet" | "messages" | "events" | "sendToBot" | "sendToGroup" | "respond" | "alwaysAllow" | "markBotRead" | "markGroupRead"
>;

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
}

function emptySnapshot(): CompanionSnapshot {
  return { client: null, state: initialState(), connected: false, connecting: false, pairing: false, pairError: null, readError: null, cardActions: {} };
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
    this.snapshot = { ...this.snapshot, ...patch };
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
        const handle = client.events(
          this.snapshot.state.cursor,
          (frame) => {
            if (!this.current(generation)) return;
            if (frame.kind === "hello") {
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
