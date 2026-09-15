// The Agent Hub — hire a teammate from a curated template. Details-first
// cards (skills, best-with peers, honest sources) and one click that runs
// the whole create → identity → SOUL.md → first-task-draft flow through the
// store's hireTemplate action.
import { AlertTriangle, X } from "lucide-react";
import { useEffect, useState } from "react";

import { AGENT_TEMPLATES, templateById, type AgentTemplate } from "@/lib/agent-templates";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";

import { AgentAvatar } from "./Avatar";

function TemplateCard({ template }: { template: AgentTemplate }) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const peers = template.bestWith
    .map((id) => templateById(id)?.name)
    .filter((n): n is string => Boolean(n));
  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl border border-white/10 bg-white/6 p-4",
        "shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)]",
      )}
    >
      <div className="flex items-start gap-3">
        <AgentAvatar
          character={template.character}
          color={template.color}
          state="idle"
          size={40}
          motion="none"
          motionKey={0}
          animated={false}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-ink">
            {template.name} <span className="font-normal text-ink-secondary">· {template.title}</span>
          </p>
          <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">
            {template.category}
          </p>
        </div>
      </div>
      <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-secondary">{template.tagline}</p>
      {template.setupNote && (
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-warning">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {template.setupNote}
        </p>
      )}
      {open && (
        <div className="mt-3 space-y-2.5 border-t border-hairline/40 pt-3 text-[12px] text-ink-secondary">
          <p className="text-ink">{template.reason}</p>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary/80">Skills</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {template.skills.map((s) => (
                <span key={s} className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink">{s}</span>
              ))}
            </div>
          </div>
          {peers.length > 0 && (
            <p>
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary/80">Works best with</span>
              <br />
              {peers.join(" · ")}
            </p>
          )}
          <p>
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary/80">Reads</span>
            <br />
            {template.sources.join(" · ")}
          </p>
          <p className="text-[11px] text-ink-secondary/70">{template.provenance}</p>
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          {open ? "Hide details" : "View details"}
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "hireTemplate", template })}
          className="ml-auto rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:brightness-110"
        >
          Hire {template.name}
        </button>
      </div>
    </div>
  );
}

export function TemplatesModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Agent Hub">
      <div className="absolute inset-0 bg-black/60" onMouseDown={onClose} />
      <div className="menu-pop relative flex max-h-[85vh] w-full max-w-[820px] origin-center flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-2xl shadow-black/60">
        <div className="flex items-start justify-between gap-4 border-b border-hairline/40 px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">Agent Hub</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-secondary">
              Curated teammates with a real persona, guardrails that start conservative, and a first task
              already in the composer. Everything runs on your own engines and keys.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Agent Hub"
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-3 overflow-y-auto p-5 sm:grid-cols-2">
          {AGENT_TEMPLATES.map((t) => (
            <TemplateCard key={t.id} template={t} />
          ))}
        </div>
        <div className="border-t border-hairline/40 px-5 py-3 text-[11.5px] text-ink-secondary/70">
          Templates never pin a model or grant permissions — the new teammate starts with your defaults,
          and you decide what it may touch.
        </div>
      </div>
    </div>
  );
}
