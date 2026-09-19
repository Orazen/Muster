// Provider error envelopes should read like a sentence, not a wire dump.
//
// When an engine's provider rejects a turn, some CLIs echo the provider's
// JSON envelope verbatim as the assistant message — the user sees
// `Error: 402 {"detail":...,"requestId":...}` as a chat bubble. The fact
// belongs in the conversation (routing visibility), but the *shape* should
// be human: the detail sentence, with the envelope machinery stripped.
//
// The detector is deliberately conservative: the whole message must be the
// envelope (an optional `Error:` prefix and status code allowed), and it
// must carry envelope-shaped keys — a model legitimately replying with JSON
// is never rewritten. `null` means "not a provider error, render as-is".
//
// Display-only: CopyButton keeps relaying the raw bytes, so the evidence
// chain stays intact.
import { z } from "zod";

interface ProviderEnvelope {
  detail?: string;
  message?: string;
  title?: string;
  status?: number;
  error?: ProviderEnvelope;
}

const envelopeSchema: z.ZodType<ProviderEnvelope> = z
  .object({
    detail: z.string().optional(),
    message: z.string().optional(),
    title: z.string().optional(),
    status: z.number().optional(),
    error: z.lazy(() => envelopeSchema).optional(),
  })
  .passthrough();

const zodView = (v: ProviderEnvelope) => ({
  status: v.status,
  detail: (v.detail ?? v.message ?? "").replace(/\s+/g, " ").trim(),
  title: v.title,
});

export type ProviderErrorView = ReturnType<typeof zodView>;

function statusCopy(status: number | undefined): string {
  switch (status) {
    case 401:
      return "The engine's provider rejected the credentials for this turn. Re-authenticate the engine, then try again.";
    case 402:
      return "The engine's provider account needs an active subscription before it can run turns.";
    case 403:
      return "The engine's provider refused this turn for this account.";
    case 404:
      return "The provider could not find the requested model or resource for this turn.";
    case 429:
      return "The provider is rate-limiting this engine's account. Try again shortly.";
    default:
      if (status !== undefined && status >= 500) return "The provider had a server problem during this turn. Trying again may help.";
      return status !== undefined
        ? `The provider reported a problem with this turn (HTTP ${status}).`
        : "The provider reported a problem with this turn.";
  }
}

/** Human text for a provider-error bubble: the provider's own detail
 * sentence when it has one, otherwise a status-appropriate explanation,
 * with the envelope's title kept as last-resort context. */
export function describeProviderError(view: ProviderErrorView): string {
  const detail = view.detail.trim();
  if (detail) return detail;
  if (!view.status && view.title?.trim()) return `The provider reported a problem with this turn (${view.title.trim()}).`;
  return statusCopy(view.status);
}

/** Recognize a provider-error envelope echoed as a whole message. */
export function providerErrorView(raw: string): ProviderErrorView | null {
  let candidate = raw.trim();
  if (!candidate || candidate.length > 2000) return null;
  const prefixed = /^error\s*:\s*/i.exec(candidate);
  if (prefixed) candidate = candidate.slice(prefixed[0].length).trim();
  const leadingStatus = /^\d{3}\s+/.exec(candidate);
  if (leadingStatus) candidate = candidate.slice(leadingStatus[0].length).trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;

  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return null;
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) return null;
  // Providers nest the sentence either at the top level or inside `error`;
  // read both and let the top level win.
  const top = zodView(parsed.data);
  const inner = parsed.data.error ? zodView(parsed.data.error) : null;
  const status = top.status ?? inner?.status;
  const detail = top.detail || inner?.detail || "";
  const title = top.title ?? inner?.title;

  // Must actually look like an error envelope, not any JSON object the
  // model echoed on purpose.
  const looksEnvelope = "error" in parsed.data || ["detail", "message", "title", "status", "type"].some((k) => k in parsed.data);
  if (!looksEnvelope || (status === undefined && !detail && !title?.trim())) return null;

  return { status, detail, title };
}
