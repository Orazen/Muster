// The conversational onboarding beats engine — GAIA-style chat onboarding,
// Muster-native: the assistant asks one question per beat, every answer is a
// chip, and the user's picks become their own bubbles. Pure and testable
// (the OMB welcome-flow discipline: beat order as tested logic).
//
// The flow only runs on hosted deployments (storageGate.required) after the
// storage gate opens; desktop keeps the classic wizard untouched.

import { z } from "zod";

export interface ChatBeatOption {
  id: string;
  label: string;
  emoji?: string;
}

export interface ChatBeat {
  id: "greet" | "role" | "pains" | "crew" | "done";
  /** assistant lines before the question */
  intro: string[];
  question: string;
  /** single = one chip; multi = up to `max` chips */
  kind: "single" | "multi" | "none";
  options?: ChatBeatOption[];
  max?: number;
}

export const ONBOARDING_CHAT_BEATS: ReadonlyArray<ChatBeat> = [
  {
    id: "greet",
    kind: "none",
    intro: ["Hey {name}! I'm Muster. Nice to meet you.", "Think about the work that piles up — the research, the chasing, the thing you do every week and hate. Your teammates do all of that. Not you."],
    question: "First — what do you do for work?",
  },
  {
    id: "role",
    kind: "single",
    intro: [],
    question: "So, what do you do for work?",
    options: [
      { id: "founder", label: "Founder / CEO", emoji: "🚀" },
      { id: "executive", label: "Executive", emoji: "💼" },
      { id: "engineering", label: "Engineering", emoji: "{}" },
      { id: "marketing", label: "Marketing", emoji: "📣" },
      { id: "creative", label: "Creative", emoji: "🎨" },
      { id: "sales", label: "Sales", emoji: "🤝" },
      { id: "ops", label: "Operations", emoji: "🗂️" },
      { id: "student", label: "Student", emoji: "🎓" },
      { id: "other", label: "Other", emoji: "✨" },
    ],
  },
  {
    id: "pains",
    kind: "multi",
    intro: ["Got it."],
    question: "What do you want off your plate first? Pick up to three.",
    max: 3,
    options: [
      { id: "research", label: "Research I keep putting off", emoji: "🔍" },
      { id: "writing", label: "Writing everything myself", emoji: "✍️" },
      { id: "inbox", label: "Inbox out of control", emoji: "📥" },
      { id: "meetings", label: "Walking into meetings cold", emoji: "📅" },
      { id: "grunt", label: "Grunt work every week", emoji: "🔁" },
      { id: "tracking", label: "Things I keep forgetting", emoji: "🧠" },
      { id: "tools", label: "Too many tools to juggle", emoji: "🧰" },
      { id: "other", label: "Something else", emoji: "💬" },
    ],
  },
  {
    id: "crew",
    kind: "single",
    intro: ["Here's the plan — a small crew that takes exactly those off your plate. Pick one to hire now, or start empty and hire later."],
    question: "Hire your first crew?",
    options: [
      { id: "research-desk", label: "Research desk", emoji: "📖" },
      { id: "writing-pod", label: "Writing pod", emoji: "✒️" },
      { id: "engineering", label: "Engineering crew", emoji: "🛠️" },
      { id: "ops", label: "Operations team", emoji: "🧭" },
      { id: "empty", label: "Start empty", emoji: "🚪" },
    ],
  },
  {
    id: "done",
    kind: "none",
    intro: ["They're hired and already on your roster.", "Give them a first task — they'll ask before anything risky."],
    question: "Ready when you are.",
  },
] as const;

export function beatAt(index: number): ChatBeat {
  return ONBOARDING_CHAT_BEATS[Math.max(0, Math.min(index, ONBOARDING_CHAT_BEATS.length - 1))];
}

export function beatCount(): number {
  return ONBOARDING_CHAT_BEATS.length;
}

export const ONBOARDING_CHAT_DONE_KEY = "muster.onboarding-chat.done";

/** True when the conversational first-run has finished (or been dismissed).
 * The classic wizard's auto-open waits for this so both surfaces never fight
 * over the first-run moment or the focus. Reads ONLY the bare flag — every
 * current read of the flag keeps working, record or no record. */
export function onboardingChatDone(): boolean {
  try { return window.localStorage.getItem(ONBOARDING_CHAT_DONE_KEY) === "1"; } catch { return false; }
}

/** Which first-run surface a completion record belongs to. */
export type OnboardingSurface = "chat" | "wizard";

/** The versioned completion record (openbot's setup-v2 artifact, adapted):
 * written BESIDE the existing flags, never replacing them. */
export const ONBOARDING_COMPLETION_KEY = "muster.onboarding-done:v1";

export interface OnboardingCompletionRecord {
  version: number;
  /** epoch ms of the FIRST recorded completion; null when unknown — the
   * legacy bare flag predates the record and carries no timestamp. */
  completedAt: number | null;
  surface: OnboardingSurface;
}

/** Strict parse of the record itself. Anything malformed reads as absent —
 * a corrupt record can only fall back to the legacy flag, never block it. */
const completionSchema = z.object({
  version: z.number(),
  completedAt: z.number().nullable(),
  surface: z.enum(["chat", "wizard"]),
});

function parseCompletion(raw: string | null): OnboardingCompletionRecord | null {
  if (!raw) return null;
  try {
    // Same stored-JSON discipline as onboarding-draft: schema at the boundary,
    // malformed input fails closed to "absent" instead of blocking the flag.
    const parsed = completionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The completion record with the backwards-compatible read: an install that
 * only carries the bare `"1"` flag counts as version 1 with an unknown
 * completion time and the chat surface (the flag is the chat surface's). */
export function readOnboardingCompletion(): OnboardingCompletionRecord | null {
  try {
    const record = parseCompletion(window.localStorage.getItem(ONBOARDING_COMPLETION_KEY));
    if (record) return record;
    if (window.localStorage.getItem(ONBOARDING_CHAT_DONE_KEY) === "1") {
      return { version: 1, completedAt: null, surface: "chat" };
    }
    return null;
  } catch {
    return null;
  }
}

/** Write the record for a surface. The FIRST completion wins: a later write
 * never re-stamps completedAt (or the surface) — a replay or review is not a
 * new onboarding. A malformed record is repaired in place. Never throws:
 * blocked storage loses only the record, the bare flags still guard the flow. */
export function writeOnboardingCompletion(surface: OnboardingSurface): void {
  try {
    if (parseCompletion(window.localStorage.getItem(ONBOARDING_COMPLETION_KEY))) return;
    window.localStorage.setItem(ONBOARDING_COMPLETION_KEY, JSON.stringify({
      version: 1,
      completedAt: Date.now(),
      surface,
    } satisfies OnboardingCompletionRecord));
  } catch {
    // Private mode / quota: the flags beside this record still count as done.
  }
}

/** The chat surface's finish-or-dismiss write: the bare flag AND the versioned
 * record, together. Flag first — the record is only ever written BESIDE a flag
 * that landed, so every existing read of the flag keeps working unchanged.
 * Never throws: blocked storage loses only the persistence, callers continue
 * exactly as they did with the previous inline flag write. */
export function markOnboardingChatDone(): void {
  try {
    window.localStorage.setItem(ONBOARDING_CHAT_DONE_KEY, "1");
  } catch {
    return; // private mode: no flag → no record beside it
  }
  writeOnboardingCompletion("chat");
}

/** A chat turn for the transcript: who said it and what. */
export type Turn =
  | { who: "assistant"; text: string }
  | { who: "user"; text: string };

export interface CrewMember {
  name: string;
  title: string;
  description: string;
}

const CREWS = {
  "research-desk": [
    { name: "Scout", title: "finding sources", description: "Runs wide searches and returns candidates with links and dates." },
    { name: "Scholar", title: "reading and synthesis", description: "Reads sources properly and separates verified facts from claims." },
  ],
  "writing-pod": [
    { name: "Writer", title: "drafts and content", description: "Drafts posts, emails and docs in your voice. Asks before inventing facts." },
    { name: "Editor", title: "review and polish", description: "Tightens structure and tone; flags anything unverified." },
  ],
  engineering: [
    { name: "Coder", title: "feature implementation", description: "Takes a ticket, works the repo, reports a diff." },
    { name: "Reviewer", title: "code review", description: "Reads diffs before they land: correctness, edge cases, tests." },
  ],
  ops: [
    { name: "Chief", title: "coordination", description: "Splits work across the team, tracks it, merges results." },
    { name: "Archivist", title: "records and memory", description: "Files what happened and finds it again. Provenance on every fact." },
  ],
} satisfies Record<string, CrewMember[]>;

/** Which crew the answers point at, and what each member should know. The
 * pains sharpen the crew's descriptions so the hire feels chosen, not
 * generic. `empty` and unknown ids return null — the caller creates nothing. */
export function planCrew(crewId: string, pains: string[]): { key: string; members: CrewMember[] } | null {
  // SAFETY: the id originates from the crew beat's own option list; unknown
  // ids (and the deliberate "empty" path) fall through to null.
  const members: CrewMember[] | undefined = CREWS[crewId as keyof typeof CREWS];
  if (!members) return null;
  const painLabels = (ONBOARDING_CHAT_BEATS.find((b) => b.id === "pains")?.options ?? [])
    .filter((o) => pains.includes(o.id))
    .map((o) => o.label.toLowerCase());
  const sharpened = members.map((m) => ({
    ...m,
    description: painLabels.length
      ? `${m.description} First focus: ${painLabels.slice(0, 2).join(" and ")}.`
      : m.description,
  }));
  return { key: crewId, members: sharpened };
}
