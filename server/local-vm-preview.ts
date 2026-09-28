import { SHARED_LOCAL_VM_TARGET, type LocalVmTarget } from "./container-computer.ts";
import type { BotRecord } from "./store.ts";

type PreviewBot = Pick<BotRecord, "id" | "ownerId" | "hidden">;

export interface LocalVmPreviewContext {
  bot(id: string): PreviewBot | null | undefined;
  ownsRecord(bot: PreviewBot): boolean;
  /** The dispatcher's resolver also registers the target for idle cleanup. */
  desktopTargetForBot(id: string): LocalVmTarget;
}

/** Settings retains its shared setup target. A bot's Computer panel must
 * resolve the same target as its turns, but only after validating the bot:
 * query parameters do not pass through the /api/bots/:id ownership guard. */
export function localVmPreviewTarget(botId: string | null, context: LocalVmPreviewContext): LocalVmTarget | null {
  if (botId === null) return SHARED_LOCAL_VM_TARGET;
  const bot = botId ? context.bot(botId) : undefined;
  if (!bot || bot.hidden || !context.ownsRecord(bot)) return null;
  return context.desktopTargetForBot(bot.id);
}
