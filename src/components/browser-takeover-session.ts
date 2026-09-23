// The takeover console's request/state loop — the client half of the
// browser takeover round-trip. Adapted from OpenMuse
// (github.com/CopilotKit/OpenMuse), MIT License, Copyright (c) 2026
// OpenMuse contributors: the console interaction model (click-to-select,
// type-into-field, key chips, scroll), the fixed 1280×800 click-coordinate
// mapping, and the retained-draft rule — an unsent text survives errors
// and is cleared only when a send of the SAME text succeeded.
//
// Nothing here issues requests on its own: the panel's existing preview
// poll owns frames and renews the signed link, and this session only runs
// while the console (opened by an explicit Take control click) posts an
// action. The takeover routes themselves are inert unless the deployment
// enables MUSTER_BROWSER_TAKEOVER.
import type { BrowserPreviewState } from "./browser-preview-session";

export type BrowserTakeoverStatus = "connecting" | "live" | "updating" | "disconnected";

export type BrowserTakeoverAction =
  | { type: "click"; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; key: "Enter" | "Tab" | "Backspace" }
  | { type: "scroll"; deltaY: number };

export type BrowserTakeoverSnapshot = {
  status: BrowserTakeoverStatus;
  error: string | null;
  text: string;
  busy: boolean;
};

export const emptyBrowserTakeover = (): BrowserTakeoverSnapshot => ({
  status: "connecting", error: null, text: "", busy: false,
});

/** The screencast frames are captured at a fixed 1280×800 viewport, so a
 * click on the rendered image maps back into those coordinates. */
export const TAKEOVER_VIEWPORT = { width: 1280, height: 800 } as const;

export type TakeoverRect = { left: number; top: number; width: number; height: number };

/** Map a click on the screenshot back to the fixed viewport — the console's
 * click-to-select math (formula adapted from OpenMuse's browser console;
 * see the file header). Clamped, never negative, never past the edge. */
export function mapTakeoverClick(
  point: { clientX: number; clientY: number },
  rect: TakeoverRect,
  viewport: { width: number; height: number } = TAKEOVER_VIEWPORT,
) {
  const x = Math.min(viewport.width - 1, Math.max(0, Math.floor(((point.clientX - rect.left) * viewport.width) / rect.width)));
  const y = Math.min(viewport.height - 1, Math.max(0, Math.floor(((point.clientY - rect.top) * viewport.height) / rect.height)));
  return { x, y };
}

/** What a takeover POST answers: the refreshed panel state — the same
 * state the preview poll reads, including any renewed preview link. The
 * shared API client throws the server's error instead of resolving it. */
export type TakeoverReply = BrowserPreviewState;

export type TakeoverRequest = (path: string, init?: RequestInit) => Promise<TakeoverReply>;

/** One mounted console owns these requests, exactly like the preview
 * session: disposing discards late replies, and a busy send blocks
 * duplicates. */
export function createBrowserTakeoverSession(
  botId: string,
  request: TakeoverRequest,
  publish: (snapshot: BrowserTakeoverSnapshot) => void,
) {
  const base = `/api/bots/${encodeURIComponent(botId)}/browser-panel/takeover`;
  let snapshot = emptyBrowserTakeover();
  let disposed = false;

  const update = (patch: Partial<BrowserTakeoverSnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    publish(snapshot);
  };

  return {
    /** Draft text for "type into the selected field" — typed during a
     * flight too, so the user can keep composing while an action runs. */
    setText: (text: string) => {
      if (disposed) return;
      update({ text });
    },
    send: async (action: BrowserTakeoverAction): Promise<void> => {
      if (disposed || snapshot.busy) return;
      if (action.type === "text" && !action.text) return;
      const sent = action.type === "text" ? action.text : null;
      update({ busy: true, error: null, status: "updating" });
      try {
        await request(base, { method: "POST", body: JSON.stringify(action) });
        // Clear the draft only if it still equals what was sent — text
        // typed while the action was in flight stays in the box.
        const next: Partial<BrowserTakeoverSnapshot> = { busy: false, status: "live", error: null };
        if (sent !== null && snapshot.text === sent) next.text = "";
        update(next);
      } catch (error) {
        update({ busy: false, status: "disconnected", error: error instanceof Error ? error.message : String(error) });
      }
    },
    /** Screenshot load/error events drive live vs disconnected status;
     * they never overwrite an in-flight action's state. */
    markFrame: (loaded: boolean) => {
      if (disposed || snapshot.busy) return;
      update({ status: loaded ? "live" : "disconnected" });
    },
    /** Manual refresh: clear the visible error and wait for the next
     * frame, mirroring the console's ↻ control. */
    refresh: () => {
      if (disposed || snapshot.busy) return;
      update({ error: null, status: "connecting" });
    },
    dispose: () => {
      disposed = true;
    },
    snapshot: () => snapshot,
  };
}
