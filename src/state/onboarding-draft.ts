import { z } from "zod";
import { DAILY_PLANNING_TASK } from "@/lib/daily-planning";
import { ONBOARDING_CHAT_BEATS } from "@/lib/onboarding-chat";

// Length caps in UTF-16 code units (string .length), matching what the
// server's limits measure. zod 4 changed `max()` to count codepoints, so
// astral characters (emoji) no longer overflow the same check — a 4001-unit
// draft would sail past z.string().max(4000) and overflow the API on restore.
const maxUtf16 = (max: number) =>
  z.string().refine((value) => value.length <= max, { message: `Too long: must be ${max} characters or fewer` });

/* Onboarding draft persistence — the wizard is component state, so a reload
 * or the sign-in round trip (AuthGate bounces to /sign-in and back in the
 * same tab) used to throw away everything the user had typed. Drafts live in
 * sessionStorage keyed per account: they survive the auth round trip and
 * reloads, stay out of other tabs/accounts, and are cleared on success or
 * deliberate abandonment. Storage is try/catch-guarded like chat-selection:
 * a blocked or absent storage must never break the wizard itself.
 *
 * First-task templates ride the same module: marketing deep links carry
 * ?template=<id>, and only IDs on the allowlist below prefill the first-task
 * input — the user still presses the finish button to send it. */

export interface SetupAxes {
  companion: number;
  tone: number;
  independence: number;
  depth: number;
  honesty: number;
}

export const ONBOARDING_STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "tour", label: "Tour" },
  { id: "engines", label: "Engines" },
  { id: "phone", label: "Phone" },
  { id: "teammate", label: "Teammate" },
  { id: "permissions", label: "Permissions" },
  { id: "first-task", label: "First task" },
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]["id"];

/* ── Presentation stages ──
 * The seven steps grouped into the five-phase arc the wizard narrates:
 * intro (welcome + tour) → connect (engines) → needs (phone + teammate) →
 * acks (permissions) → handoff (first task). Pure labeling: a stage never
 * changes what a step means, how it saves, or which draft fields it owns. */

export const ONBOARDING_STAGES = ["intro", "connect", "needs", "acks", "handoff"] as const;

export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

/** Exhaustive by construction — a new step id will not compile without a stage. */
const STEP_STAGES = {
  welcome: "intro",
  tour: "intro",
  engines: "connect",
  phone: "needs",
  teammate: "needs",
  permissions: "acks",
  "first-task": "handoff",
} satisfies Record<OnboardingStep, OnboardingStage>;

export function stageForStep(step: OnboardingStep): OnboardingStage {
  return STEP_STAGES[step];
}

/* ── First-task gate ──
 * Only the handoff step sends a real task, so only the handoff step needs a
 * connected engine. Every earlier step — and every escape hatch that finishes
 * without a task (Quick start, Skip, Maybe later, Escape) — stays free: the
 * wizard must never be able to brick itself when the user has no engine yet. */

const PERMISSIONS_INDEX = ONBOARDING_STEPS.findIndex((entry) => entry.id === "permissions");
const HANDOFF_INDEX = ONBOARDING_STEPS.length - 1;

export function canEnterStep(step: number, engineConnected: boolean): boolean {
  return engineConnected || step !== HANDOFF_INDEX;
}

/** A restored draft can sit past the gate (the engine went away while the
 * tab was closed). Park it on Permissions — the last free step, where the
 * wizard explains how to connect — and release it untouched once the gate
 * opens. */
export function clampOnboardingStep(step: number, engineConnected: boolean): number {
  if (canEnterStep(step, engineConnected)) return step;
  return PERMISSIONS_INDEX;
}

/** A first task may only be SENT from the handoff step with an engine. */
export function canSendFirstTask(step: number, engineConnected: boolean): boolean {
  return step === HANDOFF_INDEX && engineConnected;
}

/* ── Needs multi-select (Q2) ──
 * Option ids come from the chat engine's pains beat so a draft written by
 * either surface restores here, and the cap is the beat's own `max`. */

const PAINS_BEAT = ONBOARDING_CHAT_BEATS.find((beat) => beat.id === "pains");

export const ONBOARDING_NEED_OPTIONS = PAINS_BEAT?.options ?? [];
export const ONBOARDING_NEEDS_MAX = PAINS_BEAT?.max ?? 3;

const KNOWN_NEED_IDS = ONBOARDING_NEED_OPTIONS.map((option) => option.id);

/** Restored picks drop ids this build no longer offers (and any overflow past
 * the live cap), so a draft can never light up a chip that does not exist. */
export function sanitizeNeeds(ids: readonly string[] | undefined): string[] {
  return (ids ?? []).filter((id) => KNOWN_NEED_IDS.includes(id)).slice(0, ONBOARDING_NEEDS_MAX);
}

export interface OnboardingDraft {
  version: 2;
  step: OnboardingStep;
  /** Optional so drafts saved before welcome-field persistence still restore. */
  name?: string;
  email?: string;
  botName: string;
  botRole: string;
  botColor: string;
  botCharacter: string;
  suggestion: string;
  customTask: string;
  showPersonality: boolean;
  axes: SetupAxes;
  /** Optional so drafts saved before the needs step still restore. */
  needs?: string[];
  otherNeed?: string;
}

export interface OnboardingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Allowlisted first-task templates. Values mirror the onboarding suggestion
 * chips so a deep link lands on the same copy the wizard offers. Unknown IDs
 * resolve to "" and are ignored. */
export const FIRST_TASK_TEMPLATES = {
  "plan-my-day": DAILY_PLANNING_TASK,
  "weekly-priorities":
    "Help me get on top of my week — ask what's on my plate and figure out what to prioritize.",
  "field-brief": "Put together a quick brief on what's new in my field right now.",
  "notes-to-draft": "I'll paste some rough notes — turn them into a polished first draft.",
} as const;

export type FirstTaskTemplateId = keyof typeof FIRST_TASK_TEMPLATES;

export function resolveFirstTaskTemplate(id: string | null | undefined): string {
  if (!id || !Object.hasOwn(FIRST_TASK_TEMPLATES, id)) return "";
  // SAFETY: the own-property check limits id to this closed template map's keys.
  return FIRST_TASK_TEMPLATES[id as FirstTaskTemplateId];
}

export type FirstTaskDraft = Pick<OnboardingDraft, "suggestion" | "customTask">;

/** Live edits, including an explicit clear, take precedence when supplied.
 * Callers should pass live only after a user edit; a blank pristine input is
 * not an edit. A saved draft also wins even when both task fields are blank. */
export function resolveInitialTaskDraft(
  stored: FirstTaskDraft | null,
  templateId?: string | null,
  live?: FirstTaskDraft,
): FirstTaskDraft {
  const preferred = live ?? stored;
  if (preferred) return { suggestion: preferred.suggestion, customTask: preferred.customTask };
  return { suggestion: "", customTask: resolveFirstTaskTemplate(templateId) };
}

// Caps mirror the server's PATCH limits (name 100, title 200, description
// 4000) so a poisoned draft can't overflow the API on restore.
const draftSchema = z.object({
  version: z.literal(2),
  step: z.enum(ONBOARDING_STEPS.map((step) => step.id)),
  name: z.string().max(100).optional(),
  // Preserve unfinished email input; format validation belongs to submission.
  email: z.string().max(320).optional(),
  botName: z.string().max(100),
  botRole: maxUtf16(200),
  botColor: z.string().max(64),
  botCharacter: z.string().max(64),
  suggestion: maxUtf16(2000),
  customTask: maxUtf16(4000),
  showPersonality: z.boolean(),
  axes: z.object({
    companion: z.number().min(0).max(100),
    tone: z.number().min(0).max(100),
    independence: z.number().min(0).max(100),
    depth: z.number().min(0).max(100),
    honesty: z.number().min(0).max(100),
  }),
  // Lenient on restore (≤8 ids), strict at the UI (sanitizeNeeds trims to the
  // live cap): an older or hand-edited draft can never select a missing chip.
  needs: z.array(z.string().max(64)).max(8).optional(),
  otherNeed: maxUtf16(200).optional(),
});

// Version 1 used these same indexes for two different wizard layouts.
// Preserve its fields, but restart at Welcome rather than guess a step.
const legacyDraftSchema = draftSchema.extend({
  version: z.literal(1),
  step: z.number().int().min(0).max(4),
});

function draftStorage(): OnboardingStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    // Storage may be blocked by the browser or absent during server rendering.
    return null;
  }
}

function draftKey(accountId: string, version: 1 | 2): string {
  return `muster:onboarding-draft:v${version}:${encodeURIComponent(accountId)}`;
}

export function readOnboardingDraft(
  accountId: string | undefined,
  storage: OnboardingStorage | null = draftStorage(),
): OnboardingDraft | null {
  if (!accountId || !storage) return null;
  try {
    const saved = storage.getItem(draftKey(accountId, 2));
    if (saved !== null) {
      // A malformed current draft or a clear tombstone must never revive v1.
      const parsed = draftSchema.safeParse(JSON.parse(saved));
      return parsed.success ? parsed.data : null;
    }
    const legacy = storage.getItem(draftKey(accountId, 1));
    if (legacy === null) return null;
    const parsed = legacyDraftSchema.safeParse(JSON.parse(legacy));
    if (!parsed.success) return null;
    const migrated: OnboardingDraft = { ...parsed.data, version: 2, step: "welcome" };
    saveOnboardingDraft(accountId, migrated, storage);
    return migrated;
  } catch {
    return null;
  }
}

export function saveOnboardingDraft(
  accountId: string | undefined,
  draft: OnboardingDraft,
  storage: OnboardingStorage | null = draftStorage(),
): void {
  if (!accountId || !storage) return;
  try {
    const parsed = draftSchema.safeParse(draft);
    if (!parsed.success) return;
    storage.setItem(draftKey(accountId, 2), JSON.stringify(parsed.data));
    // Keep the only recoverable copy until the current version is stored.
    storage.removeItem(draftKey(accountId, 1));
  } catch {
    // The draft is an optimization; the wizard still works without storage.
  }
}

export function clearOnboardingDraft(
  accountId: string | undefined,
  storage: OnboardingStorage | null = draftStorage(),
): void {
  if (!accountId || !storage) return;
  try {
    storage.removeItem(draftKey(accountId, 1));
  } catch {
    // Removing v2 while v1 survives would expose an older draft. A current
    // tombstone clears both logically; if writes also fail, retain v2.
    try { storage.setItem(draftKey(accountId, 2), "null"); } catch { /* Storage remains unavailable. */ }
    return;
  }
  try {
    storage.removeItem(draftKey(accountId, 2));
  } catch {
    // Blocked storage must not interrupt completion; the current draft may remain.
  }
}
