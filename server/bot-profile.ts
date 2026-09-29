// Shared saved/wire profile boundary. No device, provider or account lookup:
// repairing an incomplete record must never choose an engine or start work.
/* eslint-disable anti-slop/no-unknown-parameters -- This module is the saved-record and HTTP wire parsing boundary; every unknown input is schema-parsed here before producing domain values. */
import { z } from "zod";
import type { EffortLevel, ModelSelection } from "./contracts.ts";

// Kept browser-only at runtime; the boundary tests cover every canonical
// contract level so adding a new level cannot silently desynchronize them.
const effortSchema: z.ZodType<EffortLevel> = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);

const savedSelectionSchema = z.looseObject({
  instanceId: z.string().catch(""),
  model: z.string().catch(""),
  effort: effortSchema.optional().catch(undefined),
});
const profileSchema = z.object({
  title: z.string().catch(""),
  description: z.string().catch(""),
  color: z.enum(["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"]).catch("orange"),
  notifications: z.boolean().catch(false),
  unread: z.boolean().catch(false),
});
const cursorMapSchema = z.record(z.string(), z.unknown());

export function normalizeModelSelection(value: unknown): ModelSelection {
  const parsed = savedSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : { instanceId: "", model: "" };
}

/** Keep identity, transcripts, permissions and unknown fields untouched.
 * Only the required display/model fields get conservative defaults. */
export function normalizeBotProfile<T extends object>(bot: T) {
  const profile = profileSchema.parse(bot);
  const model = z.object({ modelSelection: z.unknown().optional() }).parse(bot);
  return { ...bot, ...profile, modelSelection: normalizeModelSelection(model.modelSelection) };
}

/** Internal saved bookkeeping only; never add it to public wire records. */
export function normalizeBotCursors(value: Record<string, string> | undefined): Record<string, string> {
  const parsed = cursorMapSchema.safeParse(value);
  return parsed.success && value ? value : {};
}

const selectionPatchSchema = z.looseObject({
  instanceId: z.string().optional(),
  model: z.string().optional(),
  effort: effortSchema.optional(),
}).refine(value => value.instanceId !== undefined || value.model !== undefined || value.effort !== undefined);

export function prepareModelSelectionPatch(value: unknown, previous: unknown):
  | { ok: true; selection: ModelSelection; explicitEffort: boolean }
  | { ok: false; error: string } {
  const parsed = selectionPatchSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.some(issue => issue.path[0] === "effort")
      ? "The requested effort level is not recognized."
      : "modelSelection must contain a string instanceId or model, or a valid effort level." };
  }
  const patch = parsed.data;
  const current = normalizeModelSelection(previous);
  // A complete selection replaces the old one: Settings' Default button
  // deliberately omits effort to clear it. Only partial updates are merged.
  const complete = patch.instanceId !== undefined && patch.model !== undefined;
  const changedEngine = patch.instanceId !== undefined && patch.instanceId !== current.instanceId;
  const base = complete || changedEngine ? { instanceId: patch.instanceId ?? "", model: "" } : current;
  return {
    ok: true,
    selection: normalizeModelSelection({ ...base, ...patch }),
    explicitEffort: patch.effort !== undefined,
  };
}
