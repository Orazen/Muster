import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { client } from "../core/client";

interface PairingScreenProps {
  onPaired: () => void;
}

export function PairingScreen({ onPaired }: PairingScreenProps) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePair = async () => {
    if (!address.trim() || !code.trim()) {
      setError("Enter both address and code");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const token = await client.pair({
        address: address.trim(),
        code: code.trim(),
      });
      await client.saveCredentials(address.trim(), token);
      onPaired();
    } catch (e: any) {
      setError(e.message || "Pairing failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <StatusBar style="light" />
      <View style={styles.content}>
        <Text style={styles.title}>Pair with Muster</Text>
        <Text style={styles.subtitle}>
          Enter your computer's address and the pairing code
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Computer address (e.g. 192.168.1.100:8810)"
          placeholderTextColor="#666"
          value={address}
          onChangeText={setAddress}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <TextInput
          style={styles.input}
          placeholder="6-digit pairing code"
          placeholderTextColor="#666"
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          maxLength={6}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handlePair}
          disabled={loading}
        >
          <Text style={styles.buttonText}>
            {loading ? "Pairing..." : "Pair"}
          </Text>
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
  content: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: "#888",
    marginBottom: 32,
  },
  input: {
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: "#fff",
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#333",
  },
  error: {
    color: "#ff4444",
    marginBottom: 16,
    textAlign: "center",
  },
  button: {
    backgroundColor: "#1084fe",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
