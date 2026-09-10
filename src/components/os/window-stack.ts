export type WindowTarget = { kind: "agent"; botId: string } | { kind: "app"; appId: string };

export interface OpenWindow {
  id: string;
  target: WindowTarget;
  minimized: boolean;
  cascade: number;
}

export const windowId = (target: WindowTarget) => target.kind === "agent"
  ? `window-agent-${target.botId}` : `window-app-${target.appId}`;

/** Resolve against the latest stack, including successive clicks in one render. */
export function revealWindow(current: OpenWindow[], target: WindowTarget, mode: "show" | "dock" = "show"): OpenWindow[] {
  const id = windowId(target);
  const existing = current.find((item) => item.id === id);
  const focused = [...current].reverse().find((item) => !item.minimized);
  if (mode === "dock" && existing && !existing.minimized && focused?.id === id) {
    return current.map((item) => item.id === id ? { ...item, minimized: true } : item);
  }
  const window = existing ? { ...existing, minimized: false } : {
    id, target, minimized: false, cascade: current.length % 6,
  };
  return [...current.filter((item) => item.id !== id), window];
}
