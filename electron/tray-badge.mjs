// Menu-bar status item presentation (tiptour study, slice 5): the pure
// rules that turn the local roster feed (GET /api/bots?messages=0) into the
// pending-approvals badge text, tooltip and context-menu read-out. No
// Electron import and no network here — electron/main.mjs owns the Tray
// object and the poll; this module only says what the badge reads. That
// reads across as intent: presentation only. The badge reports how many
// bots wait on a human; it never answers a card, and every click path opens
// the window where the human decides.
//
// Not ported from anywhere — written against Muster's own feed shape.
// src/lib/mascot/tray-state.ts counts the same fact for the tray window;
// electron/tray-badge.test.mjs pins the two counts together.

/** The roster activity a bot carries while a card or question waits for a
 * human (server/index.ts: request.opened sets it, request.resolved clears
 * it). Same literal the tray window's view model matches on. */
const WAITING = "waiting-on-you";

/** Bots awaiting a human, from the slim roster payload — either the raw
 * `{ bots: [...] }` response or a bare array. Tolerates a malformed or
 * partial feed (a restart can answer mid-parse): anything unreadable counts
 * as 0 rather than throwing inside the tray tick. Hidden bots never count —
 * the same filter the tray window renders with. */
export function countWaitingOnYou(payload) {
  const bots = Array.isArray(payload) ? payload : Array.isArray(payload?.bots) ? payload.bots : [];
  return bots.filter((bot) => bot && !bot.hidden && bot.activity === WAITING).length;
}

/** The macOS badge line beside the icon: "" (no line at all) when nothing
 * waits, capped at 9+ so a pile-up cannot shove the menu bar around.
 * Counts arrive from a feed, so anything non-numeric reads as "nothing". */
export function badgeText(count) {
  // Number.isFinite already rejects non-numbers — it never coerces.
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > 9 ? "9+" : String(Math.floor(count));
}

/** Hover text — the count in words, or just the app when the fleet is
 * quiet. */
export function trayTooltip(count) {
  return count > 0 ? `Muster — ${count} waiting on you` : "Muster";
}

/** The context menu's read-out row: a disabled line, never an action —
 * approving, declining and dismissing all stay on the card itself. */
export function pendingMenuLabel(count) {
  return count > 0 ? `${count} waiting on you` : "Nothing waiting on you";
}
