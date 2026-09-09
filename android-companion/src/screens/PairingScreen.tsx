import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

interface PairingScreenProps {
  pairing: boolean;
  error: string | null;
  onPair: (input: { address: string; credential?: string; code?: string }) => void;
}

export function PairingScreen({ pairing, error, onPair }: PairingScreenProps) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");

  const canPair = address.trim().length > 0 && (code.length === 6 || address.includes("omb_pair_"));

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <RNStatusBar barStyle="light-content" />
      <View style={styles.content}>
        <Text style={styles.title}>Pair with Muster</Text>
        <Text style={styles.subtitle}>
          Run `muster pair` on your computer and scan the QR, or enter its
          address and the 6-digit code.
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Computer address (e.g. 192.168.1.20:8810)"
          placeholderTextColor="#666"
          value={address}
          onChangeText={setAddress}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <TextInput
          style={styles.input}
          placeholder="6-digit pairing code"
          placeholderTextColor="#666"
          value={code}
          onChangeText={(t) => setCode(t.replace(/[^0-9]/g, "").slice(0, 6))}
          keyboardType="number-pad"
          maxLength={6}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, (!canPair || pairing) && styles.buttonDisabled]}
          onPress={() => onPair({ address, code: code.length === 6 ? code : undefined })}
          disabled={!canPair || pairing}
        >
          <Text style={styles.buttonText}>{pairing ? "Pairing…" : "Pair"}</Text>
        </TouchableOpacity>

        <Text style={styles.hint}>
          The code expires quickly — request a fresh one with `muster pair` if
          pairing fails.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { flex: 1, justifyContent: "center", paddingHorizontal: 32 },
  title: { fontSize: 28, fontWeight: "700", color: "#f6f6f7", marginBottom: 8 },
  subtitle: { fontSize: 15, color: "#8a8a8e", marginBottom: 32, lineHeight: 21 },
  input: {
    backgroundColor: "#131314",
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: "#f6f6f7",
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#2a2a2c",
  },
  error: { color: "#ff5f52", marginBottom: 16, textAlign: "center" },
  button: {
    backgroundColor: "#f0460e",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  hint: { color: "#5a5a5e", fontSize: 13, textAlign: "center", marginTop: 24, lineHeight: 18 },
});
