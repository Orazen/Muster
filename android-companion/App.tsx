import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useCompanion } from "./src/hooks/useCompanion";
import { currentChatTarget, type ChatSelection } from "./src/hooks/companion-session";
import { PairingScreen } from "./src/screens/PairingScreen";
import { ChatListScreen } from "./src/screens/ChatListScreen";
import { ChatViewScreen } from "./src/screens/ChatViewScreen";

export default function App() {
  const companion = useCompanion();
  const [selection, setSelection] = useState<ChatSelection | null>(null);
  const target = currentChatTarget(selection, companion.client, companion.state);
  const [refreshing, setRefreshing] = useState(false);

  if (!companion.client) {
    return (
      <PairingScreen
        pairing={companion.pairing}
        error={companion.pairError}
        onPair={companion.pair}
      />
    );
  }

  const bot =
    target?.kind === "bot"
      ? Object.values(companion.state.bots).find((b) => b.id === target.id)
      : undefined;
  const room =
    target?.kind === "room"
      ? Object.values(companion.state.rooms).find((r) => r.id === target.id)
      : undefined;

  if (target && (bot || room)) {
    return (
      <ChatViewScreen
        state={companion.state}
        target={target}
        bot={bot}
        room={room}
        onSend={(text) => companion.send(target, text)}
        onRespond={companion.respond}
        onAlwaysAllow={companion.alwaysAllow}
        onBack={() => setSelection(null)}
        onLoadOlder={() => companion.loadOlder(target.threadId, companion.state.hasMore[target.threadId] ?? false)}
        viewThread={companion.viewThread}
      />
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <ChatListScreen
        state={companion.state}
        bots={Object.values(companion.state.bots).filter((b) => !b.hidden)}
        rooms={Object.values(companion.state.rooms)}
        connected={companion.connected}
        refreshing={refreshing}
        onSelect={(next) => setSelection({ client: companion.client, target: next })}
        onRefresh={async () => {
          setRefreshing(true);
          await companion.refresh();
          setRefreshing(false);
        }}
        onUnpair={companion.unpair}
      />
      {!companion.connected && !companion.connecting ? (
        <View style={styles.reconnectBanner}>
          <Text style={styles.reconnectText}>Reconnecting to your computer…</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  reconnectBanner: {
    position: "absolute",
    bottom: 32,
    alignSelf: "center",
    backgroundColor: "#1c1c1e",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#333",
  },
  reconnectText: { color: "#e8e8ea", fontSize: 13 },
});
