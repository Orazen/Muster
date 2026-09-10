// Native composition only; the session controller owns async identity fences.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { fetch } from "expo/fetch";
import { MusterClient, parseAddress, parseConnection } from "../core/client";
import {
  CompanionSession, ConnectionPersistence, type ChatTarget,
} from "./companion-session";

export type { ChatTarget } from "./companion-session";
const CREDENTIALS_KEY = "muster.connection";

// Shared across hook remounts, including outstanding native storage writes.
const persistence = new ConnectionPersistence({
  async load() {
    const raw = await SecureStore.getItemAsync(CREDENTIALS_KEY);
    return raw ? parseConnection(JSON.parse(raw)) : null;
  },
  async save(connection) {
    if (connection) await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(connection));
    else await SecureStore.deleteItemAsync(CREDENTIALS_KEY);
  },
});

export function useCompanion() {
  const [session] = useState(() => new CompanionSession({
    persistence,
    createClient: (connection) => new MusterClient(connection, fetch),
    async pair(input) {
      const { host, port, scheme } = parseAddress(input.address);
      const { response } = await MusterClient.pair(host, port, {
        scheme,
        credential: input.credential,
        code: input.code,
        deviceName: input.deviceName ?? "Muster Android",
      }, fetch);
      return { connection: { host, port, scheme, token: response.token }, response };
    },
  }));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  useEffect(() => {
    void session.start();
    return session.dispose;
  }, [session]);

  // Capture the render's client so callbacks retained by an old screen
  // cannot send to or modify the newly paired account.
  const send = useCallback((target: ChatTarget, text: string) =>
    session.send(snapshot.client, target, text), [session, snapshot.client]);
  const respond = useCallback((threadId: string, requestId: string, behavior: string, message?: string) =>
    session.respond(snapshot.client, threadId, requestId, behavior, message), [session, snapshot.client]);
  const alwaysAllow = useCallback((botId: string, allowKey: string) =>
    session.alwaysAllow(snapshot.client, botId, allowKey), [session, snapshot.client]);
  const viewThread = useCallback((threadId: string) =>
    session.viewThread(snapshot.client, threadId), [session, snapshot.client]);
  const loadOlder = useCallback((threadId: string, hasMore: boolean) =>
    session.loadOlder(snapshot.client, threadId, hasMore), [session, snapshot.client]);

  return {
    ...snapshot,
    pair: session.pair, unpair: session.unpair, refresh: session.refresh,
    send, respond, alwaysAllow, viewThread, loadOlder,
  };
}
