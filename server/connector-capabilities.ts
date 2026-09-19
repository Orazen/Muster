import { PeerCapabilities, type PeerLease } from "./peer-capabilities.ts";

/** Installation-wide accounts belong to the primary owner on hosted servers.
 * Legacy ownerless bots inherit that owner only after it is known. */
export function installationAppsAllowed(
  hosted: boolean,
  primaryUserId: string | null | undefined,
  ownerId: string | null | undefined,
): boolean {
  return !hosted || Boolean(primaryUserId && (ownerId || primaryUserId) === primaryUserId);
}

export type ConnectorLease = PeerLease;
export interface ConnectorGrant { lease: ConnectorLease; token: string }

/** Dispatch-scoped app access. This registry is deliberately separate from peer
 * delegation: neither capability can be redeemed at the other's boundary. */
export class ConnectorCapabilities {
  private readonly registry: PeerCapabilities;

  constructor(now = Date.now, ttlMs = 24 * 60 * 60_000) {
    this.registry = new PeerCapabilities(now, ttlMs);
  }

  issue(context: { botId: string; threadId: string; ownerId: string }, instanceId: string): ConnectorGrant {
    const lease = this.registry.begin({ ...context, taskId: context.threadId, depth: 0 });
    const token = this.registry.activate(lease, instanceId, true);
    if (!token) throw new Error("connector dispatch could not be activated");
    return { lease, token };
  }

  current(lease: ConnectorLease): boolean { return this.registry.current(lease); }
  resolve(header: string | string[] | undefined): ConnectorLease | undefined { return this.registry.resolve(header); }
  bindTurn(lease: ConnectorLease, instanceId: string, turnId: string | undefined): void { this.registry.bindTurn(lease, instanceId, turnId); }
  revoke(lease: ConnectorLease): void { this.registry.revoke(lease); }
  revokeBot(botId: string): void { this.registry.revokeBot(botId); }
  revokeThread(threadId: string, turnId?: string): void { this.registry.revokeThread(threadId, turnId); }
  clear(): void { this.registry.clear(); }
  onEvent(event: { type: string; threadId: string; providerInstanceId?: string; turnId?: string }): ConnectorLease | undefined {
    return this.registry.onEvent(event);
  }
}
