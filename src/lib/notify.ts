// Desktop notifications, driven by the harness's {kind:"notify"} frames.
// The server decides *whether* something is worth an interruption (it owns
// the per-bot toggle); this only decides how to show it here.
import type { Notification } from "../../server/notify.ts";

export type NotifyFrame = Notification;

/** Ask while handling the settings click. Browsers may reject permission
 * requests that are triggered later by an incoming SSE frame. */
export function requestNotificationPermission(): Promise<NotificationPermission> | null {
  if (!("Notification" in globalThis) || Notification.permission !== "default") return null;
  return Notification.requestPermission();
}

/** Show one, unless the app is already in front of the user — a banner over
 * the window you are looking at is noise, and the chat itself already shows
 * the card. */
export function showNotification(frame: NotifyFrame, onOpen: (botId: string) => void) {
  if (!("Notification" in globalThis)) return;
  if (document.hasFocus()) return;

  const open = () => {
    window.focus();
    onOpen(frame.botId);
  };

  if (Notification.permission === "granted") {
    new Notification(frame.title, { body: frame.body, tag: frame.threadId }).onclick = open;
  }
}
