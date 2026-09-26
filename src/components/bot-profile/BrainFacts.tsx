import { useCallback, useEffect, useState } from "react";
import { EyeOff, History, RotateCcw, Undo2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { gaiaTheme } from "@/lib/gaia-theme";
import {
  factHistory,
  listBrainFacts,
  restoreFact,
  revertFact,
  withdrawFact,
  type BrainFact,
  type FactHistory,
} from "@/lib/memory/brain-facts";

const KIND_COLOR = {
  person: "text-sky-400",
  company: "text-violet-400",
  project: "text-emerald-400",
  decision: "text-amber-400",
  note: "text-ink-secondary",
} satisfies Record<BrainFact["kind"], string>;

const actionButton =
  "flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-2.5 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50";

const formatAt = (at: string) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Provenance line: kind, the citation, who wrote it, when, and withdrawal. */
function FactMeta({ fact }: { fact: BrainFact }) {
  return (
    <span className="mt-0.5 block text-[11px] text-ink-secondary">
      <span className={cn("font-medium", KIND_COLOR[fact.kind])}>{fact.kind}</span>
      {" · "}
      {fact.source}
      {fact.origin ? ` · ${fact.origin}` : ""}
      {" · "}
      {formatAt(fact.createdAt)}
      {fact.withdrawnAt ? ` · withdrawn ${formatAt(fact.withdrawnAt)}` : ""}
    </span>
  );
}

/** The correction chain behind one fact, oldest first: what it superseded,
 * the fact itself, and what has since superseded it. */
function HistoryChain({ chain }: { chain: FactHistory }) {
  const entries: Array<{ fact: BrainFact; role: "ancestor" | "current" | "descendant" }> = [
    ...chain.ancestors.map((fact) => ({ fact, role: "ancestor" as const })),
    ...(chain.fact ? [{ fact: chain.fact, role: "current" as const }] : []),
    ...chain.descendants.map((fact) => ({ fact, role: "descendant" as const })),
  ];
  return (
    <div className="mt-2.5 border-t border-hairline/40 pt-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        <History size={13} />
        Correction chain
      </div>
      <div className="grid gap-1.5">
        {entries.map(({ fact, role }) => (
          <div key={fact.id} className={cn("rounded-xl px-2.5 py-1.5", role === "current" && "bg-raised/60")}>
            <span
              className={cn("block text-[12px] text-ink", fact.withdrawnAt && "text-ink-secondary line-through")}
            >
              {fact.text}
            </span>
            <span className="block text-[11px] text-ink-secondary">
              {role === "current" ? "this fact · " : ""}
              {fact.source}
              {fact.origin ? ` · ${fact.origin}` : ""}
              {" · "}
              {formatAt(fact.createdAt)}
              {fact.withdrawnAt ? ` · withdrawn ${formatAt(fact.withdrawnAt)}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Reverting mints a NEW fact superseding this one — history is never
 * rewritten — so the input asks for what is true now, not an edit. */
function RevertInput({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    if (draft.trim() && !busy) onConfirm(draft.trim());
  };
  return (
    <div className="mt-2.5 flex items-center gap-2">
      <input
        className="min-w-0 flex-1 rounded-lg border border-hairline bg-raised px-2 py-1.5 text-[12.5px] text-ink placeholder:text-ink-secondary"
        value={draft}
        autoFocus
        placeholder="State what is true now"
        aria-label="Replacement fact"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <button onClick={submit} disabled={busy || !draft.trim()} className={actionButton}>
        <RotateCcw size={12} />
        Revert
      </button>
      <button
        onClick={onCancel}
        disabled={busy}
        className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
      >
        Cancel
      </button>
    </div>
  );
}

/** One listed fact: text, provenance, and the actions its state allows —
 * withdraw while live, restore while withdrawn, revert in either case. */
function FactRow({
  fact,
  busy,
  expanded,
  chain,
  reverting,
  onToggleHistory,
  onWithdraw,
  onRestore,
  onRevertStart,
  onRevertCancel,
  onRevertConfirm,
}: {
  fact: BrainFact;
  busy: boolean;
  expanded: boolean;
  chain: FactHistory | null;
  reverting: boolean;
  onToggleHistory: (fact: BrainFact) => void;
  onWithdraw: (fact: BrainFact) => void;
  onRestore: (fact: BrainFact) => void;
  onRevertStart: (fact: BrainFact) => void;
  onRevertCancel: () => void;
  onRevertConfirm: (fact: BrainFact, text: string) => void;
}) {
  const withdrawn = Boolean(fact.withdrawnAt);
  return (
    <div className={cn("rounded-2xl border px-3 py-2.5", gaiaTheme.card.border)}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <span className={cn("block text-[12.5px] text-ink", withdrawn && "text-ink-secondary line-through")}>
            {fact.text}
          </span>
          <FactMeta fact={fact} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => onToggleHistory(fact)}
            disabled={busy}
            aria-expanded={expanded}
            className={actionButton}
          >
            <History size={12} />
            History
          </button>
          {withdrawn ? (
            <button onClick={() => onRestore(fact)} disabled={busy} className={actionButton}>
              <Undo2 size={12} />
              Restore
            </button>
          ) : (
            <button onClick={() => onWithdraw(fact)} disabled={busy} className={actionButton}>
              <EyeOff size={12} />
              Withdraw
            </button>
          )}
          <button onClick={() => onRevertStart(fact)} disabled={busy} className={actionButton}>
            <RotateCcw size={12} />
            Revert
          </button>
        </div>
      </div>
      {reverting && (
        <RevertInput busy={busy} onConfirm={(text) => onRevertConfirm(fact, text)} onCancel={onRevertCancel} />
      )}
      {expanded &&
        (chain ? (
          <HistoryChain chain={chain} />
        ) : (
          <div className="mt-2 text-[11px] text-ink-secondary">Loading history…</div>
        ))}
    </div>
  );
}

/** Brain facts card for the settings memory tab: what the fleet brain
 * durably believes, with the correction chain behind each belief. This is
 * the card, so fetching and request state live here; the rows, chain and
 * revert input above are purely views. */
export function BrainFacts() {
  const [facts, setFacts] = useState<BrainFact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [chain, setChain] = useState<FactHistory | null>(null);
  const [revertId, setRevertId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFacts(await listBrainFacts());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleHistory = async (fact: BrainFact) => {
    if (expandedId === fact.id) {
      setExpandedId(null);
      setChain(null);
      return;
    }
    setExpandedId(fact.id);
    setChain(null);
    setError(null);
    try {
      setChain(await factHistory(fact.id));
    } catch (cause) {
      // no half-open expander when the chain cannot load — the error below says why
      setExpandedId(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const refresh = async () => {
    try {
      setFacts(await listBrainFacts());
      if (expandedId) setChain(await factHistory(expandedId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const withdraw = async (fact: BrainFact) => {
    setBusy(true);
    setError(null);
    try {
      await withdrawFact(fact.id);
      if (revertId === fact.id) setRevertId(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (fact: BrainFact) => {
    setBusy(true);
    setError(null);
    try {
      await restoreFact(fact.id);
      if (revertId === fact.id) setRevertId(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const revert = async (fact: BrainFact, text: string) => {
    setBusy(true);
    setError(null);
    try {
      await revertFact(fact.id, text);
      setRevertId(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        Brain facts
      </div>
      {facts === null && !error && <div className="text-[13px] text-ink-secondary">Loading…</div>}
      {facts !== null && facts.length === 0 && (
        <div className="text-[13px] text-ink-secondary">No brain facts yet.</div>
      )}
      {facts !== null && facts.length > 0 && (
        <div className="grid gap-2">
          {facts.map((fact) => (
            <FactRow
              key={fact.id}
              fact={fact}
              busy={busy}
              expanded={expandedId === fact.id}
              chain={expandedId === fact.id ? chain : null}
              reverting={revertId === fact.id}
              onToggleHistory={(f) => void toggleHistory(f)}
              onWithdraw={(f) => void withdraw(f)}
              onRestore={(f) => void restore(f)}
              onRevertStart={(f) => setRevertId(f.id)}
              onRevertCancel={() => setRevertId(null)}
              onRevertConfirm={(f, text) => void revert(f, text)}
            />
          ))}
        </div>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
