// Native composition only; the session controller owns async identity fences.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { fetch } from "expo/fetch";
import { MusterClient, parseAddress, parseConnection } from "../core/client";
import { resolvePairingInput } from "../core/pairing";
import type { CardAction, CardReference } from "../core/card-actions";
import {
  CompanionSession, ConnectionPersistence, type ChatTarget, type SeedAction, type SeedReference,
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
      const result = resolvePairingInput(input);
      if (!result.ok) throw new Error(result.error);
      const { host, port, scheme } = parseAddress(result.value.address);
      const { response } = await MusterClient.pair(host, port, {
        scheme,
        credential: result.value.credential,
        code: result.value.code,
        deviceName: input.deviceName ?? "Muster Android",
      }, fetch);
      return { connection: { host, port, scheme, token: response.token }, response };
    },
  }));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  useEffect(() => {
    let appState = AppState.currentState;
    // AppState has no synchronous Android window-focus getter. An active
    // app starts focused; blur/focus events refine that independently.
    let windowFocused = true;
    const updateForeground = () => session.setForeground(appState === "active" && windowFocused);
    const subscriptions = [AppState.addEventListener("change", (nextState) => {
      appState = nextState;
      updateForeground();
    })];
    if (Platform.OS === "android") {
      subscriptions.push(
        AppState.addEventListener("blur", () => { windowFocused = false; updateForeground(); }),
        AppState.addEventListener("focus", () => { windowFocused = true; updateForeground(); }),
      );
    }
    updateForeground();
    void session.start();
    return () => {
      for (const subscription of subscriptions) subscription.remove();
      session.dispose();
    };
  }, [session]);

  // Capture the render's client so callbacks retained by an old screen
  // cannot send to or modify the newly paired account.
  const send = useCallback((target: ChatTarget, text: string) =>
    session.send(snapshot.client, target, text), [session, snapshot.client]);
  const actOnCard = useCallback((reference: CardReference, action: CardAction) =>
    session.actOnCard(snapshot.client, reference, action), [session, snapshot.client]);
  const actOnSeed = useCallback((reference: SeedReference, action: SeedAction) =>
    session.actOnSeed(snapshot.client, reference, action), [session, snapshot.client]);
  const refreshCards = useCallback(() => session.refreshCards(snapshot.client), [session, snapshot.client]);
  const viewConversation = useCallback((target: ChatTarget) =>
    session.viewConversation(snapshot.client, target), [session, snapshot.client]);
  const retryRead = useCallback((target: ChatTarget) =>
    session.retryRead(snapshot.client, target), [session, snapshot.client]);
  const loadOlder = useCallback((threadId: string, hasMore: boolean) =>
    session.loadOlder(snapshot.client, threadId, hasMore), [session, snapshot.client]);

  return {
    ...snapshot,
    pair: session.pair, unpair: session.unpair, refresh: session.refresh,
    send, actOnCard, actOnSeed, refreshCards, viewConversation, retryRead, loadOlder,
  };
}
