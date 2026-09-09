// Owns the client, the state fold, and the event-stream lifecycle.

import { useCallback, useEffect, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { MusterClient, Connection, parseAddress } from "../core/client";
import { applyFrame, CompanionState, hydrate, initialState, markViewed, prependPage, setCursor } from "../core/store";
import { ThreadPage } from "../core/types";

const CREDENTIALS_KEY = "muster.connection";

export interface ChatTarget {
  kind: "bot" | "room";
  id: string; // botId or groupId
  threadId: string;
}

async function loadConnection(): Promise<Connection | null> {
  try {
    const raw = await SecureStore.getItemAsync(CREDENTIALS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.host && parsed?.port && parsed?.token) return parsed as Connection;
    return null;
  } catch {
    return null;
  }
}

function saveConnection(conn: Connection | null): Promise<void> {
  if (!conn) return SecureStore.deleteItemAsync(CREDENTIALS_KEY);
  return SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(conn));
}

export function useCompanion() {
  const [client, setClient] = useState<MusterClient | null>(null);
  const [state, setState] = useState<CompanionState>(initialState);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const stopStream = useRef<(() => void) | null>(null);
  const cursorRef = useRef<string | null>(null);

  const refreshWith = useCallback(async (c: MusterClient) => {
    try {
      const fleet = await c.fleet();
      setState((s) => hydrate(s, fleet));
    } catch {
      // Unreachable server; the stream loop keeps retrying underneath.
    }
  }, []);

  // Boot: restore saved connection, hydrate the fleet, open the stream.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const conn = await loadConnection();
      if (!conn || cancelled) return;
      const c = new MusterClient(conn);
      setClient(c);
      await refreshWith(c);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshWith]);

  const refresh = useCallback(async () => {
    if (client) await refreshWith(client);
  }, [client, refreshWith]);

  // Stream lifecycle: (re)open whenever the client changes.
  useEffect(() => {
    if (!client) return;
    setConnecting(true);
    let disposed = false;

    const open = async () => {
      const handle = await client.events(
        cursorRef.current,
        (frame) => {
          if (frame.kind === "unknown" && frame.rawKind === "unauthorized") {
            // Token revoked → drop credentials, back to pairing.
            saveConnection(null);
            setClient(null);
            setState(initialState());
            return;
          }
          setState((s) => applyFrame(s, frame));
        },
        (cursor) => {
          cursorRef.current = cursor;
          setState((s) => setCursor(s, cursor));
        },
      );
      if (disposed) {
        handle.stop();
        return;
      }
      stopStream.current = handle.stop;
      setConnecting(false);
      setConnected(true);
    };

    open();
    return () => {
      disposed = true;
      stopStream.current?.();
      stopStream.current = null;
      setConnected(false);
    };
  }, [client]);

  const pair = useCallback(
    async (input: { address: string; credential?: string; code?: string; deviceName?: string }) => {
      setPairing(true);
      setPairError(null);
      try {
        const { host, port } = parseAddress(input.address);
        const { response } = await MusterClient.pair(host, port, {
          credential: input.credential,
          code: input.code,
          deviceName: input.deviceName ?? "Muster Android",
        });
        const conn: Connection = { host, port, token: response.token };
        await saveConnection(conn);
        cursorRef.current = null;
        setClient(new MusterClient(conn));
        return { response };
      } catch (err) {
        setPairError((err as Error).message || "Pairing failed");
        return null;
      } finally {
        setPairing(false);
      }
    },
    [],
  );

  const unpair = useCallback(async () => {
    stopStream.current?.();
    await saveConnection(null);
    cursorRef.current = null;
    setClient(null);
    setConnected(false);
    setState(initialState());
  }, []);

  const send = useCallback(
    async (target: ChatTarget, text: string) => {
      if (!client) return;
      if (target.kind === "bot") await client.sendToBot(target.id, text);
      else await client.sendToGroup(target.id, text);
    },
    [client],
  );

  const respond = useCallback(
    async (threadId: string, requestId: string, behavior: string, message?: string) => {
      if (!client) return;
      await client.respond(threadId, requestId, behavior, message);
    },
    [client],
  );

  const alwaysAllow = useCallback(
    async (botId: string, allowKey: string) => {
      if (!client) return;
      await client.alwaysAllow(botId, allowKey);
    },
    [client],
  );

  const viewThread = useCallback(
    async (threadId: string) => {
      setState((s) => markViewed(s, threadId));
      if (client) {
        try {
          await client.markRead(threadId);
        } catch {}
      }
    },
    [client],
  );

  const loadOlder = useCallback(
    async (threadId: string, hasMore: boolean) => {
      if (!client || !hasMore) return;
      const list = state.messages[threadId] ?? [];
      const oldest = list[0]?.id;
      if (!oldest) return;
      try {
        const page: ThreadPage = await client.messages(threadId, { before: oldest, limit: 50 });
        setState((s) => prependPage(s, threadId, page));
      } catch {}
    },
    [client, state.messages],
  );

  return {
    client,
    state,
    connected,
    connecting,
    pairing,
    pairError,
    pair,
    unpair,
    refresh,
    send,
    respond,
    alwaysAllow,
    viewThread,
    loadOlder,
  };
}
