import { useEffect, useRef, useCallback } from "react";
import { client } from "../core/client";
import { SSEParser } from "../core/sse";
import { ConnectionState } from "../core/types";

interface UseEventStreamOptions {
  onEvent: (event: { type: string; data: any }) => void;
  onConnectionChange: (state: Partial<ConnectionState>) => void;
  enabled?: boolean;
}

export function useEventStream({
  onEvent,
  onConnectionChange,
  enabled = true,
}: UseEventStreamOptions) {
  const parserRef = useRef(new SSEParser());
  const abortRef = useRef<AbortController | null>(null);

  const connect = useCallback(async () => {
    if (!enabled) return;

    onConnectionChange({ status: "connecting" });
    parserRef.current.reset();

    const url = client.getEventStreamUrl();

    try {
      abortRef.current = new AbortController();
      // SAFETY: client exposes a private `token` field we need for the auth header.
      // The token is set by saveCredentials() and is always a string.
      const token = (client as { token: string }).token;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        onConnectionChange({ status: "error", error: `HTTP ${res.status}` });
        return;
      }

      onConnectionChange({ status: "connected" });

      // Read the stream as text chunks
      const reader = res.body?.getReader();
      if (!reader) {
        onConnectionChange({ status: "error", error: "No response body" });
        return;
      }

      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const events = parserRef.current.feed(chunk);

        for (const event of events) {
          onEvent(event);
        }
      }

      onConnectionChange({ status: "disconnected" });
    } catch (e: any) {
      if (e.name === "AbortError") {
        onConnectionChange({ status: "disconnected" });
      } else {
        onConnectionChange({ status: "error", error: e.message });
      }
    }
  }, [enabled, onEvent, onConnectionChange]);

  const disconnect = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    parserRef.current.reset();
  }, []);

  // Auto-reconnect
  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      // TODO: check if we should reconnect
    }, 5000);

    // Initial connect
    connect();

    return () => {
      clearInterval(interval);
      disconnect();
    };
  }, [enabled, connect, disconnect]);

  return { connect, disconnect };
}
