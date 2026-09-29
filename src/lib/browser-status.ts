// What the Web browser card is allowed to say about ONE bot.
//
// `/api/browser-status` reports two different things and conflating them is
// the bug this exists to prevent:
//
//   - `available` is whether the Obscura BINARY is on this machine. It is a
//     property of the server's filesystem, not of any bot.
//   - `effective` is whether THIS bot's engine can actually mount the browser.
//     It needs the toggle on, the binary present, AND the bot's driver to
//     declare `customMcp` — which only some of them do.
//
// A bot whose engine cannot mount the browser was reading "This bot gets 14
// browser tools on its next task" while every one of its turns silently ran
// with none, because the card only ever looked at `available` and its own
// toggle. The server started telling the truth per bot; this is the part that
// decides what the card says about it.
//
// The decision and request lifetime are tested without a mounted UI.

import { z } from "zod";

const browserStatusEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  engineId: z.string().nullable(),
  engineSupportsBrowser: z.boolean(),
  effective: z.boolean(),
  reason: z.string().nullable(),
});
const browserStatusSchema = z.object({
  available: z.boolean(),
  command: z.string().nullable(),
  tools: z.number().int().nonnegative(),
  // Older servers only report the machine envelope. It remains valid, but
  // cannot authorize a claim about a particular bot's tools.
  status: z.array(browserStatusEntrySchema).optional(),
  blockedCount: z.number().int().nonnegative().optional(),
});
export type BrowserStatusEntry = z.infer<typeof browserStatusEntrySchema>;
export type BrowserStatus = z.infer<typeof browserStatusSchema>;

export type BrowserCardVerdict =
  /** The binary is missing; offer the install path. */
  | { kind: "not-installed" }
  /** The card has not loaded status yet, or has no row for this bot. Say
   *  nothing the server has not confirmed. */
  | { kind: "unknown" }
  /** Toggle off: nothing is being claimed, so nothing needs correcting. */
  | { kind: "off" }
  /** Toggle on and the engine can mount it. The truthful good case. */
  | { kind: "ready"; tools: number }
  /** Toggle on, binary present, engine cannot mount a browser. The toggle is
   *  a claim the product cannot honour, and the user is the one who has to
   *  change something, so the copy names the engine. */
  | { kind: "engine-unsupported"; engineId: string | null }
  /** Toggle on and the binary vanished between the two checks. */
  | { kind: "blocked-missing-binary" };

/**
 * The card's verdict for one bot.
 *
 * `unknown` is deliberately the fallback rather than an optimistic default. An
 * older server that does not send `status` at all, or a request that failed,
 * must not produce a confident claim about browser tools — that is the exact
 * failure this file was written to remove.
 */
export function browserCardVerdict(
  status: BrowserStatus | null,
  botId: string,
  enabled: boolean,
  engineId?: string | null,
): BrowserCardVerdict {
  const parsed = browserStatusSchema.safeParse(status);
  if (!parsed.success) return { kind: "unknown" };
  const confirmed = parsed.data;
  if (!confirmed.available) return { kind: "not-installed" };
  const entry = confirmed.status?.find((row) => row.id === botId);
  if (!entry) return { kind: "unknown" };
  if (!enabled) return { kind: "off" };
  // Settings are optimistic until the bot's server frame arrives. An older
  // row must not describe the newly selected toggle or engine.
  if (entry.enabled !== enabled || (engineId && entry.engineId !== engineId)) return { kind: "unknown" };
  if (entry.effective && entry.engineSupportsBrowser) return { kind: "ready", tools: confirmed.tools };
  if (entry.reason === "not-installed") return { kind: "blocked-missing-binary" };
  if (entry.reason === "engine-unsupported" && !entry.engineSupportsBrowser) {
    return { kind: "engine-unsupported", engineId: entry.engineId };
  }
  return { kind: "unknown" };
}

/** One effect-owned read. Closing or changing the card invalidates its result,
 * even when a transport ignores AbortSignal or rejects after a newer request. */
export function refreshBrowserStatus(
  request: (signal: AbortSignal) => Promise<BrowserStatus>,
  publish: (status: BrowserStatus | null) => void,
): () => void {
  const controller = new AbortController();
  publish(null);
  void Promise.resolve().then(() => {
    if (controller.signal.aborted) return null;
    return request(controller.signal);
  }).then((reply) => {
    if (controller.signal.aborted) return;
    const parsed = browserStatusSchema.safeParse(reply);
    publish(parsed.success ? parsed.data : null);
  }).catch(() => {
    if (!controller.signal.aborted) publish(null);
  });
  return () => controller.abort();
}

/**
 * How many enabled bots the toggle is claiming and the engine cannot honour.
 * Shown above everything else on the card because it is the number a user
 * needs: one bot on an unsupported engine is a per-bot mistake, four is a
 * fleet-wide misconfiguration. Zero renders nothing.
 */
export function browserBlockedCount(status: BrowserStatus | null): number {
  const parsed = browserStatusSchema.safeParse(status);
  return parsed.success ? parsed.data.blockedCount ?? 0 : 0;
}
