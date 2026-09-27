// Desktop canvas (OMB parity #10): watch every local desktop side by side.
// Read-only by design — Muster's control surface stays in each bot's own
// Computer panel, which owns the lease and the activity context; this view
// is the wall-mounted monitor, not the driver's seat. The server reports
// only desktops that actually exist right now, so recycled ones drop out.
import { useCallback, useEffect, useRef, useState } from "react";

import { useStore } from "@/state/store";

interface CanvasDesktop {
  botId: string;
  label: string;
  image: string;
}

/** The heading a tile wears. A per-bot tile is that bot's desktop and names it;
 *  a shared tile is one desktop every bot drives, so naming a teammate there is
 *  a fiction — the server sends an empty botId for exactly that case, and this
 *  is the one place that renders the distinction.
 *
 *  Exported for the test: the pre-fix build called `botName(desktop.botId)`
 *  unconditionally, and on a shared tile `botName` fell through to its `"Desktop"`
 *  default or, worse, matched whichever arbitrary bot id the server's dedupe
 *  had kept. Neither is distinguishable from correct at a glance, which is why
 *  it survived. */
export function canvasTileTitle(desktop: Pick<CanvasDesktop, "botId" | "label">, nameOf: (id: string) => string): string {
  if (desktop.label === SHARED_DESKTOP_LABEL) return "All bots";
  // A per-bot tile whose id no longer resolves is a deleted bot: say so rather
  // than printing an empty heading.
  return desktop.botId ? nameOf(desktop.botId) : "Desktop";
}

/** The server's label for the one desktop every bot shares. Matched against the
 *  wire value, so a rename on either side shows up as a failing test. */
export const SHARED_DESKTOP_LABEL = "shared";

/** Ask the server for one snapshot of every running local desktop. */
async function fetchCanvas(): Promise<CanvasDesktop[]> {
  const res = await fetch("/api/local-computer/canvas-screenshots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`canvas request failed (${res.status})`);
  // SAFETY: the server's canvas endpoint always answers {desktops: [...]}
  // with {botId,label,image} strings; anything else cannot be rendered.
  const body = (await res.json()) as { desktops?: CanvasDesktop[] };
  return body.desktops ?? [];
}

export default function DesktopCanvas({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  const [desktops, setDesktops] = useState<CanvasDesktop[] | null>(null);
  const [error, setError] = useState("");
  const [refreshMs, setRefreshMs] = useState(5000);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    fetchCanvas()
      .then((next) => {
        setDesktops(next);
        setError("");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Canvas refresh failed."));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(refresh, refreshMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh, refreshMs]);

  const botName = (id: string): string => state.bots.find((b) => b.id === id)?.name ?? "Desktop";

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-inset/95 backdrop-blur-[2px]">
      <div className="flex items-center justify-between border-b border-hairline/40 px-4 py-2.5">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">Desktops</h2>
          <p className="text-[11.5px] text-ink-secondary">
            Watch-only view of every running local desktop. To act on one, open that bot's Computer panel.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
            Refresh
            <select
              aria-label="Canvas refresh interval"
              value={refreshMs}
              onChange={(e) => setRefreshMs(Number(e.target.value))}
              className="rounded-lg border border-hairline/40 bg-inset px-2 py-1 text-[12px] text-ink"
            >
              <option value={2000}>2s</option>
              <option value={5000}>5s</option>
              <option value={10000}>10s</option>
            </select>
          </label>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:border-hairline"
          >
            Close
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error && <p role="alert" className="text-[13px] text-[#ff6b6b]">{error}</p>}
        {desktops === null && !error && <p className="text-[13px] text-ink-secondary">Loading desktops…</p>}
        {desktops !== null && desktops.length === 0 && (
          <div className="mt-16 text-center text-[13.5px] leading-relaxed text-ink-secondary">
            <p className="font-medium text-ink">No local desktops are running.</p>
            <p className="mt-1.5">
              Desktops appear here while bots work on this machine's Local VM (or their own, in per-bot isolation mode).
            </p>
          </div>
        )}
        {desktops !== null && desktops.length > 0 && (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(480px, 100%), 1fr))` }}
          >
            {desktops.map((desktop) => (
              <figure key={`${desktop.label}:${desktop.botId}`} className="overflow-hidden rounded-xl border border-hairline/40 bg-inset">
                <figcaption className="flex items-center justify-between border-b border-hairline/40 px-3 py-1.5 text-[12px] text-ink-secondary">
                  <span className="font-medium text-ink">{canvasTileTitle(desktop, botName)}</span>
                  <span>{desktop.label === SHARED_DESKTOP_LABEL ? "Shared desktop" : "Own desktop"}</span>
                </figcaption>
                <CanvasFrame image={desktop.image} />
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CanvasFrame({ image }: { image: string }) {
  // Screenshots arrive as raw base64 (no data: prefix) from the container
  // computer; mime is part of the shot itself — prefer png, fall back wide.
  const src = image.startsWith("data:") ? image : `data:image/png;base64,${image}`;
  return <img src={src} alt="Live desktop screenshot" className="block w-full bg-black object-contain" />;
}
