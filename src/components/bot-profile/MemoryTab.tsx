import { FileText, MessageSquare, Sparkles, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { gaiaTheme } from "@/lib/gaia-theme";

/** Decorative accents cycle per topic — visual variety, not semantics:
 * Muster memory is plain files and the app does not pretend otherwise. */
const ACCENTS = [
  { icon: Sparkles, color: gaiaTheme.memory.episodic },
  { icon: FileText, color: gaiaTheme.memory.semantic },
  { icon: Zap, color: gaiaTheme.memory.procedural },
  { icon: MessageSquare, color: gaiaTheme.memory.narrative },
] as const;

const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`;

/** Gaia-style grid over a bot's real memory topic files. Purely a view:
 * fetching, opening and editing stay in MemoryCard, which owns the API. */
export function MemoryTab({
  topics,
  onOpen,
}: {
  topics: Array<{ name: string; bytes: number }>;
  onOpen: (name: string) => void;
}) {
  if (topics.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        Topic files
      </div>
      <div className="grid grid-cols-2 gap-2">
        {topics.map((topic, index) => {
          const accent = ACCENTS[index % ACCENTS.length];
          const Icon = accent.icon;
          return (
            <button
              key={topic.name}
              onClick={() => onOpen(topic.name)}
              className={cn(
                "flex items-start gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition hover:bg-raised/60",
                gaiaTheme.card.border,
              )}
            >
              <span className="mt-0.5 shrink-0">
                <Icon size={15} className={accent.color} />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-mono text-[12.5px] text-ink">{topic.name}</span>
                <span className="block text-[11px] text-ink-secondary">{formatBytes(topic.bytes)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
