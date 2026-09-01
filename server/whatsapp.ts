// WhatsApp Business channel — business packs' distribution surface.
//
// A business owner messages a Muster-powered WhatsApp number; the message
// becomes a bot turn; the bot's reply goes back over the WhatsApp Cloud
// API. This is the channel local businesses already live in (booking,
// orders, FAQs) — no app install on their side.
//
// Configuration is environment-only, never stored in source or config
// files: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
// WHATSAPP_VERIFY_TOKEN (webhook subscription handshake), and
// WHATSAPP_APP_SECRET (X-Hub-Signature-256 verification). Unconfigured
// deployments simply don't mount the routes.
//
// Outbound uses the Graph API over https with the host pinned to
// graph.facebook.com — user input never reaches a URL here, only message
// bodies inside the POST body.

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const GRAPH_API_HOST = "graph.facebook.com";
const GRAPH_API_VERSION = "v21.0";

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string;
}

export function whatsappConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WhatsAppConfig | null {
  const accessToken = env.WHATSAPP_ACCESS_TOKEN?.trim() ?? "";
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";
  const appSecret = env.WHATSAPP_APP_SECRET?.trim() ?? "";
  if (!accessToken || !phoneNumberId || !verifyToken || !appSecret) return null;
  return { accessToken, phoneNumberId, verifyToken, appSecret };
}

/** Constant-time verification of Meta's X-Hub-Signature-256 header over
 * the raw request body. Meta signs with the app secret. */
export function verifySignature(appSecret: string, rawBody: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const provided = header.slice("sha256=".length);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Webhook subscription handshake (GET): echo the challenge only when the
 * verify token matches what the deployment configured. */
export function verifySubscription(query: URLSearchParams, config: WhatsAppConfig): string | null {
  if (query.get("hub.mode") !== "subscribe") return null;
  const token = query.get("hub.verify_token") ?? "";
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(config.verifyToken, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return query.get("hub.challenge") ?? null;
}

export interface InboundWhatsAppMessage {
  /** The customer's WhatsApp number (E.164, no plus). Thread key. */
  from: string;
  text: string;
  /** WhatsApp's own message id — for idempotency upstream. */
  id: string;
  timestamp?: number;
}

/** Stable thread key per customer: same number → same thread, so chat
 * history and per-customer context survive across messages. The prefix
 * keeps WhatsApp threads separate from any local thread id space. */
export function customerThreadKey(from: string): string {
  return `wa:${from.replace(/[^0-9A-Za-z]/g, "")}`;
}

/** Extract the first customer text message from a webhook payload. Meta
 * batches: entry[].changes[].value.messages[]. Non-text and echo messages
 * (statuses) are ignored. Zod parses the envelope at the boundary — a
 * malformed payload yields no messages instead of an exception. */
const messageSchema = z.object({
  from: z.string(),
  id: z.string(),
  text: z.object({ body: z.string() }).optional(),
  timestamp: z.string().optional(),
});

const envelopeSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z
                .object({
                  messages: z.array(messageSchema).optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/** Extract customer text messages from the RAW webhook body. The string is
 * the I/O boundary: JSON.parse + Zod both happen here, and a malformed
 * payload yields no messages instead of an exception. */
export function parseInboundMessages(rawBody: string): InboundWhatsAppMessage[] {
  const fallbackParse = () => {
    try {
      // SAFETY: JSON.parse returns any by contract; the Zod envelope schema
      // below is the actual validation step, so this cast adds no risk.
      return JSON.parse(rawBody) as ReturnType<typeof JSON.parse>;
    } catch {
      return null;
    }
  };
  const parsed = envelopeSchema.safeParse(fallbackParse());
  if (!parsed.success) return [];
  const out: InboundWhatsAppMessage[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        const text = message.text?.body?.trim() ?? "";
        if (!message.from || !message.id || !text) continue;
        out.push({
          from: message.from,
          id: message.id,
          text,
          timestamp: message.timestamp ? Number(message.timestamp) || undefined : undefined,
        });
      }
    }
  }
  return out;
}

/** Send one WhatsApp text reply. Host is pinned to Meta's Graph API — the
 * phone number only ever appears in the path/body, never in a URL the
 * caller controls. Returns true on 2xx. */
export async function sendWhatsAppText(
  config: WhatsAppConfig,
  to: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = `https://${GRAPH_API_HOST}/${GRAPH_API_VERSION}/${encodeURIComponent(config.phoneNumberId)}/messages`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text.slice(0, 4_096) },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
