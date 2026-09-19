import { fallbackEligible, markAttempted, pickAlternate, type InstanceSummary } from "./provider-fallback.ts";

export interface FallbackSnapshot {
  ownerId: string;
  threadId: string;
  instanceId: string;
  model: string;
  latestUserId: string;
}
export interface FallbackConsent { enabled: boolean; generation: number }
export interface FallbackCandidate {
  botId: string;
  threadId: string;
  text: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  guard: () => boolean;
}
export interface ProviderFallbackDependencies {
  snapshot(botId: string): FallbackSnapshot | null;
  consent(ownerId: string): FallbackConsent;
  describe(): Promise<InstanceSummary[]>;
  retry(candidate: FallbackCandidate): Promise<void>;
}
export interface FallbackEventIdentity { providerInstanceId?: string; turnId?: string }
interface Ticket extends FallbackSnapshot {
  turnId?: string;
  botId: string;
  text: string;
  progress: boolean;
  completed: boolean;
  error?: { message: string; generation: number };
}

/** One pending retry ticket per bot. Identity, consent and turn changes invalidate
 * asynchronous lookup and dispatch; successful output is never replayed. */
export class ProviderFallbackRunner {
  private readonly tickets = new Map<string, Ticket>();
  private readonly deps: ProviderFallbackDependencies;
  constructor(deps: ProviderFallbackDependencies) { this.deps = deps; }

  begin(input: FallbackSnapshot & { botId: string; text: string }): void {
    this.tickets.set(input.botId, { ...input, progress: false, completed: false });
  }

  cancel(botId: string): void { this.tickets.delete(botId); }

  bindTurn(botId: string, threadId: string, instanceId: string, turnId: string): void {
    const ticket = this.tickets.get(botId);
    if (ticket && !ticket.completed && !ticket.turnId && ticket.threadId === threadId && ticket.instanceId === instanceId && turnId) ticket.turnId = turnId;
  }

  private matches(ticket: Ticket | undefined, threadId: string, event: FallbackEventIdentity): ticket is Ticket {
    return Boolean(ticket && ticket.threadId === threadId && ticket.turnId && event.turnId === ticket.turnId && event.providerInstanceId === ticket.instanceId);
  }

  markProgress(botId: string, threadId: string, event: FallbackEventIdentity): void {
    const ticket = this.tickets.get(botId);
    if (this.matches(ticket, threadId, event)) ticket.progress = true;
  }

  error(botId: string, threadId: string, message: string, event: FallbackEventIdentity): void {
    const ticket = this.tickets.get(botId);
    if (!this.matches(ticket, threadId, event) || ticket.completed || ticket.progress || !ticket.ownerId) return;
    if (!fallbackEligible(threadId, message)) return;
    const consent = this.deps.consent(ticket.ownerId);
    if (consent.enabled && !ticket.error) ticket.error = { message, generation: consent.generation };
  }

  async complete(botId: string, threadId: string, ok: boolean, event: FallbackEventIdentity): Promise<void> {
    const ticket = this.tickets.get(botId);
    if (!this.matches(ticket, threadId, event) || ticket.completed) return;
    ticket.completed = true;
    let target: string | undefined;
    const guard = (): boolean => {
      if (this.tickets.get(botId) !== ticket || ticket.progress || !ticket.error || !ticket.ownerId) return false;
      const consent = this.deps.consent(ticket.ownerId);
      if (!consent.enabled || consent.generation !== ticket.error.generation) return false;
      const current = this.deps.snapshot(botId);
      if (!current || current.ownerId !== ticket.ownerId || current.threadId !== ticket.threadId || current.latestUserId !== ticket.latestUserId) return false;
      return current.instanceId === ticket.instanceId && current.model === ticket.model;
    };
    try {
      if (ok || !guard() || !fallbackEligible(threadId, ticket.error!.message)) return;
      const described = await this.deps.describe();
      if (!guard()) return;
      target = pickAlternate(ticket.instanceId, ticket.ownerId, described) ?? undefined;
      if (!target) return;
      // Claim the cooldown only once a usable target exists and immediately
      // before dispatch; duplicate completion events cannot start another lookup.
      markAttempted(threadId);
      await this.deps.retry({ botId, threadId, text: ticket.text, sourceInstanceId: ticket.instanceId, targetInstanceId: target, guard });
    } finally {
      if (this.tickets.get(botId) === ticket) this.tickets.delete(botId);
    }
  }
}

/** All adapter events are stamped by EventBus. Once a turn selects a provider,
 * events from its failed predecessor cannot settle the replacement. */
export function matchesActiveProvider(event: FallbackEventIdentity, active?: { instanceId: string }): boolean {
  return !active || event.providerInstanceId === active.instanceId;
}
