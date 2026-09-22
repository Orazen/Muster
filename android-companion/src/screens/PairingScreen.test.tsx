import React, { type ComponentProps } from "react";
import { Linking, ScrollView, Text, TextInput, TouchableOpacity } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { PairingScreen } from "./PairingScreen";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

// The camera's host stub: the screen renders the scanner, but no real expo
// module loads under jest. Scan reports arrive through the captured props,
// exactly as the native view would report them.
let mockCamera: { onBarcodeScanned?: (event: { data: string; type: string }) => void } | null = null;
jest.mock("expo-camera", () => ({
  CameraView: (props: { onBarcodeScanned?: (event: { data: string; type: string }) => void }) => {
    mockCamera = props;
    return null;
  },
  useCameraPermissions: () => [{ granted: true, canAskAgain: true }, () => Promise.resolve()],
}));

// Native host stubs exercise the real screen and parser. Insets are injected;
// actual keyboard, screen bounds and safe-area behavior need device acceptance.
type Props = ComponentProps<typeof PairingScreen>;
type PairResult = Awaited<ReturnType<Props["onPair"]>>;
const withInsets = (props: Props) => (
  <SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 16, left: 0, right: 0 }}>
    <PairingScreen {...props} />
  </SafeAreaInsetsContext.Provider>
);
const token = `omb_pair_${"A".repeat(43)}`;
const link = `muster://pair?address=192.168.1.20%3A8810&token=${token}&code=004209`;
const trees: ReactTestRenderer[] = [];
afterEach(() => { act(() => { for (const tree of trees.splice(0)) tree.unmount(); }); });

function deferred() {
  let resolve!: (value: PairResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PairResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function render(overrides: Partial<Props> = {}) {
  let current: Props = { pairing: false, error: null, onPair: async () => null, ...overrides };
  let tree!: ReactTestRenderer;
  act(() => { tree = create(withInsets(current)); });
  trees.push(tree);
  const input = (name: string) => tree.root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === name);
  return {
    tree,
    address: () => input("Pairing link or computer address")!,
    code: () => input("6-digit pairing code"),
    button: () => tree.root.findAllByType(TouchableOpacity).find((node) => node.props.accessibilityLabel === "Pair with computer")!,
    scan: () => tree.root.findByProps({ accessibilityLabel: "Scan a pairing QR code" }),
    editAddress(value: string) { act(() => input("Pairing link or computer address")!.props.onChangeText(value)); },
    editCode(value: string) { act(() => input("6-digit pairing code")!.props.onChangeText(value)); },
    alerts: () => tree.root.findAllByType(Text).filter((node) => node.props.accessibilityRole === "alert").map((node) => node.props.children),
    update(next: Partial<Props>) { current = { ...current, ...next }; act(() => tree.update(withInsets(current))); },
    unmount() { act(() => tree.unmount()); trees.splice(trees.indexOf(tree), 1); },
  };
}

describe("PairingScreen recovery", () => {
  it("exposes labeled fields and a tappable submit inside the scrolling form", () => {
    const screen = render();
    const scroll = screen.tree.root.findByType(ScrollView);
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
    expect(scroll.findAllByType(TextInput)).toHaveLength(2);
    expect(scroll.findAllByType(TouchableOpacity).map((node) => node.props.accessibilityLabel)).toContain("Pair with computer");
    expect(screen.button().props.disabled).toBe(true);
    const text = JSON.stringify(screen.tree.toJSON());
    expect(text).toContain("Settings → Companion");
    expect(text).not.toMatch(/muster pair|scan the QR/);
  });

  it("pastes a valid link without sending and submits only its normalized credential", async () => {
    const onPair = jest.fn<Props["onPair"]>().mockResolvedValue(null);
    const screen = render({ onPair });
    screen.editAddress(link);
    expect(onPair).not.toHaveBeenCalled();
    expect(screen.code()).toBeUndefined();
    expect(screen.button().props.disabled).toBe(false);
    await act(async () => screen.button().props.onPress());
    expect(onPair).toHaveBeenCalledWith({ address: "http://192.168.1.20:8810", credential: token });
  });

  it("preserves leading zeroes in an explicit legacy code-only invite", async () => {
    const onPair = jest.fn<Props["onPair"]>().mockResolvedValue(null);
    const screen = render({ onPair });
    screen.editAddress("muster://pair?address=local.fixture.invalid&code=004209");
    expect(screen.code()).toBeUndefined();
    await act(async () => screen.address().props.onSubmitEditing());
    expect(onPair).toHaveBeenCalledWith({ address: "http://local.fixture.invalid:8810", code: "004209" });
  });

  it("supports manual HTTPS and six digits, preserving input after dispatch", async () => {
    const onPair = jest.fn<Props["onPair"]>().mockResolvedValue(null);
    const screen = render({ onPair });
    screen.editAddress(" https://desktop.fixture.invalid ");
    screen.editCode("00-42 09");
    expect(screen.code()!.props.value).toBe("004209");
    await act(async () => screen.code()!.props.onSubmitEditing());
    expect(onPair).toHaveBeenCalledWith({ address: "https://desktop.fixture.invalid:443", code: "004209" });
    expect(screen.address().props.value).toBe(" https://desktop.fixture.invalid ");
    expect(screen.code()!.props.value).toBe("004209");
  });

  it("never falls back to a typed code when an invitation token is malformed", async () => {
    const onPair = jest.fn<Props["onPair"]>().mockResolvedValue(null);
    const screen = render({ onPair });
    screen.editCode("004209");
    screen.editAddress("muster://pair?address=local.fixture.invalid&token=omb_pair_bad&code=004209");
    act(() => screen.address().props.onBlur());
    expect(screen.button().props.disabled).toBe(true);
    expect(screen.alerts()).toHaveLength(1);
    await act(async () => screen.button().props.onPress());
    expect(onPair).not.toHaveBeenCalled();
  });

  it("locks immediate duplicate presses and freezes edits until the request settles", async () => {
    const attempt = deferred();
    const onPair = jest.fn<Props["onPair"]>().mockReturnValue(attempt.promise);
    const screen = render({ onPair });
    screen.editAddress(link);
    const press = screen.button().props.onPress;
    act(() => { press(); press(); screen.address().props.onChangeText("another.fixture.invalid"); });
    expect(onPair).toHaveBeenCalledTimes(1);
    expect(screen.address().props.value).toBe(link);
    expect(screen.address().props.editable).toBe(false);
    expect(screen.button().props.accessibilityState.busy).toBe(true);
    await act(async () => attempt.resolve(null));
  });

  it("retains an exact failed invitation and permits retry without retyping", async () => {
    const attempt = deferred();
    const onPair = jest.fn<Props["onPair"]>().mockReturnValueOnce(attempt.promise).mockResolvedValue(null);
    const screen = render({ onPair });
    screen.editAddress(link);
    act(() => screen.button().props.onPress());
    await act(async () => attempt.reject(new Error("Computer is unreachable")));
    expect(screen.address().props.value).toBe(link);
    expect(screen.alerts()).toContain("Computer is unreachable");
    expect(screen.button().props.disabled).toBe(false);
    await act(async () => screen.button().props.onPress());
    expect(onPair).toHaveBeenCalledTimes(2);
    expect(screen.alerts()).toHaveLength(0);
  });

  it("shows the session error after a null result and clears stale feedback on edit", async () => {
    const screen = render({ onPair: async () => null });
    screen.editAddress("first.fixture.invalid");
    screen.editCode("004209");
    await act(async () => screen.button().props.onPress());
    screen.update({ error: "This pairing window has expired" });
    expect(screen.alerts()).toContain("This pairing window has expired");
    screen.editAddress("second.fixture.invalid");
    expect(screen.alerts()).toHaveLength(0);
    expect(screen.code()!.props.value).toBe("004209");
  });

  it("recovers from a synchronous callback failure", async () => {
    const screen = render({ onPair: () => { throw new Error("Local setup failed"); } });
    screen.editAddress(link);
    await act(async () => screen.button().props.onPress());
    expect(screen.alerts()).toContain("Local setup failed");
    expect(screen.button().props.disabled).toBe(false);
  });

  it("honors an updated parent pairing lock even through a previously captured callback", async () => {
    const onPair = jest.fn<Props["onPair"]>().mockResolvedValue(null);
    const screen = render({ onPair });
    screen.editAddress(link);
    const press = screen.button().props.onPress;
    screen.update({ pairing: true });
    await act(async () => press());
    expect(onPair).not.toHaveBeenCalled();
    expect(screen.address().props.editable).toBe(false);
  });

  it("uses the current draft if edits and submit arrive before a React rerender", async () => {
    const onPair = jest.fn<Props["onPair"]>().mockResolvedValue(null);
    const screen = render({ onPair });
    const edit = screen.address().props.onChangeText;
    const press = screen.button().props.onPress;
    await act(async () => { edit(link); press(); });
    expect(onPair).toHaveBeenCalledWith({ address: "http://192.168.1.20:8810", credential: token });
  });

  it("ignores captured submits after unmount, including a late failure", async () => {
    const attempt = deferred();
    const onPair = jest.fn<Props["onPair"]>().mockReturnValue(attempt.promise);
    const screen = render({ onPair });
    screen.editAddress(link);
    const press = screen.button().props.onPress;
    act(() => press());
    screen.unmount();
    await act(async () => { attempt.reject(new Error("Late failure")); });
    await act(async () => press());
    expect(onPair).toHaveBeenCalledTimes(1);
  });
});

describe("PairingScreen external delivery (deep link and QR)", () => {
  beforeEach(() => { mockCamera = null; });
  const otherLink = `muster://pair?address=other.fixture.invalid%3A8810&token=omb_pair_${"b".repeat(43)}`;

  // The screen subscribed on mount; deliver arrivals like the OS would.
  function lastLinkListener(): (event: { url: string }) => void {
    const calls = (Linking.addEventListener as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const call = calls.at(-1);
    expect(call).toBeDefined();
    return call![1] as (event: { url: string }) => void;
  }

  it("fills from an arrived deep link and pairs only after the explicit tap", async () => {
    const onPair = jest.fn<Props["onPair"]>().mockResolvedValue(null);
    const screen = render({ onPair });
    act(() => lastLinkListener()({ url: link }));
    expect(screen.address().props.value).toBe(link);
    expect(screen.code()).toBeUndefined(); // invite-ready hides the code field
    expect(onPair).not.toHaveBeenCalled(); // never auto-submit
    expect(screen.button().props.disabled).toBe(false);
    await act(async () => screen.button().props.onPress());
    expect(onPair).toHaveBeenCalledWith({ address: "http://192.168.1.20:8810", credential: token });
  });

  it("fills when the app was cold-started through the pairing link", async () => {
    (Linking.getInitialURL as unknown as { mockResolvedValueOnce: (value: string) => void }).mockResolvedValueOnce(link);
    const screen = render();
    await act(async () => {}); // let the initial-URL promise settle
    expect(screen.address().props.value).toBe(link);
    expect(screen.button().props.disabled).toBe(false);
  });

  it("refuses a non-invitation arrival without touching the form", () => {
    const screen = render();
    screen.editAddress("typed.fixture.invalid");
    act(() => lastLinkListener()({ url: "https://evil.fixture.invalid/pair?token=nope" }));
    expect(screen.address().props.value).toBe("typed.fixture.invalid");
    expect(screen.alerts()).toContain("That code is not a Muster pairing invitation.");
    expect(screen.button().props.disabled).toBe(true);
  });

  it("scans a QR invitation into the form and still waits for the Pair tap", async () => {
    const onPair = jest.fn<Props["onPair"]>().mockResolvedValue(null);
    const screen = render({ onPair });
    expect(mockCamera).toBeNull();
    act(() => screen.scan().props.onPress());
    expect(mockCamera).not.toBeNull(); // the scanner mounted its camera
    act(() => mockCamera!.onBarcodeScanned!({ data: ` ${link}\n`, type: "qr" }));
    expect(screen.address().props.value).toBe(link); // trimmed fill
    expect(onPair).not.toHaveBeenCalled(); // never auto-submit
    expect(screen.tree.root.findAllByProps({ accessibilityLabel: "Cancel scanning" })).toHaveLength(0); // closed
    await act(async () => screen.button().props.onPress());
    expect(onPair).toHaveBeenCalledTimes(1);
    expect(onPair).toHaveBeenCalledWith({ address: "http://192.168.1.20:8810", credential: token });
  });

  it("ignores an arrival while an attempt is in flight and the fields are frozen", async () => {
    const attempt = deferred();
    const onPair = jest.fn<Props["onPair"]>().mockReturnValue(attempt.promise);
    const screen = render({ onPair });
    screen.editAddress(link);
    act(() => screen.button().props.onPress());
    act(() => lastLinkListener()({ url: otherLink }));
    expect(screen.address().props.value).toBe(link);
    await act(async () => attempt.resolve(null));
  });
});
