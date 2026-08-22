// Desktop notifications, driven by the harness's {kind:"notify"} frames.
// The server decides *whether* something is worth an interruption (it owns
// the per-bot toggle); this only decides how to show it here.
import type { Notification } from "../../server/notify.ts";

export type NotifyFrame = Notification;

/** In-app banner subscribers (NotificationStack). Each frame is offered to
 * both channels exactly once: the desktop channel shows only when the window
 * is backgrounded and permission is granted, so the in-app card covers every
 * case the desktop one does not — including permission denied, where frames
 * previously vanished entirely. */
type FrameListener = (frame: NotifyFrame, desktopShown: boolean) => void;
const listeners = new Set<FrameListener>();

export function onNotifyFrame(listener: FrameListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

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
  const focused = document.hasFocus();
  const granted = "Notification" in globalThis && Notification.permission === "granted";
  const desktopShown = !focused && granted;
  for (const listener of listeners) listener(frame, desktopShown);
  if (!("Notification" in globalThis)) return;
  if (focused) return;

  const open = () => {
    window.focus();
    onOpen(frame.botId);
  };

  if (Notification.permission === "granted") {
    new Notification(frame.title, { body: frame.body, tag: frame.threadId }).onclick = open;
  }
}
