// HTTP and SSE client for the companion sidecar. Native callers inject expo/fetch.
import { advanceCursor, decodeFleet, decodeFrame, type Frame } from "./frames";
import { SSEParser, type SSEEvent } from "./sse";
import { apiErrorSchema, instancesSchema, pairResponseSchema, requestResponseSchema, threadPageSchema, type JsonValue } from "./contracts";
import { connectionOrigin, parseConnection, type Connection, type ConnectionScheme } from "./connection";
import { parsePairingInvite } from "./pairing";
import { seedAnswerTextSchema, seedCardResultSchema } from "./seed-card";
import type { ClientFetch, ClientResponse, ConnectionStatus, EventStream, StreamReader } from "./transport";
import type { Fleet, Instance, PairResponse, RequestBehavior, RequestOutcome, ThreadPage, SeedCardResult } from "./types";
export { DEFAULT_PORT, parseAddress, parseConnection, type Connection, type ParsedAddress } from "./connection";
export type { ClientFetch, ClientResponse, ConnectionStatus } from "./transport";

export class PairingError extends Error {}
export class APIError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
interface PairOptions { credential?: string; code?: string; deviceName: string; scheme?: ConnectionScheme }
interface PairBody { deviceName: string; credential?: string; code?: string }
interface SeedResponseIdentity { cardId: string; answer?: string }
interface RespondBody { requestId: string; behavior: RequestBehavior; message?: string }
type RequestBody = { threadId: string; answer: string } | { threadId: string; expectedAttempt: number } | { text: string } | RespondBody | { allowKey: string } | { emoji: string } | Record<string, never>;

async function errorDetail(response: ClientResponse): Promise<string> {
  try {
    const parsed = apiErrorSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data.error;
  } catch { /* Non-JSON failures retain the HTTP description. */ }
  return response.statusText;
}

export interface PairingInvite {
  address: string;
  token: string;
}

// muster://pair?address=host:port&token=omb_pair_…|code=…&name=…
export function parsePairingURL(url: string): PairingInvite | null {
  return parsePairingInvite(url);
}

export class MusterClient {
  readonly conn: Connection;
  constructor(conn: Connection, private readonly fetchRequest: ClientFetch) {
    const parsed = parseConnection({ ...conn });
    if (!parsed) throw new Error("Invalid saved server connection");
    this.conn = parsed;
  }
  get base(): string { return connectionOrigin(this.conn); }
  private headers() {
    return { Authorization: `Bearer ${this.conn.token}`, "Content-Type": "application/json" };
  }
  private async request(method: string, path: string, body?: RequestBody, signal?: AbortSignal): Promise<JsonValue> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetchRequest(`${this.base}${path}`, {
        method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal, credentials: "omit",
      });
      if (!response.ok) throw new APIError(response.status, await errorDetail(response));
      return response.status === 204 ? null : await response.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  private async requestVoid(method: string, path: string, body?: RequestBody, signal?: AbortSignal): Promise<void> {
    await this.request(method, path, body, signal);
  }
  static async pair(host: string, port: number, opts: PairOptions, fetchRequest: ClientFetch): Promise<{ response: PairResponse; token: string }> {
    const address = parseConnection({ host, port, scheme: opts.scheme ?? "http", token: "pending" });
    if (!address) throw new PairingError("Invalid server address");
    const body: PairBody = { deviceName: opts.deviceName };
    if (opts.credential) body.credential = opts.credential;
    else if (opts.code) body.code = opts.code;
    else throw new PairingError("Need a QR credential or a 6-digit code");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetchRequest(`${connectionOrigin(address)}/api/pair`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal, credentials: "omit",
      });
      if (!res.ok) throw new PairingError(await errorDetail(res));
      const parsed = pairResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new PairingError("The server returned an invalid pairing response");
      return { response: parsed.data, token: parsed.data.token };
    } finally { clearTimeout(timer); }
  }
  async fleet(): Promise<Fleet> { return decodeFleet(await this.request("GET", "/api/bots?messages=50")); }
  async messages(threadId: string, opts?: { before?: string; limit?: number }): Promise<ThreadPage> {
    const params = new URLSearchParams();
    if (opts?.before) params.set("before", opts.before);
    params.set("limit", String(opts?.limit ?? 50));
    return threadPageSchema.parse(await this.request("GET", `/api/threads/${encodeURIComponent(threadId)}/messages?${params}`));
  }
  async instances(): Promise<Instance[]> { return instancesSchema.parse(await this.request("GET", "/api/instances")); }

  async sendToBot(botId: string, text: string): Promise<void> {
    await this.requestVoid("POST", `/api/bots/${encodeURIComponent(botId)}/messages`, { text });
  }

  async sendToGroup(groupId: string, text: string): Promise<void> {
    await this.requestVoid("POST", `/api/groups/${encodeURIComponent(groupId)}/messages`, { text });
  }

  async respond(
    threadId: string,
    requestId: string,
    behavior: RequestBehavior,
    message?: string,
  ): Promise<RequestOutcome> {
    const body: RespondBody = { requestId, behavior };
    if (message !== undefined) body.message = message;
    const result = requestResponseSchema.safeParse(await this.request("POST", `/api/threads/${encodeURIComponent(threadId)}/respond`, body));
    if (!result.success) throw new Error("Your computer returned an unrecognized response. Check the request status before responding again.");
    return result.data.outcome;
  }

  private seedPath(botId: string, cardId: string): string {
    return `/api/bots/${encodeURIComponent(botId)}/cards/${encodeURIComponent(cardId)}/answer`;
  }
  private async seedRequest(method: "GET" | "POST", path: string, expected: SeedResponseIdentity, body?: RequestBody, signal?: AbortSignal): Promise<SeedCardResult> {
    const parsed = seedCardResultSchema.safeParse(await this.request(method, path, body, signal));
    if (!parsed.success || parsed.data.cardMessage.id !== expected.cardId || expected.answer !== undefined && parsed.data.userMessage?.text !== expected.answer || method === "POST" && (!parsed.data.outcome || !parsed.data.userMessage || !parsed.data.cardMessage.card.seedAnswer)) {
      throw new Error("Your computer returned an unrecognized saved-answer receipt. Check status before trying again.");
    }
    return parsed.data;
  }
  async answerSeedCard(botId: string, cardId: string, threadId: string, answer: string, signal?: AbortSignal): Promise<SeedCardResult> {
    if (!seedAnswerTextSchema.safeParse(answer).success) throw new Error("Enter a nonblank answer of up to 4,000 characters.");
    return this.seedRequest("POST", this.seedPath(botId, cardId), { cardId, answer }, { threadId, answer }, signal);
  }
  async seedCardStatus(botId: string, cardId: string, threadId: string, signal?: AbortSignal): Promise<SeedCardResult> {
    return this.seedRequest("GET", `${this.seedPath(botId, cardId)}?threadId=${encodeURIComponent(threadId)}`, { cardId }, undefined, signal);
  }
  async startSeedCard(botId: string, cardId: string, threadId: string, expectedAttempt: number, signal?: AbortSignal): Promise<SeedCardResult> {
    if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 0 || expectedAttempt >= Number.MAX_SAFE_INTEGER) throw new Error("A valid saved-answer attempt is required.");
    return this.seedRequest("POST", `${this.seedPath(botId, cardId)}/start`, { cardId }, { threadId, expectedAttempt }, signal);
  }

  async alwaysAllow(botId: string, allowKey: string): Promise<void> {
    await this.requestVoid("POST", `/api/bots/${encodeURIComponent(botId)}/always-allow`, {
      allowKey,
    });
  }

  async markBotRead(botId: string, signal?: AbortSignal): Promise<void> {
    // Expo's Android transport requires a non-null POST body.
    await this.requestVoid("POST", `/api/bots/${encodeURIComponent(botId)}/read`, {}, signal);
  }

  async markGroupRead(groupId: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid("POST", `/api/groups/${encodeURIComponent(groupId)}/read`, {}, signal);
  }

  async toggleReaction(threadId: string, messageId: string, emoji: string): Promise<void> {
    await this.requestVoid(
      "POST",
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { emoji },
    );
  }

  events(
    since: string | null,
    onFrame: (frame: Frame, seq: number | null) => void,
    onCursor: (cursor: string) => void,
    onStatus?: (status: ConnectionStatus) => void,
  ): EventStream {
    let stopped = false;
    let controller: AbortController | null = null;
    let reader: StreamReader | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let wakeRetry: (() => void) | null = null;
    const status = (value: ConnectionStatus) => { if (!stopped) onStatus?.(value); };
    const frame = (value: Frame, seq: number | null) => { if (!stopped) onFrame(value, seq); };
    const cursorChanged = (value: string) => { if (!stopped) onCursor(value); };
    const releaseReader = async () => {
      const active = reader;
      reader = null;
      if (!active) return;
      try { await active.cancel(); } catch { /* Already failed or aborted. */ }
      finally { active.releaseLock(); }
    };
    const run = async () => {
      let cursor = since;
      while (!stopped) {
        status("connecting");
        if (stopped) return;
        controller = new AbortController();
        const parser = new SSEParser();
        try {
          const params = new URLSearchParams({ screens: "off" });
          if (cursor) params.set("since", cursor);
          const res = await this.fetchRequest(`${this.base}/api/events?${params}`, {
            headers: { Authorization: `Bearer ${this.conn.token}`, Accept: "text/event-stream" },
            signal: controller.signal, credentials: "omit",
          });
          reader = res.body?.getReader() ?? null;
          if (stopped) return;
          if (res.status === 401 || res.status === 403) {
            status("unauthorized");
            return;
          }
          const contentType = res.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
          if (!res.ok || !reader || contentType !== "text/event-stream") {
            throw new APIError(res.status, "The server did not open an event stream");
          }
          status("connected");
          const decoder = new TextDecoder();
          while (!stopped) {
            const chunk = await reader.read();
            if (stopped || chunk.done) break;
            for (const evt of parser.feed(decoder.decode(chunk.value, { stream: true }))) {
              if (stopped) break;
              cursor = this.handleEvent(evt, cursor, frame, cursorChanged);
            }
          }
        } catch {
          // Network/read failures retry; cancellation is terminal below.
        } finally {
          controller?.abort();
          controller = null;
          await releaseReader();
        }
        if (stopped) return;
        status("disconnected");
        if (stopped) return;
        await new Promise<void>((resolve) => {
          wakeRetry = resolve;
          retryTimer = setTimeout(() => { retryTimer = null; wakeRetry = null; resolve(); }, 2000);
        });
      }
    };
    void run();
    return { stop: () => {
      if (stopped) return;
      stopped = true;
      controller?.abort();
      void releaseReader();
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      wakeRetry?.();
      wakeRetry = null;
    } };
  }

  private handleEvent(
    evt: SSEEvent, cursor: string | null,
    onFrame: (frame: Frame, seq: number | null) => void,
    onCursor: (cursor: string) => void,
  ): string | null {
    let next = cursor;
    if (evt.id) {
      next = advanceCursor(cursor, evt.id);
      // Replayed events must not append runtime deltas a second time.
      if (next === cursor) return cursor;
    }
    const frame = decodeFrame(evt.data);
    // The server announces its latest cursor BEFORE sending missed events.
    // On a resumed stream, commit only the replay IDs as they are applied.
    if (frame.kind === "hello" && frame.cursor && !frame.resumed) next = frame.cursor;
    onFrame(frame, null);
    if (next !== cursor && next !== null) onCursor(next);
    return next;
  }
}
