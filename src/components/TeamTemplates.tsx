// Hire-a-team-in-60s (decision 13): after the storage gate opens, a hosted
// user's roster is empty — this step offers curated, pre-written teams. Keys
// are BYOK and asked at first task (decision: "keys at first task"), so a
// hired teammate starts with the default model picker and prompts honestly
// when it is first tasked without one.
import { useEffect, useState } from "react";

import { api, useStore } from "@/state/store";

interface TemplateMember { name: string; title: string; description: string }
interface TeamTemplate { id: string; name: string; blurb: string; members: TemplateMember[] }

const TEAMS: TeamTemplate[] = [
  {
    id: "engineering",
    name: "Engineering crew",
    blurb: "Ship features: one builds, one reviews, one keeps the machines running.",
    members: [
      { name: "Coder", title: "feature implementation", description: "Writes and refactors code. Takes a ticket, works the repo, reports a diff." },
      { name: "Reviewer", title: "code review", description: "Reads diffs before they land: correctness, edge cases, tests. Confident, specific comments." },
      { name: "Keeper", title: "builds and deploys", description: "Owns typecheck, tests and deploys. Ships only what is verified." },
    ],
  },
  {
    id: "marketing",
    name: "Marketing pod",
    blurb: "Position, write and measure — a launch week in a box.",
    members: [
      { name: "Strategist", title: "positioning and plans", description: "Turns a vague product into a sharp story and a weekly plan." },
      { name: "Writer", title: "copy and content", description: "Drafts posts, emails and landing copy in your voice. Asks before inventing facts." },
      { name: "Analyst", title: "metrics and research", description: "Reads the numbers, studies competitors, reports what changed and why." },
    ],
  },
  {
    id: "research",
    name: "Research desk",
    blurb: "Deep dives with receipts: scout, verify, summarize.",
    members: [
      { name: "Scout", title: "finding sources", description: "Runs wide searches, returns candidates with links and dates." },
      { name: "Scholar", title: "reading and synthesis", description: "Reads the sources properly and separates verified facts from claims." },
      { name: "Scribe", title: "briefs and notes", description: "Writes the one-page brief with citations. Never invents a citation." },
    ],
  },
  {
    id: "operations",
    name: "Operations team",
    blurb: "The back office: coordinate, remember, report.",
    members: [
      { name: "Chief", title: "coordination", description: "Splits work across the team, tracks it, merges the results." },
      { name: "Archivist", title: "records and memory", description: "Files what happened and finds it again. Provenance on every fact." },
      { name: "Envoy", title: "drafts and replies", description: "Handles outgoing messages for your approval. Nothing sends unsigned." },
    ],
  },
];

const DISMISS_KEY = "muster.team-templates.dismissed";

export function TeamTemplates() {
  const { state } = useStore();
  const [hiring, setHiring] = useState<string | null>(null);
  const [hired, setHired] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return window.localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });

  // Shown only on a gated (hosted) deployment whose gate just opened and
  // whose roster is still empty — and only when the conversational
  // onboarding has finished (the chat is the first-run hire; this card is
  // its fallback if the chat was dismissed without hiring).
  const chatDone = (() => {
    try { return window.localStorage.getItem("muster.onboarding-chat.done") === "1"; } catch { return false; }
  })();
  const shown = state.config?.storageGate?.required === true
    && state.config.storageGate.satisfied
    && state.bots.length === 0
    && chatDone
    && !dismissed;

  // The SSE/bots hydration may land after this mounts; re-read the flag so a
  // race never buries the step under a user who already has teammates.
  useEffect(() => { /* bots arrive via hydration; render follows state */ }, [state.bots.length]);

  if (!shown) return null;

  const hire = async (team: TeamTemplate) => {
    setHiring(team.id);
    setError(null);
    try {
      for (const member of team.members) {
        // SAFETY: the create endpoint answers {bot:{id}}; the patch fails
        // loudly below if the id were missing.
        const created = await api("/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }) as { bot?: { id?: string } };
        const id = created?.bot?.id;
        if (!id) throw new Error(`could not create ${member.name}`);
        await api(`/api/bots/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(member) });
      }
      setHired(team.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Hiring failed — try again.");
    } finally {
      setHiring(null);
    }
  };

  if (hired) {
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" role="status">
        <div className="glass-shell w-full max-w-md rounded-2xl bg-surface p-7 text-center shadow-2xl">
          <h1 className="text-xl font-semibold text-ink">Your {hired.toLowerCase()} is hired</h1>
          <p className="mt-3 text-[13.5px] text-ink-secondary">
            Give them their first task — they'll ask for the API key they need the first time they work.
          </p>
          {/* The hired roster arrives over SSE and unmounts this overlay on
              its own; this button is the immediate acknowledgment. */}
          <button
            onClick={() => {
              try { window.localStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
              setDismissed(true);
            }}
            className="mt-5 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
          >
            Meet your team
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Hire your first team">
      <div className="glass-shell w-full max-w-2xl rounded-2xl bg-surface p-7 shadow-2xl">
        <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.3em] text-accent opacity-80">Your storage is connected</div>
        <h1 className="text-xl font-semibold text-ink">Hire your first team</h1>
        <p className="mt-2 text-[13.5px] text-ink-secondary">Pick a ready-made crew — personalities included, rename anything later.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {TEAMS.map((team) => (
            <div key={team.id} className="flex flex-col rounded-xl border border-hairline bg-raised p-4">
              <div className="font-medium text-ink">{team.name}</div>
              <div className="mt-1 flex-1 text-[12.5px] leading-relaxed text-ink-secondary">{team.blurb}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {team.members.map((m) => (
                  <span key={m.name} className="rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-secondary">{m.name}</span>
                ))}
              </div>
              <button
                onClick={() => void hire(team)}
                disabled={hiring !== null}
                className="mt-3 self-start rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white transition-all hover:brightness-110 disabled:opacity-60"
              >
                {hiring === team.id ? "Hiring…" : `Hire ${team.members.length} teammates`}
              </button>
            </div>
          ))}
        </div>
        {error && <p role="alert" className="mt-4 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink">{error}</p>}
        <button
          onClick={() => {
            try { window.localStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
            setDismissed(true);
          }}
          className="mt-4 text-[12.5px] text-ink-secondary underline decoration-hairline underline-offset-4 transition-colors hover:text-ink"
        >
          Start empty — I'll hire teammates myself
        </button>
      </div>
    </div>
  );
}
