/* TeachReplay's pure core — the trajectory schema, parameter substitution and
 * the replay verifier, with no harness attached.
 *
 * A demonstration records clicks by semantic role + accessible name, typed
 * values and shell commands. Nothing here is pixel-addressed: mild UI drift
 * survives a replay, and severe drift fails the verdict instead of passing
 * silently. A value demonstrated while recording carries the demonstration as
 * its default, so compiling a trajectory yields the skill's declared input
 * list and substitution never has to invent one.
 *
 * Deliberately free of Electron, filesystem, network and server/electron
 * imports. Adapters execute and observe through the StepRunner seam; the test
 * suite asserts zod is the only import this module is allowed to keep. */

import { z } from "zod";

/** A value that is genuinely a string at runtime, not merely typed as one. */
const isText = <T>(value: T): value is T & string => String(value) === value;

export const TEACH_REPLAY_SCHEMA_VERSION = 1;

// A demonstrated value is either a literal the recording captured or a named
// input whose default is the value that was demonstrated.
const teachValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }).strict(),
  z.object({ kind: z.literal("input"), name: z.string().min(1), default: z.string() }).strict(),
]);

const clickStepSchema = z
  .object({
    kind: z.literal("click"),
    role: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

const typeStepSchema = z
  .object({
    kind: z.literal("type"),
    role: z.string().min(1),
    name: z.string().min(1),
    value: teachValueSchema,
  })
  .strict();

const shellStepSchema = z
  .object({
    kind: z.literal("shell"),
    command: teachValueSchema,
  })
  .strict();

const stepSchema = z.discriminatedUnion("kind", [clickStepSchema, typeStepSchema, shellStepSchema]);

// Strict objects on purpose: a stored trajectory with a stray key is a schema
// mismatch to be reported, not data to be quietly dropped.
const trajectorySchema = z
  .object({
    version: z.literal(TEACH_REPLAY_SCHEMA_VERSION),
    steps: z.array(stepSchema),
  })
  .strict();

export type TeachValue = z.infer<typeof teachValueSchema>;
export type TeachClickStep = z.infer<typeof clickStepSchema>;
export type TeachTypeStep = z.infer<typeof typeStepSchema>;
export type TeachShellStep = z.infer<typeof shellStepSchema>;
export type TeachStep = z.infer<typeof stepSchema>;
export type TeachTrajectory = z.infer<typeof trajectorySchema>;

export interface TeachInput {
  name: string;
  /** The value observed during recording; replay uses it when no override is supplied. */
  default: string;
}

export interface TeachSkill {
  version: typeof TEACH_REPLAY_SCHEMA_VERSION;
  steps: TeachStep[];
  inputs: TeachInput[];
}

export type ResolvedStep =
  | { kind: "click"; role: string; name: string }
  | { kind: "type"; role: string; name: string; value: string }
  | { kind: "shell"; command: string };

export interface ReplayVerdict {
  ok: boolean;
  failedStep?: number;
  observed?: string;
  expected?: string;
}

export interface StepObservation {
  /** The signal the backend actually matched at this step. */
  observed?: string;
  /** Backend-level failure (target missing, command refused); fails the step. */
  error?: string;
}

export type StepRunner = (step: ResolvedStep, index: number) => StepObservation;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

export function parseTrajectory(json: string): TeachTrajectory {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("TeachReplay trajectory is not valid JSON.");
  }
  const parsed = trajectorySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`TeachReplay trajectory failed validation — ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function serializeTrajectory(trajectory: TeachTrajectory): string {
  const parsed = trajectorySchema.safeParse(trajectory);
  if (!parsed.success) {
    throw new Error(`TeachReplay trajectory failed validation — ${formatIssues(parsed.error)}`);
  }
  return JSON.stringify(parsed.data);
}

/** Collects the inputs a demonstration declared, in first-appearance order.
 * The same input may appear in several steps, but only if every appearance
 * agrees on the demonstrated default — otherwise the skill has no single
 * default and the compile must fail rather than pick one silently. */
export function compileTrajectory(trajectory: TeachTrajectory): TeachSkill {
  const parsed = trajectorySchema.safeParse(trajectory);
  if (!parsed.success) {
    throw new Error(`TeachReplay trajectory failed validation — ${formatIssues(parsed.error)}`);
  }

  const inputs: TeachInput[] = [];
  const defaults = new Map<string, string>();
  for (const step of parsed.data.steps) {
    const values = step.kind === "click" ? [] : step.kind === "type" ? [step.value] : [step.command];
    for (const value of values) {
      if (value.kind !== "input") continue;
      const seen = defaults.get(value.name);
      if (seen !== undefined) {
        if (seen !== value.default) {
          throw new Error(
            `TeachReplay input "${value.name}" was demonstrated with conflicting defaults "${seen}" and "${value.default}".`,
          );
        }
        continue;
      }
      defaults.set(value.name, value.default);
      inputs.push({ name: value.name, default: value.default });
    }
  }

  return { version: parsed.data.version, steps: parsed.data.steps, inputs };
}

export function substituteInputs(
  skill: TeachSkill,
  overrides: Record<string, string> = {},
): ResolvedStep[] {
  const declared = new Set(skill.inputs.map((input) => input.name));
  for (const [name, value] of Object.entries(overrides)) {
    if (!declared.has(name)) {
      throw new Error(`TeachReplay skill declares no input "${name}".`);
    }
    if (!isText(value)) {
      throw new Error(`TeachReplay input "${name}" must be a string.`);
    }
  }

  const defaults = new Map(skill.inputs.map((input) => [input.name, input.default]));
  const resolve = (value: TeachValue): string => {
    if (value.kind === "literal") return value.value;
    if (Object.hasOwn(overrides, value.name)) return overrides[value.name];
    return defaults.get(value.name) ?? value.default;
  };

  return skill.steps.map((step) => {
    switch (step.kind) {
      case "click":
        return { kind: "click" as const, role: step.role, name: step.name };
      case "type":
        return { kind: "type" as const, role: step.role, name: step.name, value: resolve(step.value) };
      case "shell":
        return { kind: "shell" as const, command: resolve(step.command) };
    }
  });
}

function expectedFor(step: ResolvedStep): string {
  switch (step.kind) {
    case "click":
      return `${step.role} "${step.name}"`;
    case "type":
      return step.value;
    case "shell":
      return step.command;
  }
}

/** Runs a compiled skill against an injected backend and returns an explicit
 * verdict. There is no bare-success path: an empty skill verifies vacuously
 * but still yields a verdict object, and any divergence names the step. */
export function replaySkill(
  skill: TeachSkill,
  overrides: Record<string, string>,
  runStep: StepRunner,
): ReplayVerdict {
  const steps = substituteInputs(skill, overrides);
  for (let index = 0; index < steps.length; index += 1) {
    const expected = expectedFor(steps[index]);
    // A backend that throws is still a replay failure, not an escape hatch
    // from the verdict contract: convert it into a named failed step so the
    // caller never receives a bare exception where a verdict was promised.
    let outcome: StepObservation = {};
    try {
      outcome = runStep(steps[index], index) ?? {};
    } catch (cause) {
      const observed = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, failedStep: index, observed, expected };
    }
    if (outcome.error !== undefined) {
      return { ok: false, failedStep: index, observed: outcome.error, expected };
    }
    if (outcome.observed !== expected) {
      return outcome.observed === undefined
        ? { ok: false, failedStep: index, expected }
        : { ok: false, failedStep: index, observed: outcome.observed, expected };
    }
  }
  return { ok: true };
}