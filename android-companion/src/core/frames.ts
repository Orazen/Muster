// Frame decoding mirroring ios/Sources/CompanionCore/Frames.swift.
// One JSON object per SSE data line; unknown kinds are absorbed, never fatal.

import {
  Bot,
  Fleet,
  Message,
  NotificationFrame,
  Room,
  RuntimeEvent,
  ScreenFrame,
} from "./types";

export type Frame =
  | { kind: "hello"; cursor: string; resumed: boolean }
  | { kind: "message"; threadId: string; message: Message }
  | { kind: "message.patch"; threadId: string; message: Message }
  | { kind: "thread"; threadId: string; activeLeafId?: string | null }
  | { kind: "bot"; bot: Bot }
  | { kind: "bot.deleted"; botId: string }
  | { kind: "group"; group: Room }
  | { kind: "group.deleted"; groupId: string }
  | { kind: "notify"; notification: NotificationFrame }
  | { kind: "screen"; screen: ScreenFrame }
  | { kind: "computer"; botId: string; state?: string | null }
  | { kind: "config" }
  | { kind: "runtime"; event: RuntimeEvent }
  | { kind: "unknown"; rawKind: string };

export interface StreamFrame {
  frame: Frame;
  seq: number | null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// Decodes a message without trusting the wire's kind string: a kind we don't
// know renders as "unknown" instead of crashing, same as the iOS decoder.
function decodeMessage(raw: any): Message {
  const kind = asString(raw?.kind) ?? "unknown";
  const known: Message["kind"][] = ["text", "options", "activity", "screen"];
  return {
    id: asString(raw?.id) ?? "",
    role: raw?.role === "user" ? "user" : "bot",
    kind: known.includes(kind as Message["kind"]) ? (kind as Message["kind"]) : "unknown",
    at: asNumber(raw?.at) ?? 0,
    text: asString(raw?.text),
    card: raw?.card ?? null,
    tool: raw?.tool ?? null,
    parentId: raw?.parentId ?? null,
    from: raw?.from ?? null,
    reactions: Array.isArray(raw?.reactions) ? raw.reactions : null,
    comm: raw?.comm ?? null,
    hasImage: asBool(raw?.hasImage) ?? false,
    png: asString(raw?.png) ?? null,
    mime: asString(raw?.mime) ?? null,
  };
}

function decodeBot(raw: any): Bot {
  return {
    id: asString(raw?.id) ?? "",
    threadId: asString(raw?.threadId) ?? "",
    name: asString(raw?.name) ?? "Bot",
    title: asString(raw?.title),
    description: asString(raw?.description),
    notifications: asBool(raw?.notifications) ?? true,
    color: asString(raw?.color),
    unread: asNumber(raw?.unread) ?? 0,
    modelSelection: raw?.modelSelection ?? null,
    createdAt: asNumber(raw?.createdAt),
    busy: asBool(raw?.busy),
    pinned: asBool(raw?.pinned),
    hidden: asBool(raw?.hidden),
    chiefOfStaff: asBool(raw?.chiefOfStaff),
    autoApprove: asBool(raw?.autoApprove),
    alwaysAllow: Array.isArray(raw?.alwaysAllow) ? raw.alwaysAllow : undefined,
    computer: asString(raw?.computer) ?? null,
    speakReplies: asBool(raw?.speakReplies),
    voice: asString(raw?.voice) ?? null,
    mascotExpression: asString(raw?.mascotExpression) ?? null,
    tasks: Array.isArray(raw?.tasks) ? raw.tasks : undefined,
    messages: Array.isArray(raw?.messages) ? raw.messages.map(decodeMessage) : undefined,
    activeLeafId: raw?.activeLeafId ?? null,
    hasMore: asBool(raw?.hasMore),
  };
}

function decodeRoom(raw: any): Room {
  return {
    id: asString(raw?.id) ?? "",
    threadId: asString(raw?.threadId) ?? "",
    name: asString(raw?.name),
    memberIds: Array.isArray(raw?.memberIds) ? raw.memberIds : [],
    defaultResponder: raw?.defaultResponder ?? { kind: "round-robin" },
    bulletin: raw?.bulletin ?? null,
    unread: asNumber(raw?.unread) ?? 0,
    createdAt: asNumber(raw?.createdAt),
    dm: asBool(raw?.dm),
    busyBotId: asString(raw?.busyBotId) ?? null,
    messages: Array.isArray(raw?.messages) ? raw.messages.map(decodeMessage) : undefined,
    hasMore: asBool(raw?.hasMore),
  };
}

function decodeNotification(raw: any): NotificationFrame {
  return {
    kind: asString(raw?.kind) ?? "done",
    botId: asString(raw?.botId),
    botName: asString(raw?.botName),
    threadId: asString(raw?.threadId),
    title: asString(raw?.title),
    body: asString(raw?.body),
  };
}

function decodeRuntimeEvent(raw: any): RuntimeEvent {
  return {
    type: asString(raw?.type) ?? "",
    threadId: asString(raw?.threadId),
    delta: asString(raw?.delta),
    streamKind: asString(raw?.streamKind),
  };
}

function decodeFleet(raw: any): Fleet {
  return {
    bots: Array.isArray(raw?.bots) ? raw.bots.map(decodeBot) : [],
    groups: Array.isArray(raw?.groups) ? raw.groups.map(decodeRoom) : [],
  };
}

export function decodeFrame(data: string): Frame {
  let raw: any;
  try {
    raw = JSON.parse(data);
  } catch {
    return { kind: "unknown", rawKind: "malformed" };
  }
  const kind = asString(raw?.kind) ?? "unknown";
  switch (kind) {
    case "hello":
      return {
        kind: "hello",
        cursor: asString(raw?.cursor) ?? "",
        resumed: asBool(raw?.resumed) ?? false,
      };
    case "message":
    case "message.patch": {
      const threadId = asString(raw?.threadId) ?? "";
      if (!threadId || !raw?.message) return { kind: "unknown", rawKind: kind };
      return { kind, threadId, message: decodeMessage(raw.message) };
    }
    case "thread":
      return {
        kind: "thread",
        threadId: asString(raw?.threadId) ?? "",
        activeLeafId: raw?.activeLeafId ?? null,
      };
    case "bot":
      return raw?.bot ? { kind: "bot", bot: decodeBot(raw.bot) } : { kind: "unknown", rawKind: kind };
    case "bot.deleted":
      return asString(raw?.botId)
        ? { kind: "bot.deleted", botId: asString(raw?.botId)! }
        : { kind: "unknown", rawKind: kind };
    case "group":
      return raw?.group ? { kind: "group", group: decodeRoom(raw.group) } : { kind: "unknown", rawKind: kind };
    case "group.deleted":
      return asString(raw?.groupId)
        ? { kind: "group.deleted", groupId: asString(raw?.groupId)! }
        : { kind: "unknown", rawKind: kind };
    case "notify":
      return { kind: "notify", notification: decodeNotification(raw?.notification) };
    case "screen": {
      const botId = asString(raw?.botId);
      const png = asString(raw?.png);
      if (!botId || !png) return { kind: "unknown", rawKind: kind };
      return { kind: "screen", screen: { botId, png, mime: asString(raw?.mime) } };
    }
    case "computer":
      return {
        kind: "computer",
        botId: asString(raw?.botId) ?? "",
        state: asString(raw?.state) ?? null,
      };
    case "config":
      return { kind: "config" };
    case "runtime":
      return { kind: "runtime", event: decodeRuntimeEvent(raw?.event) };
    default:
      return { kind: "unknown", rawKind: kind };
  }
}

// Parses the SSE `id:` line ("<streamId>:<seq>") into a resume cursor.
// The streamId prefix must be preserved; only the seq advances.
export function advanceCursor(current: string | null, id: string): string {
  const sep = id.lastIndexOf(":");
  if (sep < 0) return current ?? id;
  const streamId = id.slice(0, sep);
  const seq = Number(id.slice(sep + 1));
  if (!Number.isFinite(seq)) return current ?? id;
  const curSep = current?.lastIndexOf(":") ?? -1;
  const curStreamId = curSep > 0 ? current!.slice(0, curSep) : streamId;
  const curSeq = curSep > 0 ? Number(current!.slice(curSep + 1)) : -1;
  if (curStreamId === streamId && curSeq >= seq) return current!;
  return `${streamId}:${seq}`;
}

export { decodeBot, decodeRoom, decodeMessage, decodeFleet, decodeNotification };
