import React, { useEffect } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Room, Bot } from "../core/types";

interface ChatListScreenProps {
  rooms: Room[];
  bots: Bot[];
  onSelectRoom: (roomId: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

export function ChatListScreen({
  rooms,
  bots,
  onSelectRoom,
  onRefresh,
  refreshing,
}: ChatListScreenProps) {
  const getBotForRoom = (room: Room): Bot | undefined => {
    if (room.kind === "dm") {
      return bots.find((b) => room.members.includes(b.id));
    }
    return undefined;
  };

  const getRoomTitle = (room: Room): string => {
    if (room.name) return room.name;
    const bot = getBotForRoom(room);
    return bot?.name || room.id;
  };

  const getRoomSubtitle = (room: Room): string => {
    const bot = getBotForRoom(room);
    if (bot) return bot.engine;
    return room.members.length > 1 ? `${room.members.length} members` : "";
  };

  const renderRoom = ({ item }: { item: Room }) => {
    const bot = getBotForRoom(item);
    return (
      <TouchableOpacity
        style={styles.roomItem}
        onPress={() => onSelectRoom(item.id)}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {bot?.name?.[0] || item.name?.[0] || "?"}
          </Text>
        </View>
        <View style={styles.roomInfo}>
          <View style={styles.roomHeader}>
            <Text style={styles.roomName} numberOfLines={1}>
              {getRoomTitle(item)}
            </Text>
            {item.lastMessage && (
              <Text style={styles.timestamp}>
                {new Date(item.lastMessage.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Text>
            )}
          </View>
          <View style={styles.roomMeta}>
            <Text style={styles.roomSubtitle} numberOfLines={1}>
              {getRoomSubtitle(item)}
            </Text>
            {item.lastMessage && (
              <Text style={styles.preview} numberOfLines={1}>
                {item.lastMessage.content}
              </Text>
            )}
          </View>
        </View>
        {item.unread > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{item.unread}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.title}>Muster</Text>
      </View>
      <FlatList
        data={rooms}
        renderItem={renderRoom}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#1084fe"
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No rooms yet</Text>
            <Text style={styles.emptyHint}>
              Create a bot on your computer to get started
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  header: {
    paddingTop: 60,
    paddingBottom: 16,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#1a1a1a",
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#fff",
  },
  roomItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#1a1a1a",
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#1084fe",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  avatarText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#fff",
  },
  roomInfo: {
    flex: 1,
  },
  roomHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  roomName: {
    fontSize: 16,
    fontWeight: "600",
    color: "#fff",
    flex: 1,
  },
  timestamp: {
    fontSize: 12,
    color: "#666",
    marginLeft: 8,
  },
  roomMeta: {
    flexDirection: "row",
    alignItems: "center",
  },
  roomSubtitle: {
    fontSize: 13,
    color: "#888",
    marginRight: 8,
  },
  preview: {
    fontSize: 13,
    color: "#666",
    flex: 1,
  },
  badge: {
    backgroundColor: "#1084fe",
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 6,
    marginLeft: 8,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#fff",
  },
  empty: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 100,
  },
  emptyText: {
    fontSize: 18,
    color: "#666",
    marginBottom: 8,
  },
  emptyHint: {
    fontSize: 14,
    color: "#444",
    textAlign: "center",
  },
});
