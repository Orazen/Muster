import React, { useLayoutEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { CompanionState } from "../core/store";
import { seedCardSignature, seedCardWriteBlocker } from "../core/seed-card";
import type { Message } from "../core/types";
import {
  seedActionKey, seedReference,
  type ChatTarget, type CompanionClient, type SeedAction, type SeedActionState, type SeedReference,
} from "../hooks/companion-session";
import { composerContextKey } from "./composer-draft";
import { SeedCardHost, SeedCardPublication, SeedCardSlot, useSeedCardHost } from "./SeedCardHost";

export interface SeedRequestCardProps {
  state: CompanionState;
  message: Message;
  target: ChatTarget;
  connection: CompanionClient;
  seedActions: Record<string, SeedActionState>;
  onSeedAction: (reference: SeedReference, action: SeedAction) => Promise<void>;
}

const CARD_MARGIN = 6;

/** Drafts belong to this mounted account/conversation/card, never its successor. */
export function SeedRequestCard(props: SeedRequestCardProps) {
  const host = useSeedCardHost();
  if (host) return <SeedCardSlot id={props.message.id} />;
  return <SeedCardHost key={composerContextKey(props.connection, props.target)}>
    <SeedCardOwner {...props} /><SeedCardSlot id={props.message.id} />
  </SeedCardHost>;
}

/** Mounted at chat root, independently of its virtualized presentation row. */
export function SeedCardOwner(props: SeedRequestCardProps) {
  const identity = JSON.stringify([
    composerContextKey(props.connection, props.target), props.message.id, seedCardSignature(props.message),
  ]);
  return <SeedContent key={identity} {...props} />;
}

function SeedContent({ state, message, target, seedActions, onSeedAction }: SeedRequestCardProps) {
  const [draft, setDraft] = useState("");
  const [lastAnswer, setLastAnswer] = useState<string | undefined>();
  const [pending, setPending] = useState<SeedAction["kind"] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [editorGeneration, setEditorGeneration] = useState<number | null>(null);
  const editor = useRef(false);
  const editorEpoch = useRef(0);
  const answerInput = useRef<TextInput>(null);
  const active = useRef(false);
  const epoch = useRef(0);
  const locked = useRef(false);
  const reference = seedReference(state, target, message);
  const candidate = reference ? seedActions[seedActionKey(reference)] : undefined;
  const action = candidate && (candidate.reference.signature === reference?.signature || candidate.phase === "pending" || candidate.inFlight)
    ? candidate : undefined;
  const card = message.card;
  const receipt = card?.seedAnswer;
  const writeBlocked = reference ? seedCardWriteBlocker(state, reference.botId, reference.threadId, reference.cardId) : null;
  const canAnswer = !!reference && !writeBlocked && card?.answered == null && !receipt;
  const canStart = !!reference && !writeBlocked && (receipt?.status === "recorded" || receipt?.status === "not-started");
  const busy = pending !== null || action?.phase === "pending" || action?.inFlight === true;
  const failure = localError ?? (action?.phase === "failed" ? action.message : null);
  const retryAnswer = lastAnswer ?? action?.lastAnswer;
  // Old event handlers must observe current eligibility, even if a busy flag,
  // newer user message or active branch changes without replacing this card.
  const current = useRef({ reference, canAnswer, canStart, busy, onSeedAction });
  useLayoutEffect(() => { current.current = { reference, canAnswer, canStart, busy, onSeedAction }; });
  useLayoutEffect(() => {
    if (!canAnswer) { editor.current = false; editorEpoch.current++; setEditorGeneration(null); }
  }, [canAnswer]);
  useLayoutEffect(() => {
    active.current = true;
    epoch.current++;
    return () => {
      active.current = false; epoch.current++;
      editor.current = false; editorEpoch.current++;
    };
  }, []);

  const submit = async (next: SeedAction) => {
    const now = current.current;
    if (!active.current || locked.current || now.busy || !now.reference) return;
    if (next.kind === "answer" && (!now.canAnswer || !next.text.trim() || next.text.length > 4000)) return;
    if (next.kind === "start" && !now.canStart) return;
    locked.current = true;
    const started = epoch.current;
    setPending(next.kind);
    setLocalError(null);
    if (next.kind === "answer") setLastAnswer(next.text);
    try { await now.onSeedAction(now.reference, next); }
    catch (error) {
      if (active.current && epoch.current === started) {
        setLocalError(error instanceof Error && error.message.trim()
          ? error.message : "Could not confirm the saved answer. Check status before retrying.");
      }
    } finally {
      if (active.current && epoch.current === started) { locked.current = false; setPending(null); }
    }
  };

  if (!card) return null;
  const editorVisible = editorGeneration !== null && canAnswer;
  const currentEditor = () => active.current && editor.current && editorGeneration === editorEpoch.current;
  const closeEditor = () => {
    if (!currentEditor()) return;
    editor.current = false; editorEpoch.current++; setEditorGeneration(null);
  };
  const button = (label: string, next: SeedAction, disabled = busy, primary = false, inEditor = false) => (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled, busy }} disabled={disabled}
      style={[styles.button, primary && styles.primary, disabled && styles.disabled]}
      onPress={() => { if (inEditor ? currentEditor() : !editor.current) void submit(next); }}>
      <Text style={styles.buttonText}>{label}</Text>
    </TouchableOpacity>
  );

  const feedback = <>
    {busy ? <Text style={styles.note} accessibilityLiveRegion="polite">{
      action?.phase === "failed" && action.inFlight ? "Waiting for the previous request to close…"
        : (pending ?? action?.operation) === "check" ? "Checking saved status…"
        : (pending ?? action?.operation) === "start" ? "Requesting task start…" : "Recording your answer…"
    }</Text> : null}
    {reference && failure ? <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{failure}</Text> : null}
    {reference && (receipt || failure || writeBlocked) ? <View style={styles.choices}>
      {button("Check status", { kind: "check" }, busy, false, editorVisible)}
      {canStart ? button("Start saved task", { kind: "start" }, busy, true) : null}
      {canAnswer && failure && retryAnswer !== undefined
        ? button("Retry same answer", { kind: "answer", text: retryAnswer }, busy, false, editorVisible) : null}
    </View> : null}
  </>;

  const cardView = <View style={styles.card} accessibilityElementsHidden={editorVisible}
    importantForAccessibility={editorVisible ? "no-hide-descendants" : "auto"}>
    <Text style={styles.kind}>{reference ? "Getting started question" : "Saved question"}</Text>
    <Text style={styles.title}>{card.title}</Text>
    {card.subtitle ? <Text style={styles.subtitle}>{card.subtitle}</Text> : null}
    <View style={styles.choices}>{card.options.map((option, index) => (
      <View key={`${index}:${option}`}>
        {canAnswer ? button(option, { kind: "answer", text: option }) : <Text style={styles.choice}>{option}</Text>}
      </View>
    ))}</View>
    {canAnswer ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Write your own answer"
      accessibilityState={{ disabled: busy, busy }} disabled={busy} style={[styles.button, styles.choices, busy && styles.disabled]}
      onPress={() => {
        if (!active.current || editor.current || !current.current.canAnswer || current.current.busy) return;
        editor.current = true; setEditorGeneration(++editorEpoch.current);
      }}><Text style={styles.buttonText}>Write your own answer</Text></TouchableOpacity> : null}
    {card.answered != null ? <Text style={styles.saved}>Saved answer: {card.answered}</Text> : null}
    {reference && receipt ? <View accessibilityLiveRegion="polite">
      <Text style={styles.note}>{receipt.status === "recorded" ? "Answer recorded. The task has not started."
        : receipt.status === "starting" ? "Answer recorded. Start requested; waiting for confirmation."
        : receipt.status === "started" ? "Answer recorded. The task started; follow its progress in this conversation."
        : receipt.status === "not-started" ? "Answer recorded. The task did not start. Resolve the issue below, then start the saved task."
        : "Answer recorded. The start result could not be confirmed. Check status and review this conversation before sending another task."}</Text>
      {receipt.error ? <Text style={styles.note}>{receipt.error}</Text> : null}
    </View> : null}
    {!reference ? <Text style={styles.note}>Continue on your computer to review this saved question. It cannot start a task here.</Text> : null}
    {writeBlocked ? <Text style={styles.note}>{writeBlocked}</Text> : null}
    {!editorVisible ? feedback : null}
  </View>;
  const editorView = editorVisible ?
      <KeyboardAvoidingView style={styles.editor} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.editorHeader}>
          <Text style={styles.editorTitle} accessibilityRole="header">Your own answer</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close answer editor"
            style={styles.button} onPress={closeEditor}><Text style={styles.buttonText}>Close</Text></TouchableOpacity>
        </View>
        <ScrollView style={styles.editorScroll} contentContainerStyle={styles.editorContent} keyboardShouldPersistTaps="handled">
          <TextInput ref={answerInput} accessibilityLabel="Your own answer" placeholder="Type your own answer"
            placeholderTextColor="#8a8a8e" value={draft} onChangeText={(text) => {
              if (currentEditor() && current.current.canAnswer) setDraft(text);
            }} multiline maxLength={4000} style={styles.input} />
          {feedback}
        </ScrollView>
        <View style={styles.editorFooter}>
          {button("Send answer", { kind: "answer", text: draft }, busy || !draft.trim() || draft.length > 4000, true, true)}
        </View>
      </KeyboardAvoidingView>
    : null;
  return <SeedCardPublication id={message.id} card={cardView} editor={editorView && editorGeneration !== null ? {
    node: editorView, opening: editorGeneration, onClose: closeEditor,
    onShown: () => { if (currentEditor() && current.current.canAnswer) answerInput.current?.focus(); },
  } : null} />;
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 14, marginVertical: CARD_MARGIN, padding: 14, borderRadius: 16, backgroundColor: "#1c1c1e", borderWidth: 1, borderColor: "#3a3a3e" },
  kind: { color: "#b5b5bb", fontSize: 11, fontWeight: "600", marginBottom: 6 },
  title: { color: "#f6f6f7", fontSize: 16, fontWeight: "600", lineHeight: 22 },
  subtitle: { color: "#b5b5bb", fontSize: 14, marginTop: 5, lineHeight: 20 },
  choices: { marginTop: 12, gap: 8 },
  choice: { color: "#d4d4d8", fontSize: 14, lineHeight: 20, paddingVertical: 6 },
  button: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, backgroundColor: "#2a2a2e", justifyContent: "center" },
  primary: { backgroundColor: "#c63d0a" },
  buttonText: { color: "#fff", fontSize: 14, lineHeight: 20, fontWeight: "600", flexShrink: 1 },
  disabled: { opacity: 0.5 },
  editor: { flex: 1, backgroundColor: "#0a0a0a" },
  editorHeader: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderBottomWidth: 1, borderBottomColor: "#3a3a3e" },
  editorTitle: { flex: 1, color: "#f6f6f7", fontSize: 18, lineHeight: 24, fontWeight: "600" },
  editorScroll: { flex: 1 },
  editorContent: { padding: 16 },
  editorFooter: { padding: 12, borderTopWidth: 1, borderTopColor: "#3a3a3e" },
  input: { color: "#f6f6f7", backgroundColor: "#111113", borderRadius: 10, padding: 12, minHeight: 84, maxHeight: 160, fontSize: 15, textAlignVertical: "top" },
  saved: { color: "#e8e8ea", fontSize: 14, lineHeight: 20, marginTop: 12 },
  note: { color: "#b5b5bb", fontSize: 13, lineHeight: 19, marginTop: 8 },
  error: { color: "#ff8a80", fontSize: 13, lineHeight: 19, marginTop: 12 },
});
