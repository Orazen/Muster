// Telegram Bot API transport for the workspace bundle — the same encrypted
// bundle Drive gets, uploaded as one document into the connected bot/chat.
// Chat discovery currently selects the latest incoming message; it does not
// establish who owns that chat. Callers provide the encrypted bundle.
//
// Requests use the fixed https://api.telegram.org endpoint. Bot tokens are
// format-checked before interpolation into method and download paths.
import { z } from "zod";

const API_BASE = "https://api.telegram.org";
const BUNDLE_NAME = "muster-workspace.enc";
const META_TIMEOUT = 15_000;
const TRANSFER_TIMEOUT = 60_000;

// BotFather tokens are <bot id>:<hash> — digits, one colon, then hash
// characters. The check is a hard precondition: the token is interpolated
// into URL paths, so anything shaped like a URL or path separator is
// rejected before any request is built.
const BOT_TOKEN_RE = /^\d{8,12}:[A-Za-z0-9_-]{30,}$/;

function botUrl(token: string, method: string): string {
  if (!BOT_TOKEN_RE.test(token)) {
    throw new Error("that does not look like a Telegram bot token — copy it from @BotFather");
  }
  return `${API_BASE}/bot${token}/${method}`;
}

const apiResponseSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
});

const meSchema = apiResponseSchema.extend({
  result: z.object({ username: z.string().optional() }),
});

const updatesSchema = apiResponseSchema.extend({
  result: z
    .array(
      z.object({
        update_id: z.number().optional(),
        message: z
          .object({
            chat: z.object({
              id: z.number(),
              title: z.string().optional(),
              username: z.string().optional(),
              first_name: z.string().optional(),
            }),
            document: z.object({ file_id: z.string(), file_name: z.string().optional() }).optional(),
          })
          .optional(),
      }),
    ),
});

const documentSentSchema = apiResponseSchema.extend({
  result: z.object({ document: z.object({ file_id: z.string().min(1) }) }),
});

const filePathSchema = apiResponseSchema.extend({
  result: z.object({ file_path: z.string().min(1) }),
});

type TelegramEnvelope = z.infer<typeof apiResponseSchema>;

function telegramError(what: string, status: number, data: TelegramEnvelope): Error {
  const detail = data.description ? ` — ${data.description}` : "";
  const retry = status === 429 || data.error_code === 429 ? " (Telegram rate limit — wait a minute and try again)" : "";
  const code = data.error_code !== undefined && data.error_code !== status ? ` (Telegram code ${data.error_code})` : "";
  return new Error(`${what}: HTTP ${status}${code}${retry}${detail}`);
}

async function callTelegram<Schema extends z.ZodType>(
  token: string, method: string, timeoutMs: number, schema: Schema, failure: string, init: RequestInit = {},
): Promise<z.output<Schema>> {
  const res = await fetch(botUrl(token, method), { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const raw: unknown = await res.json().catch(() => null);
  const envelope = apiResponseSchema.safeParse(raw);
  if (!envelope.success) {
    throw telegramError(`Telegram returned an unreadable response for ${method}`, res.status, { ok: false });
  }
  if (!res.ok || !envelope.data.ok) throw telegramError(failure, res.status, envelope.data);
  // Parse the full raw payload again. Passing envelope.data would discard
  // the method's result because the shared schema strips unknown fields.
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw telegramError(`Telegram returned an unreadable ${method} response`, res.status, envelope.data);
  return parsed.data;
}

/** Validate the token against getMe; returns the bot's @username. */
export async function verifyBot(token: string): Promise<string> {
  const me = await callTelegram(token, "getMe", META_TIMEOUT, meSchema, "Telegram rejected that bot token");
  return me.result.username ?? "";
}

export interface TelegramChat {
  chatId: number;
  label: string;
}

export interface TelegramFileBinding {
  botToken?: string;
  chatId?: number;
  lastFileId?: string;
}

/** Check the binding again after a provider await before caching its file. */
export function telegramConnectionMatches(
  current: TelegramFileBinding | undefined,
  botToken: string,
  chatId: number,
): boolean {
  return BOT_TOKEN_RE.test(botToken) && Number.isSafeInteger(chatId) && chatId !== 0
    && current?.botToken === botToken && current.chatId === chatId;
}

/** Restore also supports the existing unbound recent-document discovery
 * mode, but only while that same token and null chat binding remain set. */
export function telegramRestoreConnectionMatches(
  current: TelegramFileBinding | undefined,
  botToken: string,
  chatId: number | null,
): boolean {
  if (!BOT_TOKEN_RE.test(botToken) || current?.botToken !== botToken) return false;
  if (chatId !== null && (!Number.isSafeInteger(chatId) || chatId === 0)) return false;
  return (current.chatId ?? null) === chatId;
}

/** A cached file belongs to the exact bot/chat that uploaded it. Preserve
 * same-identity reconnects beyond the recent-update retention window. */
export function telegramFileIdAfterConnect(
  current: TelegramFileBinding | undefined,
  nextBotToken: string,
  nextChatId: number,
): string {
  if (!telegramConnectionMatches(current, nextBotToken, nextChatId)) return "";
  return current?.lastFileId ?? "";
}

/** Discover the latest incoming chat after a message such as /start.
 * This does not verify chat ownership; an explicit binding handshake is
 * outside the current protocol. Confirms updates so discovery does not
 * replay on the next connect. */
export async function discoverChat(token: string): Promise<TelegramChat> {
  const updates = await callTelegram(token, "getUpdates", META_TIMEOUT, updatesSchema, "Telegram would not list recent messages");
  let lastUpdateId = 0;
  for (const update of updates.result) {
    if (update.update_id && update.update_id > lastUpdateId) lastUpdateId = update.update_id;
  }
  const withChat = updates.result.filter((u) => u.message?.chat?.id != null);
  const latest = withChat.at(-1);
  if (!latest?.message) {
    throw new Error("no message from you yet — open Telegram, send /start to the bot, then connect again");
  }
  const chat = latest.message.chat;
  if (lastUpdateId > 0) {
    // Confirm up to the newest update (offset semantics) — best effort.
    await fetch(botUrl(token, `getUpdates?offset=${lastUpdateId + 1}`), {
      signal: AbortSignal.timeout(META_TIMEOUT),
    }).catch(() => null);
  }
  return {
    chatId: chat.id,
    label: chat.title ?? chat.username ?? chat.first_name ?? String(chat.id),
  };
}

/** Scan recent updates for the newest document in the connected
 * chat. Covers a fresh install: the owner forwards the muster-workspace.enc
 * file to the bot, and this finds it — getUpdates keeps updates for ~24h,
 * so pushes normally rely on the stored lastFileId instead. */
export async function resolveLatestFileId(token: string, chatId: number | null): Promise<string | null> {
  const updates = await callTelegram(token, "getUpdates", META_TIMEOUT, updatesSchema, "Telegram would not list recent messages");
  const docs = updates.result.filter((u) => u.message?.document?.file_id);
  // Null is the existing fresh-install discovery mode. An explicit chat
  // binding must never borrow another chat's document when it has none.
  const inChat = chatId == null ? docs : docs.filter((u) => u.message?.chat?.id === chatId);
  return inChat.at(-1)?.message?.document?.file_id ?? null;
}

/** Upload the encrypted bundle as one document into the bot chat. Returns
 * the Telegram file_id for later pulls. */
export async function pushBundle(token: string, chatId: number, payload: string, fileName = BUNDLE_NAME): Promise<string> {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", new File([payload], fileName, { type: "application/octet-stream" }));
  const sent = await callTelegram(token, "sendDocument", TRANSFER_TIMEOUT, documentSentSchema, "Telegram upload failed", {
    method: "POST",
    body: form,
  });
  return sent.result.document.file_id;
}

/** Download a previously uploaded document by file_id (the payload is the
 * same base64 bundle string Drive holds). */
export async function downloadBundle(token: string, fileId: string): Promise<string> {
  const meta = await callTelegram(token, "getFile", META_TIMEOUT, filePathSchema, "Telegram could not resolve that file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  // Telegram file paths are "documents/file_N.ext". Validate segment-wise so
  // the interpolated download path stays under the fixed host.
  const filePath = meta.result.file_path;
  const segments = filePath.split("/");
  if (
    segments.length === 0 ||
    !segments.every((s) => s.length > 0 && s !== "." && s !== ".." && /^[A-Za-z0-9._-]+$/.test(s))
  ) {
    throw new Error("Telegram reported an unexpected file path");
  }
  if (!BOT_TOKEN_RE.test(token)) {
    throw new Error("that does not look like a Telegram bot token — copy it from @BotFather");
  }
  const binRes = await fetch(`${API_BASE}/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(TRANSFER_TIMEOUT),
  });
  if (!binRes.ok) throw new Error(`Telegram download failed: HTTP ${binRes.status}`);
  return await binRes.text();
}
