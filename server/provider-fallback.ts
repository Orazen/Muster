// Cross-provider fallback for turns killed by provider rate limits.
//
// Why. Every "the bot never answered" report traced to the same shape: the
// bot resolves onto its engine fine, tools run, and then the provider
// answers 429 (free-tier cap) AFTER the quick in-driver retries burn out —
// the turn dies with only activity chips in the thread, no words. The
// owner often HAS a second configured provider sitting unused.
//
// What. After a runtime error that confidently names a rate/quota limit,
// the bot is re-pointed at another AVAILABLE instance (owner-scoped when
// the bot has an owner) and the original message re-dispatched once, with
// a visible activity note explaining the switch.
//
// Guardrails: one attempt per thread per cooldown window — a dead provider
// must cause one hop, not a bounce storm between two failing engines.

/** Errors that confidently mean "this provider can't serve right now" —
 * matched against driver messages like `OpenCode Zen (API) HTTP 429: …`. */
const RATE_LIMITED = /\b429\b|\brate.?limit|\bquota\b|\bcredit\b|\bbalance\b|insufficient/i;

const COOLDOWN_MS = 10 * 60_000;
const attempted = new Map<string, number>();

/** Rate-limit observability for the usage dashboard: every detected
 * provider cap records the provider family + when, bounded like the
 * attempt map. The dashboard reads this to show "your Claude quota is
 * getting hot" without scraping provider APIs. */
export interface RateLimitHit {
  provider: string;
  at: number;
}
const rateLimitHits: RateLimitHit[] = [];
const RATE_LIMIT_HISTORY_MAX = 200;

export function recordRateLimitHit(providerFamily: string, at = Date.now()): void {
  rateLimitHits.push({ provider: providerFamily, at });
  if (rateLimitHits.length > RATE_LIMIT_HISTORY_MAX) rateLimitHits.shift();
}

/** Hits in the trailing window (default 24h), oldest last. */
export function recentRateLimitHits(windowMs = 24 * 60 * 60_000, now = Date.now()): RateLimitHit[] {
  return rateLimitHits.filter((h) => now - h.at < windowMs);
}

/** "claude", "codex", "openai" — the first label segment of an instance id
 * (owner-scoped ids carry `:<ownerId>` after the family). */
export function providerFamilyOf(instanceId: string): string {
  return instanceId.split(":")[0]?.split("-")[0] ?? instanceId;
}

export function fallbackEligible(threadId: string, errorMessage: string, now = Date.now()): boolean {
  if (!RATE_LIMITED.test(errorMessage)) return false;
  const last = attempted.get(threadId);
  return !last || now - last >= COOLDOWN_MS;
}

export function markAttempted(threadId: string, now = Date.now()): void {
  attempted.set(threadId, now);
  if (attempted.size > 512) {
    // bounded memory on a long-lived process; oldest entries first
    for (const [k, t] of attempted) {
      if (now - t >= COOLDOWN_MS) attempted.delete(k);
      if (attempted.size <= 256) break;
    }
  }
}

export interface InstanceSummary {
  instanceId: string;
  state: string;
}

/** Pick another instance for this bot. Owner-scoped ids end in `:<ownerId>`;
 * operator-global ids carry no colon. Prefers a DIFFERENT provider family
 * than the one that just failed (same family likely shares the same cap). */
export function pickAlternate(
  currentInstanceId: string,
  ownerId: string | null | undefined,
  described: InstanceSummary[],
): string | null {
  const ownable = ownerId ? `:${ownerId}` : null;
  const candidates = described.filter((d) => {
    if (d.state !== "available" || d.instanceId === currentInstanceId) return false;
    const scoped = d.instanceId.includes(":");
    if (ownable) return scoped && d.instanceId.endsWith(ownable);
    return !scoped; // ownerless bots ride operator-global instances only
  });
  const failedBase = currentInstanceId.split(":")[0];
  return (
    candidates.find((d) => d.instanceId.split(":")[0] !== failedBase) ?? candidates[0]
  )?.instanceId ?? null;
}
