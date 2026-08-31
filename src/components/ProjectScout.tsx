import { useState } from "react";

import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";

interface SuggestedMember {
  name: string;
  title: string;
  description: string;
  color: string;
}

interface ScoutResult {
  profile: { name: string; summary: string; stacks: string[] };
  suggestion: { roomName: string; members: SuggestedMember[]; reasons: Record<string, string> };
}

/** Point the scout at a folder, review the suggested lineup, create the
 * team. The server only reads and suggests; creating goes through the same
 * per-bot endpoints as a hand-made bot, one human click for the whole set. */
export function ProjectScout({ onDone }: { onDone: () => void }) {
  const { dispatch } = useStore();
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScoutResult | null>(null);

  const scout = async () => {
    if (!cwd.trim() || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const body = await api("/api/scout", { method: "POST", body: JSON.stringify({ cwd: cwd.trim() }) });
      // SAFETY: /api/scout is this repo's own endpoint; its reply shape is the profile + suggestion rendered below.
      setResult(body as ScoutResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scout failed");
    } finally {
      setBusy(false);
    }
  };

  const createTeam = async () => {
    if (!result || busy) return;
    setBusy(true);
    try {
      let leadId: string | undefined;
      for (const member of result.suggestion.members) {
        // SAFETY: POST /api/bots is this repo's own endpoint; it replies {bot:{id}}.
        const created = (await api("/api/bots", { method: "POST" })) as { bot: { id: string } };
        if (!leadId) leadId = created.bot.id;
        await api(`/api/bots/${created.bot.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: member.name,
            title: member.title,
            description: member.description,
            color: member.color,
          }),
        });
      }
      if (leadId) dispatch({ type: "select", id: leadId });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the team");
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-[520px] rounded-xl bg-card p-4 text-left shadow-[0_12px_40px_rgba(0,0,0,0.35)]">
      <div className="text-[15px] font-medium text-ink">Scout a project folder</div>
      <div className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">
        Point Muster at a checkout and it proposes a starting lineup of agents — read-only, nothing is created until you approve.
      </div>
      <div className="mt-3 flex gap-2">
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void scout()}
          placeholder="/absolute/path/to/project"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
        />
        <button
          onClick={() => void scout()}
          disabled={busy || !cwd.trim()}
          className="rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy && !result ? "Scouting…" : "Scout"}
        </button>
      </div>
      {error && <div className="mt-2 text-[12.5px] text-danger">{error}</div>}
      {result && (
        <div className="mt-3">
          <div className="text-[13px] text-ink">
            <span className="font-semibold">{result.suggestion.roomName}</span>
            {result.profile.stacks.length > 0 && (
              <span className="text-ink-secondary"> · {result.profile.stacks.join(", ")}</span>
            )}
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {result.suggestion.members.map((m) => (
              <div key={m.name} className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-ink">{m.name}</span>
                  <span className="text-[12px] text-ink-secondary">{m.title}</span>
                </div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                  {result.suggestion.reasons[m.name]}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={onDone}
              className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              Not now
            </button>
            <button
              onClick={() => void createTeam()}
              disabled={busy}
              className={cn("rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40")}
            >
              {busy ? "Creating…" : `Create ${result.suggestion.members.length} agents`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
