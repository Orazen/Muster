import { describe, expect, it } from "vitest";

import { initialState, prepareUnreadAnnouncement, reducer, visibleMessages, type Bot, type Group, type Message } from "./store";
import { buildWorkspaceSummary } from "../components/os/workspace-state";

describe("incomplete bot profile ingress", () => {
  const minimal = { id: "legacy", threadId: "original-thread", name: "Saved teammate", messages: [
    { id: "kept-message", role: "user", kind: "text", text: "Keep this", at: 1 },
  ] };
  // The wire boundary can violate the static type; reproduce the installed
  // record without inventing data for it before the production reducer runs.
  // @ts-expect-error Deliberately reproduce an incomplete record received from an older backend.
  const incoming: Bot = minimal;
  it.each(["hydrate", "botAdded", "botPatched"] as const)("repairs %s before UI consumers render", type => {
    const next = reducer(initialState, type === "hydrate" ? { type, bots: [incoming], groups: [] } : { type, bot: incoming });
    expect(next.bots[0]).toMatchObject({ ...minimal, title: "", description: "", color: "orange", notifications: false,
      unread: false, modelSelection: { instanceId: "", model: "" } });
    expect(next.bots[0].messages).toEqual(minimal.messages);
    expect(next.bots[0].autoApprove).toBeUndefined();
    expect(next.bots[0].computer).toBeUndefined();
  });
  it("merges known partial announcements before normalization and preserves transcripts", () => {
    const loaded = reducer(initialState, { type: "hydrate", bots: [incoming], groups: [] });
    const picked = reducer(loaded, { type: "setModel", botId: incoming.id,
      selection: { instanceId: "offline", model: "chosen", effort: "high" } });
    const patch = { id: incoming.id, name: "Renamed", notifications: true };
    // @ts-expect-error Older wire announcements can omit required profile fields.
    const next = reducer(picked, { type: "botPatched", bot: patch });
    expect(next.bots[0].modelSelection).toEqual(picked.bots[0].modelSelection);
    expect(next.bots[0].threadId).toBe(incoming.threadId);
    expect(next.bots[0].messages).toEqual(minimal.messages);
    expect(next.bots[0].notifications).toBe(true);
  });
  it("keeps explicit unconfigured selection and task-switch transcript authoritative", () => {
    const loaded = reducer(initialState, { type: "hydrate", bots: [incoming], groups: [] });
    const next = reducer(loaded, { type: "botPatched", bot: { ...loaded.bots[0],
      threadId: "next-thread", messages: [], modelSelection: { instanceId: "", model: "" } } });
    expect(next.bots[0].threadId).toBe("next-thread");
    expect(next.bots[0].messages).toEqual([]);
    expect(next.bots[0].modelSelection).toEqual({ instanceId: "", model: "" });
  });
});

describe("conversation visibility and unread replies", () => {
  const bot: Bot = {
    id: "selected-bot", threadId: "selected-thread", name: "Scout", title: "", description: "",
    notifications: true, color: "green", unread: false, activity: "idle", busy: false,
    modelSelection: { instanceId: "codex", model: "default" },
    messages: [{ id: "task", role: "user", kind: "text", text: "Review this draft", at: 1 }],
  };
  const group: Group = {
    id: "selected-room", threadId: "room-thread", name: "Review", memberIds: [bot.id],
    defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, messages: [],
  };
  const reply: Message = { id: "reply", parentId: "task", role: "bot", kind: "text", text: "The draft review is ready.", at: 2 };

  it.each([false, true])("keeps a selected bot reply ready to read only outside the chat (readSelectedMessages=%s)", (readSelectedMessages) => {
    const loaded = reducer({ ...initialState, readSelectedMessages }, { type: "hydrate", bots: [bot], groups: [] });
    const appended = reducer(loaded, { type: "messageAdded", threadId: bot.threadId, message: reply });
    expect(appended.bots[0].messages.at(-1)).toEqual(reply);
    // The server announces unread independently of the message frame. Use
    // the same preparation as the SSE handler, including its PATCH decision.
    const announcement = { ...bot, messages: undefined, unread: true };
    const prepared = prepareUnreadAnnouncement(appended, announcement);
    expect(prepared.markRead).toBe(readSelectedMessages);
    const settled = reducer(appended, { type: "botPatched", bot: prepared.record });
    expect(settled.bots[0].unread).toBe(!readSelectedMessages);
    expect(announcement.unread).toBe(true);
    expect(buildWorkspaceSummary(settled.bots, true).replies.map((item) => item.bot.id))
      .toEqual(readSelectedMessages ? [] : [bot.id]);
  });

  it.each([false, true])("applies the same visible-conversation rule to group replies (readSelectedMessages=%s)", (readSelectedMessages) => {
    const loaded = reducer({ ...initialState, readSelectedMessages, selectedId: group.id }, {
      type: "hydrate", bots: [bot], groups: [group],
    });
    const appended = reducer(loaded, { type: "messageAdded", threadId: group.threadId, message: reply });
    const prepared = prepareUnreadAnnouncement(appended, { id: group.id, unread: true });
    expect(prepared.markRead).toBe(readSelectedMessages);
    const settled = reducer(appended, { type: "groupPatched", group: prepared.record });
    expect(settled.groups[0].unread).toBe(!readSelectedMessages);
    expect(settled.groups[0].messages).toEqual([reply]);
  });

  it.each([
    { readSelectedMessages: false, selectedId: bot.id },
    { readSelectedMessages: true, selectedId: bot.id },
    { readSelectedMessages: false, selectedId: group.id },
    { readSelectedMessages: true, selectedId: group.id },
  ])("selection of $selectedId clears unread only in a conversation provider ($readSelectedMessages)", ({ readSelectedMessages, selectedId }) => {
    const loaded = reducer({ ...initialState, readSelectedMessages }, {
      type: "hydrate", bots: [{ ...bot, unread: true }], groups: [{ ...group, unread: true }],
    });
    const selected = reducer(loaded, { type: "select", id: selectedId });
    expect(selected.selectedId).toBe(selectedId);
    expect(selected.bots[0].unread).toBe(selectedId === bot.id ? !readSelectedMessages : true);
    expect(selected.groups[0].unread).toBe(selectedId === group.id ? !readSelectedMessages : true);
  });

  it("does not acknowledge another bot or repeat acknowledgement of an already-read announcement", () => {
    const reading = { readSelectedMessages: true, selectedId: bot.id, activeView: "chat" as const };
    const other = { id: "another-bot", unread: true };
    expect(prepareUnreadAnnouncement(reading, other)).toEqual({ record: other, markRead: false });
    expect(prepareUnreadAnnouncement(reading, { id: bot.id, unread: false }).markRead).toBe(false);
  });

  it("Today preserves the selected conversation and leaves new replies unread until it is opened", () => {
    const loaded = reducer(initialState, { type: "hydrate", bots: [bot], groups: [group] });
    const today = reducer(loaded, { type: "showToday" });
    expect(today.activeView).toBe("today");
    expect(today.selectedId).toBe(loaded.selectedId);
    expect(today.bots).toBe(loaded.bots);
    expect(today.groups).toBe(loaded.groups);
    const prepared = prepareUnreadAnnouncement(today, { ...bot, unread: true });
    expect(prepared.markRead).toBe(false);
    expect(prepared.record.unread).toBe(true);
    const announced = reducer(today, { type: "botPatched", bot: prepared.record });
    expect(announced.bots[0].unread).toBe(true);
    const opened = reducer(announced, { type: "select", id: bot.id });
    expect(opened.activeView).toBe("chat");
    expect(opened.bots[0].unread).toBe(false);
    expect(opened.bots[0].messages).toEqual(bot.messages);
  });
});

describe("account roster readiness", () => {
  it("does not mistake an open SSE connection for a loaded roster, including an empty account", () => {
    const connected = reducer(initialState, { type: "connected", value: true });
    expect(connected.rosterHydrated).toBe(false);
    const loaded = reducer(connected, { type: "hydrate", bots: [], groups: [] });
    expect(loaded.rosterHydrated).toBe(true);
    expect(reducer(loaded, { type: "connected", value: false }).rosterHydrated).toBe(true);
    // A different account starts a fresh provider from initialState.
    expect(initialState.rosterHydrated).toBe(false);
  });
});

describe("cross-client bot creation", () => {
  it("adds an announced bot before its greeting frames arrive", () => {
    const announced = {
      id: "phone-bot",
      threadId: "phone-thread",
      name: "Scout",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
    } satisfies Omit<Bot, "messages">;

    const added = reducer(initialState, { type: "botPatched", bot: announced });

    expect(added.bots).toEqual([{ ...announced, messages: [] }]);

    const greeting = {
      id: "greeting",
      role: "bot",
      kind: "text",
      text: "Hey — I'm Scout. Nice to meet you.",
      at: 2,
    } satisfies Message;
    const greeted = reducer(added, {
      type: "messageAdded",
      threadId: announced.threadId,
      message: greeting,
    });

    expect(greeted.bots[0]?.messages).toEqual([greeting]);
  });
});

describe("hydrate transcript preservation", () => {
  const baseBot = {
    id: "bot-1",
    threadId: "thread-1",
    name: "Scout",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "codex", model: "default" },
  } satisfies Omit<Bot, "messages">;
  const chat = (id: string): Message => ({ id, role: "user", kind: "text", text: `msg ${id}`, at: 1 });

  it("a reconcile snapshot with empty transcripts keeps what the stream delivered", () => {
    const seeded = reducer(initialState, { type: "botPatched", bot: baseBot });
    const talked = reducer(seeded, {
      type: "messageAdded",
      threadId: baseBot.threadId,
      message: chat("m1"),
    });

    // the 30s busy-reconcile polls /api/bots?messages=0 — no transcripts by
    // design. It must never erase them from local state (the wipe bug).
    const reconciled = reducer(talked, {
      type: "hydrate",
      bots: [{ ...baseBot, messages: [] }],
      groups: [],
    });

    expect(reconciled.bots[0]?.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("a snapshot that CARRIES messages still replaces the transcript", () => {
    const seeded = reducer(initialState, { type: "botPatched", bot: baseBot });

    const refreshed = reducer(seeded, {
      type: "hydrate",
      bots: [{ ...baseBot, messages: [chat("m2")] }],
      groups: [],
    });

    expect(refreshed.bots[0]?.messages.map((m) => m.id)).toEqual(["m2"]);
  });

  it("empty-transcript snapshots preserve room transcripts too", () => {
    const room = {
      id: "room-1",
      threadId: "room-thread-1",
      name: "Ops",
      memberIds: [baseBot.id],
      defaultResponder: { kind: "everyone" },
      bulletin: "",
      unread: false,
      createdAt: 1,
      messages: [chat("r1")],
    } satisfies Group;

    const reconciled = reducer({ ...initialState, groups: [room] }, {
      type: "hydrate",
      bots: [],
      groups: [{ ...room, messages: [] }],
    });

    expect(reconciled.groups[0]?.messages.map((m) => m.id)).toEqual(["r1"]);
  });
});

describe("duplicate message acknowledgements", () => {
  const bot: Bot = {
    id: "bot", threadId: "thread", name: "Scout", title: "", description: "",
    notifications: true, color: "green", unread: false, messages: [],
    modelSelection: { instanceId: "fixture", model: "default" },
  };
  const request: Message = { id: "request", role: "user", kind: "text", text: "Draft a brief", at: 1, parentId: null };
  const reply: Message = { id: "reply", role: "bot", kind: "text", text: "Here is your brief", at: 2, parentId: request.id };

  it("keeps a recovered receipt that arrives before the roster and transcript hydrate", () => {
    // SSE opens before the roster request finishes. The echoed message has
    // no mounted carrier yet, but its receipt must survive the later snapshot.
    const beforeRoster = reducer(initialState, {
      type: "messageAdded", threadId: bot.threadId, message: request,
    });
    const recovered = reducer(beforeRoster, {
      type: "messageDelivery", threadId: bot.threadId, intentId: "recovered-intent",
      state: "sent", messageId: request.id,
    });
    expect(recovered.bots).toEqual([]);

    const hydrated = reducer(recovered, {
      type: "hydrate", bots: [{ ...bot, messages: [request, reply] }], groups: [],
    });
    expect(hydrated.bots[0].messages).toEqual([request, reply]);
    expect(hydrated.messageDelivery["recovered-intent"]).toMatchObject({
      threadId: bot.threadId, messageId: request.id, state: "sent",
    });
  });

  it("keeps an original-task receipt while another task is mounted and after switching back", () => {
    const original = { ...bot, messages: [request, reply] };
    const otherTask = { ...bot, threadId: "another-task", messages: [] };
    const switched = reducer({ ...initialState, bots: [original] }, {
      type: "taskSwitched", bot: otherTask,
    });
    const echoed = reducer(switched, {
      type: "messageAdded", threadId: original.threadId, message: request,
    });
    const recovered = reducer(echoed, {
      type: "messageDelivery", threadId: original.threadId, intentId: "original-intent",
      state: "sent", messageId: request.id,
    });
    expect(recovered.bots[0]).toEqual(otherTask);
    expect(Object.values(recovered.messageDelivery).filter((entry) => entry.threadId === otherTask.threadId)).toEqual([]);

    const restored = reducer(recovered, { type: "taskSwitched", bot: original });
    expect(restored.bots[0].messages).toEqual([request, reply]);
    expect(restored.messageDelivery["original-intent"]).toMatchObject({
      threadId: original.threadId, messageId: request.id, state: "sent",
    });
  });

  it("keeps the bot reply visible when completion retry echoes the earlier accepted user message", () => {
    const requested = reducer({ ...initialState, bots: [bot] }, {
      type: "messageAdded", threadId: bot.threadId, message: request,
    });
    const answered = reducer(requested, { type: "messageAdded", threadId: bot.threadId, message: reply });
    const retried = reducer(answered, { type: "messageAdded", threadId: bot.threadId, message: { ...request } });
    expect(retried).toBe(answered);
    expect(retried.bots[0].activeLeafId).toBe(reply.id);
    expect(visibleMessages(retried.bots[0])).toEqual([request, reply]);
  });

  it("does not switch branches or replay state when an existing bot response is redelivered", () => {
    const answered = reducer({ ...initialState, bots: [{ ...bot, messages: [request, reply], activeLeafId: reply.id }] }, {
      type: "threadActive", threadId: bot.threadId, activeLeafId: request.id,
    });
    const replayed = reducer(answered, { type: "messageAdded", threadId: bot.threadId, message: { ...reply } });
    expect(replayed).toBe(answered);
    expect(replayed.bots[0].activeLeafId).toBe(request.id);
    expect(visibleMessages(replayed.bots[0])).toEqual([request]);
  });
});
