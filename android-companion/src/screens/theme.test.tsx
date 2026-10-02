import React from "react";
import { KeyboardAvoidingView, Linking, StyleSheet, Text, TextInput, TouchableOpacity } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { COMPANION_THEMES } from "./theme";
import { PairingScreen } from "./PairingScreen";

let mockScheme: "dark" | "light" | null = "dark";
jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({
  __esModule: true,
  default: () => mockScheme,
}));
jest.mock("expo-camera", () => ({ CameraView: () => null, useCameraPermissions: () => [null, jest.fn()] }));

const trees: ReactTestRenderer[] = [];
beforeEach(() => {
  mockScheme = "dark";
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
});
afterEach(() => {
  act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
  jest.restoreAllMocks();
});

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map((channel) => parseInt(channel, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + 0.05) / (dark + 0.05);
}

describe("companion presentation", () => {
  it.each(["dark", "light"] as const)("keeps %s text, warnings and primary controls readable", (scheme) => {
    const theme = COMPANION_THEMES[scheme];
    for (const surface of [theme.page, theme.panel, theme.card, theme.raised, theme.inset]) {
      expect(contrast(theme.ink, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.secondary, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.accent, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.danger, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.warning, surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(theme.primaryInk, theme.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.ink, theme.userBubble)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.danger, theme.dangerSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it("repaints system appearance without replacing a pairing draft or submitting it", async () => {
    const onPair = jest.fn<() => Promise<null>>().mockResolvedValue(null);
    const screen = () => <SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 16, left: 0, right: 0 }}>
      <PairingScreen pairing={false} error={null} onPair={onPair} />
    </SafeAreaInsetsContext.Provider>;
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(screen()); });
    trees.push(tree);
    const input = (label: string) => tree.root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === label)!;
    act(() => {
      input("Pairing link or computer address").props.onChangeText("https://desktop.fixture.invalid");
      input("6-digit pairing code").props.onChangeText("004209");
    });
    expect(StyleSheet.flatten(tree.root.findByType(KeyboardAvoidingView).props.style).backgroundColor).toBe(COMPANION_THEMES.dark.page);
    for (const scheme of ["light", "dark", null] as const) {
      mockScheme = scheme;
      await act(async () => { tree.update(screen()); });
      const expected = COMPANION_THEMES[scheme ?? "light"];
      expect(input("Pairing link or computer address").props.value).toBe("https://desktop.fixture.invalid");
      expect(input("6-digit pairing code").props.value).toBe("004209");
      expect(StyleSheet.flatten(input("6-digit pairing code").props.style).color).toBe(expected.ink);
      expect(StyleSheet.flatten(tree.root.findByType(KeyboardAvoidingView).props.style).backgroundColor).toBe(expected.page);
      const button = tree.root.findAllByType(TouchableOpacity).find((node) => node.props.accessibilityLabel === "Pair with computer")!;
      expect(StyleSheet.flatten(button.props.style).backgroundColor).toBe(expected.primary);
      expect(StyleSheet.flatten(button.findByType(Text).props.style).color).toBe(expected.primaryInk);
      expect(onPair).not.toHaveBeenCalled();
    }
  });
});
