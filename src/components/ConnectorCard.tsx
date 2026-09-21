import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, PlugZap, RefreshCw, X } from "lucide-react";

import { api, type Message } from "@/state/store";

/** Does the status endpoint's failure mean the connection attempt itself
 * expired (stop polling honestly) versus a transport hiccup? The api helper
 * throws Error carrying the server's message; parse that message here, at
 * the UI boundary where the string actually lives. */
function connectedError(error: Error): boolean {
  return /expired|revoked|no such connection request|404/i.test(error.message);
}

async function openConnectionPage(url: string) {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return;
  }
  const opened = window.open("", "_blank");
  if (!opened) throw new Error("Your browser blocked the connection page. Allow pop-ups, then try again.");
  opened.opener = null;
  opened.location.replace(url);
}

export function ConnectorCard({ botId, threadId, message }: { botId: string; threadId: string; message: Message }) {
  const connector = message.connector!;
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const polling = useRef(false);
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/connector-cards/${encodeURIComponent(message.id)}`;
  const checkStatus = useCallback(async () => {
    const result = await api(`${endpoint}/status?threadId=${encodeURIComponent(threadId)}`);
    return Boolean(result.connected);
  }, [endpoint, threadId]);

  useEffect(() => {
    if (connector.status !== "authorizing" || connector.dismissed) return;
    polling.current = true;
    let tries = 0;
    let consecutiveFailures = 0;
    // 75 × 4s = 5 min of polling. Two things used to break this: the timer
    // stopping silently at the cap (the card froze on "Waiting for sign-in…"
    // even though the sign-in itself had long expired), and transient API
    // hiccups counting against the cap like real time. Now the cap restarts
    // whenever the server says the connection expired — the card flips to
    // its failed state with a Try again button instead of lying — and
    // consecutive transport failures surface an honest local error rather
    // than spinning forever.
    const timer = setInterval(() => {
      if (!polling.current) return;
      void checkStatus()
        .then((connected) => {
          tries += 1;
          consecutiveFailures = 0;
          if (connected || tries >= 75) {
            polling.current = false;
            clearInterval(timer);
          }
        })
        .catch((error: Error) => {
          tries += 1;
          consecutiveFailures += 1;
          if (connectedError(error)) {
            // the sign-in session itself expired server-side: stop polling
            // and show the failed state (Try again) instead of a frozen spinner
            polling.current = false;
            clearInterval(timer);
            setLocalError("The connection request expired. Click Try again to start a new sign-in.");
          } else if (consecutiveFailures >= 5) {
            polling.current = false;
            clearInterval(timer);
            setLocalError("Lost contact with the server while waiting for sign-in. Try again when it's back.");
          }
          if (tries >= 75) clearInterval(timer);
        });
    }, 4_000);
    return () => {
      polling.current = false;
      clearInterval(timer);
    };
  }, [checkStatus, connector.dismissed, connector.status]);

  if (connector.dismissed) return null;

  const connect = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      const result = await api(`${endpoint}/authorize`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
      await openConnectionPage(String(result.url));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, { method: "POST", body: JSON.stringify({ threadId }) });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    void api(`${endpoint}/dismiss`, { method: "POST", body: JSON.stringify({ threadId }) }).catch(() => {});
  };

  const connected = connector.status === "connected";
  const authorizing = connector.status === "authorizing";
  const error = localError ?? connector.error;

  return (
    <div className="flex w-full justify-start">
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-raised text-[16px] font-semibold text-ink">
            {connector.label.slice(0, 1).toUpperCase() || <PlugZap size={19} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-ink">{connector.label}</span>
              {connected && (
                <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                  <Check size={11} /> Connected
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
              {connected
                ? connector.resumed
                  ? "Connected securely. Your bot is continuing the task."
                  : "Connected securely. Continue the paused task when you're ready."
                : connector.description}
            </p>
            {!connected && (
              <p className="mt-1 text-[11.5px] text-ink-secondary/80">
                Sign in or enter the app key on the secure connection page — never in chat.
              </p>
            )}
            {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
          </div>
          {!connected && (
            <button onClick={dismiss} aria-label="Not now" title="Not now" className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink">
              <X size={15} />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-hairline/40 bg-panel/40 px-4 py-2.5">
          <div className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
            {authorizing ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />}
            {authorizing ? "Waiting for sign-in…" : connected ? "Ready to use" : "Requested by your bot"}
          </div>
          {!connected ? (
            <button
              onClick={() => void connect()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy || authorizing ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
              {authorizing ? "Open again" : connector.status === "failed" ? "Try again" : "Connect securely"}
            </button>
          ) : !connector.resumed ? (
            <button
              onClick={() => void resume()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Continue task
            </button>
          ) : (
            <span className="flex items-center gap-1 text-[12px] font-medium text-success"><Check size={13} /> Continuing</span>
          )}
        </div>
      </div>
    </div>
  );
}
