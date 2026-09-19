export interface ConnectorStatus {
  connected: boolean;
  pending?: boolean;
  status?: string;
}

export function mergeCurrentConnectorStatus(
  current: Record<string, ConnectorStatus>,
  incoming: Record<string, ConnectorStatus>,
  latestGenerations: ReadonlyMap<string, number>,
  requestGenerations: ReadonlyMap<string, number>,
) {
  const next = { ...current };
  for (const [slug, state] of Object.entries(incoming)) {
    if ((latestGenerations.get(slug) ?? 0) !== (requestGenerations.get(slug) ?? 0)) continue;
    next[slug] = state;
  }
  return next;
}
