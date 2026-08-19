import React, { useState, useRef } from "react";
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Message, Approval } from "../core/types";

interface ChatViewScreenProps {
  roomId: string;
  messages: Message[];
  approvals: Approval[];
  onSendMessage: (content: string) => void;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onAnswer: (id: string, answer: string) => void;
  onBack: () => void;
}

export function ChatViewScreen({
  roomId,
  messages,
  approvals,
  onSendMessage,
  onApprove,
  onDeny,
  onAnswer,
  onBack,
}: ChatViewScreenProps) {
  const [input, setInput] = useState("");
  const flatListRef = useRef<FlatList>(null);

  const pendingApprovals = approvals.filter(
    (a) => a.roomId === roomId && a.status === "pending"
  );

  const handleSend = () => {
    if (!input.trim()) return;
    onSendMessage(input.trim());
    setInput("");
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.role === "user";
    return (
      <View
        style={[styles.messageBubble, isUser ? styles.userBubble : styles.botBubble]}
      >
        <Text style={[styles.messageText, isUser && styles.userText]}>
          {item.content}
        </Text>
        <Text style={styles.messageTime}>
          {new Date(item.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </Text>
      </View>
    );
  };

  const renderApproval = ({ item }: { item: Approval }) => {
    if (item.type === "question") {
      return (
        <View style={styles.approvalCard}>
          <Text style={styles.approvalTitle}>Question</Text>
          <Text style={styles.approvalDescription}>{item.description}</Text>
          <TextInput
            style={styles.answerInput}
            placeholder="Type your answer..."
            placeholderTextColor="#666"
            value=""
            onChangeText={(text) => onAnswer(item.id, text)}
          />
          <View style={styles.approvalActions}>
            <TouchableOpacity
              style={styles.approveButton}
              onPress={() => onAnswer(item.id, input)}
            >
              <Text style={styles.approveButtonText}>Send Answer</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.approvalCard}>
        <Text style={styles.approvalTitle}>
          {item.type === "shell" ? "Shell Command" : "File Edit"}
        </Text>
        <Text style={styles.approvalDescription}>{item.title}</Text>
        <Text style={styles.approvalDetail} numberOfLines={3}>
          {item.description}
        </Text>
        <View style={styles.approvalActions}>
          <TouchableOpacity
            style={styles.denyButton}
            onPress={() => onDeny(item.id)}
          >
            <Text style={styles.denyButtonText}>Deny</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.approveButton}
            onPress={() => onApprove(item.id)}
          >
            <Text style={styles.approveButtonText}>Allow</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={90}
    >
      <StatusBar style="light" />
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {roomId}
        </Text>
      </View>

      <FlatList
        ref={flatListRef}
        data={messages}
        renderItem={renderMessage}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messageList}
        onContentSizeChange={() =>
          flatListRef.current?.scrollToEnd({ animated: true })
        }
      />

      {pendingApprovals.length > 0 && (
        <View style={styles.approvalsContainer}>
          <FlatList
            data={pendingApprovals}
            renderItem={renderApproval}
            keyExtractor={(item) => item.id}
            horizontal
            showsHorizontalScrollIndicator={false}
          />
        </View>
      )}

      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          placeholder="Message..."
          placeholderTextColor="#666"
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          returnKeyType="send"
          multiline
        />
        <TouchableOpacity
          style={[styles.sendButton, !input.trim() && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={!input.trim()}
        >
          <Text style={styles.sendButtonText}>↑</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 60,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#1a1a1a",
  },
  backButton: {
    marginRight: 12,
    padding: 8,
  },
  backText: {
    fontSize: 24,
    color: "#1084fe",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#fff",
    flex: 1,
  },
  messageList: {
    padding: 16,
    paddingBottom: 8,
  },
  messageBubble: {
    maxWidth: "80%",
    padding: 12,
    borderRadius: 16,
    marginBottom: 8,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#1084fe",
    borderBottomRightRadius: 4,
  },
  botBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#1a1a1a",
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 15,
    color: "#fff",
    lineHeight: 20,
  },
  userText: {
    color: "#fff",
  },
  messageTime: {
    fontSize: 11,
    color: "#666",
    marginTop: 4,
  },
  approvalsContainer: {
    borderTopWidth: 1,
    borderTopColor: "#1a1a1a",
    paddingVertical: 12,
    paddingHorizontal: 16,
    maxHeight: 200,
  },
  approvalCard: {
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 16,
    marginRight: 12,
    minWidth: 280,
    borderWidth: 1,
    borderColor: "#333",
  },
  approvalTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#ffaa00",
    marginBottom: 8,
  },
  approvalDescription: {
    fontSize: 15,
    color: "#fff",
    marginBottom: 8,
  },
  approvalDetail: {
    fontSize: 13,
    color: "#888",
    fontFamily: "monospace",
    marginBottom: 12,
  },
  approvalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  denyButton: {
    backgroundColor: "#333",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  denyButtonText: {
    color: "#ff4444",
    fontSize: 14,
    fontWeight: "600",
  },
  approveButton: {
    backgroundColor: "#1084fe",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  approveButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  answerInput: {
    backgroundColor: "#0a0a0a",
    borderRadius: 8,
    padding: 12,
    color: "#fff",
    marginBottom: 12,
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: "#1a1a1a",
  },
  input: {
    flex: 1,
    backgroundColor: "#1a1a1a",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    color: "#fff",
    maxHeight: 100,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#1084fe",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  sendButtonDisabled: {
    opacity: 0.3,
  },
  sendButtonText: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
  },
});
