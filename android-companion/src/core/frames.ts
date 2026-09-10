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

import { botSchema, fleetSchema, frameEnvelopeSchema, type JsonValue, messageSchema, notificationSchema, roomSchema, runtimeEventSchema } from "./contracts";

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

export function decodeMessage(raw: JsonValue): Message | null {
  const parsed = messageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function decodeBot(raw: JsonValue): Bot | null {
  const parsed = botSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function decodeRoom(raw: JsonValue): Room | null {
  const parsed = roomSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function decodeFleet(raw: JsonValue): Fleet { return fleetSchema.parse(raw); }
export function decodeNotification(raw: JsonValue): NotificationFrame { return notificationSchema.parse(raw); }

export function decodeFrame(data: string): Frame {
  let parsed;
  try { parsed = frameEnvelopeSchema.safeParse(JSON.parse(data)); }
  catch { return { kind: "unknown", rawKind: "malformed" }; }
  if (!parsed.success) return { kind: "unknown", rawKind: "malformed" };
  const raw = parsed.data;
  const kind = raw.kind;
  const unknown: Frame = { kind: "unknown", rawKind: kind };
  switch (kind) {
    case "hello": return { kind, cursor: raw.cursor ?? "", resumed: raw.resumed ?? false };
    case "message":
    case "message.patch": {
      const message = decodeMessage(raw.message ?? null);
      return raw.threadId && message ? { kind, threadId: raw.threadId, message } : unknown;
    }
    case "thread": return raw.threadId ? { kind, threadId: raw.threadId, activeLeafId: raw.activeLeafId } : unknown;
    case "bot": {
      const bot = decodeBot(raw.bot ?? null);
      return bot ? { kind, bot } : unknown;
    }
    case "bot.deleted": return raw.botId ? { kind, botId: raw.botId } : unknown;
    case "group": {
      const group = decodeRoom(raw.group ?? null);
      return group ? { kind, group } : unknown;
    }
    case "group.deleted": return raw.groupId ? { kind, groupId: raw.groupId } : unknown;
    case "notify": return { kind, notification: decodeNotification(raw.notification ?? null) };
    case "screen": return raw.botId && raw.png
      ? { kind, screen: { botId: raw.botId, png: raw.png, mime: raw.mime } } : unknown;
    case "computer": return raw.botId ? { kind, botId: raw.botId, state: raw.state } : unknown;
    case "config": return { kind };
    case "runtime": return { kind, event: runtimeEventSchema.parse(raw.event) };
    default: return unknown;
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
