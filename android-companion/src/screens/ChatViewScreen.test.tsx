import React, { type ComponentProps } from "react";
import { Text, TextInput, TouchableOpacity } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { MusterClient } from "../core/client";
import { initialState } from "../core/store";
import { ChatViewScreen } from "./ChatViewScreen";

// React Native's official test preset supplies native host stubs. The screen,
// composer, hooks and JSX run unchanged; these are not device/keyboard tests.
type ScreenProps = ComponentProps<typeof ChatViewScreen>;
const trees: ReactTestRenderer[] = [];
afterEach(() => { act(() => { for (const tree of trees.splice(0)) tree.unmount(); }); });

function deferred() {
  let resolve: (accepted: boolean) => void = () => { throw new Error("Deferred not initialized"); };
  let reject: (error: Error) => void = () => { throw new Error("Deferred not initialized"); };
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function connection(name = "first") {
  return new MusterClient({ host: `${name}.fixture.invalid`, port: 8810, token: `offline-${name}` }, async () => {
    throw new Error("Screen tests must not request a network transport");
  });
}

function props(overrides: Partial<ScreenProps> = {}): ScreenProps {
  return {
    connection: connection(),
    state: initialState(),
    target: { kind: "bot", id: "basil", threadId: "basil-thread" },
    bot: { id: "basil", name: "Basil", threadId: "basil-thread" },
    onSend: async () => true,
    onRespond: () => undefined,
    onAlwaysAllow: () => undefined,
    onBack: () => undefined,
    onLoadOlder: () => undefined,
    viewThread: () => undefined,
    ...overrides,
  };
}

function render(screenProps: ScreenProps) {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(<ChatViewScreen {...screenProps} />); });
  if (!tree) throw new Error("Screen failed to render");
  const rendered = tree;
  trees.push(rendered);
  const input = () => rendered.root.findByType(TextInput);
  const send = () => rendered.root.findAllByType(TouchableOpacity).find((node) => node.props.accessibilityLabel === "Send message");
  return {
    input,
    send() {
      const button = send();
      if (!button) throw new Error("Accessible Send message button is missing");
      return button;
    },
    edit(text: string) { act(() => input().props.onChangeText(text)); },
    alerts: () => rendered.root.findAllByType(Text).filter((node) => node.props.accessibilityRole === "alert"),
    update(next: ScreenProps) { act(() => rendered.update(<ChatViewScreen {...next} />)); },
    unmount() { act(() => rendered.unmount()); trees.splice(trees.indexOf(rendered), 1); },
  };
}

describe("ChatViewScreen asynchronous composer", () => {
  it("keeps the exact failed draft and exposes the actual error, then retries without retyping", async () => {
    const attempt = deferred();
    const onSend = jest.fn<(text: string) => Promise<boolean>>().mockReturnValueOnce(attempt.promise).mockResolvedValue(true);
    const screen = render(props({ onSend }));
    screen.edit("  Keep my task\nincluding details  ");
    act(() => screen.send().props.onPress());
    expect(screen.input().props.value).toBe("  Keep my task\nincluding details  ");
    expect(screen.send().props.disabled).toBe(true);
    expect(onSend).toHaveBeenCalledWith("Keep my task\nincluding details");
    await act(async () => { attempt.reject(new Error("Connection lost before acceptance")); });
    expect(screen.input().props.value).toBe("  Keep my task\nincluding details  ");
    expect(screen.alerts().map((node) => node.props.children)).toContain("Connection lost before acceptance");
    expect(screen.send().props.disabled).toBe(false);
    await act(async () => screen.send().props.onPress());
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(screen.input().props.value).toBe("");
    expect(screen.alerts()).toHaveLength(0);
  });

  it("clears the submitted draft only after an accepted result", async () => {
    const attempt = deferred();
    const screen = render(props({ onSend: () => attempt.promise }));
    screen.edit("Prepare the report");
    act(() => screen.send().props.onPress());
    expect(screen.input().props.value).toBe("Prepare the report");
    await act(async () => { attempt.resolve(true); });
    expect(screen.input().props.value).toBe("");
    expect(screen.send().props.disabled).toBe(true);
    expect(screen.alerts()).toHaveLength(0);
  });

  it.each(["a newer follow-up", "original task"])("preserves edits made during the request, including editing away and back (%s)", async (newDraft) => {
    const attempt = deferred();
    const screen = render(props({ onSend: () => attempt.promise }));
    screen.edit("original task");
    act(() => screen.send().props.onPress());
    screen.edit("editing in progress");
    screen.edit(newDraft);
    await act(async () => { attempt.resolve(true); });
    expect(screen.input().props.value).toBe(newDraft);
    expect(screen.send().props.disabled).toBe(false);
  });

  it("locks repeated taps synchronously and permits one later retry", async () => {
    const attempt = deferred();
    const onSend = jest.fn<(text: string) => Promise<boolean>>().mockReturnValueOnce(attempt.promise).mockResolvedValue(true);
    const screen = render(props({ onSend }));
    screen.edit("Send once");
    const capturedPress = screen.send().props.onPress;
    act(() => { capturedPress(); capturedPress(); capturedPress(); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.send().props.disabled).toBe(true);
    await act(async () => { attempt.reject(new Error("Retry needed")); });
    await act(async () => screen.send().props.onPress());
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("keeps the draft and presents recovery when the send was ignored after a context change", async () => {
    const screen = render(props({ onSend: async () => false }));
    screen.edit("Keep this unsent task");
    await act(async () => screen.send().props.onPress());
    expect(screen.input().props.value).toBe("Keep this unsent task");
    expect(screen.alerts()).toHaveLength(1);
    expect(screen.alerts()[0].props.children).toEqual(expect.stringMatching(/\S/));
    expect(screen.send().props.disabled).toBe(false);
  });

  it.each(["accepted", "failed"])("isolates a new bot's draft from the old bot's %s request", async (outcome) => {
    const oldAttempt = deferred();
    const oldProps = props({ onSend: () => oldAttempt.promise });
    const screen = render(oldProps);
    screen.edit("Basil's task");
    act(() => screen.send().props.onPress());
    const newSend = jest.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);
    screen.update({
      ...oldProps,
      target: { kind: "bot", id: "noodle", threadId: "noodle-thread" },
      bot: { id: "noodle", name: "Noodle", threadId: "noodle-thread" },
      onSend: newSend,
    });
    expect(screen.input().props.value).toBe("");
    expect(screen.alerts()).toHaveLength(0);
    screen.edit("Noodle's private draft");
    await act(async () => {
      if (outcome === "accepted") oldAttempt.resolve(true);
      else oldAttempt.reject(new Error("Basil connection failed"));
    });
    expect(screen.input().props.value).toBe("Noodle's private draft");
    expect(screen.alerts()).toHaveLength(0);
    expect(newSend).not.toHaveBeenCalled();
    expect(screen.send().props.disabled).toBe(false);
  });

  it("isolates a new account even when bot and thread identifiers repeat", async () => {
    const oldAttempt = deferred();
    const oldProps = props({ onSend: () => oldAttempt.promise });
    const screen = render(oldProps);
    screen.edit("First account's task");
    act(() => screen.send().props.onPress());
    screen.update({ ...oldProps, connection: connection("second"), onSend: async () => true });
    expect(screen.input().props.value).toBe("");
    screen.edit("Second account's private draft");
    await act(async () => { oldAttempt.reject(new Error("Old account rejected")); });
    expect(screen.input().props.value).toBe("Second account's private draft");
    expect(screen.alerts()).toHaveLength(0);
  });

  it("resets a bot composer when its active thread changes", async () => {
    const oldProps = props();
    const screen = render(oldProps);
    screen.edit("Task for the previous conversation");
    screen.update({ ...oldProps, target: { ...oldProps.target, threadId: "new-thread" } });
    expect(screen.input().props.value).toBe("");
    expect(screen.send().props.disabled).toBe(true);
  });

  it("ignores an empty draft and accepts pending failure after unmount without updating another screen", async () => {
    const attempt = deferred();
    const onSend = jest.fn<(text: string) => Promise<boolean>>().mockReturnValue(attempt.promise);
    const screen = render(props({ onSend }));
    screen.edit("  \n  ");
    act(() => screen.send().props.onPress());
    expect(onSend).not.toHaveBeenCalled();
    screen.edit("Pending before leaving");
    act(() => screen.send().props.onPress());
    screen.unmount();
    const next = render(props());
    next.edit("Another screen's draft");
    await act(async () => { attempt.reject(new Error("Late failure")); });
    expect(next.input().props.value).toBe("Another screen's draft");
    expect(next.alerts()).toHaveLength(0);
  });
});
