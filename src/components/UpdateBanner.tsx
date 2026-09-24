// Auto-update popup — a small card floating bottom-left, driven by the
// preload's updater bridge. Renders nothing in the browser/dev (no bridge)
// and while idle/checking; appears only when actionable: an update to
// download, a download in progress, a restart to apply, or an error.
import { useEffect, useState } from "react";
import { ArrowDownToLine, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";

// The one action button in the card. Disabled drops the accent fill for the
// flat raised grey — the "I heard you" the click needs while the main process
// gets going.
const primaryAction =
  "flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white transition-colors disabled:cursor-default disabled:bg-raised disabled:text-ink-secondary";

// electron-updater surfaces failures as a whole HTTP dump — status line,
// every response header, stack trace. That is unreadable in a 300px popup,
// so name the two cases that actually happen and clip anything else to its
// first line.
function friendlyError(message?: string): string {
  if (!message) return "Something went wrong.";
  if (/cannot find .*\.yml|404/i.test(message))
    return "No update has been published for this platform yet.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(message))
    return "Couldn't reach the update server.";
  return message.split("\n")[0].slice(0, 140);
}

// A successful quitAndInstall tears down this whole renderer within seconds —
// the OS replaces the running app. If this component is still mounted and
// still showing "installing" after a real one would have already relaunched,
// the install is taking far longer than it should.
//
// HOW LONG IS "far longer": a signed macOS update is a ~180 MB application
// that macOS verifies, swaps and relaunches, and that work happens AFTER the
// window is gone — the 15s this used to wait was short enough that a normal,
// healthy install of a large app was declared "Restart didn't finish" while
// Squirrel was still applying it. That is how a working update path taught
// people to distrust it. Two thresholds now: "still working" (say so, keep
// waiting) and "didn't finish" (offer the way out), both far beyond a real
// install, and neither blaming the build's signature — Muster ships Developer
// ID signed, and the old copy blamed "an unsigned build" for a hang that was
// mostly this timer.
export const INSTALL_STILL_WORKING_MS = 45_000;
export const INSTALL_STUCK_MS = 120_000;

/** One honest timer for the two moments, testable without a renderer. */
export function installPhase(elapsedMs: number): "installing" | "still-working" | "stuck" {
  if (elapsedMs < INSTALL_STILL_WORKING_MS) return "installing";
  return elapsedMs < INSTALL_STUCK_MS ? "still-working" : "stuck";
}

export function UpdateBanner() {
  const s = useUpdaterState();
  // dismissal is per status+version, so the popup returns for the next
  // update (and when an available one finishes downloading)
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A click has to go renderer → main → broadcast before the real status
  // arrives. Latch the pressed button as busy on the same frame so it greys
  // out immediately; the incoming status clears the latch.
  const [pending, setPending] = useState<"download" | "install" | "check" | null>(null);
  const status = s?.status;
  useEffect(() => setPending(null), [status]);

  const manualDownloadUrl = window.location.origin ? `${window.location.origin}/downloads` : "/downloads";

  // A successful quitAndInstall tears down this whole renderer within
  // seconds — the OS replaces the running app. If this component is still
  // mounted and still showing "installing" after a real one would have
  // already relaunched, the install genuinely hung.
  const [installElapsed, setInstallElapsed] = useState(0);
  useEffect(() => {
    if (status !== "installing") {
      setInstallElapsed(0);
      return;
    }
    const started = Date.now();
    setInstallElapsed(0);
    const timer = setInterval(() => setInstallElapsed(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, [status]);
  const installState = status === "installing" ? installPhase(installElapsed) : "installing";
  const stillWorking = installState === "still-working";
  const stuckInstalling = installState === "stuck";

  if (!s || s.status === "idle" || s.status === "checking") return null;
  const key = `${s.status}:${s.version ?? ""}`;
  if (dismissed === key) return null;
  const updater = window.ogb!.updater!;

  // while busy the card owns the moment: no dismissing, no second click —
  // unless it's stuck, in which case the user needs a way out
  const installing = s.status === "installing" && !stillWorking && !stuckInstalling;
  const busy = s.status === "downloading" || installing || stillWorking;

  // Unsigned mac builds never enter the download/restart pipeline at all:
  // one honest button that opens the release page. Everything Squirrel can't
  // guarantee stays out of the state machine rather than patched over.
  const manualMac = Boolean(s.manualOnly);

  const title =
    s.status === "available"
      ? `Muster ${s.version} is available`
      : s.status === "downloading"
        ? `Downloading ${s.version ?? "update"}…`
        : s.status === "downloaded"
          ? `${s.version} is ready`
          : installing
            ? "Restarting to update…"
            : stillWorking
              ? "Still applying the update…"
              : stuckInstalling
                ? "Restart didn't finish"
                : "Update check failed";
  const subtitle =
    s.status === "available"
      ? manualMac
        ? "Install by downloading the new app and replacing this one."
        : "A newer version is ready to download."
      : s.status === "downloading"
        ? // no percent yet means the transfer hasn't reported in — don't imply 0
          s.percent == null
          ? "Starting download…"
          : `${Math.round(s.percent)}%`
        : s.status === "downloaded"
          ? "Restart to finish updating."
          : installing
            ? "Muster will reopen in a moment."
            : stillWorking
              ? "macOS is verifying and swapping the new app. This takes a minute on a large download — leave Muster open."
              : stuckInstalling
                ? manualMac
                  ? "This can happen on an unsigned build. Download the update directly instead."
                  : "macOS didn't finish applying the update. Download the new version directly, or quit Muster and open it again."
                : friendlyError(s.message);

  return (
    <div className="animate-panel-in fixed bottom-4 left-4 z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary" title={subtitle}>
            {subtitle}
          </div>
        </div>
        {!busy && (
          <button
            onClick={() => setDismissed(key)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {s.status === "downloading" && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-raised">
          <div
            className={cn(
              "h-full rounded-full bg-accent transition-[width]",
              // before the first progress report, a sliver that breathes beats
              // a zero-width bar that looks stalled
              s.percent == null && "w-1/4 animate-pulse",
            )}
            style={s.percent == null ? undefined : { width: `${Math.min(100, Math.max(0, s.percent))}%` }}
          />
        </div>
      )}

      {installing && (
        <div className="mt-2.5 flex gap-2">
          <button
            disabled
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised py-1.5 text-[13px] font-medium text-ink-secondary"
          >
            <Loader2 size={13} className="animate-spin" /> Restarting…
          </button>
        </div>
      )}

      {stillWorking && (
        <div className="mt-2.5 flex gap-2">
          <div
            role="status"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised px-2 py-1.5 text-[13px] text-ink-secondary"
          >
            <Loader2 size={13} className="animate-spin" /> Verifying and swapping the new app…
          </div>
        </div>
      )}

      {!busy && (
        <div className="mt-2.5 flex gap-2">
          {s.status === "available" && manualMac && (
            <a
              href={manualDownloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                // system browser, not a second electron window
                if (window.ogb?.openExternal) {
                  e.preventDefault();
                  // SAFETY: this handler is attached to the <a> itself, so
                  // currentTarget is that anchor at click time.
                  window.ogb.openExternal((e.currentTarget as HTMLAnchorElement).href);
                }
              }}
              className={primaryAction}
            >
              <ArrowDownToLine size={13} /> Get Muster {s.version}
            </a>
          )}
          {s.status === "available" && !manualMac && (
            <button
              onClick={() => {
                setPending("download");
                void updater.download();
              }}
              disabled={pending !== null}
              className={primaryAction}
            >
              {pending === "download" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Starting…
                </>
              ) : (
                <>
                  <ArrowDownToLine size={13} /> Download
                </>
              )}
            </button>
          )}
          {s.status === "downloaded" && !manualMac && (
            <button
              onClick={() => {
                setPending("install");
                void updater.install();
              }}
              disabled={pending !== null}
              className={primaryAction}
            >
              {pending === "install" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Restarting…
                </>
              ) : (
                <>
                  <RefreshCw size={13} /> Restart to update
                </>
              )}
            </button>
          )}
          {s.status === "error" && (
            <>
              <button
                onClick={() => {
                  setPending("check");
                  void updater.check();
                }}
                disabled={pending !== null}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:text-ink-secondary disabled:hover:bg-raised"
              >
                {pending === "check" ? (
                  <>
                    <Loader2 size={13} className="animate-spin" /> Checking…
                  </>
                ) : (
                  "Try again"
                )}
              </button>
              {/* Muster's builds aren't Developer ID signed yet — macOS's
               * own updater can fail to apply an update it already found
               * and downloaded for exactly that reason. "Try again" alone
               * leaves someone stuck with no way out of that specific
               * failure, so always offer the one path that reliably works:
               * grab the new build directly. */}
              <a
                href={manualDownloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline/50 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Download manually
              </a>
            </>
          )}
          {stuckInstalling && (
            <a
              href={manualDownloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised py-1.5 text-[13px] text-ink hover:bg-raised-hover"
            >
              <ArrowDownToLine size={13} /> Download manually
            </a>
          )}
          <button
            onClick={() => setDismissed(key)}
            disabled={pending !== null}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Later
          </button>
        </div>
      )}
    </div>
  );
}
