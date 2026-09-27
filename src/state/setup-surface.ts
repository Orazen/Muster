/** Exactly one owner for the first-run slot. A saved account completion is
 * authoritative; empty rosters and browser-global legacy flags cannot reopen
 * another interview. Required connection repair remains reachable separately. */
export function setupSurface({ready, gateDecision, firstRun, storage, connectionReturn}: {
  ready: boolean;
  gateDecision: "pending" | "show" | "hide";
  firstRun: boolean;
  connectionReturn?: boolean;
  storage?: {required: boolean; satisfied: boolean};
}): "pending" | "wizard" | "connection-notice" | "workspace" {
  if (!ready || gateDecision === "pending") return "pending";
  const needsStorage = storage?.required === true && storage.satisfied === false;
  if (firstRun && (gateDecision === "show" || needsStorage || connectionReturn)) return "wizard";
  return needsStorage ? "connection-notice" : "workspace";
}
