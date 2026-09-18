// The conversational onboarding beats engine — GAIA-style chat onboarding,
// Muster-native: the assistant asks one question per beat, every answer is a
// chip, and the user's picks become their own bubbles. Pure and testable
// (the OMB welcome-flow discipline: beat order as tested logic).
//
// The flow only runs on hosted deployments (storageGate.required) after the
// storage gate opens; desktop keeps the classic wizard untouched.

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
