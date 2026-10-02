import React, { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createThemedStyles, useCompanionTheme } from "./theme";
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
import { Bot, Message, Room } from "../core/types";
import { CompanionState, StreamBuffers, visibleTranscript } from "../core/store";
import type { ChatTarget, CompanionClient } from "../hooks/companion-session";
import { ComposerDraft, composerContextKey } from "./composer-draft";
import { RequestCard, type RequestCardProps } from "./RequestCard";
import { SeedCardHost } from "./SeedCardHost";
import { SeedCardOwner } from "./SeedRequestCard";

interface ChatViewScreenProps {
  state: CompanionState;
  target: ChatTarget;
  connection: CompanionClient;
  bot?: Bot;
  room?: Room;
  onSend: (text: string) => Promise<boolean>;
  onCardAction: RequestCardProps["onCardAction"];
  cardActions: RequestCardProps["cardActions"];
  onRefreshCards: RequestCardProps["onRefreshCards"];
  onSeedAction: RequestCardProps["onSeedAction"];
  seedActions: RequestCardProps["seedActions"];
  onBack: () => void;
  onLoadOlder: () => void;
  viewConversation: (target: ChatTarget) => () => void;
  readError: string | null;
  onRetryRead: () => void;
}

function Bubble({
  message,
  color,
}: {
  message: Message;
  color: string;
}) {
  const theme = useCompanionTheme();
  const styles = themedStyles[theme.scheme];
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

  if (message.kind === "unknown" || (!message.text && message.kind === "text")) {
    if (!message.text) return null;
  }

  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleBot]}>
      {!isUser && message.from?.name ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View accessible={false} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
          <Text style={styles.sender}>{message.from.name}</Text>
        </View>
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
  const theme = useCompanionTheme();
  const styles = themedStyles[theme.scheme];
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
          placeholderTextColor={theme.secondary}
          selectionColor={theme.accent}
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
          {pending ? <ActivityIndicator color={theme.primaryInk} /> : <Text style={styles.sendText}>↑</Text>}
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
  onCardAction,
  cardActions,
  onRefreshCards,
  onSeedAction,
  seedActions,
  onBack,
  onLoadOlder,
  viewConversation,
  readError,
  onRetryRead,
}: ChatViewScreenProps) {
  const theme = useCompanionTheme();
  const styles = themedStyles[theme.scheme];
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
    // An inverted list places index zero nearest the composer. Keep the
    // stored transcript chronological and put one live row at that edge.
    const out: (Message | null)[] = [...transcript].reverse();
    if (streams?.reasoning || streams?.text) out.unshift(null);
    return out;
  }, [transcript, streams]);


  return (
    <SeedCardHost key={composerContextKey(connection, target)}>
      {transcript.filter((message) => message.kind === "options" && message.card && !message.card.requestId).map((message) =>
        <SeedCardOwner key={message.id} state={state} message={message} target={target} connection={connection}
          seedActions={seedActions} onSeedAction={onSeedAction} />)}
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
    >
      <StatusBar style={theme.statusBar} />
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
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item, i) => item?.id ?? `stream-${i}`}
        onEndReached={() => hasMore && onLoadOlder()}
        onEndReachedThreshold={0.4}
        ListFooterComponent={hasMore ? <ActivityIndicator color={theme.secondary} style={styles.more} /> : null}
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
              {item.kind === "options" && item.card ? (
                <RequestCard state={state} message={item} target={target} connection={connection} bot={bot}
                  seedActions={seedActions} onSeedAction={onSeedAction}
                  cardActions={cardActions} onCardAction={onCardAction} onRefreshCards={onRefreshCards} />
              ) : <Bubble message={item} color={color} />}
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
    </SeedCardHost>
  );
}

const themedStyles = createThemedStyles((theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.page },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 52,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  back: { color: theme.accent, fontSize: 30, lineHeight: 34, width: 32 },
  headerTitle: { flex: 1, alignItems: "center" },
  title: { color: theme.ink, fontSize: 16, fontWeight: "600" },
  busy: { color: theme.accent, fontSize: 11, marginTop: 1 },
  list: { flex: 1 },
  more: { marginVertical: 8 },
  userRow: { alignItems: "flex-end" },
  activityOuter: { alignItems: "flex-start" },
  bubble: {
    maxWidth: "82%",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginHorizontal: 14,
    marginVertical: 4,
  },
  bubbleBot: { backgroundColor: "transparent", alignSelf: "flex-start", maxWidth: "92%" },
  bubbleUser: { backgroundColor: theme.userBubble, alignSelf: "flex-end" },
  sender: { color: theme.ink, fontSize: 12, fontWeight: "700", marginBottom: 2 },
  comm: { color: theme.secondary, fontSize: 11, marginBottom: 2 },
  bubbleText: { color: theme.ink, fontSize: 15, lineHeight: 21 },
  bubbleTextUser: { color: theme.ink, fontSize: 15, lineHeight: 21 },
  reasoning: { color: theme.secondary, fontSize: 12, fontStyle: "italic" },
  caret: { color: theme.accent, fontSize: 14 },
  activityRow: {
    alignSelf: "flex-start",
    backgroundColor: theme.panel,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginHorizontal: 14,
    marginVertical: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  activityRowUser: { alignSelf: "flex-end" },
  activityText: { color: theme.secondary, fontSize: 12, fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) },
  readStatus: { paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  readError: { color: theme.danger, fontSize: 13, lineHeight: 18 },
  readRetry: { alignSelf: "flex-start", paddingVertical: 10, marginTop: 2 },
  readRetryText: { color: theme.ink, fontSize: 13, fontWeight: "600" },
  composerSection: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  sendError: { color: theme.danger, paddingHorizontal: 16, paddingTop: 10, fontSize: 13, lineHeight: 18 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 12,
    paddingBottom: 24,
  },
  input: {
    flex: 1,
    backgroundColor: theme.raised,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    color: theme.ink,
    fontSize: 16,
    minHeight: 48,
    maxHeight: 120,
    marginRight: 8,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.35 },
  sendText: { color: theme.primaryInk, fontSize: 20, fontWeight: "700" },
}));
