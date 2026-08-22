import { useState } from "react";
import { Brain, Clock, Sparkles, Shield, FileText, MessageSquare, Zap, Users, ChevronRight, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/cn";

/** Vellum-style 8 memory types — integrated into Muster bot profile */
const MEMORY_TYPES = [
  { id: "episodic", label: "Episodic", desc: "Specific events and experiences", icon: Sparkles, color: "text-amber-400", bg: "bg-amber-400/10" },
  { id: "semantic", label: "Semantic", desc: "Facts, concepts, knowledge", icon: Brain, color: "text-sky-400", bg: "bg-sky-400/10" },
  { id: "procedural", label: "Procedural", desc: "Skills and how-to sequences", icon: Zap, color: "text-emerald-400", bg: "bg-emerald-400/10" },
  { id: "emotional", label: "Emotional", desc: "Sentiment, preferences, tone", icon: Shield, color: "text-rose-400", bg: "bg-rose-400/10" },
  { id: "prospective", label: "Prospective", desc: "Goals, plans, future intentions", icon: Clock, color: "text-violet-400", bg: "bg-violet-400/10" },
  { id: "behavioral", label: "Behavioral", desc: "Patterns in how you work", icon: Users, color: "text-teal-400", bg: "bg-teal-400/10" },
  { id: "narrative", label: "Narrative", desc: "Storylines and context threads", icon: MessageSquare, color: "text-amber-300", bg: "bg-amber-300/10" },
  { id: "shared", label: "Shared", desc: "Cross-bot pooled knowledge", icon: FileText, color: "text-indigo-400", bg: "bg-indigo-400/10" },
];

export function MemoryTab({ botId: _botId }: { botId: string }) {
  const [selected, setSelected] = useState("episodic");
  const active = MEMORY_TYPES.find((m) => m.id === selected)!;

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex items-center gap-2 text-[15px] font-semibold text-ink">
        <Brain size={18} className="text-accent" />
        <span>Memory</span>
        <span className="text-[11px] font-normal text-ink-secondary">· 8 types</span>
      </header>

      {/* Memory type grid (Gaia-style card grid) */}
      <div className="grid grid-cols-4 gap-2">
        {MEMORY_TYPES.map((m) => (
          <button
            key={m.id}
            onClick={() => setSelected(m.id)}
            className={cn(
              "relative flex flex-col gap-1.5 rounded-xl border px-2.5 py-2.5 text-left transition",
              selected === m.id
                ? "border-accent/40 bg-card shadow-md shadow-black/5"
                : "border-hairline/40 bg-raised hover:border-hairline/60 hover:bg-raised/70",
            )}
          >
            <div className={cn("flex size-7 items-center justify-center rounded-lg", m.bg)}>
              <m.icon size={14} className={m.color} />
            </div>
            <div className="text-[12.5px] font-medium leading-tight text-ink">{m.label}</div>
            <div className="text-[10.5px] leading-tight text-ink-secondary">{m.desc}</div>
            {selected === m.id && <ChevronRight size={10} className="absolute right-2 top-2 text-accent" />}
          </button>
        ))}
      </div>

      {/* Active memory detail panel (Vellum-style detail view) */}
      <div className={cn("flex-1 rounded-2xl border border-hairline/40 bg-card p-4", active.bg)}>
        <div className="flex items-center gap-2 mb-3">
          <active.icon size={18} className={active.color} />
          <h3 className="text-[14px] font-semibold text-ink">{active.label} memories</h3>
          <span className="ml-auto text-[11px] text-ink-secondary">Staleness: 7 days</span>
        </div>
        <div className="space-y-2.5">
          {[
            { title: "User prefers concise answers", source: "conversation · 2 days ago", tag: "semantic" },
            { title: "Project: Muster agent redesign", source: "file · 5 days ago", tag: "episodic" },
          ].map((item) => (
            <div key={item.title} className="rounded-lg bg-raised/70 px-3 py-2.5">
              <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />
                {item.title}
              </div>
              <div className="mt-0.5 text-[11.5px] text-ink-secondary">{item.source}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 text-[11px] text-ink-secondary">
          Retrieval: dense + sparse embeddings · Isolation: per-user · Source attribution: enabled
        </div>
      </div>
    </div>
  );
}
