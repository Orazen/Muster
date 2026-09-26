// The agent's own headless browser is invisible to the human; this module
// carries the panel's mirror of it. Keep the reply decoders as strict as
// the fetch layer that owns error surfacing.
import { z } from "zod";

export type BrowserPreviewState = {
  running: boolean;
  url: string | null;
  title: string | null;
  profile: "bot" | "guest";
  error: string | null;
  /** Server gate: true only when MUSTER_BROWSER_TAKEOVER is enabled.
   * Absent/undefined keeps every takeover affordance off. */
  takeoverEnabled?: boolean;
  /** Short-lived signed screenshot link for the takeover console. */
  previewLink?: string | null;
};

export type BrowserPreviewAction = "start" | "stop" | "navigate" | "profile";
/** Where the agent's own headless browser last went, per its browser-tool
 * chips. Null until the agent browses; the panel mirrors it from here. */
export type AgentBrowserPage = { tool: string; url: string; at: number };
const agentPageSchema = z.object({
  tool: z.string().max(200).default(""),
  url: z.string().min(1).max(8000),
  at: z.number().finite(),
});
export type BrowserPreviewSnapshot = {
  state: BrowserPreviewState | null;
  frame: string | null;
  agent: AgentBrowserPage | null;
  busy: BrowserPreviewAction | null;
  error: string | null;
  pollError: string | null;
};

export const emptyBrowserPreview = (): BrowserPreviewSnapshot => ({
  state: null, frame: null, agent: null, busy: null, error: null, pollError: null,
});

const idle = (): BrowserPreviewState => ({ running: false, url: null, title: null, profile: "bot", error: null });
export type BrowserPreviewReply = BrowserPreviewState | { state: BrowserPreviewState; frame: string | null } | { ok: true };
type PreviewRequest = (path: string, init?: RequestInit) => Promise<BrowserPreviewReply>;

/** One mounted panel owns these requests. Disposing prevents late replies and
 * follow-on requests from an old bot; revisions discard reads begun before an action. */
export function createBrowserPreviewSession(
  botId: string,
  request: PreviewRequest,
  publish: (snapshot: BrowserPreviewSnapshot) => void,
) {
  const base = `/api/bots/${encodeURIComponent(botId)}/browser-panel`;
  let snapshot = emptyBrowserPreview();
  let disposed = false;
  let polling = false;
  let revision = 0;

  const update = (patch: Partial<BrowserPreviewSnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    publish(snapshot);
  };

  const pull = async () => {
    // Visibility-aware polling: a hidden document gets no requests at all;
    // the interval above resumes the feed when the tab comes back.
    if (globalThis.document?.hidden) return;
    if (disposed || polling || snapshot.busy) return;
    polling = true;
    const requestedRevision = revision;
    try {
      // SAFETY: own /frame endpoint returns the server's state, JPEG payload,
      // and the agent's latest browser-tool page.
      const data = await request(`${base}/frame`) as { state: BrowserPreviewState; frame: string | null; agent?: AgentBrowserPage | null };
      const agent = agentPageSchema.safeParse(data.agent);
      if (!disposed && revision === requestedRevision) {
        update({
          state: data.state,
          frame: data.state.running ? data.frame : null,
          agent: agent.success ? agent.data : null,
          pollError: null,
        });
      }
    } catch (error) {
      if (!disposed && revision === requestedRevision) {
        update({ pollError: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      polling = false;
    }
  };

  const perform = async (busy: BrowserPreviewAction, action: () => Promise<void>) => {
    if (disposed || snapshot.busy) return;
    revision++;
    update({ busy, error: null });
    try {
      await action();
    } catch (error) {
      update({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      update({ busy: null });
    }
  };

  const startProfile = async (profile: "bot" | "guest") => {
    // SAFETY: own /start endpoint returns BrowserPanelState.
    const state = await request(`${base}/start`, { method: "POST", body: JSON.stringify({ profile }) }) as BrowserPreviewState;
    update({ state, frame: null });
  };

  const stopProfile = async () => {
    await request(`${base}/stop`, { method: "POST" });
    update({ state: idle(), frame: null });
  };

  return {
    pull,
    dispose: () => { disposed = true; },
    start: (profile: "bot" | "guest") => {
      if (!snapshot.state || snapshot.state.running) return Promise.resolve();
      return perform("start", () => startProfile(profile));
    },
    stop: () => {
      if (!snapshot.state?.running) return Promise.resolve();
      return perform("stop", stopProfile);
    },
    navigate: (url: string) => {
      if (!snapshot.state?.running || !url.trim()) return Promise.resolve();
      return perform("navigate", async () => {
        // SAFETY: own /navigate endpoint returns BrowserPanelState.
        const state = await request(`${base}/navigate`, { method: "POST", body: JSON.stringify({ url: url.trim() }) }) as BrowserPreviewState;
        update({ state, frame: null });
      });
    },
    /** Open the page the agent navigated to in THIS visible preview: starts
     * the session when the human has not, then navigates. The agent's own
     * browser is headless — this is how the human actually sees the page. */
    openAgentPage: (url: string) => {
      if (!url.trim()) return Promise.resolve();
      return perform("navigate", async () => {
        if (!snapshot.state?.running) await startProfile("bot");
        // SAFETY: own /navigate endpoint returns BrowserPanelState.
        const state = await request(`${base}/navigate`, { method: "POST", body: JSON.stringify({ url: url.trim() }) }) as BrowserPreviewState;
        update({ state, frame: null });
      });
    },
    switchProfile: (profile: "bot" | "guest") => {
      if (!snapshot.state?.running || snapshot.state.profile === profile) return Promise.resolve();
      return perform("profile", async () => {
        await stopProfile();
        if (!disposed) await startProfile(profile);
      });
    },
  };
}
