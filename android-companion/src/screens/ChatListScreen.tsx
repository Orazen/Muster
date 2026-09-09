import React from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Bot, Room } from "../core/types";
import { ChatTarget } from "../hooks/useCompanion";
import { CompanionState, StreamBuffers } from "../core/store";

interface ChatListScreenProps {
  state: CompanionState;
  bots: Bot[];
  rooms: Room[];
  connected: boolean;
  refreshing: boolean;
  onSelect: (target: ChatTarget) => void;
  onRefresh: () => void;
  onUnpair: () => void;
}

function lastActivity(
  state: CompanionState,
  threadId: string,
): { at: number; preview: string } {
  const list = state.messages[threadId] ?? [];
  const last = list[list.length - 1];
  const streams: StreamBuffers | undefined = state.streams[threadId];
  if (streams && (streams.text || streams.reasoning)) {
    return { at: last?.at ?? 0, preview: (streams.text || "thinking…").trim() };
  }
  if (!last) return { at: 0, preview: "" };
  const preview =
    last.card?.title ?? last.tool?.name ?? (last.text ? last.text.trim() : "");
  return { at: last.at, preview: preview || "" };
}

export function ChatListScreen({
  state,
  bots,
  rooms,
  connected,
  refreshing,
  onSelect,
  onRefresh,
  onUnpair,
}: ChatListScreenProps) {
  const time = (ms: number) =>
    ms > 0
      ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";

  type Row =
    | { key: string; kind: "bot"; bot: Bot; threadId: string; act: { at: number; preview: string } }
    | { key: string; kind: "room"; room: Room; threadId: string; act: { at: number; preview: string } };

  const rows: Row[] = [
    ...bots.map((bot) => ({
      key: `bot-${bot.id}`,
      kind: "bot" as const,
      bot,
      threadId: bot.threadId,
      act: lastActivity(state, bot.threadId),
    })),
    ...rooms.map((room) => ({
      key: `room-${room.id}`,
      kind: "room" as const,
      room,
      threadId: room.threadId,
      act: lastActivity(state, room.threadId),
    })),
  ].sort((a, b) => b.act.at - a.act.at);

  const pendingCount = state.notifications.filter((n) => n.kind === "approval" || n.kind === "question").length;

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Muster</Text>
          <Text style={styles.status}>
            {connected ? "Connected" : "Reconnecting…"}
            {pendingCount > 0 ? `  ·  ${pendingCount} awaiting approval` : ""}
          </Text>
        </View>
        <TouchableOpacity onPress={onUnpair} hitSlop={12}>
          <Text style={styles.unpair}>Unpair</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => {
          const name = item.kind === "bot" ? item.bot.name : item.room.name ?? "Room";
          const color = item.kind === "bot" ? item.bot.color ?? "#2a2a2c" : "#1c1c1e";
          const initial = name.slice(0, 1).toUpperCase() || "?";
          const unread =
            item.kind === "bot" ? item.bot.unread ?? 0 : item.room.unread ?? 0;
          const busy = item.kind === "bot" ? item.bot.busy : false;
          const subtitle =
            item.act.preview ||
            (item.kind === "bot"
              ? item.bot.description ?? "No messages yet"
              : item.room.bulletin ?? "No messages yet");
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() =>
                onSelect(
                  item.kind === "bot"
                    ? { kind: "bot", id: item.bot.id, threadId: item.threadId }
                    : { kind: "room", id: item.room.id, threadId: item.threadId },
                )
              }
            >
              <View style={[styles.avatar, { backgroundColor: color }]}>
                <Text style={styles.avatarText}>{initial}</Text>
              </View>
              <View style={styles.rowBody}>
                <View style={styles.rowTop}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {name}
                    {busy ? "  ●" : ""}
                  </Text>
                  <Text style={styles.rowTime}>{time(item.act.at)}</Text>
                </View>
                <View style={styles.rowBottom}>
                  <Text style={styles.rowPreview} numberOfLines={1}>
                    {subtitle}
                  </Text>
                  {unread > 0 ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{unread}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f0460e" />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No bots yet</Text>
            <Text style={styles.emptyHint}>
              Create a bot on your computer — it appears here instantly.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#222",
  },
  title: { fontSize: 24, fontWeight: "700", color: "#f6f6f7" },
  status: { fontSize: 12, color: "#8a8a8e", marginTop: 2 },
  unpair: { color: "#f0460e", fontSize: 14, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  avatarText: { color: "#fff", fontSize: 18, fontWeight: "700" },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  rowName: { color: "#f6f6f7", fontSize: 16, fontWeight: "600", flexShrink: 1 },
  rowTime: { color: "#6a6a6e", fontSize: 12, marginLeft: 8 },
  rowBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 2,
  },
  rowPreview: { color: "#8a8a8e", fontSize: 14, flexShrink: 1 },
  badge: {
    backgroundColor: "#f0460e",
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    marginLeft: 8,
  },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  empty: { alignItems: "center", marginTop: 96, paddingHorizontal: 40 },
  emptyTitle: { color: "#f6f6f7", fontSize: 18, fontWeight: "600" },
  emptyHint: {
    color: "#8a8a8e",
    fontSize: 14,
    textAlign: "center",
    marginTop: 8,
    lineHeight: 20,
  },
});
