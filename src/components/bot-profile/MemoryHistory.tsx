import { History, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { gaiaTheme } from "@/lib/gaia-theme";

export interface MemoryVersion {
  id: string;
  at: string;
  origin: "user-edit" | "agent" | "rollback";
  bytes: number;
}

/** What superseded this version — same wording the server records it under. */
const ORIGIN_LABEL = {
  "user-edit": "replaced by an editor save",
  agent: "replaced by bot activity",
  rollback: "replaced by a restore",
} satisfies Record<MemoryVersion["origin"], string>;

const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`;

const formatAt = (at: string) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Past versions of MEMORY.md, newest first. Purely a view: fetching,
 * previewing and restoring stay in MemoryCard, which owns the API. */
export function MemoryHistory({
  versions,
  restoringId,
  onPreview,
  onRestore,
}: {
  versions: MemoryVersion[];
  restoringId: string | null;
  onPreview: (version: MemoryVersion) => void;
  onRestore: (version: MemoryVersion) => void;
}) {
  if (versions.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        <History size={13} />
        Version history
      </div>
      <div className="grid gap-2">
        {versions.map((version) => (
          <div
            key={version.id}
            className={cn(
              "flex items-center gap-3 rounded-2xl border px-3 py-2.5",
              gaiaTheme.card.border,
            )}
          >
            <button onClick={() => onPreview(version)} className="min-w-0 flex-1 text-left">
              <span className="block text-[12.5px] text-ink">{formatAt(version.at)}</span>
              <span className="block truncate text-[11px] text-ink-secondary">
                {ORIGIN_LABEL[version.origin]} · {formatBytes(version.bytes)}
              </span>
            </button>
            <button
              onClick={() => onRestore(version)}
              disabled={restoringId !== null}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-2.5 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              <RotateCcw size={12} />
              {restoringId === version.id ? "Restoring…" : "Restore"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
