import React, { useState, type ComponentProps } from "react";
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
    viewConversation: () => () => undefined,
    readError: null,
    onRetryRead: () => undefined,
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
    buttons: (label: string) => rendered.root.findAllByType(TouchableOpacity).filter((node) => node.props.accessibilityLabel === label),
    update(next: ScreenProps) { act(() => rendered.update(<ChatViewScreen {...next} />)); },
    unmount() { act(() => rendered.unmount()); trees.splice(trees.indexOf(rendered), 1); },
  };
}

describe("ChatViewScreen read visibility", () => {
  it.each([
    { kind: "bot", id: "bot-owner", threadId: "bot-thread" },
    { kind: "room", id: "room-owner", threadId: "room-thread" },
  ] satisfies ScreenProps["target"][])("registers the exact $kind target and releases it on unmount", (target) => {
    const cleanup = jest.fn<() => void>();
    const viewConversation = jest.fn<ScreenProps["viewConversation"]>().mockReturnValue(cleanup);
    const screen = render(props({ target, viewConversation }));
    expect(viewConversation).toHaveBeenCalledTimes(1);
    expect(viewConversation).toHaveBeenCalledWith(target);
    expect(cleanup).not.toHaveBeenCalled();
    screen.unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves the view lease across draft edits and unrelated screen updates", () => {
    const cleanup = jest.fn<() => void>();
    const viewConversation = jest.fn<ScreenProps["viewConversation"]>().mockReturnValue(cleanup);
    const original = props({ viewConversation });
    const screen = render(original);
    screen.edit("My draft stays independent");
    screen.update({ ...original, target: { ...original.target }, readError: "Read status could not be shared." });
    expect(viewConversation).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect(screen.input().props.value).toBe("My draft stays independent");
  });

  it("releases the previous owner before registering a new kind, owner or thread", () => {
    const events: string[] = [];
    const viewConversation: ScreenProps["viewConversation"] = (target) => {
      const key = `${target.kind}:${target.id}:${target.threadId}`;
      events.push(`view:${key}`);
      return () => { events.push(`leave:${key}`); };
    };
    const original = props({ viewConversation });
    const screen = render(original);
    screen.update({ ...original, target: { ...original.target, kind: "room" } });
    screen.update({ ...original, target: { kind: "room", id: "room-owner", threadId: "basil-thread" } });
    screen.update({ ...original, target: { kind: "room", id: "room-owner", threadId: "room-thread" } });
    screen.unmount();
    expect(events).toEqual([
      "view:bot:basil:basil-thread", "leave:bot:basil:basil-thread",
      "view:room:basil:basil-thread", "leave:room:basil:basil-thread",
      "view:room:room-owner:basil-thread", "leave:room:room-owner:basil-thread",
      "view:room:room-owner:room-thread", "leave:room:room-owner:room-thread",
    ]);
  });

  it("releases the old captured client callback when connection callbacks change", () => {
    const oldCleanup = jest.fn<() => void>();
    const nextCleanup = jest.fn<() => void>();
    const oldView = jest.fn<ScreenProps["viewConversation"]>().mockReturnValue(oldCleanup);
    const nextView = jest.fn<ScreenProps["viewConversation"]>().mockReturnValue(nextCleanup);
    const original = props({ viewConversation: oldView });
    const screen = render(original);
    screen.update({ ...original, connection: connection("second"), viewConversation: nextView });
    expect(oldCleanup).toHaveBeenCalledTimes(1);
    expect(nextView).toHaveBeenCalledWith(original.target);
    expect(nextCleanup).not.toHaveBeenCalled();
    screen.unmount();
    expect(nextCleanup).toHaveBeenCalledTimes(1);
  });

  it("releases the view when Back returns the parent to the chat list", () => {
    const cleanup = jest.fn<() => void>();
    const viewConversation = jest.fn<ScreenProps["viewConversation"]>().mockReturnValue(cleanup);
    const screenProps = props({ viewConversation });
    function Navigation() {
      const [open, setOpen] = useState(true);
      return open ? <ChatViewScreen {...screenProps} onBack={() => setOpen(false)} /> : <Text>Chats</Text>;
    }
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(<Navigation />); });
    if (!tree) throw new Error("Navigation did not render");
    const rendered = tree;
    trees.push(rendered);
    const back = rendered.root.findAllByType(TouchableOpacity).find((node) => node.props.accessibilityLabel === "Back to chats");
    if (!back) throw new Error("Accessible Back button is missing");
    act(() => back.props.onPress());
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(rendered.root.findAllByType(ChatViewScreen)).toHaveLength(0);
  });

  it("retries visible read errors without submitting or clearing a draft", () => {
    const onRetryRead = jest.fn<() => void>();
    const onSend = jest.fn<(text: string) => Promise<boolean>>().mockResolvedValue(true);
    const original = props({ readError: "Could not share read status: connection lost.", onRetryRead, onSend });
    const screen = render(original);
    screen.edit("  Preserve my unsent task\nexactly  ");
    expect(screen.alerts().map((node) => node.props.children)).toContain(original.readError);
    const retry = screen.buttons("Retry read status");
    expect(retry).toHaveLength(1);
    expect(retry[0].props.accessibilityRole).toBe("button");
    act(() => retry[0].props.onPress());
    expect(onRetryRead).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.input().props.value).toBe("  Preserve my unsent task\nexactly  ");
    screen.update({ ...original, readError: null });
    expect(screen.buttons("Retry read status")).toHaveLength(0);
    expect(screen.alerts()).toHaveLength(0);
    expect(screen.input().props.value).toBe("  Preserve my unsent task\nexactly  ");
  });

  it("keeps the composer failure when an independent read retry starts", async () => {
    const original = props({ readError: "Read status is unavailable.", onSend: async () => { throw new Error("Task was not accepted."); } });
    const screen = render(original);
    screen.edit("Retry this task later");
    await act(async () => screen.send().props.onPress());
    expect(screen.alerts().map((node) => node.props.children)).toEqual(expect.arrayContaining(["Read status is unavailable.", "Task was not accepted."]));
    screen.update({ ...original, readError: null });
    expect(screen.alerts().map((node) => node.props.children)).toEqual(["Task was not accepted."]);
    expect(screen.input().props.value).toBe("Retry this task later");
  });
});

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
