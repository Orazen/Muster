import React, { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Bot, isCardPending, Message, Room } from "../core/types";
import { CompanionState, StreamBuffers, visibleTranscript } from "../core/store";
import type { ChatTarget, CompanionClient } from "../hooks/companion-session";
import { ComposerDraft, composerContextKey } from "./composer-draft";

interface ChatViewScreenProps {
  state: CompanionState;
  target: ChatTarget;
  connection: CompanionClient;
  bot?: Bot;
  room?: Room;
  onSend: (text: string) => Promise<boolean>;
  onRespond: (threadId: string, requestId: string, behavior: string, message?: string) => void;
  onAlwaysAllow: (botId: string, allowKey: string) => void;
  onBack: () => void;
  onLoadOlder: () => void;
  viewConversation: (target: ChatTarget) => () => void;
  readError: string | null;
  onRetryRead: () => void;
}

function Bubble({
  message,
  color,
  onApprove,
  onDeny,
  onAllowAlways,
}: {
  message: Message;
  color: string;
  onApprove: (card: NonNullable<Message["card"]>) => void;
  onDeny: (card: NonNullable<Message["card"]>) => void;
  onAllowAlways: (card: NonNullable<Message["card"]>) => void;
}) {
  const isUser = message.role === "user";

  if (message.kind === "activity" && message.tool) {
    const ok = message.tool.ok;
    return (
      <View style={[styles.activityRow, isUser && styles.activityRowUser]}>
        <Text style={styles.activityText}>
          {ok === false ? "✗" : "⚙"} {message.tool.name}
        </Text>
      </View>
    );
  }

  if (message.kind === "options" && message.card) {
    const card = message.card;
    const pending = isCardPending(card);
    return (
      <View style={[styles.card, !pending && styles.cardDone]}>
        <Text style={styles.cardTitle}>{card.title}</Text>
        {card.subtitle ? <Text style={styles.cardSubtitle}>{card.subtitle}</Text> : null}
        {pending ? (
          <View style={styles.cardActions}>
            <TouchableOpacity
              style={[styles.cardBtn, styles.cardAllow]}
              onPress={() => onApprove(card)}
            >
              <Text style={styles.cardAllowText}>Allow</Text>
            </TouchableOpacity>
            {card.allowKey ? (
              <TouchableOpacity
                style={[styles.cardBtn, styles.cardAlways]}
                onPress={() => onAllowAlways(card)}
              >
                <Text style={styles.cardAlwaysText}>Always</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.cardBtn, styles.cardDeny]}
              onPress={() => onDeny(card)}
            >
              <Text style={styles.cardDenyText}>Deny</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <Text style={styles.cardAnswered}>
            {card.dismissed ? "Dismissed" : `Answered: ${card.answered ?? ""}`}
          </Text>
        )}
      </View>
    );
  }

  if (message.kind === "unknown" || (!message.text && message.kind === "text")) {
    if (!message.text) return null;
  }

  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleBot]}>
      {!isUser && message.from?.name ? (
        <Text style={[styles.sender, { color }]}>{message.from.name}</Text>
      ) : null}
      {message.comm ? (
        <Text style={styles.comm}>↔ {message.comm.withName ?? "room"}</Text>
      ) : null}
      <Text style={isUser ? styles.bubbleTextUser : styles.bubbleText}>{message.text}</Text>
    </View>
  );
}

interface ChatComposerProps {
  title: string;
  onSend: (text: string) => Promise<boolean>;
}
function ChatComposer({ title, onSend }: ChatComposerProps) {
  const sendRef = useRef(onSend);
  useLayoutEffect(() => { sendRef.current = onSend; }, [onSend]);
  const [composer] = useState(() => new ComposerDraft((text) => sendRef.current(text)));
  const { draft, pending, error } = useSyncExternalStore(composer.subscribe, composer.getSnapshot, composer.getSnapshot);
  useLayoutEffect(composer.attach, [composer]);
  const disabled = pending || !draft.trim();
  return (
    <View style={styles.composerSection}>
      {error ? <Text style={styles.sendError} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text> : null}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          accessibilityLabel="Message draft"
          placeholder={`Message ${title}…`}
          placeholderTextColor="#666"
          value={draft}
          onChangeText={composer.edit}
          multiline
        />
        <TouchableOpacity
          style={[styles.send, disabled && styles.sendDisabled]}
          onPress={() => { void composer.submit(); }}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled, busy: pending }}
        >
          {pending ? <ActivityIndicator color="#fff" /> : <Text style={styles.sendText}>↑</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function ChatViewScreen({
  state,
  target,
  connection,
  bot,
  room,
  onSend,
  onRespond,
  onAlwaysAllow,
  onBack,
  onLoadOlder,
  viewConversation,
  readError,
  onRetryRead,
}: ChatViewScreenProps) {
  const listRef = useRef<FlatList<Message | null>>(null);
  const threadId = target.threadId;

  const transcript = useMemo(() => visibleTranscript(state, threadId), [state, threadId]);
  const streams: StreamBuffers | undefined = state.streams[threadId];
  const hasMore = state.hasMore[threadId] ?? false;
  const title = bot?.name ?? room?.name ?? "Chat";
  const color = bot?.color ?? "#f0460e";

  useLayoutEffect(() => viewConversation({
    kind: target.kind, id: target.id, threadId: target.threadId,
  }), [target.kind, target.id, target.threadId, viewConversation]);

  const rows: (Message | null)[] = useMemo(() => {
    const out: (Message | null)[] = [...transcript];
    if (streams?.reasoning) out.push(null); // reasoning placeholder
    if (streams?.text) out.push(null); // streaming placeholder
    return out;
  }, [transcript, streams]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
    >
      <StatusBar style="light" />
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back to chats">
          <Text style={styles.back}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Text style={styles.title}>{title}</Text>
          {bot?.busy ? <Text style={styles.busy}>working…</Text> : null}
        </View>
        <View style={{ width: 32 }} />
      </View>

      <FlatList
        ref={listRef}
        data={rows}
        inverted
        keyExtractor={(item, i) => item?.id ?? `stream-${i}`}
        onEndReached={() => hasMore && onLoadOlder()}
        onEndReachedThreshold={0.4}
        ListFooterComponent={hasMore ? <ActivityIndicator color="#555" style={styles.more} /> : null}
        renderItem={({ item }) => {
          if (item === null) {
            const text = streams?.text ? streams.text : streams?.reasoning ?? "";
            const label = streams?.text ? "" : "thinking · ";
            return (
              <View style={[styles.bubble, styles.bubbleBot]}>
                {label ? <Text style={styles.reasoning}>{label}{streams?.reasoning?.slice(-140)}</Text> : null}
                {streams?.text ? <Text style={styles.bubbleText}>{streams.text}</Text> : null}
                {!streams?.text ? <Text style={styles.caret}>▍</Text> : null}
                {text.length === 0 ? <Text style={styles.caret}>▍</Text> : null}
              </View>
            );
          }
          return (
            <View
              style={
                item.role === "user"
                  ? styles.userRow
                  : item.kind === "activity"
                    ? styles.activityOuter
                    : undefined
              }
            >
              <Bubble
                message={item}
                color={color}
                onApprove={(card) =>
                  card.requestId && onRespond(threadId, card.requestId, "allow")
                }
                onDeny={(card) =>
                  card.requestId &&
                  onRespond(threadId, card.requestId, card.tool ? "deny" : "dismiss")
                }
                onAllowAlways={(card) => {
                  if (card.requestId && card.allowKey && bot) {
                    onAlwaysAllow(bot.id, card.allowKey);
                    onRespond(threadId, card.requestId, "allow");
                  }
                }}
              />
            </View>
          );
        }}
        style={styles.list}
      />

      {readError ? (
        <View style={styles.readStatus}>
          <Text style={styles.readError} accessibilityRole="alert" accessibilityLiveRegion="polite">{readError}</Text>
          <TouchableOpacity onPress={onRetryRead} accessibilityRole="button" accessibilityLabel="Retry read status" style={styles.readRetry}>
            <Text style={styles.readRetryText}>Retry read status</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <ChatComposer
        key={composerContextKey(connection, target)}
        title={title}
        onSend={onSend}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 52,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#222",
  },
  back: { color: "#f0460e", fontSize: 30, lineHeight: 34, width: 32 },
  headerTitle: { flex: 1, alignItems: "center" },
  title: { color: "#f6f6f7", fontSize: 16, fontWeight: "600" },
  busy: { color: "#f0460e", fontSize: 11, marginTop: 1 },
  list: { flex: 1 },
  more: { marginVertical: 8 },
  userRow: { alignItems: "flex-end" },
  activityOuter: { alignItems: "flex-start" },
  bubble: {
    maxWidth: "82%",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginHorizontal: 14,
    marginVertical: 4,
  },
  bubbleBot: { backgroundColor: "#1a1a1c", alignSelf: "flex-start" },
  bubbleUser: { backgroundColor: "#f0460e", alignSelf: "flex-end" },
  sender: { fontSize: 12, fontWeight: "700", marginBottom: 2 },
  comm: { color: "#8a8a8e", fontSize: 11, marginBottom: 2 },
  bubbleText: { color: "#e8e8ea", fontSize: 15, lineHeight: 21 },
  bubbleTextUser: { color: "#fff", fontSize: 15, lineHeight: 21 },
  reasoning: { color: "#6a6a6e", fontSize: 12, fontStyle: "italic" },
  caret: { color: "#f0460e", fontSize: 14 },
  activityRow: {
    alignSelf: "flex-start",
    backgroundColor: "#141416",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginHorizontal: 14,
    marginVertical: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#26262a",
  },
  activityRowUser: { alignSelf: "flex-end" },
  activityText: { color: "#9a9a9e", fontSize: 12, fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) },
  card: {
    alignSelf: "flex-start",
    backgroundColor: "#1c1c1e",
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 14,
    marginVertical: 4,
    maxWidth: "86%",
    borderWidth: 1,
    borderColor: "#3a3a3e",
  },
  cardDone: { opacity: 0.55, borderColor: "#2a2a2c" },
  cardTitle: { color: "#f6f6f7", fontSize: 15, fontWeight: "600" },
  cardSubtitle: { color: "#8a8a8e", fontSize: 13, marginTop: 3, lineHeight: 18 },
  cardActions: { flexDirection: "row", gap: 8, marginTop: 12 },
  cardBtn: {
    borderRadius: 9,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  cardAllow: { backgroundColor: "#f0460e" },
  cardAllowText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  cardAlways: { backgroundColor: "#2a2a2c" },
  cardAlwaysText: { color: "#e8e8ea", fontWeight: "600", fontSize: 13 },
  cardDeny: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#3a3a3e" },
  cardDenyText: { color: "#9a9a9e", fontWeight: "600", fontSize: 13 },
  cardAnswered: { color: "#8a8a8e", fontSize: 12, marginTop: 8 },
  readStatus: { paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#222" },
  readError: { color: "#ff8a80", fontSize: 13, lineHeight: 18 },
  readRetry: { alignSelf: "flex-start", paddingVertical: 10, marginTop: 2 },
  readRetryText: { color: "#f6f6f7", fontSize: 13, fontWeight: "600" },
  composerSection: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#222" },
  sendError: { color: "#ff8a80", paddingHorizontal: 16, paddingTop: 10, fontSize: 13, lineHeight: 18 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 12,
    paddingBottom: 24,
  },
  input: {
    flex: 1,
    backgroundColor: "#1a1a1c",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    color: "#f6f6f7",
    fontSize: 15,
    maxHeight: 120,
    marginRight: 8,
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#f0460e",
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.35 },
  sendText: { color: "#fff", fontSize: 20, fontWeight: "700" },
});
