import { z } from "zod";

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

export interface OnboardingDraft {
  version: 1;
  step: number;
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
  version: z.literal(1),
  step: z.number().int().min(0).max(4),
  name: z.string().max(100).optional(),
  // Preserve unfinished email input; format validation belongs to submission.
  email: z.string().max(320).optional(),
  botName: z.string().max(100),
  botRole: z.string().max(200),
  botColor: z.string().max(64),
  botCharacter: z.string().max(64),
  suggestion: z.string().max(2000),
  customTask: z.string().max(4000),
  showPersonality: z.boolean(),
  axes: z.object({
    companion: z.number().min(0).max(100),
    tone: z.number().min(0).max(100),
    independence: z.number().min(0).max(100),
    depth: z.number().min(0).max(100),
    honesty: z.number().min(0).max(100),
  }),
});

function draftStorage(): OnboardingStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    // Storage may be blocked by the browser or absent during server rendering.
    return null;
  }
}

function draftKey(accountId: string): string {
  return `muster:onboarding-draft:v1:${encodeURIComponent(accountId)}`;
}

export function readOnboardingDraft(
  accountId: string | undefined,
  storage: OnboardingStorage | null = draftStorage(),
): OnboardingDraft | null {
  if (!accountId || !storage) return null;
  try {
    const saved = storage.getItem(draftKey(accountId));
    if (!saved) return null;
    const parsed = draftSchema.safeParse(JSON.parse(saved));
    return parsed.success ? parsed.data : null;
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
    storage.setItem(draftKey(accountId), JSON.stringify(parsed.data));
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
    storage.removeItem(draftKey(accountId));
  } catch {
    // Blocked storage must not interrupt completion; an old draft may remain.
  }
}
