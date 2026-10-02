import React from "react";
import { createThemedStyles, useCompanionTheme } from "./theme";
import {
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Bot, Room, isCardPending } from "../core/types";
import { ChatTarget } from "../hooks/useCompanion";
import { CompanionState, StreamBuffers, visibleTranscript } from "../core/store";

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

interface ChatActivity { at: number; preview: string }

function waitingRequestCount(state: CompanionState): number {
  const requests = new Set<string>();
  const collect = (threadId: string, speaker?: string) => {
    for (const message of visibleTranscript(state, threadId)) {
      const card = message.card;
      if (message.role === "bot" && message.kind === "options" && card?.requestId?.trim() && isCardPending(card)
        && (speaker === undefined || message.from?.botId === speaker)) {
        requests.add(JSON.stringify([threadId, card.requestId]));
      }
    }
  };
  for (const bot of Object.values(state.bots)) {
    if (!bot.hidden) collect(bot.threadId);
  }
  for (const room of Object.values(state.rooms)) {
    if (room.busyBotId?.trim()) collect(room.threadId, room.busyBotId);
  }
  return requests.size;
}

function lastActivity(
  state: CompanionState,
  threadId: string,
): ChatActivity {
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
  const theme = useCompanionTheme();
  const styles = themedStyles[theme.scheme];
  const time = (ms: number) =>
    ms > 0
      ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";

  type Row =
    | { key: string; kind: "bot"; bot: Bot; threadId: string; act: ChatActivity }
    | { key: string; kind: "room"; room: Room; threadId: string; act: ChatActivity };

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

  const pendingCount = waitingRequestCount(state);

  return (
    <View style={styles.container}>
      <StatusBar style={theme.statusBar} />
      <View style={styles.header}>
        <View>
          <View style={styles.brand}>
            <Image source={require("../../assets/icon.png")} style={styles.mascot} accessible={false} />
            <Text style={styles.title}>Muster</Text>
          </View>
          <Text style={styles.status}>
            {connected ? "Connected" : "Reconnecting…"}
            {pendingCount > 0 ? `  ·  ${pendingCount} waiting for you` : ""}
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
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} colors={[theme.accent]} progressBackgroundColor={theme.panel} />
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

const themedStyles = createThemedStyles((theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.page },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 8 },
  mascot: { width: 32, height: 32 },
  title: { fontSize: 24, fontWeight: "600", color: theme.ink },
  status: { fontSize: 12, color: theme.secondary, marginTop: 2 },
  unpair: { color: theme.accent, fontSize: 14, fontWeight: "600" },
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
  avatarText: { color: theme.primaryInk, fontSize: 18, fontWeight: "700" },
  rowBody: { flex: 1, minWidth: 0 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  rowName: { color: theme.ink, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  rowTime: { color: theme.secondary, fontSize: 12, marginLeft: 8 },
  rowBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 2,
  },
  rowPreview: { color: theme.secondary, fontSize: 14, flexShrink: 1 },
  badge: {
    backgroundColor: theme.primary,
    borderRadius: 10,
    minWidth: 20,
    minHeight: 20,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    marginLeft: 8,
  },
  badgeText: { color: theme.primaryInk, fontSize: 12, fontWeight: "700" },
  empty: { alignItems: "center", marginTop: 96, paddingHorizontal: 40 },
  emptyTitle: { color: theme.ink, fontSize: 18, fontWeight: "600" },
  emptyHint: {
    color: theme.secondary,
    fontSize: 14,
    textAlign: "center",
    marginTop: 8,
    lineHeight: 20,
  },
}));
