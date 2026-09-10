import { z } from "zod";

export interface SelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface SelectionTarget {
  id: string;
}

interface SelectableBot extends SelectionTarget {
  hidden?: boolean;
}

const savedSelectionSchema = z.object({ version: z.literal(1), selectedId: z.string().min(1).max(256) });

function selectionStorage(): SelectionStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    // Storage may be blocked by the browser or absent during server rendering.
    return null;
  }
}

function selectionKey(accountId: string): string {
  return `muster:selected-chat:v1:${encodeURIComponent(accountId)}`;
}

export function readChatSelection(accountId: string, storage = selectionStorage()): string {
  if (!accountId || !storage) return "";
  try {
    const saved = storage.getItem(selectionKey(accountId));
    if (!saved) return "";
    const parsed = savedSelectionSchema.safeParse(JSON.parse(saved));
    return parsed.success ? parsed.data.selectedId : "";
  } catch {
    return "";
  }
}

export function saveChatSelection(accountId: string, selectedId: string, storage = selectionStorage()): void {
  if (!accountId || !storage) return;
  try {
    const key = selectionKey(accountId);
    if (selectedId) storage.setItem(key, JSON.stringify({ version: 1, selectedId }));
    else storage.removeItem(key);
  } catch {
    // Selection still works in memory when storage is unavailable or full.
  }
}

export function resolveChatSelection(selectedId: string, bots: SelectableBot[], groups: SelectionTarget[]): string {
  if (bots.some((bot) => bot.id === selectedId && !bot.hidden) || groups.some((group) => group.id === selectedId)) {
    return selectedId;
  }
  return bots.find((bot) => !bot.hidden)?.id ?? groups[0]?.id ?? "";
}
