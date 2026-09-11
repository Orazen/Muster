import React from "react";
import { Text, TextInput, TouchableOpacity } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { MusterClient } from "../core/client";
import { cardActionKey, cardReference, type CardActionState } from "../core/card-actions";
import type { Message } from "../core/types";
import { initialState } from "../core/store";
import { RequestCard, type RequestCardProps } from "./RequestCard";

// Actual component/hooks with React Native host stubs, not native layout proof.
const trees: ReactTestRenderer[] = [];
afterEach(() => { act(() => { for (const tree of trees.splice(0)) tree.unmount(); }); });
function deferred() {
  let resolve: () => void = () => { throw new Error("Not initialized"); };
  let reject: (error: Error) => void = () => { throw new Error("Not initialized"); };
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function connection() {
  return new MusterClient({ host: "cards.fixture.invalid", port: 8810, token: "offline-fixture" }, async () => {
    throw new Error("Card rendering must not request a network transport");
  });
}
const question: Message = {
  id: "question-message", kind: "options", role: "bot", at: 1,
  card: { title: "Choose a direction", subtitle: "Your answer guides the next step.", requestId: "question-request", options: ["Writing & research", "Life admin"] },
};
const permission: Message = {
  ...question, id: "permission-message",
  card: { title: "Approval needed", subtitle: "git status --short", options: ["Allow", "Deny"], requestId: "permission-request", tool: "Bash", allowKey: "Bash:git", held: "Auto mode stopped to ask." },
};
function props(overrides: Partial<RequestCardProps> = {}): RequestCardProps {
  return {
    state: initialState(), seedActions: {}, onSeedAction: async () => undefined,
    message: question, connection: connection(), target: { kind: "bot", id: "basil", threadId: "thread" },
    bot: { id: "basil", name: "Basil", threadId: "thread" }, cardActions: {},
    onCardAction: async () => undefined, onRefreshCards: async () => undefined, ...overrides,
  };
}
function withState(original: RequestCardProps, state: Partial<CardActionState>): RequestCardProps {
  const reference = cardReference(original.target, original.message);
  if (!reference) throw new Error("Expected fixture request");
  return { ...original, cardActions: { [cardActionKey(reference)]: {
    reference, phase: "failed", message: null, outcome: null, grantSaved: false, ...state,
  } } };
}
function render(original: RequestCardProps) {
  let rendered: ReactTestRenderer | undefined;
  act(() => { rendered = create(<RequestCard {...original} />); });
  if (!rendered) throw new Error("No rendered card");
  const tree = rendered;
  trees.push(tree);
  const buttons = (label: string) => tree.root.findAllByType(TouchableOpacity).filter((node) => node.props.accessibilityLabel === label);
  const button = (label: string) => {
    const nodes = buttons(label);
    if (nodes.length !== 1) throw new Error(`Expected one ${label} button, got ${nodes.length}`);
    return nodes[0];
  };
  return {
    buttons, button,
    allButtons: () => tree.root.findAllByType(TouchableOpacity),
    text: () => tree.root.findAllByType(Text).map((node) => node.props.children).flat().join(" "),
    alerts: () => tree.root.findAllByType(Text).filter((node) => node.props.accessibilityRole === "alert").map((node) => node.props.children),
    input: () => tree.root.findByType(TextInput),
    edit(text: string) { act(() => tree.root.findByType(TextInput).props.onChangeText(text)); },
    update(next: RequestCardProps) { act(() => tree.update(<RequestCard {...next} />)); },
    unmount() { act(() => tree.unmount()); trees.splice(trees.indexOf(tree), 1); },
  };
}

describe("RequestCard questions and permissions", () => {
  it("shows the actual seed choices without presenting a live permission or inert action", () => {
    const onCardAction = jest.fn<RequestCardProps["onCardAction"]>();
    const screen = render(props({ message: { ...question, card: { ...question.card!, requestId: undefined } }, onCardAction }));
    expect(screen.text()).toContain("Writing & research");
    expect(screen.text()).toContain("Life admin");
    expect(screen.text()).toContain("Continue on your computer");
    expect(screen.text()).not.toContain("Permission request");
    expect(screen.allButtons()).toHaveLength(0);
    expect(onCardAction).not.toHaveBeenCalled();
  });

  it.each(["Allow", "Deny", "東京 & research"])("sends the literal question choice %s as an answer", async (choice) => {
    const onCardAction = jest.fn<RequestCardProps["onCardAction"]>().mockResolvedValue(undefined);
    const original = props({ message: { ...question, card: { ...question.card!, options: [choice] } }, onCardAction });
    const screen = render(original);
    expect(screen.buttons("Allow once")).toHaveLength(0);
    expect(screen.buttons("Always allow this tool")).toHaveLength(0);
    await act(async () => screen.button(choice).props.onPress());
    expect(onCardAction).toHaveBeenCalledWith(cardReference(original.target, original.message), { kind: "answer", text: choice });
  });

  it("preserves custom answer indentation, newlines and trailing spaces while rejecting blank text", async () => {
    const onCardAction = jest.fn<RequestCardProps["onCardAction"]>().mockResolvedValue(undefined);
    const original = props({ message: { ...question, card: { ...question.card!, options: [] } }, onCardAction });
    const screen = render(original);
    screen.edit(" \n ");
    await act(async () => screen.button("Send answer").props.onPress());
    expect(screen.button("Send answer").props.disabled).toBe(true);
    expect(onCardAction).not.toHaveBeenCalled();
    screen.edit("  Use next Tuesday\nand keep the original scope  ");
    await act(async () => screen.button("Send answer").props.onPress());
    expect(onCardAction).toHaveBeenCalledWith(cardReference(original.target, original.message), { kind: "answer", text: "  Use next Tuesday\nand keep the original scope  " });
    expect(screen.input().props.value).toBe("  Use next Tuesday\nand keep the original scope  ");
  });

  it.each(["Allow once", "Deny", "Always allow this tool"])("makes %s an explicit permission action", async (label) => {
    const onCardAction = jest.fn<RequestCardProps["onCardAction"]>().mockResolvedValue(undefined);
    const original = props({ message: permission, onCardAction });
    const screen = render(original);
    expect(screen.buttons("Send answer")).toHaveLength(0);
    expect(screen.text()).toContain("Auto mode stopped to ask.");
    expect(screen.text()).toContain("git status --short");
    await act(async () => screen.button(label).props.onPress());
    expect(onCardAction).toHaveBeenCalledWith(cardReference(original.target, permission), {
      kind: label === "Allow once" ? "allow" : label === "Deny" ? "deny" : "always",
    });
  });

  it.each(["room", "missing-key", "blank-key", "different-bot", "hidden-bot"])("does not offer a persistent grant for %s", (kind) => {
    const original = props({ message: permission });
    if (kind === "room") original.target = { kind: "room", id: "room", threadId: "room-thread" };
    if (kind === "missing-key" || kind === "blank-key") original.message = { ...permission, card: { ...permission.card!, allowKey: kind === "blank-key" ? " " : undefined } };
    if (kind === "different-bot") original.bot = { id: "different", threadId: "thread", name: "Other" };
    if (kind === "hidden-bot") original.bot = { ...original.bot!, hidden: true };
    const screen = render(original);
    expect(screen.buttons("Always allow this tool")).toHaveLength(0);
    expect(screen.buttons("Allow once")).toHaveLength(1);
  });
});

describe("RequestCard operation lifecycle", () => {
  it("locks same-frame repeated decisions and exposes pending state without inventing acceptance", async () => {
    const pending = deferred();
    const onCardAction = jest.fn<RequestCardProps["onCardAction"]>().mockReturnValue(pending.promise);
    const screen = render(props({ message: permission, onCardAction }));
    const allow = screen.button("Allow once").props.onPress;
    const deny = screen.button("Deny").props.onPress;
    act(() => { allow(); allow(); deny(); });
    expect(onCardAction).toHaveBeenCalledTimes(1);
    expect(screen.button("Deny").props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(screen.text()).toContain("Sending response…");
    expect(screen.text()).not.toContain("Allowed once.");
    await act(async () => pending.resolve());
  });

  it("keeps exact and newer drafts through failure and checks status without replaying a decision", async () => {
    const pending = deferred();
    const onCardAction = jest.fn<RequestCardProps["onCardAction"]>().mockReturnValue(pending.promise);
    const onRefreshCards = jest.fn<RequestCardProps["onRefreshCards"]>().mockResolvedValue(undefined);
    const original = props({ onCardAction, onRefreshCards });
    const screen = render(original);
    screen.edit(" Original answer ");
    act(() => screen.button("Send answer").props.onPress());
    screen.edit(" Newer unsent answer ");
    screen.update(withState(original, { message: "Delivery could not be confirmed. Check status before retrying." }));
    await act(async () => pending.resolve());
    expect(screen.input().props.value).toBe(" Newer unsent answer ");
    expect(screen.alerts()).toContain("Delivery could not be confirmed. Check status before retrying.");
    await act(async () => screen.button("Check status").props.onPress());
    expect(onRefreshCards).toHaveBeenCalledTimes(1);
    expect(onCardAction).toHaveBeenCalledTimes(1);
    expect(screen.input().props.value).toBe(" Newer unsent answer ");
    await act(async () => screen.button("Send answer").props.onPress());
    expect(onCardAction).toHaveBeenCalledTimes(2);
  });

  it("shows rejected status refresh and allows one later check without automatic action retry", async () => {
    const pending = deferred();
    const onRefreshCards = jest.fn<RequestCardProps["onRefreshCards"]>().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const onCardAction = jest.fn<RequestCardProps["onCardAction"]>();
    const original = withState(props({ onRefreshCards, onCardAction }), { message: "Decision failed." });
    const screen = render(original);
    const check = screen.button("Check status").props.onPress;
    act(() => { check(); check(); });
    expect(onRefreshCards).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error("Computer is offline.")));
    expect(screen.alerts()).toContain("Computer is offline.");
    await act(async () => screen.button("Check status").props.onPress());
    expect(onRefreshCards).toHaveBeenCalledTimes(2);
    expect(onCardAction).not.toHaveBeenCalled();
  });

  it("distinguishes a saved grant from an unconfirmed permission response", () => {
    const original = withState(props({ message: permission }), {
      grantSaved: true, message: "The preference was saved. Could not confirm whether the response was delivered.",
    });
    const screen = render(original);
    expect(screen.text()).toContain("The tool grant was saved for this bot.");
    expect(screen.alerts()).toContain(original.cardActions[cardActionKey(cardReference(original.target, permission)!)].message);
    expect(screen.text()).not.toContain("Allowed once.");
    expect(screen.buttons("Check status")).toHaveLength(1);
  });

  it.each(["allowed-once", "rejected", "answered", "unavailable"] as const)("honors accepted %s before the SSE card settles", (outcome) => {
    const original = withState(props({ message: outcome === "answered" ? question : permission }), { phase: "settled", outcome });
    const screen = render(original);
    expect(screen.buttons("Allow once")).toHaveLength(0);
    expect(screen.buttons("Deny")).toHaveLength(0);
    expect(screen.buttons("Send answer")).toHaveLength(0);
    if (outcome === "unavailable") {
      expect(screen.alerts()).toContain("This request is no longer available. Your response was not delivered.");
      expect(screen.buttons("Check status")).toHaveLength(1);
      expect(screen.text()).not.toContain("Allowed once.");
    }
  });

  it.each([{ answered: "answer" }, { dismissed: true }, { answered: "unavailable", dismissed: true }])("does not reactivate persisted settlement %j", (settlement) => {
    const screen = render(props({ message: { ...question, card: { ...question.card!, ...settlement } } }));
    expect(screen.buttons("Writing & research")).toHaveLength(0);
    expect(screen.buttons("Send answer")).toHaveLength(0);
    expect(screen.text()).toContain("Writing & research");
  });

  it.each(["allow", "deny"])("keeps persisted question answer %s distinct from permission settlement", (answered) => {
    const screen = render(props({ message: { ...question, card: { ...question.card!, answered } } }));
    expect(screen.text()).toContain(`Answered: ${answered}`);
    expect(screen.text()).not.toContain("Allowed once.");
    expect(screen.text()).not.toContain("Denied.");
    expect(screen.buttons("Send answer")).toHaveLength(0);
  });

  it("ignores an old signature's error but keeps its same-request pending lock", () => {
    const original = withState(props(), { message: "Old content failed." });
    const changed = { ...original, message: { ...question, card: { ...question.card!, subtitle: "Changed question" } } };
    const screen = render(changed);
    expect(screen.alerts()).toHaveLength(0);
    const reference = cardReference(original.target, question)!;
    screen.update({ ...changed, cardActions: { [cardActionKey(reference)]: { ...original.cardActions[cardActionKey(reference)], phase: "pending" } } });
    expect(screen.button("Writing & research").props.disabled).toBe(true);
  });

  it.each(["connection", "target", "request", "signature"])("isolates draft and a late failure after %s changes", async (kind) => {
    const pending = deferred();
    const original = props({ onCardAction: () => pending.promise });
    const screen = render(original);
    screen.edit("Old private answer");
    const oldPress = screen.button("Send answer").props.onPress;
    act(() => oldPress());
    const next = { ...original, onCardAction: jest.fn<RequestCardProps["onCardAction"]>().mockResolvedValue(undefined) };
    if (kind === "connection") next.connection = connection();
    if (kind === "target") next.target = { kind: "room", id: "room", threadId: "room-thread" };
    if (kind === "request") next.message = { ...question, card: { ...question.card!, requestId: "new-request" } };
    if (kind === "signature") next.message = { ...question, card: { ...question.card!, subtitle: "New question" } };
    screen.update(next);
    expect(screen.input().props.value).toBe("");
    screen.edit("New private answer");
    act(() => oldPress());
    await act(async () => pending.reject(new Error("Old request failed.")));
    expect(screen.input().props.value).toBe("New private answer");
    expect(screen.alerts()).toHaveLength(0);
    expect(next.onCardAction).not.toHaveBeenCalled();
  });

  it("does not send a retained card callback after unmount", async () => {
    const onCardAction = jest.fn<RequestCardProps["onCardAction"]>().mockResolvedValue(undefined);
    const screen = render(props({ message: permission, onCardAction }));
    const press = screen.button("Allow once").props.onPress;
    screen.unmount();
    await act(async () => press());
    expect(onCardAction).not.toHaveBeenCalled();
  });
});
