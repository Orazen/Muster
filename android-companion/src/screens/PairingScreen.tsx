import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Linking, Platform, ScrollView,
  StatusBar as RNStatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pairingFillFromExternalText, resolvePairingInput, type PairingInput } from "../core/pairing";
import type { PairResponse } from "../core/types";
import { PairQrScanner } from "./PairQrScanner";

interface PairingScreenProps {
  pairing: boolean;
  error: string | null;
  onPair: (input: PairingInput) => Promise<{ response: PairResponse } | null>;
}

export function PairingScreen({ pairing, error, onPair }: PairingScreenProps) {
  const insets = useSafeAreaInsets();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const draft = useRef({ address: "", code: "" });
  const codeField = useRef<TextInput>(null);
  const pairingNow = useRef(pairing);
  pairingNow.current = pairing;
  const pending = useRef(false);
  const mounted = useRef(true);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [hideServerError, setHideServerError] = useState(false);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const resolution = resolvePairingInput({ address, code });
  const inviteReady = resolution.ok && resolution.method === "invite";
  const busy = pairing || submitting;
  const visibleError = busy ? null : localError ?? (hideServerError ? null : error);

  function editAddress(value: string) {
    if (pending.current || pairingNow.current) return;
    draft.current.address = value;
    setAddress(value);
    setLocalError(null);
    setHideServerError(true);
  }
  function editCode(value: string) {
    if (pending.current || pairingNow.current) return;
    const digits = value.replace(/[^0-9]/g, "").slice(0, 6);
    draft.current.code = digits;
    setCode(digits);
    setLocalError(null);
    setHideServerError(true);
  }
  function validate() {
    if (pending.current || pairingNow.current || !draft.current.address.trim()) return;
    const current = resolvePairingInput(draft.current);
    setLocalError(current.ok ? null : current.error);
  }
  async function submit() {
    if (!mounted.current || pending.current || pairingNow.current) return;
    const current = resolvePairingInput(draft.current);
    if (!current.ok) { setLocalError(current.error); return; }
    // One-time invitations must not be redeemed twice before React rerenders.
    pending.current = true;
    setSubmitting(true);
    setLocalError(null);
    setHideServerError(false);
    try {
      await onPair(current.value);
    } catch (failure) {
      if (mounted.current) setLocalError(failure instanceof Error ? failure.message : "Could not pair. Try again.");
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  // A deep link or a scanned QR code arrives here and fills the form — it
  // never pairs. The text is validated by the same invitation grammar a
  // paste goes through, so what fills is exactly what pasting would have
  // produced, and "Pair with computer" stays the only thing that sends.
  // An arrival is a deliberate act (the person just tapped the link or
  // aimed the camera), so it replaces what was typed. It touches only
  // refs and stable setters, so the effect below can safely hold this
  // first-render closure.
  function fillFromExternal(text: string) {
    if (pending.current || pairingNow.current) return; // fields are frozen mid-attempt
    const fill = pairingFillFromExternalText(text);
    if (!fill.ok) {
      setLocalError(fill.error);
      setHideServerError(true);
      return;
    }
    draft.current.address = fill.address;
    draft.current.code = "";
    setAddress(fill.address);
    setCode("");
    setLocalError(null);
    setHideServerError(true);
  }

  // Cold start through the link, and links arriving while this screen
  // lives. PairingScreen mounts exactly when the app is unpaired, so a
  // link opened while already paired meets no listener at all — a paired
  // phone ignores it rather than silently re-pairing somewhere else.
  useEffect(() => {
    let active = true;
    void Linking.getInitialURL().then((url) => {
      if (active && url) fillFromExternal(url);
    });
    const subscription = Linking.addEventListener("url", ({ url }) => {
      if (active) fillFromExternal(url);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  // One scan closes the scanner and hands the text to the same fill path
  // a deep link takes. Closing first means an invalid code shows its one
  // honest error on the form, not in a camera loop chasing it.
  function scanned(text: string) {
    setScanning(false);
    fillFromExternal(text);
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <RNStatusBar barStyle="light-content" backgroundColor="#0a0a0a" />
      <ScrollView
        contentContainerStyle={[styles.scrollContent, {
          paddingLeft: Math.max(insets.left, 24), paddingRight: Math.max(insets.right, 24),
          paddingBottom: Math.max(insets.bottom, 24),
        }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="never"
      >
        <View style={styles.content}>
          <View style={styles.brand}>
            <Image source={require("../../assets/icon.png")} style={styles.mascot} accessible={false} />
            <Text style={styles.brandName}>MUSTER<Text style={styles.brandDetail}>{"\n"}COMPANION</Text></Text>
          </View>
          <Text accessibilityRole="header" style={styles.title}>Your team.{"\n"}Anywhere.</Text>
          <Text style={styles.subtitle}>Follow work, send tasks and answer approvals from your phone.</Text>

          <View style={styles.setup}>
            <Text style={styles.setupTitle}>Start on your computer</Text>
            <Text style={styles.setupText}>Open Muster → Settings → Companion, then choose Set up a phone or Pair another phone.</Text>
          </View>

          <Text style={styles.label}>Pairing link or computer address</Text>
          <TextInput
            accessibilityLabel="Pairing link or computer address"
            style={styles.input}
            placeholder="Paste a link, or enter an address"
            placeholderTextColor="#838388"
            value={address}
            onChangeText={editAddress}
            onBlur={validate}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
            returnKeyType={inviteReady ? "go" : "next"}
            onSubmitEditing={() => { if (inviteReady) void submit(); else codeField.current?.focus(); }}
          />
          {inviteReady ? (
            <Text style={styles.ready}>Link ready for {resolution.value.address}</Text>
          ) : (
            <>
              <Text style={styles.fieldHint}>For example, 192.168.1.20:8810. Use the address shown on your computer.</Text>
              <Text style={styles.label}>6-digit pairing code</Text>
              <TextInput
                ref={codeField}
                accessibilityLabel="6-digit pairing code"
                style={[styles.input, styles.codeInput]}
                placeholder="000000"
                placeholderTextColor="#838388"
                value={code}
                onChangeText={editCode}
                onBlur={validate}
                keyboardType="number-pad"
                returnKeyType="go"
                maxLength={6}
                editable={!busy}
                onSubmitEditing={() => { void submit(); }}
              />
            </>
          )}

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Scan a pairing QR code"
            style={styles.scanButton}
            onPress={() => setScanning(true)}
            disabled={busy}
          >
            <Text style={styles.scanButtonText}>Scan QR code</Text>
          </TouchableOpacity>

          {visibleError ? (
            <View style={styles.errorBox}>
              <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{visibleError}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Pair with computer"
            accessibilityState={{ disabled: !resolution.ok || busy, busy }}
            style={[styles.button, (!resolution.ok || busy) && styles.buttonDisabled]}
            onPress={() => { void submit(); }}
            disabled={!resolution.ok || busy}
          >
            {busy ? <ActivityIndicator color="#201207" style={styles.spinner} /> : null}
            <Text style={styles.buttonText}>{busy ? "Connecting…" : "Pair with computer"}</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>Links and codes expire quickly. Open a fresh pairing window on your computer if needed.</Text>
        </View>
      </ScrollView>
      {scanning ? (
        <PairQrScanner onScan={scanned} onCancel={() => setScanning(false)} />
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  scrollContent: { flexGrow: 1, justifyContent: "center", paddingTop: 28 },
  content: { width: "100%", maxWidth: 440, alignSelf: "center" },
  brand: { flexDirection: "row", alignItems: "center", marginBottom: 24 },
  mascot: { width: 56, height: 56, marginRight: 12 },
  brandName: { fontSize: 16, fontWeight: "700", letterSpacing: 2, lineHeight: 23, color: "#f6f1e8" },
  brandDetail: { fontSize: 10, fontWeight: "500", letterSpacing: 2, color: "#aaa59d" },
  title: { fontSize: 36, fontWeight: "700", lineHeight: 40, letterSpacing: -1, color: "#f6f1e8", marginBottom: 12 },
  subtitle: { fontSize: 16, color: "#b2ada5", lineHeight: 23, marginBottom: 24 },
  setup: { borderLeftWidth: 2, borderLeftColor: "#f28a1d", paddingLeft: 14, marginBottom: 28 },
  setupTitle: { fontSize: 14, fontWeight: "600", color: "#f6f1e8", marginBottom: 5 },
  setupText: { fontSize: 14, lineHeight: 20, color: "#b2ada5" },
  label: { fontSize: 14, fontWeight: "600", color: "#e8e2d9", marginBottom: 9 },
  input: { backgroundColor: "#151515", borderRadius: 12, padding: 16, minHeight: 54, fontSize: 16, color: "#f6f6f7", borderWidth: 1, borderColor: "#393631" },
  codeInput: { letterSpacing: 5, fontSize: 20 },
  fieldHint: { fontSize: 12, lineHeight: 18, color: "#aaa59d", marginTop: 8, marginBottom: 20 },
  ready: { fontSize: 13, lineHeight: 19, color: "#dcb884", marginTop: 10 },
  errorBox: { backgroundColor: "#2a1714", borderRadius: 10, padding: 12, marginTop: 16 },
  error: { color: "#ffc6b8", fontSize: 14, lineHeight: 20 },
  button: { backgroundColor: "#f28a1d", borderRadius: 12, minHeight: 54, padding: 16, marginTop: 20, flexDirection: "row", justifyContent: "center", alignItems: "center" },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: "#201207", fontSize: 16, fontWeight: "700", flexShrink: 1, textAlign: "center" },
  spinner: { marginRight: 10 },
  hint: { color: "#aaa59d", fontSize: 12, lineHeight: 18, marginTop: 18, marginBottom: 8 },
  scanButton: {
    alignSelf: "flex-start",
    backgroundColor: "#151515",
    borderWidth: 1,
    borderColor: "#393631",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 11,
    marginTop: 2,
  },
  scanButtonText: { color: "#e8e2d9", fontSize: 14, fontWeight: "600" },
});
