// free-best preference profile: a pure module behind the "free-best"
// pseudo-model idea popularized by free-router.
//
// Why. Owners on free tiers spread across many provider instances hit one
// cap and watch the bot die, while three other free instances sit idle.
// free-best collapses that choice into one endpoint-shaped decision: rank
// the candidate instances by cost tier and health, then prefer the head of
// that chain.
//
// What. Pure ranking + bookkeeping only — no I/O, no dispatch. Callers hand
// us instance summaries; we return the winner (pickFreeBest), record a
// failure with a cooldown (recordFreeBestFailure), and render the ordered
// chain for the UI and docs ("free-best tries: X → Y → Z").
//
// Guardrails: metered access ranks last (spending money is the last resort),
// recently-failed instances sit out a cooldown window, and the failures map
// stays bounded on a long-lived process.

/** One candidate provider instance the free-best profile may prefer. */
export interface FreeCandidate {
  instanceId: string;
  /** free rides owner-provided free keys; metered bills a real balance. */
  access: "subscription" | "metered" | "free";
  /** Live fleet state, e.g. "available" | "unavailable". */
  state: string;
  /** Epoch ms of the last known failure, if any. null/undefined = healthy. */
  lastFailureAt?: number | null;
  /** How many models the instance exposes — a crude breadth signal. */
  models: number;
}

export const FREE_BEST_COOLDOWN_MS = 10 * 60_000;
const FAILURES_MAX = 256;

/** Cost tier: lower is preferred. Free > subscription > metered. */
function accessRank(access: FreeCandidate["access"]): number {
  if (access === "free") return 0;
  if (access === "subscription") return 1;
  return 2; // metered
}

/** True while a candidate is serving out its post-failure cooldown. */
function inCooldown(lastFailureAt: number | null | undefined, now: number, cooldownMs: number): boolean {
  if (lastFailureAt === null || lastFailureAt === undefined) return false;
  return now - lastFailureAt < cooldownMs;
}

/** Prefer most models; ties broken by least-recent failure (never-failing
 * instances win outright over anyone who tripped recently). */
function compareCandidates(a: FreeCandidate, b: FreeCandidate): number {
  const tier = accessRank(a.access) - accessRank(b.access);
  if (tier !== 0) return tier;
  if (a.models !== b.models) return b.models - a.models;
  const aFail = a.lastFailureAt ?? 0;
  const bFail = b.lastFailureAt ?? 0;
  return aFail - bFail;
}

/** Filter + rank survivors exactly as pickFreeBest does, in preference
 * order. Shared by pickFreeBest and describeFreeBestChain so the UI chain
 * can never disagree with the actual pick. */
function rankedSurvivors(candidates: FreeCandidate[], now: number, cooldownMs: number): FreeCandidate[] {
  return candidates
    .filter((c) => {
      if (c.state !== "available") return false;
      return !inCooldown(c.lastFailureAt, now, cooldownMs);
    })
    .sort(compareCandidates);
}

/** The head of the free-best chain, or null when nothing qualifies. */
export function pickFreeBest(
  candidates: FreeCandidate[],
  opts?: { now?: number; cooldownMs?: number },
): FreeCandidate | null {
  const now = opts?.now ?? Date.now();
  const cooldownMs = opts?.cooldownMs ?? FREE_BEST_COOLDOWN_MS;
  return rankedSurvivors(candidates, now, cooldownMs)[0] ?? null;
}

/** Record a failure for an instance into a caller-owned bounded map. Bounded
 * to 256 entries: expired cooldowns evicted first, then oldest entries — a
 * long-lived process must not grow this forever. */
export function recordFreeBestFailure(
  instanceId: string,
  failures: Map<string, number>,
  now: number = Date.now(),
): void {
  failures.set(instanceId, now);
  if (failures.size <= FAILURES_MAX) return;
  for (const [id, at] of failures) {
    if (now - at >= FREE_BEST_COOLDOWN_MS) failures.delete(id);
    if (failures.size <= FAILURES_MAX) break;
  }
  while (failures.size > FAILURES_MAX) {
    const oldest = [...failures.entries()].sort((a, b) => a[1] - b[1])[0];
    if (!oldest) break; // SAFETY: map is non-empty when size > 0
    failures.delete(oldest[0]);
  }
}

/** The ordered preference list for UI/docs: "free-best tries: X → Y → Z".
 * Same eligibility and ranking as pickFreeBest, so the displayed chain is
 * the chain actually walked. */
export function describeFreeBestChain(
  candidates: FreeCandidate[],
  opts?: { now?: number; cooldownMs?: number },
): string[] {
  const now = opts?.now ?? Date.now();
  const cooldownMs = opts?.cooldownMs ?? FREE_BEST_COOLDOWN_MS;
  return rankedSurvivors(candidates, now, cooldownMs).map((c) => c.instanceId);
}
