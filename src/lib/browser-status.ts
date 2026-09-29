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
// Pure and dependency-free so it can be tested directly, which is how the rest
// of `src/` keeps its UI logic honest.

/** One bot's row from the server's `status` array. */
export interface BrowserStatusEntry {
  id: string;
  name: string;
  enabled: boolean;
  engineId: string | null;
  engineSupportsBrowser: boolean;
  effective: boolean;
  /** "off" | "not-installed" | "engine-unsupported" | null */
  reason: string | null;
}

export interface BrowserStatus {
  available: boolean;
  command: string | null;
  tools: number;
  status: BrowserStatusEntry[];
  blockedCount: number;
}

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
): BrowserCardVerdict {
  if (status === null) return { kind: "unknown" };
  if (!status.available) return { kind: "not-installed" };
  const entry = status.status.find((row) => row.id === botId);
  // A server that sent the envelope without this bot's row has not told us
  // anything about this bot. Say nothing rather than assume.
  if (entry === undefined) return { kind: "unknown" };
  if (!enabled) return { kind: "off" };
  if (entry.effective) return { kind: "ready", tools: status.tools };
  if (entry.reason === "not-installed") return { kind: "blocked-missing-binary" };
  return { kind: "engine-unsupported", engineId: entry.engineId };
}

/**
 * How many enabled bots the toggle is claiming and the engine cannot honour.
 * Shown above everything else on the card because it is the number a user
 * needs: one bot on an unsupported engine is a per-bot mistake, four is a
 * fleet-wide misconfiguration. Zero renders nothing.
 */
export function browserBlockedCount(status: BrowserStatus | null): number {
  if (status === null) return 0;
  return status.blockedCount;
}
