import React from "react";
import { Text } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "@jest/globals";
import { applyFrame, initialState, type CompanionState } from "../core/store";
import type { Message, Room } from "../core/types";
import { ChatListScreen } from "./ChatListScreen";

const trees: ReactTestRenderer[] = [];
afterEach(() => { act(() => { for (const tree of trees.splice(0)) tree.unmount(); }); });
const room: Room = { id: "room", name: "Shared room", threadId: "room-thread", memberIds: ["basil"], defaultResponder: { kind: "any" }, busyBotId: "basil" };
function roster() {
  let state = applyFrame(initialState(), { kind: "bot", bot: { id: "basil", name: "Basil", threadId: "bot-thread" } });
  return applyFrame(state, { kind: "group", group: room });
}
function ask(id: string, requestId: string | undefined, permission = false, parentId?: string): Message {
  return { id, role: "bot", kind: "options", at: 1, parentId, from: { botId: "basil" },
    card: { title: permission ? "Approval needed" : "A question", requestId, options: ["Allow", "Deny"], tool: permission ? "Read" : undefined } };
}
function append(state: CompanionState, threadId: string, message: Message) {
  return applyFrame(state, { kind: "message", threadId, message });
}
function render(initial: CompanionState, connected = true) {
  const element = (state: CompanionState, online: boolean) => <ChatListScreen state={state}
    bots={Object.values(state.bots).filter((bot) => !bot.hidden)} rooms={Object.values(state.rooms)}
    connected={online} refreshing={false} onSelect={() => undefined} onRefresh={() => undefined} onUnpair={() => undefined} />;
  let rendered: ReactTestRenderer | undefined;
  act(() => { rendered = create(element(initial, connected)); });
  if (!rendered) throw new Error("Roster did not render");
  const tree = rendered;
  trees.push(tree);
  return {
    status: () => tree.root.findAllByType(Text).map((node) => [node.props.children].flat().join("")).find((text) => text.startsWith("Connected") || text.startsWith("Reconnecting")),
    update(state: CompanionState, online = connected) { act(() => tree.update(element(state, online))); },
  };
}

describe("ChatListScreen current waiting requests", () => {
  it("clears settled bot and room requests while preserving eleven historical notifications", () => {
    let state = roster();
    const permission = ask("permission", "bot-request", true);
    const question = ask("question", "room-request");
    state = append(state, "bot-thread", permission);
    state = append(state, "room-thread", question);
    for (let i = 0; i < 11; i++) state = applyFrame(state, { kind: "notify", notification: { kind: i < 6 ? "approval" : "question", botId: "basil", threadId: "bot-thread" } });
    const notifications = state.notifications;
    const screen = render(state);
    expect(screen.status()).toBe("Connected  ·  2 waiting for you");
    state = applyFrame(state, { kind: "message.patch", threadId: "bot-thread", message: { ...permission, card: { ...permission.card!, answered: "allow" } } });
    screen.update(state);
    expect(screen.status()).toBe("Connected  ·  1 waiting for you");
    state = applyFrame(state, { kind: "message.patch", threadId: "room-thread", message: { ...question, card: { ...question.card!, answered: "answer" } } });
    screen.update(state);
    expect(screen.status()).toBe("Connected");
    expect(state.notifications).toBe(notifications);
    expect(state.notifications).toHaveLength(11);
  });

  it("excludes seeds, empty identities, dismissed and settled cards and non-bot/non-option messages", () => {
    const messages: Message[] = [
      ask("seed", undefined), ask("empty", ""), ask("blank", " \n "),
      { ...ask("dismissed", "r1"), card: { ...ask("dismissed", "r1").card!, dismissed: true } },
      { ...ask("unavailable", "r2"), card: { ...ask("unavailable", "r2").card!, answered: "unavailable" } },
      { ...ask("user", "r3"), role: "user" },
      { ...ask("activity", "r4"), kind: "activity" },
    ];
    let state = roster();
    for (let i = 0; i < messages.length; i++) state = append(state, "bot-thread", { ...messages[i], parentId: messages[i - 1]?.id });
    expect(render(state).status()).toBe("Connected");
  });

  it("counts only the active parent-linked branch", () => {
    const greeting: Message = { id: "greeting", role: "bot", kind: "text", at: 1, text: "Hello" };
    let state = append(roster(), "bot-thread", greeting);
    state = append(state, "bot-thread", ask("branch-ask", "request", false, greeting.id));
    const screen = render(state);
    expect(screen.status()).toBe("Connected  ·  1 waiting for you");
    state = append(state, "bot-thread", { id: "other-branch", role: "bot", kind: "text", at: 2, parentId: greeting.id, text: "Different branch" });
    screen.update(state);
    expect(screen.status()).toBe("Connected");
    state = applyFrame(state, { kind: "thread", threadId: "bot-thread", activeLeafId: "branch-ask" });
    screen.update(state);
    expect(screen.status()).toBe("Connected  ·  1 waiting for you");
  });

  it("excludes former task threads, hidden bots and deleted rooms from the count", () => {
    let state = append(roster(), "bot-thread", ask("old-task", "old-request"));
    state = append(state, "room-thread", ask("room-ask", "room-request"));
    const screen = render(state);
    expect(screen.status()).toBe("Connected  ·  2 waiting for you");
    state = applyFrame(state, { kind: "bot", bot: { ...state.bots.basil, threadId: "new-thread" } });
    screen.update(state);
    expect(screen.status()).toBe("Connected  ·  1 waiting for you");
    expect(state.messages["bot-thread"]).toHaveLength(1);
    state = append(state, "new-thread", ask("new-task", "new-request", true));
    state = applyFrame(state, { kind: "bot", bot: { ...state.bots.basil, hidden: true } });
    screen.update(state);
    expect(screen.status()).toBe("Connected  ·  1 waiting for you");
    state = applyFrame(state, { kind: "group.deleted", groupId: room.id });
    screen.update(state);
    expect(screen.status()).toBe("Connected");
  });

  it("deduplicates one physical request but keeps identical request IDs in different threads separate", () => {
    let state = append(roster(), "bot-thread", ask("first-copy", "same-request"));
    state = append(state, "bot-thread", ask("second-copy", "same-request", true, "first-copy"));
    state = append(state, "room-thread", ask("room-copy", "same-request"));
    expect(render(state).status()).toBe("Connected  ·  2 waiting for you");
  });

  it.each([undefined, null, "", " ", "another-bot"])("excludes a room request when current speaker is %s", (busyBotId) => {
    let state = append(roster(), "room-thread", ask("room-ask", "room-request"));
    state = applyFrame(state, { kind: "group", group: { ...room, busyBotId } });
    const screen = render(state);
    expect(screen.status()).toBe("Connected");
    state = applyFrame(state, { kind: "group", group: room });
    screen.update(state);
    expect(screen.status()).toBe("Connected  ·  1 waiting for you");
  });

  it("excludes a room card without a matching sender but does not require a direct bot to be busy", () => {
    let state = append(roster(), "room-thread", { ...ask("room-ask", "room-request"), from: undefined });
    state = applyFrame(state, { kind: "bot", bot: { ...state.bots.basil, busy: false } });
    state = append(state, "bot-thread", ask("direct-ask", "direct-request"));
    expect(render(state).status()).toBe("Connected  ·  1 waiting for you");
  });

  it("retains connection status when no requests are waiting", () => {
    const state = roster();
    const screen = render(state, false);
    expect(screen.status()).toBe("Reconnecting…");
    screen.update(state, true);
    expect(screen.status()).toBe("Connected");
  });
});
