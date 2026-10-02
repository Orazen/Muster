// The QR scanner the pairing screen opens on request — and only on request.
import { createThemedStyles, useCompanionTheme } from "./theme";
//
// The system permission prompt fires from this component's mount, so the
// pairing screen never asks for a camera it is not showing. Scanning
// delivers the raw QR text upward exactly once per mount; whether that
// text is a pairing invitation is the core parser's decision, never the
// camera's. A real scan against a real code is device acceptance — these
// are the scanner's own boundaries, nothing more.
import React, { useEffect, useRef } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

export interface PairQrScannerProps {
  /** The raw scanned text, delivered at most once per mount. */
  onScan: (text: string) => void;
  onCancel: () => void;
}

export function PairQrScanner({ onScan, onCancel }: PairQrScannerProps) {
  const theme = useCompanionTheme();
  const styles = themedStyles[theme.scheme];
  const [permission, requestPermission] = useCameraPermissions();
  const delivered = useRef(false);

  // The person asked to scan; the platform presents its one system prompt
  // from here. When the answer is no — or cannot be asked again — this
  // view explains and offers a way out instead of re-prompting in a loop.
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  function deliver(text: string) {
    // The pairing screen closes this view on the first delivery, but the
    // view may report the same code twice before it unmounts: one scan,
    // one fill, never a second overwrite racing the person's review.
    if (delivered.current) return;
    delivered.current = true;
    onScan(text);
  }

  if (!permission) {
    return (
      <View style={styles.container} accessibilityLabel="Preparing camera">
        <Text style={styles.message}>Preparing the camera…</Text>
        <CancelButton onPress={onCancel} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text accessibilityRole="alert" style={styles.message}>
          {permission.canAskAgain
            ? "Scanning needs camera access to read the pairing QR code."
            : "Camera access is off. Turn it on in Settings, or paste the pairing link instead."}
        </Text>
        {permission.canAskAgain ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Allow camera access"
            style={styles.button}
            onPress={() => void requestPermission()}
          >
            <Text style={styles.buttonText}>Allow camera access</Text>
          </TouchableOpacity>
        ) : null}
        <CancelButton onPress={onCancel} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={(event) => deliver(event.data)}
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <Text style={styles.hint}>Point at the pairing QR code on your computer.</Text>
        <CancelButton onPress={onCancel} />
      </View>
    </View>
  );
}

function CancelButton({ onPress }: { onPress: () => void }) {
  const theme = useCompanionTheme();
  const styles = themedStyles[theme.scheme];
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Cancel scanning"
      style={styles.button}
      onPress={onPress}
    >
      <Text style={styles.buttonText}>Cancel</Text>
    </TouchableOpacity>
  );
}

const themedStyles = createThemedStyles((theme) => StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.page,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    zIndex: 10,
  },
  message: { color: theme.secondary, fontSize: 15, lineHeight: 21, textAlign: "center", marginBottom: 20 },
  overlay: { position: "absolute", left: 16, right: 16, bottom: 48, alignItems: "center", padding: 16, borderRadius: 14, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border },
  hint: { color: theme.ink, fontSize: 14, textAlign: "center", marginBottom: 16 },
  button: {
    backgroundColor: theme.panel,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    minHeight: 44,
    paddingHorizontal: 20,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  buttonText: { color: theme.ink, fontSize: 15, fontWeight: "600" },
}));
