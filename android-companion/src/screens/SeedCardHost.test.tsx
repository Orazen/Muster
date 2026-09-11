import React from "react";
import { BackHandler, DeviceEventEmitter, StyleSheet, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { MusterClient } from "../core/client";
import { initialState } from "../core/store";
import { SEED_CARD_OPTIONS, SEED_CARD_SUBTITLE, SEED_CARD_TITLE } from "../core/seed-card";
import type { Message } from "../core/types";
import { SeedCardHost, SeedCardSlot } from "./SeedCardHost";
import { SeedCardOwner, type SeedRequestCardProps } from "./SeedRequestCard";

const trees: ReactTestRenderer[] = [];
afterEach(() => { act(() => { for (const tree of trees.splice(0)) tree.unmount(); }); jest.restoreAllMocks(); });
function fixture(onSeedAction: SeedRequestCardProps["onSeedAction"]): SeedRequestCardProps {
  const message: Message = { id: "seed", role: "bot", kind: "options", at: 1,
    card: { purpose: "onboarding-v1", title: SEED_CARD_TITLE, subtitle: SEED_CARD_SUBTITLE, options: [...SEED_CARD_OPTIONS] } };
  return { message, target: { kind: "bot", id: "bot", threadId: "thread" }, seedActions: {}, onSeedAction,
    connection: new MusterClient({ host: "owned-host.fixture.invalid", port: 8810, token: "synthetic" }, async () => { throw new Error("No network in host test"); }),
    state: { ...initialState(), bots: { bot: { id: "bot", name: "Basil", threadId: "thread" } },
      messages: { thread: [message] }, leaves: { thread: message.id } } };
}
function Harness({ owner, slot = true, session = "one" }: { owner: SeedRequestCardProps | null; slot?: boolean; session?: string }) {
  return <SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 16, left: 4, right: 6 }}><SeedCardHost key={session}>
    {owner ? <SeedCardOwner {...owner} /> : null}
    <View testID="entire-chat"><TextInput accessibilityLabel="Task draft" />{slot ? <SeedCardSlot id="seed" /> : null}</View>
  </SeedCardHost></SafeAreaInsetsContext.Provider>;
}
function render(owner: SeedRequestCardProps) {
  let rendered: ReactTestRenderer | undefined;
  act(() => { rendered = create(<Harness owner={owner} />); });
  if (!rendered) throw new Error("Missing host tree");
  const tree = rendered; trees.push(tree);
  return {
    button: (label: string) => tree.root.findAllByType(TouchableOpacity).find((node) => node.props.accessibilityLabel === label)!,
    input: () => tree.root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === "Your own answer")!,
    view: (id: string) => tree.root.findAllByType(View).find((node) => node.props.testID === id),
    update(next: { owner: SeedRequestCardProps | null; slot?: boolean; session?: string }) { act(() => tree.update(<Harness {...next} />)); },
  };
}

describe("same-window seed editor host", () => {
  it("keeps the owner and exact draft when the virtualized row disappears and returns with newer transcript data", async () => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockResolvedValue(undefined);
    const owner = fixture(onSeedAction); const ui = render(owner);
    act(() => ui.button("Write your own answer").props.onPress());
    act(() => ui.input().props.onChangeText("  Still here\nexactly  "));
    ui.update({ owner, slot: false });
    expect(ui.view("seed-editor-overlay")).toBeDefined(); expect(ui.input().props.value).toBe("  Still here\nexactly  ");
    const activity: Message = { id: "bot-note", role: "bot", kind: "text", at: 2, parentId: owner.message.id, text: "Ready when you are" };
    const updated = { ...owner, state: { ...owner.state, messages: { thread: [owner.message, activity] }, leaves: { thread: activity.id }, streams: { thread: { text: "", reasoning: "" } } } };
    ui.update({ owner: updated, slot: false });
    expect(ui.input().props.value).toBe("  Still here\nexactly  ");
    await act(async () => ui.button("Send answer").props.onPress());
    expect(onSeedAction).toHaveBeenCalledTimes(1); expect(onSeedAction.mock.calls[0][1]).toEqual({ kind: "answer", text: "  Still here\nexactly  " });
    act(() => ui.button("Close answer editor").props.onPress()); ui.update({ owner: updated });
    act(() => ui.button("Write your own answer").props.onPress()); expect(ui.input().props.value).toBe("  Still here\nexactly  ");
  });

  it("blocks the whole underlying chat from touches and accessibility and listens for Back only while open", () => {
    const addBack = BackHandler.addEventListener;
    const removed = jest.fn<() => void>();
    const back = jest.spyOn(BackHandler, "addEventListener").mockImplementation((event, listener) => {
      const subscription = addBack(event, listener);
      return { remove: () => { removed(); subscription.remove(); } };
    });
    const ui = render(fixture(async () => undefined));
    expect(back).not.toHaveBeenCalled();
    expect(ui.view("seed-editor-background")?.props.pointerEvents).toBe("auto");
    act(() => ui.button("Write your own answer").props.onPress());
    expect(back).toHaveBeenCalledTimes(1);
    expect(ui.view("seed-editor-background")?.props.pointerEvents).toBe("none");
    expect(ui.view("seed-editor-background")?.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(ui.view("seed-editor-background")?.props.accessibilityElementsHidden).toBe(true);
    expect(ui.view("seed-editor-overlay")?.props.accessibilityViewIsModal).toBe(true);
    expect(StyleSheet.flatten(ui.view("seed-editor-overlay")?.props.style)).toMatchObject({
      paddingTop: 24, paddingBottom: 16, paddingLeft: 4, paddingRight: 6,
    });
    act(() => DeviceEventEmitter.emit("hardwareBackPress"));
    expect(removed).toHaveBeenCalledTimes(1); expect(ui.view("seed-editor-overlay")).toBeUndefined();
    expect(ui.view("seed-editor-background")?.props.pointerEvents).toBe("auto");
    expect(ui.view("seed-editor-background")?.props.accessibilityElementsHidden).toBe(false);
  });

  it.each(["removed", "session"])("retires the overlay and stale callbacks when its owner is %s", async (change) => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockResolvedValue(undefined);
    const owner = fixture(onSeedAction); const ui = render(owner);
    act(() => ui.button("Write your own answer").props.onPress()); act(() => ui.input().props.onChangeText("Retired draft"));
    const send = ui.button("Send answer").props.onPress;
    ui.update(change === "removed" ? { owner: null } : { owner, session: "replacement" });
    expect(ui.view("seed-editor-overlay")).toBeUndefined();
    await act(async () => send()); expect(onSeedAction).not.toHaveBeenCalled();
    ui.update({ owner, session: "replacement" }); act(() => ui.button("Write your own answer").props.onPress());
    expect(ui.input().props.value).toBe("");
  });
});
