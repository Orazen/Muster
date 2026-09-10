import type { JsonValue } from "./contracts";

// The subset used by this client is implemented by Expo 52's named expo/fetch.
// Keep native module loading at the app boundary so the protocol is testable.
export interface StreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}
export interface StreamBody { getReader(): StreamReader }
export interface ClientResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  body: StreamBody | null;
  json(): Promise<JsonValue>;
}
export interface ClientRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  credentials?: "omit";
}
export type ClientFetch = (url: string, init?: ClientRequest) => Promise<ClientResponse>;
export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "unauthorized";

export interface EventStream { stop(): void }
