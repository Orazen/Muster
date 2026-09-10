// Owns one mounted companion's connection and asynchronous state boundaries.
import { APIError } from "../core/client";
import type { Connection, MusterClient } from "../core/client";
import type { PairResponse } from "../core/types";
import {
  applyFrame, hydrate, initialState, markViewed, prependPage, setCursor,
} from "../core/store";
import type { CompanionState } from "../core/store";

export interface ChatTarget {
  kind: "bot" | "room";
  id: string;
  threadId: string;
}

export interface PairInput {
  address: string;
  credential?: string;
  code?: string;
  deviceName?: string;
}

export type CompanionClient = Pick<MusterClient,
  "fleet" | "messages" | "events" | "sendToBot" | "sendToGroup" | "respond" | "alwaysAllow" | "markRead"
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
}

function emptySnapshot(): CompanionSnapshot {
  return { client: null, state: initialState(), connected: false, connecting: false, pairing: false, pairError: null };
}

interface FleetRecovery {
  client: CompanionClient;
  generation: number;
  revision: number;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}
type RefreshResult = "applied" | "stale" | "failed" | "inactive";

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
            const state = applyFrame(this.snapshot.state, frame);
            if (state !== this.snapshot.state) {
              this.dataRevision++;
              this.update({ state });
            }
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
              this.update({ connected: status === "connected", connecting: status === "connecting" });
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

  async send(client: CompanionClient | null, target: ChatTarget, text: string): Promise<void> {
    if (!this.owns(client) || !currentChatTarget({ client, target }, client, this.snapshot.state)) return;
    if (target.kind === "bot") await client.sendToBot(target.id, text);
    else await client.sendToGroup(target.id, text);
  }

  async respond(client: CompanionClient | null, threadId: string, requestId: string, behavior: string, message?: string): Promise<void> {
    if (this.owns(client) && this.activeThread(threadId)) await client.respond(threadId, requestId, behavior, message);
  }

  async alwaysAllow(client: CompanionClient | null, botId: string, allowKey: string): Promise<void> {
    if (this.owns(client)) await client.alwaysAllow(botId, allowKey);
  }

  async viewThread(client: CompanionClient | null, threadId: string): Promise<void> {
    if (!this.owns(client) || !this.activeThread(threadId)) return;
    const generation = this.generation;
    this.dataRevision++;
    this.update({ state: markViewed(this.snapshot.state, threadId) });
    try { await client.markRead(threadId); }
    catch (error) { this.requestFailed(error instanceof Error ? error : new Error("Could not mark the thread read."), generation); }
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
