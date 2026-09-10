interface RouteBot {
  id: string;
  hidden?: boolean;
}

export type BotChatHandoff =
  | { kind: "none" | "wait" }
  | { kind: "consume"; selectedId: string | null; search: string };

/** Carry the target across the OS and chat's separate store mounts. */
export function botChatRoute(botId: string, search = ""): string {
  const params = new URLSearchParams(search);
  params.set("bot", botId);
  return `/app?${params.toString()}`;
}

/** The roster must come from the current account's keyed StoreProvider.
 * Public bot records omit ownerId: membership in that server-filtered roster
 * is the authority. A URL alone never authorizes or creates a selection. */
export function resolveBotChatHandoff(
  search: string,
  accountId: string | undefined,
  rosterHydrated: boolean,
  bots: readonly RouteBot[],
): BotChatHandoff {
  const params = new URLSearchParams(search);
  const targets = params.getAll("bot");
  if (targets.length === 0) return { kind: "none" };
  if (!accountId || !rosterHydrated) return { kind: "wait" };
  const target = targets.length === 1 ? targets[0] : "";
  const selectedId = target && bots.some((bot) => bot.id === target && !bot.hidden) ? target : null;
  params.delete("bot");
  const remaining = params.toString();
  return { kind: "consume", selectedId, search: remaining ? `?${remaining}` : "" };
}
