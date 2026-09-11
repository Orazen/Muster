import React from "react";
import { DeviceEventEmitter, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { MusterClient } from "../core/client";
import { initialState } from "../core/store";
import { SEED_CARD_OPTIONS, SEED_CARD_SUBTITLE, SEED_CARD_TITLE } from "../core/seed-card";
import type { Message, SeedAnswerReceipt } from "../core/types";
import { seedActionKey, seedReference, type SeedActionState } from "../hooks/companion-session";
import { SeedRequestCard, type SeedRequestCardProps } from "./SeedRequestCard";
import { SeedCardPublication } from "./SeedCardHost";

// Real React component/host stubs: native wrapping, scroll and IME remain device gates.
const trees: ReactTestRenderer[] = [];
afterEach(() => { act(() => { for (const tree of trees.splice(0)) tree.unmount(); }); jest.restoreAllMocks(); });
const greeting: Message = { id: "greeting", role: "bot", kind: "text", at: 1, text: "Hey — I'm Basil. Nice to meet you." };
const seed: Message = { id: "seed", role: "bot", kind: "options", parentId: greeting.id, at: 2,
  card: { purpose: "onboarding-v1", title: SEED_CARD_TITLE, subtitle: SEED_CARD_SUBTITLE, options: [...SEED_CARD_OPTIONS] } };
function connection() {
  return new MusterClient({ host: "owned-seed.fixture.invalid", port: 8810, token: "synthetic" }, async () => {
    throw new Error("Rendering must not make network requests");
  });
}
function props(overrides: Partial<SeedRequestCardProps> = {}): SeedRequestCardProps {
  return { message: seed, target: { kind: "bot", id: "basil", threadId: "thread" }, connection: connection(), seedActions: {},
    onSeedAction: async () => undefined, state: { ...initialState(), bots: { basil: { id: "basil", name: "Basil", threadId: "thread" } },
      messages: { thread: [greeting, seed] }, leaves: { thread: seed.id } }, ...overrides };
}
function receiptProps(status: SeedAnswerReceipt["status"], original = props()): SeedRequestCardProps {
  const user: Message = { id: "saved-user", role: "user", kind: "text", at: 3, parentId: seed.id, text: "  Saved exact answer\n  " };
  const saved: Message = { ...seed, card: { ...seed.card!, answered: user.text,
    seedAnswer: { messageId: user.id, attempt: status === "recorded" ? 0 : 1, status, error: status === "not-started" ? "Choose an available engine." : undefined } } };
  return { ...original, message: saved, state: { ...original.state, messages: { thread: [greeting, saved, user] }, leaves: { thread: user.id } } };
}
function ledger(original: SeedRequestCardProps, patch: Partial<SeedActionState>): SeedRequestCardProps {
  const reference = seedReference(original.state, original.target, original.message);
  if (!reference) throw new Error("Expected canonical seed fixture");
  return { ...original, seedActions: { [seedActionKey(reference)]: { reference, phase: "failed", operation: "answer", message: "Delivery could not be confirmed.", ...patch } } };
}
function deferred() {
  let resolve: () => void = () => { throw new Error("Uninitialized deferred"); };
  let reject: (error: Error) => void = () => { throw new Error("Uninitialized deferred"); };
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function render(original: SeedRequestCardProps) {
  let rendered: ReactTestRenderer | undefined;
  act(() => { rendered = create(<SeedRequestCard {...original} />); });
  if (!rendered) throw new Error("No rendered seed");
  const tree = rendered; trees.push(tree);
  const buttons = (label: string) => tree.root.findAllByType(TouchableOpacity).filter((node) => node.props.accessibilityLabel === label);
  const button = (label: string) => {
    const matches = buttons(label);
    if (matches.length !== 1) throw new Error(`Expected one ${label}, got ${matches.length}`);
    return matches[0];
  };
  const open = () => {
    if (!tree.root.findAllByType(TextInput).length) act(() => button("Write your own answer").props.onPress());
  };
  const input = () => { open(); return tree.root.findByType(TextInput); };
  return { buttons, button, open,
    allButtons: () => tree.root.findAllByType(TouchableOpacity),
    input,
    inputs: () => tree.root.findAllByType(TextInput),
    overlays: () => tree.root.findAllByType(View).filter((node) => node.props.testID === "seed-editor-overlay"),
    nativeModals: () => tree.root.findAllByType(Modal),
    editorPresentation: () => tree.root.findByType(SeedCardPublication).props.editor,
    back: () => { act(() => DeviceEventEmitter.emit("hardwareBackPress")); },
    scrolls: () => tree.root.findAllByType(ScrollView),
    text: () => tree.root.findAllByType(Text).map((node) => node.props.children).flat().join(" "),
    alerts: () => tree.root.findAllByType(Text).filter((node) => node.props.accessibilityRole === "alert"),
    edit(text: string) { const field = input(); act(() => field.props.onChangeText(text)); },
    update(next: SeedRequestCardProps) { act(() => tree.update(<SeedRequestCard {...next} />)); },
    unmount() { act(() => tree.unmount()); trees.splice(trees.indexOf(tree), 1); },
  };
}

describe("SeedRequestCard answer contract", () => {
  it("opens a normal-scroll editor and preserves the exact draft across Close and Android Back", async () => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>();
    const ui = render(props({ onSeedAction }));
    expect(ui.inputs()).toHaveLength(0); expect(ui.overlays()).toHaveLength(0);
    ui.open(); expect(ui.overlays()).toHaveLength(1); expect(ui.scrolls()).toHaveLength(1);
    expect(ui.nativeModals()).toHaveLength(0);
    expect(ui.overlays()[0].props.accessibilityViewIsModal).toBe(true);
    expect(ui.scrolls()[0].props.keyboardShouldPersistTaps).toBe("handled");
    ui.edit("  Keep my multiline\ndraft  ");
    const oldSend = ui.button("Send answer").props.onPress;
    const oldEdit = ui.input().props.onChangeText;
    act(() => ui.button("Close answer editor").props.onPress());
    expect(ui.overlays()).toHaveLength(0);
    await act(async () => { oldSend(); oldEdit("Late edit"); });
    expect(onSeedAction).not.toHaveBeenCalled();
    ui.open(); expect(ui.input().props.value).toBe("  Keep my multiline\ndraft  ");
    ui.back();
    expect(ui.overlays()).toHaveLength(0);
    ui.open(); expect(ui.input().props.value).toBe("  Keep my multiline\ndraft  ");
  });

  it("keeps an in-flight answer locked when its editor closes and reopens only after settlement", async () => {
    const pending = deferred(); const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockReturnValue(pending.promise);
    const ui = render(props({ onSeedAction })); ui.edit("One saved draft");
    act(() => ui.button("Send answer").props.onPress());
    ui.back();
    expect(ui.button("Write your own answer").props.disabled).toBe(true);
    act(() => ui.button("Write your own answer").props.onPress());
    expect(ui.overlays()).toHaveLength(0); expect(onSeedAction).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error("Could not confirm answer.")));
    ui.open(); expect(ui.input().props.value).toBe("One saved draft");
    expect(ui.alerts()[0].props.children).toBe("Could not confirm answer.");
    expect(ui.buttons("Check status")).toHaveLength(1); expect(ui.buttons("Retry same answer")).toHaveLength(1);
  });

  it("fences old editor openings and masked card actions after Close then reopen", async () => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockResolvedValue(undefined);
    const original = ledger(props({ onSeedAction }), { lastAnswer: "Earlier answer" });
    const ui = render(original);
    const choice = ui.button("Life admin").props.onPress;
    const check = ui.button("Check status").props.onPress;
    const retry = ui.button("Retry same answer").props.onPress;
    ui.edit("First opening");
    const old = { send: ui.button("Send answer").props.onPress, edit: ui.input().props.onChangeText,
      show: ui.editorPresentation().onShown, close: ui.button("Close answer editor").props.onPress,
      back: ui.editorPresentation().onClose };
    act(() => old.close()); ui.edit("Second opening");
    const focus = jest.spyOn(TextInput.prototype, "focus").mockImplementation(() => undefined);
    focus.mockClear();
    await act(async () => { old.send(); old.edit("Stale edit"); old.show(); old.close(); old.back(); choice(); check(); retry(); });
    expect(ui.overlays()).toHaveLength(1); expect(ui.input().props.value).toBe("Second opening");
    expect(onSeedAction).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    act(() => ui.editorPresentation().onShown()); expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => ui.button("Send answer").props.onPress());
    expect(onSeedAction.mock.calls[0][1]).toEqual({ kind: "answer", text: "Second opening" });
  });

  it.each(["recorded", "busy", "later-work"])("closes the editor immediately when the card becomes %s and fences captured submission", async (change) => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>(); const original = props({ onSeedAction });
    const ui = render(original); ui.edit("Do not submit late"); const send = ui.button("Send answer").props.onPress;
    let next = original;
    if (change === "recorded") next = receiptProps("recorded", original);
    if (change === "busy") next = { ...original, state: { ...original.state, bots: { basil: { ...original.state.bots.basil, busy: true } } } };
    if (change === "later-work") {
      const user: Message = { id: "later-user", role: "user", kind: "text", parentId: seed.id, at: 4, text: "Another task" };
      next = { ...original, state: { ...original.state, messages: { thread: [greeting, seed, user] }, leaves: { thread: user.id } } };
    }
    ui.update(next); expect(ui.overlays()).toHaveLength(0); expect(ui.inputs()).toHaveLength(0);
    await act(async () => send()); expect(onSeedAction).not.toHaveBeenCalled();
    expect(ui.buttons("Check status")).toHaveLength(1);
  });

  it("sends a canonical choice through only the seed action API", async () => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockResolvedValue(undefined);
    const original = props({ onSeedAction }); const ui = render(original);
    expect(ui.text()).toContain("Getting started question");
    expect(ui.buttons("Allow once")).toHaveLength(0);
    await act(async () => ui.button("Life admin").props.onPress());
    expect(onSeedAction).toHaveBeenCalledWith(seedReference(original.state, original.target, seed), { kind: "answer", text: "Life admin" });
    expect(ui.text()).not.toContain("Answer recorded.");
  });
  it("keeps exact multiline whitespace and enforces the4000-character boundary", async () => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockResolvedValue(undefined);
    const ui = render(props({ onSeedAction }));
    expect(ui.input().props.multiline).toBe(true); expect(ui.input().props.maxLength).toBe(4000);
    ui.edit(" \n "); await act(async () => ui.button("Send answer").props.onPress());
    ui.edit("x".repeat(4001)); await act(async () => ui.button("Send answer").props.onPress());
    expect(onSeedAction).not.toHaveBeenCalled();
    const answer = "  Use this plan\n" + "x".repeat(3982) + "  ";
    expect(answer).toHaveLength(4000); ui.edit(answer); await act(async () => ui.button("Send answer").props.onPress());
    expect(onSeedAction.mock.calls[0][1]).toEqual({ kind: "answer", text: answer }); expect(ui.input().props.value).toBe(answer);
  });
  it("accepts an explicitly null unanswered wire value without showing a saved answer", () => {
    const message: Message = { ...seed, card: { ...seed.card!, answered: null } };
    const original = props(); const ui = render({ ...original, message, state: { ...original.state, messages: { thread: [greeting, message] } } });
    expect(ui.buttons("Life admin")).toHaveLength(1); expect(ui.text()).not.toContain("Saved answer:");
  });
  it("locks same-frame repeated submits and never equates a resolved callback with a recorded answer", async () => {
    const pending = deferred(); const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockReturnValue(pending.promise);
    const ui = render(props({ onSeedAction })); ui.edit("One answer"); const send = ui.button("Send answer").props.onPress; const choice = ui.button("Life admin").props.onPress;
    act(() => { send(); send(); choice(); });
    expect(onSeedAction).toHaveBeenCalledTimes(1); expect(ui.button("Life admin").props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(ui.text()).toContain("Recording your answer…"); expect(ui.text()).not.toContain("Answer recorded.");
    await act(async () => pending.resolve()); expect(ui.text()).not.toContain("Answer recorded.");
  });
  it("keeps newer draft edits on failure, checks without answering, and retries the original exact bytes", async () => {
    const pending = deferred(); const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const original = props({ onSeedAction }); const ui = render(original); ui.edit("  First\nanswer  "); act(() => ui.button("Send answer").props.onPress());
    ui.edit("Newer unsent draft"); ui.update(ledger(original, { lastAnswer: "  First\nanswer  " })); await act(async () => pending.resolve());
    expect(ui.input().props.value).toBe("Newer unsent draft"); expect(ui.alerts()).toHaveLength(1);
    await act(async () => ui.button("Check status").props.onPress()); expect(onSeedAction.mock.calls[1][1]).toEqual({ kind: "check" });
    await act(async () => ui.button("Retry same answer").props.onPress()); expect(onSeedAction.mock.calls[2][1]).toEqual({ kind: "answer", text: "  First\nanswer  " });
    expect(ui.input().props.value).toBe("Newer unsent draft");
  });
  it("reports a thrown transport error and permits explicit retry without an automatic action", async () => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockRejectedValueOnce(new Error("Owned request failed.")).mockResolvedValue(undefined);
    const ui = render(props({ onSeedAction })); ui.edit("Keep me"); await act(async () => ui.button("Send answer").props.onPress());
    expect(ui.alerts()[0].props.children).toBe("Owned request failed."); expect(ui.input().props.value).toBe("Keep me"); expect(onSeedAction).toHaveBeenCalledTimes(1);
    await act(async () => ui.button("Retry same answer").props.onPress()); expect(onSeedAction).toHaveBeenCalledTimes(2);
  });
  it.each(["recorded", "starting", "started", "not-started", "uncertain"] as const)("renders persisted %s truth and only eligible explicit actions", async (status) => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockResolvedValue(undefined);
    const original = receiptProps(status, props({ onSeedAction })); const ui = render(original);
    expect(ui.text()).toContain("Saved answer: "); expect(ui.text()).toContain(original.message.card!.answered);
    expect(ui.inputs()).toHaveLength(0); expect(ui.buttons("Check status")).toHaveLength(1);
    const canStart = status === "recorded" || status === "not-started";
    expect(ui.buttons("Start saved task")).toHaveLength(canStart ? 1 : 0);
    expect(ui.text()).toContain(status === "recorded" ? "The task has not started." : status === "starting" ? "Start requested; waiting for confirmation." : status === "started" ? "The task started;" : status === "not-started" ? "The task did not start." : "The start result could not be confirmed.");
    if (canStart) { await act(async () => ui.button("Start saved task").props.onPress()); expect(onSeedAction.mock.calls[0][1]).toEqual({ kind: "start" }); }
    expect(ui.buttons("Try again")).toHaveLength(0);
  });
});

describe("SeedRequestCard stale and inert boundaries", () => {
  it.each(["room", "hidden", "wrong-thread", "unknown", "legacy-settled", "inactive-branch", "invalid-wire"])("keeps %s history inert", (kind) => {
    const original = props();
    if (kind === "room") original.target = { kind: "room", id: "basil", threadId: "thread" };
    if (kind === "hidden") original.state.bots.basil = { ...original.state.bots.basil, hidden: true };
    if (kind === "wrong-thread") original.target = { ...original.target, threadId: "old-thread" };
    if (kind === "inactive-branch") original.state.leaves.thread = greeting.id;
    if (kind === "unknown" || kind === "legacy-settled" || kind === "invalid-wire") {
      original.message = { ...seed, card: { ...seed.card!, ...(kind === "unknown" ? { purpose: "future-version" } : kind === "legacy-settled" ? { answered: "Life admin" } : { seedInvalid: true }) } };
      original.state.messages.thread = [greeting, original.message];
    }
    const ui = render(original); expect(ui.allButtons()).toHaveLength(0); expect(ui.inputs()).toHaveLength(0); expect(ui.text()).toContain("Saved question");
  });
  it.each(["busy", "newer-work"])("rejects a captured old answer handler after %s without remount", async (kind) => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>(); const original = props({ onSeedAction }); const ui = render(original);
    const old = ui.button("Life admin").props.onPress;
    const next = { ...original, state: { ...original.state } };
    if (kind === "busy") next.state.bots = { ...next.state.bots, basil: { ...next.state.bots.basil, busy: true } };
    else { const later: Message = { id: "later", role: "user", kind: "text", at: 4, parentId: seed.id, text: "New work" }; next.state.messages = { thread: [greeting, seed, later] }; next.state.leaves = { thread: later.id }; }
    ui.update(next); await act(async () => old()); expect(onSeedAction).not.toHaveBeenCalled(); expect(ui.buttons("Send answer")).toHaveLength(0); expect(ui.buttons("Check status")).toHaveLength(1);
  });
  it("hides saved-task startup after newer work and rejects a captured start handler", async () => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>(); const original = receiptProps("not-started", props({ onSeedAction })); const ui = render(original); const old = ui.button("Start saved task").props.onPress;
    const later: Message = { id: "new-task", role: "user", kind: "text", at: 4, parentId: "saved-user", text: "Another task" };
    ui.update({ ...original, state: { ...original.state, messages: { thread: [...original.state.messages.thread, later] }, leaves: { thread: later.id } } });
    await act(async () => old()); expect(onSeedAction).not.toHaveBeenCalled(); expect(ui.buttons("Start saved task")).toHaveLength(0); expect(ui.buttons("Check status")).toHaveLength(1);
  });
  it.each(["connection", "target", "thread", "card-content"])("does not leak a draft or late callback across %s identity", async (kind) => {
    const pending = deferred(); const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockReturnValue(pending.promise); const original = props({ onSeedAction }); const ui = render(original);
    ui.edit("Old account answer"); const old = ui.button("Send answer").props.onPress; act(() => old());
    const next = { ...original };
    if (kind === "connection") next.connection = connection();
    if (kind === "target") next.target = { ...next.target, id: "other-bot" };
    if (kind === "thread") next.target = { ...next.target, threadId: "other-thread" };
    if (kind === "card-content") { next.message = { ...seed, id: "new-card" }; next.state = { ...next.state, messages: { thread: [greeting, next.message] }, leaves: { thread: next.message.id } }; }
    ui.update(next); await act(async () => { old(); pending.reject(new Error("Old request failed.")); });
    expect(onSeedAction).toHaveBeenCalledTimes(1); expect(ui.alerts()).toHaveLength(0);
    for (const input of ui.inputs()) expect(input.props.value).toBe("");
  });
  it("keeps a matching physical pending ledger locked even if its content signature differs", () => {
    const original = props(); const next = ledger(original, { phase: "pending", operation: "answer" });
    const key = Object.keys(next.seedActions)[0]; next.seedActions[key].reference = { ...next.seedActions[key].reference, signature: "older content" };
    const ui = render(next); expect(ui.button("Life admin").props.disabled).toBe(true); expect(ui.text()).toContain("Recording your answer…");
  });
  it("shows timeout uncertainty while keeping all controls locked until the original transport closes", async () => {
    const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockResolvedValue(undefined);
    const original = props({ onSeedAction });
    const pending = ledger(original, { phase: "failed", inFlight: true, lastAnswer: "Original answer", message: "Timed out; waiting for the original request to close." });
    const ui = render(pending);
    expect(ui.alerts()[0].props.children).toBe("Timed out; waiting for the original request to close.");
    expect(ui.text()).toContain("Waiting for the previous request to close…");
    for (const button of ui.allButtons()) expect(button.props.disabled).toBe(true);
    await act(async () => { ui.button("Check status").props.onPress(); ui.button("Retry same answer").props.onPress(); });
    expect(onSeedAction).not.toHaveBeenCalled();
    ui.update(ledger(original, { phase: "failed", inFlight: false, lastAnswer: "Original answer" }));
    await act(async () => ui.button("Check status").props.onPress());
    expect(onSeedAction.mock.calls[0][1]).toEqual({ kind: "check" });
  });
  it("drops a pending completion and captured action after unmount", async () => {
    const pending = deferred(); const onSeedAction = jest.fn<SeedRequestCardProps["onSeedAction"]>().mockReturnValue(pending.promise); const ui = render(props({ onSeedAction }));
    const old = ui.button("Life admin").props.onPress; act(() => old()); ui.unmount(); await act(async () => { old(); pending.reject(new Error("Too late")); }); expect(onSeedAction).toHaveBeenCalledTimes(1);
  });
});
