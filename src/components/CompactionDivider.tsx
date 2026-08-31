// What.
// The quiet divider a compaction record renders as: "Context compacted —
// earlier messages are still here", expandable to the summary itself.
//
// Why.
// Compaction bounds what the MODEL sees; the user's transcript keeps
// everything. The divider exists so the summary's arrival never reads as
// messages disappearing — scrolling up still reaches message one.
import { useState } from "react";
import { ChevronDown, History } from "lucide-react";

/** Mirrors server/model-context.ts CompactionData — the wire shape of a
 * kind:"compaction" message. Structural: no runtime import of server code. */
interface CompactionData {
  summary: string;
  firstKeptId: string;
  tokensBefore: number;
  at: number;
}

export function CompactionDivider({ data }: { data: CompactionData }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 flex w-full flex-col items-center gap-1">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[11.5px] text-ink-secondary transition-colors hover:border-hairline hover:text-ink"
      >
        <History size={12} aria-hidden="true" />
        Context compacted — earlier messages are still here
        <ChevronDown size={12} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
      </button>
      {open && (
        <div className="max-w-[70%] whitespace-pre-wrap rounded-xl border border-hairline/40 bg-raised px-4 py-3 text-[12.5px] leading-relaxed text-ink-secondary">
          {data.summary}
        </div>
      )}
    </div>
  );
}
