import { describe, expect, it } from "vitest";

import { initialState, reducer, visibleMessages, type Bot, type Group, type Message } from "./store";

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

  it("does not switch branches or replay mascot motion when an existing bot response is redelivered", () => {
    const answered = reducer({ ...initialState, bots: [{ ...bot, messages: [request, reply], activeLeafId: reply.id }] }, {
      type: "threadActive", threadId: bot.threadId, activeLeafId: request.id,
    });
    const replayed = reducer(answered, { type: "messageAdded", threadId: bot.threadId, message: { ...reply } });
    expect(replayed).toBe(answered);
    expect(replayed.bots[0].activeLeafId).toBe(request.id);
    expect(visibleMessages(replayed.bots[0])).toEqual([request]);
  });
});
