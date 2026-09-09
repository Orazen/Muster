// HTTP client mirroring ios/Sources/CompanionCore/Client.swift.
// Only endpoints in the sidecar's default-deny allowlist are callable.

import { advanceCursor, decodeFleet, decodeFrame, Frame } from "./frames";
import { SSEParser, SSEEvent } from "./sse";
import {
  Fleet,
  Instance,
  Message,
  PairResponse,
  ThreadPage,
} from "./types";

export const DEFAULT_PORT = 8810;

export interface Connection {
  host: string;
  port: number;
  token: string;
}

export class PairingError extends Error {}
export class APIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ParsedAddress {
  host: string;
  port: number;
}

// Strips scheme, handles IPv6 brackets, applies the default port — mirrors
// Connection.parse on iOS.
export function parseAddress(input: string): ParsedAddress {
  let s = input.trim();
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/\/+$/, "");
  const bracket = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    return { host: bracket[1], port: bracket[2] ? Number(bracket[2]) : DEFAULT_PORT };
  }
  const lastColon = s.lastIndexOf(":");
  if (lastColon > 0 && (s.match(/:/g) ?? []).length === 1) {
    const port = Number(s.slice(lastColon + 1));
    if (Number.isFinite(port) && port > 0) {
      return { host: s.slice(0, lastColon), port };
    }
  }
  return { host: s, port: DEFAULT_PORT };
}

export interface PairingInvite {
  address: string;
  token: string;
}

// muster://pair?address=host:port&token=omb_pair_…|code=…&name=…
export function parsePairingURL(url: string): PairingInvite | null {
  if (!url.startsWith("muster://pair?")) return null;
  const query = url.slice("muster://pair?".length);
  const params = new URLSearchParams(query.replace(/\|/g, "&"));
  const address = params.get("address");
  const token = params.get("token");
  if (!address || !token || !token.startsWith("omb_pair_") || token.length < 8) return null;
  return { address, token };
}

export class MusterClient {
  conn: Connection;

  constructor(conn: Connection) {
    this.conn = conn;
  }

  get base(): string {
    return `http://${this.conn.host}:${this.conn.port}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.conn.token}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 20_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = res.statusText;
        try {
          const errBody = await res.json();
          if (typeof errBody?.error === "string") detail = errBody.error;
        } catch {}
        throw new APIError(res.status, detail);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  static async pair(
    host: string,
    port: number,
    opts: { credential?: string; code?: string; deviceName: string },
  ): Promise<{ response: PairResponse; token: string }> {
    const body: Record<string, unknown> = { deviceName: opts.deviceName };
    if (opts.credential) body.credential = opts.credential;
    else if (opts.code) body.code = opts.code;
    else throw new PairingError("Need a QR credential or a 6-digit code");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(`http://${host}:${port}/api/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = res.statusText;
        try {
          const errBody = await res.json();
          if (typeof errBody?.error === "string") detail = errBody.error;
        } catch {}
        throw new PairingError(detail);
      }
      const response = (await res.json()) as PairResponse;
      return { response, token: response.token };
    } finally {
      clearTimeout(timer);
    }
  }

  async fleet(): Promise<Fleet> {
    const raw = await this.request<unknown>("GET", "/api/bots?messages=50");
    return decodeFleet(raw);
  }

  async messages(threadId: string, opts?: { before?: string; limit?: number }): Promise<ThreadPage> {
    const params = new URLSearchParams();
    if (opts?.before) params.set("before", opts.before);
    params.set("limit", String(opts?.limit ?? 50));
    const raw = await this.request<unknown>(
      "GET",
      `/api/threads/${encodeURIComponent(threadId)}/messages?${params}`,
    );
    return {
      messages: Array.isArray((raw as any)?.messages) ? (raw as any).messages : [],
      hasMore: Boolean((raw as any)?.hasMore),
    };
  }

  async instances(): Promise<Instance[]> {
    const raw = await this.request<unknown>("GET", "/api/instances");
    return Array.isArray(raw) ? (raw as Instance[]) : [];
  }

  async sendToBot(botId: string, text: string): Promise<void> {
    await this.request("POST", `/api/bots/${encodeURIComponent(botId)}/messages`, { text });
  }

  async sendToGroup(groupId: string, text: string): Promise<void> {
    await this.request("POST", `/api/groups/${encodeURIComponent(groupId)}/messages`, { text });
  }

  async respond(
    threadId: string,
    requestId: string,
    behavior: "allow" | "allowAlways" | "deny" | string,
    message?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { requestId, behavior };
    if (message !== undefined) body.message = message;
    await this.request("POST", `/api/threads/${encodeURIComponent(threadId)}/respond`, body);
  }

  async alwaysAllow(botId: string, allowKey: string): Promise<void> {
    await this.request("POST", `/api/bots/${encodeURIComponent(botId)}/always-allow`, {
      allowKey,
    });
  }

  async markRead(threadId: string): Promise<void> {
    await this.request("POST", `/api/threads/${encodeURIComponent(threadId)}/read`, {});
  }

  async toggleReaction(threadId: string, messageId: string, emoji: string): Promise<void> {
    await this.request(
      "POST",
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { emoji },
    );
  }

  // Event stream. `onFrame` fires for every decoded frame; the returned
  // stopper cancels the connection. Reconnect with the returned cursor.
  async events(
    since: string | null,
    onFrame: (frame: Frame, seq: number | null) => void,
    onCursor: (cursor: string) => void,
  ): Promise<{ stop: () => void }> {
    const controller = new AbortController();
    let stopped = false;

    (async () => {
      let cursor = since;
      while (!stopped) {
        const parser = new SSEParser();
        try {
          const params = new URLSearchParams({ screens: "off" });
          if (cursor) params.set("since", cursor);
          const res = await fetch(`${this.base}/api/events?${params}`, {
            headers: {
              Authorization: `Bearer ${this.conn.token}`,
              Accept: "text/event-stream",
            },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            if (res.status === 401 || res.status === 403) {
              onFrame({ kind: "unknown", rawKind: "unauthorized" }, null);
              return;
            }
            throw new APIError(res.status, res.statusText);
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done || stopped) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const evt of parser.feed(chunk)) {
              if (stopped) break;
              cursor = this.handleEvent(evt, cursor, onFrame, onCursor);
            }
          }
        } catch (err) {
          if (stopped || (err as Error).name === "AbortError") return;
        }
        if (stopped) return;
        // Backoff, then resume from the last committed cursor.
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();

    return {
      stop: () => {
        stopped = true;
        controller.abort();
      },
    };
  }

  // Returns the advanced cursor. The `id:` line carries "<streamId>:<seq>";
  // the streamId prefix must survive across resumes. hello.cursor commits a
  // server-issued cursor (fresh streams hand one over).
  private handleEvent(
    evt: SSEEvent,
    cursor: string | null,
    onFrame: (frame: Frame, seq: number | null) => void,
    onCursor: (cursor: string) => void,
  ): string | null {
    let next = cursor;
    if (evt.id) {
      next = advanceCursor(cursor, evt.id);
      if (next !== cursor) onCursor(next);
    }
    const frame = decodeFrame(evt.data);
    if (frame.kind === "hello" && frame.cursor) {
      next = frame.cursor;
      onCursor(next);
    }
    onFrame(frame, null);
    return next;
  }
}
