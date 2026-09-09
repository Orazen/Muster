// Telegram Bot API transport for the workspace bundle — the same encrypted
// bundle Drive gets, uploaded as one document into the user's private chat
// with a bot they create via @BotFather. The chat is a free cloud store the
// user already owns; it only ever holds ciphertext, so the bot token alone
// can never read a workspace.
//
// Server-side URL requests here go to exactly one validated https host:
// api.telegram.org. Every URL is a fixed-path template over that constant
// and the bot token is format-checked before it is ever interpolated, so
// loopback/private/reserved targets are structurally impossible.
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
});

const meSchema = apiResponseSchema.extend({
  result: z.object({ username: z.string().optional() }).optional(),
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
    )
    .default([]),
});

const documentSentSchema = apiResponseSchema.extend({
  result: z
    .object({ document: z.object({ file_id: z.string() }).optional() })
    .optional(),
});

const filePathSchema = apiResponseSchema.extend({
  result: z.object({ file_path: z.string() }).optional(),
});

function telegramError(what: string, status: number, data: { ok: boolean; description?: string }): Error {
  const detail = data.description ? ` — ${data.description}` : "";
  const retry = status === 429 ? " (Telegram rate limit — wait a minute and try again)" : "";
  return new Error(`${what}: HTTP ${status}${retry}${detail}`);
}

// Minimal shape checked in callTelegram; each method re-parses the FULL raw
// body with its own schema (a shared zod object would strip `result` before
// the specific schema could see it).
type TelegramEnvelope = { ok: boolean; description?: string };

async function callTelegram(token: string, method: string, timeoutMs: number): Promise<{ status: number; data: unknown }> {
  const res = await fetch(botUrl(token, method), { signal: AbortSignal.timeout(timeoutMs) });
  const raw: unknown = await res.json().catch(() => null);
  if (typeof raw !== "object" || raw === null || typeof (raw as { ok?: unknown }).ok !== "boolean") {
    throw new Error(`Telegram returned an unreadable response for ${method}`);
  }
  return { status: res.status, data: raw };
}

/** Validate the token against getMe; returns the bot's @username. */
export async function verifyBot(token: string): Promise<string> {
  const { status, data } = await callTelegram(token, "getMe", META_TIMEOUT);
  const envelope = data as TelegramEnvelope;
  if (!envelope.ok) throw telegramError("Telegram rejected that bot token", status, envelope);
  const me = meSchema.safeParse(data);
  return me.success ? (me.data.result?.username ?? "") : "";
}

export interface TelegramChat {
  chatId: number;
  label: string;
}

/** Find the chat the owner already started with the bot (send /start to it
 * first). Picks the most recent message; a dedicated sync bot makes the
 * first private chat the owner by construction. Confirms the update so the
 * discovery does not replay on the next connect. */
export async function discoverChat(token: string): Promise<TelegramChat> {
  const { status, data } = await callTelegram(token, "getUpdates", META_TIMEOUT);
  const envelope = data as TelegramEnvelope;
  if (!envelope.ok) throw telegramError("Telegram would not list recent messages", status, envelope);
  const updates = updatesSchema.safeParse(data);
  if (!updates.success) throw new Error("Telegram returned an unreadable updates response");
  let lastUpdateId = 0;
  for (const update of updates.data.result) {
    if (update.update_id && update.update_id > lastUpdateId) lastUpdateId = update.update_id;
  }
  const withChat = updates.data.result.filter((u) => u.message?.chat?.id != null);
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

/** Scan recent updates for the newest document, preferring the connected
 * chat. Covers a fresh install: the owner forwards the muster-workspace.enc
 * file to the bot, and this finds it — getUpdates keeps updates for ~24h,
 * so pushes normally rely on the stored lastFileId instead. */
export async function resolveLatestFileId(token: string, chatId: number | null): Promise<string | null> {
  const { status, data } = await callTelegram(token, "getUpdates", META_TIMEOUT);
  const envelope = data as TelegramEnvelope;
  if (!envelope.ok) throw telegramError("Telegram would not list recent messages", status, envelope);
  const updates = updatesSchema.safeParse(data);
  if (!updates.success) return null;
  const docs = updates.data.result.filter((u) => u.message?.document?.file_id);
  const inChat = chatId == null ? docs : docs.filter((u) => u.message?.chat?.id === chatId);
  const pool = inChat.length > 0 ? inChat : docs;
  return pool.at(-1)?.message?.document?.file_id ?? null;
}

/** Upload the encrypted bundle as one document into the bot chat. Returns
 * the Telegram file_id for later pulls. */
export async function pushBundle(token: string, chatId: number, payload: string): Promise<string> {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", new File([payload], BUNDLE_NAME, { type: "application/octet-stream" }));
  const res = await fetch(botUrl(token, "sendDocument"), {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TRANSFER_TIMEOUT),
  });
  const parsed = documentSentSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error("Telegram returned an unreadable upload response");
  if (!parsed.data.ok || !parsed.data.result?.document?.file_id) {
    throw telegramError("Telegram upload failed", res.status, parsed.data);
  }
  return parsed.data.result.document.file_id;
}

/** Download a previously uploaded document by file_id (the payload is the
 * same base64 bundle string Drive holds). */
export async function downloadBundle(token: string, fileId: string): Promise<string> {
  const metaRes = await fetch(botUrl(token, "getFile"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(META_TIMEOUT),
  });
  const meta = filePathSchema.safeParse(await metaRes.json().catch(() => null));
  if (!meta.success) throw new Error("Telegram returned an unreadable file reference");
  if (!meta.data.ok || !meta.data.result?.file_path) {
    throw telegramError("Telegram could not resolve that file", metaRes.status, meta.data);
  }
  // Telegram file paths are "documents/file_N.ext". Validate segment-wise so
  // the interpolated download path stays under the fixed host.
  const filePath = meta.data.result.file_path;
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
