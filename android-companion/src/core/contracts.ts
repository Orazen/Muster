import { z } from "zod";

export const jsonSchema = z.json();
export type JsonValue = z.infer<typeof jsonSchema>;

const text = z.string().optional().catch(undefined);
const number = z.number().finite().optional().catch(undefined);
const flag = z.boolean().optional().catch(undefined);
const nullableText = z.string().nullable().catch(null);
const id = z.string().min(1);
const unread = z.union([z.boolean().transform((value) => value ? 1 : 0), z.number().finite().nonnegative()]).catch(0);

// A bad sibling must not erase valid roster entries or transcript messages.
function entries<T>(schema: z.ZodType<T>) {
  return z.array(schema.nullable().catch(null))
    .transform((items) => items.flatMap((item) => item === null ? [] : [item]))
    .catch([]);
}
const strings = entries(z.string());
const cardSchema = z.object({
  title: z.string().catch(""), subtitle: text, options: strings,
  answered: nullableText, dismissed: flag, requestId: text, tool: text,
  held: text, allowKey: text,
}).nullable().catch(null);
const toolSchema = z.object({ name: z.string().catch(""), ok: flag, spoken: text, setup: flag }).nullable().catch(null);
const senderSchema = z.object({ botId: text, name: text, color: text }).nullable().catch(null);
const reactionsSchema = entries(z.object({ emoji: z.string(), by: z.string() })).nullable().catch(null);
const commSchema = z.object({ groupId: id, withBotId: text, withName: text, withColor: text }).nullable().catch(null);
export const messageSchema = z.object({
  id, role: z.enum(["user", "bot"]).catch("bot"),
  kind: z.enum(["text", "options", "activity", "screen", "unknown"]).catch("unknown"),
  at: z.number().finite().catch(0), text, card: cardSchema, tool: toolSchema,
  parentId: nullableText, from: senderSchema, reactions: reactionsSchema,
  comm: commSchema, hasImage: z.boolean().catch(false), png: nullableText, mime: nullableText,
});
export const messagesSchema = entries(messageSchema);
const taskSchema = z.object({ threadId: id, title: z.string(), createdAt: z.number().finite() });
const selectionSchema = z.object({ instanceId: id, model: z.string() }).nullable().catch(null);
export const botSchema = z.object({
  id, threadId: id, name: z.string().catch("Bot"), title: text, description: text,
  notifications: z.boolean().catch(true), color: text, unread,
  modelSelection: selectionSchema, createdAt: number, busy: flag, pinned: flag, hidden: flag,
  chiefOfStaff: flag, autoApprove: flag, alwaysAllow: strings.optional(), computer: nullableText,
  speakReplies: flag, voice: nullableText, mascotExpression: nullableText,
  tasks: entries(taskSchema).optional(), messages: messagesSchema.optional(),
  activeLeafId: nullableText, hasMore: flag,
});
export const roomSchema = z.object({
  id, threadId: id, name: text, memberIds: strings,
  defaultResponder: z.object({ kind: z.string(), botId: text }).catch({ kind: "round-robin" }),
  bulletin: nullableText, unread, createdAt: number,
  dm: flag, busyBotId: nullableText, messages: messagesSchema.optional(), hasMore: flag,
});
export const fleetSchema = z.object({ bots: z.array(jsonSchema), groups: z.array(jsonSchema).optional().default([]) })
  .transform((value) => ({ bots: entries(botSchema).parse(value.bots), groups: entries(roomSchema).parse(value.groups) }));
export const threadPageSchema = z.object({ messages: z.array(jsonSchema), hasMore: flag })
  .transform((value) => ({ messages: messagesSchema.parse(value.messages), hasMore: value.hasMore }));
export const notificationSchema = z.object({
  kind: z.string().catch("done"), botId: text, botName: text, threadId: text, title: text, body: text,
}).catch({ kind: "done" });
export const runtimeEventSchema = z.object({ type: z.string().catch(""), threadId: text, delta: text, streamKind: text }).catch({ type: "" });
const instanceEntriesSchema = entries(z.object({
  instanceId: id, driverKind: id, displayName: text,
  snapshot: z.object({ state: z.string(), reason: nullableText, authenticated: flag, version: nullableText }),
  models: z.object({ default: z.string(), options: entries(z.object({ id: z.string(), label: z.string() })) }),
}));
export const instancesSchema = z.union([
  z.object({ instances: z.array(jsonSchema) }).transform((value) => value.instances), z.array(jsonSchema),
]).transform((value) => instanceEntriesSchema.parse(value));
export const pairResponseSchema = z.object({
  token: z.string().min(1).regex(/^\S+$/),
  device: z.object({ id, name: z.string(), createdAt: number, lastSeenAt: number }), serverName: text,
});
export const apiErrorSchema = z.object({ error: z.string() });

// Parse only the envelope here; each known payload has its own lossy decoder.
export const frameEnvelopeSchema = z.object({
  kind: z.string().catch("unknown"), cursor: text, resumed: flag,
  threadId: text, botId: text, groupId: text, activeLeafId: nullableText,
  message: jsonSchema.optional(), bot: jsonSchema.optional(), group: jsonSchema.optional(),
  notification: jsonSchema.optional(), event: jsonSchema.optional(),
  png: text, mime: text, state: nullableText,
});
