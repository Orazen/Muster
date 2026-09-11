// State fold mirroring ios/Sources/CompanionCore/Store.swift.
// Pure functions over an immutable-ish state object; React re-renders on
// identity change.

import { advanceCursor } from "./frames";
import { Frame } from "./frames";
import {
  Bot,
  Fleet,
  isCardPending,
  Message,
  NotificationFrame,
  OptionCard,
  Room,
  ThreadPage,
} from "./types";

export interface StreamBuffers {
  text: string;
  reasoning: string;
}

export interface ViewedConversation {
  kind: "bot" | "room";
  id: string;
  threadId: string;
}

export interface CompanionState {
  cursor: string | null;
  bots: Record<string, Bot>;
  rooms: Record<string, Room>;
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  leaves: Record<string, string | null>;
  streams: Record<string, StreamBuffers>;
  notifications: NotificationFrame[];
  screens: Record<string, { png: string; mime?: string }>;
  viewedTarget: ViewedConversation | null;
}

export const MAX_NOTIFICATIONS = 100;

export function initialState(): CompanionState {
  return {
    cursor: null,
    bots: {},
    rooms: {},
    messages: {},
    hasMore: {},
    leaves: {},
    streams: {},
    notifications: [],
    screens: {},
    viewedTarget: null,
  };
}

function setMessages(
  state: CompanionState,
  threadId: string,
  messages: Message[],
  hasMore?: boolean,
): CompanionState {
  return {
    ...state,
    messages: { ...state.messages, [threadId]: messages },
    hasMore: hasMore === undefined ? state.hasMore : { ...state.hasMore, [threadId]: hasMore },
  };
}

function clearStream(state: CompanionState, threadId: string): CompanionState {
  if (!state.streams[threadId]) return state;
  const streams = { ...state.streams };
  delete streams[threadId];
  return { ...state, streams };
}

function setLeaf(state: CompanionState, threadId: string, leafId: string | null): CompanionState {
  if (state.leaves[threadId] === leafId) return state;
  return { ...state, leaves: { ...state.leaves, [threadId]: leafId } };
}

function appendMessage(state: CompanionState, threadId: string, message: Message): CompanionState {
  const list = state.messages[threadId] ?? [];
  if (list.some((m) => m.id === message.id)) return state;
  return setMessages(state, threadId, [...list, message]);
}

function patchMessage(state: CompanionState, threadId: string, message: Message): CompanionState {
  const list = state.messages[threadId] ?? [];
  const idx = list.findIndex((m) => m.id === message.id);
  const next = idx >= 0 ? list.map((m) => (m.id === message.id ? message : m)) : [...list, message];
  return setMessages(state, threadId, next);
}

function bumpUnread(state: CompanionState, threadId: string): CompanionState {
  const bots = { ...state.bots };
  for (const id of Object.keys(bots)) {
    if (bots[id].threadId === threadId && !isViewed(state, { kind: "bot", id, threadId })) {
      bots[id] = { ...bots[id], unread: (bots[id].unread ?? 0) + 1 };
    }
  }
  const rooms = { ...state.rooms };
  for (const id of Object.keys(rooms)) {
    if (rooms[id].threadId === threadId && !isViewed(state, { kind: "room", id, threadId })) {
      rooms[id] = { ...rooms[id], unread: (rooms[id].unread ?? 0) + 1 };
    }
  }
  return { ...state, bots, rooms };
}

// Bot frame: merge fields but preserve the local transcript, unless the frame
// carries messages[] — a task switch is authoritative and replaces it.
function mergeBot(state: CompanionState, incoming: Bot): CompanionState {
  const existing = state.bots[incoming.id];
  let next = { ...state, bots: { ...state.bots, [incoming.id]: incoming } };
  if (incoming.messages !== undefined) {
    if (existing && existing.threadId !== incoming.threadId) {
      next = clearStream(next, existing.threadId);
    }
    next = clearStream(next, incoming.threadId);
    next = setMessages(next, incoming.threadId, incoming.messages, incoming.hasMore ?? false);
    next = setLeaf(next, incoming.threadId, incoming.activeLeafId ?? null);
  } else if (incoming.activeLeafId !== undefined) {
    next = setLeaf(next, incoming.threadId, incoming.activeLeafId);
  }
  return next;
}

function removeBot(state: CompanionState, botId: string): CompanionState {
  const bot = state.bots[botId];
  const bots = { ...state.bots };
  delete bots[botId];
  let next = { ...state, bots };
  if (bot) {
    next = clearStream(next, bot.threadId);
    const messages = { ...next.messages };
    delete messages[bot.threadId];
    next = { ...next, messages };
  }
  const screens = { ...next.screens };
  delete screens[botId];
  return { ...next, screens };
}

function removeRoom(state: CompanionState, groupId: string): CompanionState {
  const room = state.rooms[groupId];
  const rooms = { ...state.rooms };
  delete rooms[groupId];
  let next = { ...state, rooms };
  if (room) {
    next = clearStream(next, room.threadId);
    const messages = { ...next.messages };
    delete messages[room.threadId];
    next = { ...next, messages };
  }
  return next;
}

function applyRuntime(state: CompanionState, event: { type: string; threadId?: string; delta?: string; streamKind?: string }): CompanionState {
  const threadId = event.threadId;
  if (!threadId) return state;
  if (event.type === "content.delta") {
    if (event.streamKind !== "assistant_text" && event.streamKind !== "reasoning_text") return state;
    if (!event.delta) return state;
    const cur = state.streams[threadId] ?? { text: "", reasoning: "" };
    const next =
      event.streamKind === "assistant_text"
        ? { ...cur, text: cur.text + event.delta }
        : { ...cur, reasoning: cur.reasoning + event.delta };
    return { ...state, streams: { ...state.streams, [threadId]: next } };
  }
  if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.aborted") {
    return clearStream(state, threadId);
  }
  return state;
}

export function applyFrame(state: CompanionState, frame: Frame): CompanionState {
  switch (frame.kind) {
    case "hello":
      // The cursor is committed by the stream layer, not the fold.
      return state;
    case "message": {
      const wasNew = !(state.messages[frame.threadId] ?? []).some(
        (m) => m.id === frame.message.id,
      );
      let next = appendMessage(state, frame.threadId, frame.message);
      next = setLeaf(next, frame.threadId, frame.message.id);
      if (frame.message.role === "bot" && frame.message.kind === "text") {
        next = clearStream(next, frame.threadId);
      }
      if (wasNew && frame.message.role === "bot") {
        next = bumpUnread(next, frame.threadId);
      }
      return next;
    }
    case "message.patch": {
      let next = patchMessage(state, frame.threadId, frame.message);
      if (frame.message.role === "bot" && frame.message.kind === "text") {
        next = clearStream(next, frame.threadId);
      }
      return next;
    }
    case "thread": {
      let next = setLeaf(state, frame.threadId, frame.activeLeafId ?? null);
      next = clearStream(next, frame.threadId);
      return next;
    }
    case "bot":
      return mergeBot(state, frame.bot);
    case "bot.deleted":
      return removeBot(state, frame.botId);
    case "group": {
      const room = frame.group;
      let next = { ...state, rooms: { ...state.rooms, [room.id]: room } };
      if (room.messages !== undefined) {
        next = clearStream(next, room.threadId);
        next = setMessages(next, room.threadId, room.messages, room.hasMore ?? false);
        next = setLeaf(next, room.threadId, null);
      }
      return next;
    }
    case "group.deleted":
      return removeRoom(state, frame.groupId);
    case "notify": {
      const notifications = [frame.notification, ...state.notifications].slice(
        0,
        MAX_NOTIFICATIONS,
      );
      return { ...state, notifications };
    }
    case "screen": {
      // Newest screen per bot only.
      return {
        ...state,
        screens: {
          ...state.screens,
          [frame.screen.botId]: { png: frame.screen.png, mime: frame.screen.mime },
        },
      };
    }
    case "computer":
      return state;
    case "config":
      return state;
    case "runtime":
      return applyRuntime(state, frame.event);
    default:
      return state;
  }
}

export function hydrate(state: CompanionState, fleet: Fleet): CompanionState {
  // Full replace: transcripts, leaves, streams and screens belong to the
  // fleet — anything the server no longer lists must vanish.
  let next: CompanionState = {
    ...state,
    bots: {},
    rooms: {},
    messages: {},
    hasMore: {},
    leaves: {},
    streams: {},
    screens: {},
  };
  for (const bot of fleet.bots) {
    next = mergeBot(next, bot);
  }
  for (const room of fleet.groups) {
    next = { ...next, rooms: { ...next.rooms, [room.id]: room } };
    if (room.messages !== undefined) {
      next = setMessages(next, room.threadId, room.messages, room.hasMore ?? false);
      const last = room.messages.length > 0 ? room.messages[room.messages.length - 1].id : null;
      next = setLeaf(next, room.threadId, last);
    }
  }
  return next;
}

// Scrollback: dedupe against what we hold, older messages first.
export function prependPage(state: CompanionState, threadId: string, page: ThreadPage): CompanionState {
  const existing = state.messages[threadId] ?? [];
  const known = new Set(existing.map((m) => m.id));
  const older = page.messages.filter((m) => !known.has(m.id));
  if (older.length === 0) {
    return page.hasMore === undefined ? state : { ...state, hasMore: { ...state.hasMore, [threadId]: page.hasMore } };
  }
  return setMessages(state, threadId, [...older, ...existing], page.hasMore ?? false);
}

function isViewed(state: CompanionState, target: ViewedConversation): boolean {
  const viewed = state.viewedTarget;
  return viewed?.kind === target.kind && viewed.id === target.id && viewed.threadId === target.threadId;
}

// Viewing suppresses new local badges only for this owner. Shared read state
// changes through server frames or a still-current accepted acknowledgement.
export function markViewed(state: CompanionState, target: ViewedConversation | null): CompanionState {
  if (target ? isViewed(state, target) : state.viewedTarget === null) return state;
  return { ...state, viewedTarget: target ? { ...target } : null };
}

export function acknowledgeViewed(state: CompanionState, target: ViewedConversation): CompanionState {
  if (!isViewed(state, target)) return state;
  if (target.kind === "bot") {
    const bot = state.bots[target.id];
    if (!bot || bot.threadId !== target.threadId || !bot.unread) return state;
    return { ...state, bots: { ...state.bots, [target.id]: { ...bot, unread: 0 } } };
  }
  const room = state.rooms[target.id];
  if (!room || room.threadId !== target.threadId || !room.unread) return state;
  return { ...state, rooms: { ...state.rooms, [target.id]: { ...room, unread: 0 } } };
}

export function setCursor(state: CompanionState, cursor: string): CompanionState {
  return { ...state, cursor };
}

// The visible branch: walk from the leaf up through parentId links.
export function visibleTranscript(state: CompanionState, threadId: string): Message[] {
  const all = state.messages[threadId];
  if (!all || all.length === 0) return [];
  const byId = new Map(all.map((m) => [m.id, m]));
  let leafId = state.leaves[threadId] ?? all[all.length - 1].id;
  let node = byId.get(leafId);
  if (!node) {
    // Leaf unknown (pruned scrollback): fall back to the newest message.
    node = all[all.length - 1];
  }
  const chain: Message[] = [];
  const seen = new Set<string>();
  let cur: Message | undefined = node;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain.reverse();
}

export interface PendingApproval {
  bot: Bot;
  threadId: string;
  message: Message;
  card: OptionCard;
}

// Pending cards across active bot transcripts, newest first.
export function pendingApprovals(state: CompanionState): PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const bot of Object.values(state.bots)) {
    for (const message of visibleTranscript(state, bot.threadId)) {
      if (message.card && isCardPending(message.card)) {
        out.push({ bot, threadId: bot.threadId, message, card: message.card });
      }
    }
  }
  return out.sort((a, b) => b.message.at - a.message.at);
}

export function totalUnread(state: CompanionState): number {
  let n = 0;
  for (const bot of Object.values(state.bots)) n += bot.unread ?? 0;
  for (const room of Object.values(state.rooms)) n += room.unread ?? 0;
  return n;
}

export { advanceCursor };
