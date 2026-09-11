import React, { useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  cardActionKey, cardReference, outcomeMessage,
  type CardAction, type CardActionState, type CardReference,
} from "../core/card-actions";
import { isCardPending, isPermissionCard, type Bot, type Message } from "../core/types";
import type { ChatTarget, CompanionClient } from "../hooks/companion-session";
import { composerContextKey } from "./composer-draft";

export interface RequestCardProps {
  message: Message;
  target: ChatTarget;
  connection: CompanionClient;
  bot?: Bot;
  cardActions: Record<string, CardActionState>;
  onCardAction: (reference: CardReference, action: CardAction) => Promise<void>;
  onRefreshCards: () => Promise<void>;
}

// Identity includes the connection even when two accounts reuse every wire ID.
// Server settlement does not change the signature or discard a typed answer.
export function RequestCard(props: RequestCardProps) {
  const reference = cardReference(props.target, props.message);
  const key = JSON.stringify([
    composerContextKey(props.connection, props.target), props.message.id,
    reference?.requestId ?? null, reference?.signature ?? null,
  ]);
  return <CardContent key={key} {...props} reference={reference} />;
}

function CardContent({
  message, target, bot, reference, cardActions, onCardAction, onRefreshCards,
}: RequestCardProps & { reference: CardReference | null }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const active = useRef(false);
  const epoch = useRef(0);
  const locked = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    epoch.current++;
    locked.current = false;
    setSending(false);
    setChecking(false);
    return () => { active.current = false; epoch.current++; };
  }, []);

  const card = message.card;
  if (!card) return null;
  const candidate = reference ? cardActions[cardActionKey(reference)] : undefined;
  // A content change cannot unlock an operation already using this request.
  const state = candidate && (candidate.reference.signature === reference?.signature || candidate.phase === "pending")
    ? candidate : undefined;
  const permission = isPermissionCard(card);
  const settled = !isCardPending(card) || state?.phase === "settled";
  const busy = sending || checking || state?.phase === "pending";
  const actionable = reference !== null && !settled;
  const unavailable = card.answered === "unavailable" || state?.outcome === "unavailable";
  const canRemember = permission && target.kind === "bot" && bot?.id === target.id
    && bot.threadId === target.threadId && !bot.hidden && !!card.allowKey?.trim();
  const failure = localError ?? (!settled && state?.phase === "failed" ? state.message : null);
  const status = unavailable ? outcomeMessage("unavailable")
    : state?.phase === "settled" && state.outcome ? outcomeMessage(state.outcome)
    : card.dismissed ? "Dismissed."
    : permission && card.answered === "allow" ? outcomeMessage("allowed-once")
    : permission && card.answered === "deny" ? outcomeMessage("rejected")
    : card.answered === "answer" ? outcomeMessage("answered")
    : card.answered != null ? `Answered: ${card.answered}` : null;

  const submit = async (action: CardAction) => {
    if (!active.current || locked.current || busy || !actionable || !reference) return;
    locked.current = true;
    const started = epoch.current;
    setSending(true);
    setLocalError(null);
    try { await onCardAction(reference, action); }
    catch (error) {
      if (active.current && epoch.current === started) {
        setLocalError(error instanceof Error ? error.message : "Could not confirm delivery. Check status before retrying.");
      }
    } finally {
      if (active.current && epoch.current === started) { locked.current = false; setSending(false); }
    }
  };
  const checkStatus = async () => {
    if (!active.current || locked.current || busy) return;
    locked.current = true;
    const started = epoch.current;
    setChecking(true);
    setLocalError(null);
    try { await onRefreshCards(); }
    catch (error) {
      if (active.current && epoch.current === started) {
        setLocalError(error instanceof Error ? error.message : "Could not refresh this request. Try checking again.");
      }
    } finally {
      if (active.current && epoch.current === started) { locked.current = false; setChecking(false); }
    }
  };

  const button = (label: string, action: CardAction, primary = false) => (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled: busy, busy }} disabled={busy}
      style={[styles.button, primary && styles.primary, busy && styles.disabled]}
      onPress={() => { void submit(action); }}>
      <Text style={styles.buttonText}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.card}>
      <Text style={styles.kind}>{permission ? "Permission request" : "Question"}</Text>
      <Text style={styles.title}>{card.title}</Text>
      {card.subtitle ? <Text style={styles.subtitle}>{card.subtitle}</Text> : null}
      {permission && card.tool ? <Text style={styles.tool}>{card.tool}</Text> : null}
      {card.held ? <Text style={styles.held}>{card.held}</Text> : null}

      {!permission && card.options.length > 0 ? (
        <View style={styles.choices}>
          {card.options.map((option, index) => actionable ? (
            <TouchableOpacity key={`${index}:${option}`} accessibilityRole="button" accessibilityLabel={option}
              accessibilityState={{ disabled: busy, busy }} disabled={busy}
              style={[styles.button, busy && styles.disabled]}
              onPress={() => { void submit({ kind: "answer", text: option }); }}>
              <Text style={styles.buttonText}>{option}</Text>
            </TouchableOpacity>
          ) : <Text key={`${index}:${option}`} style={styles.choiceText}>{option}</Text>)}
        </View>
      ) : null}

      {actionable ? permission ? (
        <View style={styles.choices}>
          {button("Allow once", { kind: "allow" }, true)}
          {button("Deny", { kind: "deny" })}
          {canRemember ? <>
            {button("Always allow this tool", { kind: "always" })}
            <Text style={styles.note}>Remembers {card.allowKey} for {bot.name}.</Text>
          </> : null}
        </View>
      ) : (
        <View style={styles.choices}>
          <TextInput accessibilityLabel="Your answer" placeholder="Type your own answer"
            placeholderTextColor="#8a8a8e" value={draft} onChangeText={setDraft}
            multiline style={styles.input} />
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Send answer"
            accessibilityState={{ disabled: busy || !draft.trim(), busy }} disabled={busy || !draft.trim()}
            style={[styles.button, styles.primary, (busy || !draft.trim()) && styles.disabled]}
            onPress={() => { if (draft.trim()) void submit({ kind: "answer", text: draft }); }}>
            <Text style={styles.buttonText}>Send answer</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!reference && !settled ? <Text style={styles.note}>{permission
        ? "Continue on your computer to review this request."
        : "Continue on your computer to answer this question."}</Text> : null}
      {busy ? <Text style={styles.note} accessibilityLiveRegion="polite">{checking ? "Checking status…" : "Sending response…"}</Text> : null}
      {status ? <Text style={unavailable ? styles.error : styles.status}
        accessibilityRole={unavailable ? "alert" : undefined} accessibilityLiveRegion="polite">{status}</Text> : null}
      {state?.grantSaved ? <Text style={styles.note}>The tool grant was saved for this bot.</Text> : null}
      {failure ? <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{failure}</Text> : null}
      {failure || unavailable ? (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Check status"
          accessibilityState={{ disabled: busy, busy: checking }} disabled={busy}
          style={[styles.button, styles.check, busy && styles.disabled]}
          onPress={() => { void checkStatus(); }}>
          <Text style={styles.buttonText}>Check status</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 14, marginVertical: 6, padding: 14, borderRadius: 16, backgroundColor: "#1c1c1e", borderWidth: 1, borderColor: "#3a3a3e" },
  kind: { color: "#b5b5bb", fontSize: 11, fontWeight: "600", marginBottom: 6 },
  title: { color: "#f6f6f7", fontSize: 16, fontWeight: "600", lineHeight: 22 },
  subtitle: { color: "#b5b5bb", fontSize: 14, marginTop: 5, lineHeight: 20 },
  tool: { color: "#d4d4d8", fontSize: 12, marginTop: 8 },
  held: { color: "#ffbf80", fontSize: 13, lineHeight: 19, marginTop: 10 },
  choices: { marginTop: 12, gap: 8 },
  choiceText: { color: "#d4d4d8", fontSize: 14, lineHeight: 20, paddingVertical: 6 },
  button: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, backgroundColor: "#2a2a2e", justifyContent: "center" },
  primary: { backgroundColor: "#c63d0a" },
  buttonText: { color: "#fff", fontSize: 14, lineHeight: 20, fontWeight: "600", flexShrink: 1 },
  disabled: { opacity: 0.5 },
  input: { color: "#f6f6f7", backgroundColor: "#111113", borderRadius: 10, padding: 12, minHeight: 48, maxHeight: 120, fontSize: 15, textAlignVertical: "top" },
  note: { color: "#b5b5bb", fontSize: 12, lineHeight: 18, marginTop: 8 },
  status: { color: "#d4d4d8", fontSize: 14, lineHeight: 20, marginTop: 12 },
  error: { color: "#ff8a80", fontSize: 13, lineHeight: 19, marginTop: 12 },
  check: { marginTop: 10 },
});
