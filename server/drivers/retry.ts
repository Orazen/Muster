// Shared retry policy for driver turns — v2 plan item 3.4
// (docs/plans/agent-harness-upgrades-v2.md). The peripheral systems (box,
// webhooks, ACP) have had bounded retries all along; this gives the main
// conversation path the same resilience without inventing per-driver copies.
//
// Policy: only a CONFIDENT transient match retries. Anything ambiguous is
// terminal — a turn that fails once with an unclassifiable error must not
// silently spin, and auth/quota/model failures must reach the user fast.

/** How many times a failed attempt may be retried (so 2 → up to 3 tries). */
export const MAX_RETRIES = 2;

const DEFAULT_BASE_DELAY_MS = 1_500;
const MAX_DELAY_MS = 10_000;
const JITTER_MS = 400;

/** Tests shrink the base so a retry path runs in milliseconds; production
 * reads nothing and gets the default. */
function configuredBaseDelayMs(): number {
  const raw = Number(process.env.MUSTER_RETRY_BASE_MS);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_BASE_DELAY_MS;
}

/** Patterns that confidently identify a transient upstream failure: rate
 * limits, capacity (529 "overloaded"), gateway/5xx blips, and dropped
 * connections. Matched case-insensitively against stderr / error text. */
const TRANSIENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\b429\b/,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b529\b/,
  /\boverloaded\b/i,
  /\brate.?limit/i,
  /\btoo many requests\b/i,
  /\bservice unavailable\b/i,
  /\bbad gateway\b/i,
  /\binternal server error\b/i,
  /\bserver_error\b/i,
  /\beconnreset\b/i,
  /\beconnrefused\b/i,
  /\betimedout\b/i,
  /\btimed out\b/i,
  /\beai_again\b/i,
  /\bsocket hang up\b/i,
  /\bconnection (reset|refused|closed|terminated)\b/i,
  /\bnetwork (error|timeout|unavailable)\b/i,
  /\bfetch failed\b/i,
];

export interface TransientFailure {
  /** The matched pattern's short label, for the turn.retrying reason. */
  reason: string;
}

/** Classify one failure message. Returns why it is transient, or null when
 * the failure does not confidently match a transient pattern (terminal). */
export function transientReason(message: string): TransientFailure | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(trimmed)) {
      const label = trimmed.slice(0, 120);
      return { reason: label };
    }
  }
  return null;
}

/** Exponential backoff with jitter: 1.5s → 3s → capped at 10s, plus 0–400ms.
 * `attempt` is the 1-based number of the attempt that just failed. */
export function retryDelayMs(attempt: number): number {
  const exponential = Math.min(configuredBaseDelayMs() * 2 ** (attempt - 1), MAX_DELAY_MS);
  return exponential + Math.floor(Math.random() * JITTER_MS);
}

/** A sleep that can be cut short — the interrupt path resolves it early so a
 * user stopping the bot never waits out a backoff before the turn settles. */
export interface CancellableSleep {
  promise: Promise<void>;
  cancel: () => void;
}

export function cancellableSleep(ms: number): CancellableSleep {
  let cancel: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, cancel };
}

/** Sleep cut short by an AbortSignal — for drivers that already own one
 * (API-backed turns), so interrupting during a backoff settles at once. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
