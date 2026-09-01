// Dispatch — the chief-of-staff fan-out for an agent room's roster.
//
// A chief (an orchestrator bot) takes one task and splits it across the
// members of its room: planDispatch deals `subtaskCount` subtasks
// round-robin over the roster, the registry below tracks each subtask from
// pending through assigned to done/failed, and mergeDispatchResults renders
// the settled outcome as one summary the chief can post back. This is the
// bookkeeping half of delegation — it schedules and records work; it never
// talks to a bot or runs anything itself.
//
// The module is deliberately pure and deterministic: no I/O, no clock —
// every mutating call takes `now` from the caller (tests drive time), and
// the same room + request always yields the same plan. State is an
// in-memory registry bounded at MAX_DISPATCH_PLANS with least-recently-
// updated eviction, the same discipline as MAX_ROOMS in agent-rooms.ts.
// Zod schemas gate the wire shapes; everything below them works on decoded
// types only.

import { z } from "zod";

/** Subtask bounds for one fan-out. Fewer than two is not a split; more
 * than six floods the room with coordination overhead. */
export const MIN_SUBTASKS = 2;
export const MAX_SUBTASKS = 6;

/** How many dispatch plans may exist at once. Small on purpose: plans are
 * working state for in-flight fan-outs, and an unbounded registry lets
 * settled plans accumulate forever on a long-lived install. */
export const MAX_DISPATCH_PLANS = 100;

export type AssignmentStatus = "pending" | "assigned" | "done" | "failed";

/** Statuses an update may move an assignment TO. Nothing ever returns to
 * pending — a task that needs re-planning gets a new plan, not a rewind. */
export type AssignmentTransition = Exclude<AssignmentStatus, "pending">;

/** One member's slice of the split task. */
export interface DispatchAssignment {
  memberId: string;
  subtask: string;
  status: AssignmentStatus;
  /** The member's final word, recorded when the work settles. */
  result?: string;
  updatedAt: number;
}

export interface DispatchRequest {
  roomId: string;
  taskId: string;
  /** The task title subtask names are cut from. */
  title: string;
  subtaskCount: number;
  /** Advisory context for the chief; rides with the request, not the plan. */
  notes?: string;
}

export interface DispatchPlan {
  roomId: string;
  taskId: string;
  /** One per subtask, in subtask order (part 1 first). */
  assignments: DispatchAssignment[];
  createdAt: number;
  /** Also the eviction key — the least-recently-updated plan goes first. */
  updatedAt: number;
}

/** The slice of an agent room dispatch needs: where work can land. Members
 * are agent ids in roster order — planDispatch deals in exactly that order. */
export interface DispatchRoom {
  id: string;
  members: string[];
}

export type PlanFailureReason =
  | "no_members" // nothing to fan out to
  | "bad_subtask_count" // outside MIN_SUBTASKS..MAX_SUBTASKS, or not an integer
  | "bad_title" // nothing to derive subtask names from
  | "registry_full"; // defensive only; see createDispatchPlan

export type PlanResult =
  | { ok: true; plan: DispatchPlan }
  | { ok: false; reason: PlanFailureReason };

export type UpdateFailureReason =
  | "no_plan" // unknown taskId
  | "no_assignment" // no assignment under that member + subtask
  | "bad_transition"; // the status move is not a legal edge

export type UpdateResult =
  | { ok: true; plan: DispatchPlan }
  | { ok: false; reason: UpdateFailureReason };

export type MergeResult =
  | { ok: true; summary: string }
  | { ok: false; reason: "incomplete" };

export const dispatchRequestSchema = z.object({
  roomId: z.string().min(1),
  taskId: z.string().min(1),
  title: z.string().min(1),
  subtaskCount: z.number().int().min(MIN_SUBTASKS).max(MAX_SUBTASKS),
  notes: z.string().optional(),
}) satisfies z.ZodType<DispatchRequest>;

export const dispatchAssignmentSchema = z.object({
  memberId: z.string().min(1),
  subtask: z.string().min(1),
  status: z.enum(["pending", "assigned", "done", "failed"]),
  result: z.string().optional(),
  updatedAt: z.number().finite().nonnegative(),
}) satisfies z.ZodType<DispatchAssignment>;

export const dispatchPlanSchema = z.object({
  roomId: z.string().min(1),
  taskId: z.string().min(1),
  assignments: z.array(dispatchAssignmentSchema).min(1),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
}) satisfies z.ZodType<DispatchPlan>;

/** Deal `subtaskCount` subtasks across the roster round-robin: subtask i
 * goes to members[i % members.length], so a roster of three receives parts
 * 1,2,3,1,2,… in roster order. Subtask names are cut from the request title
 * so every member's brief names its slice ("Title — part 2 of 5").
 * Deterministic: the same room + request + now always yields the same plan. */
export function planDispatch(room: DispatchRoom, request: DispatchRequest, now: number): PlanResult {
  if (
    !Number.isInteger(request.subtaskCount) ||
    request.subtaskCount < MIN_SUBTASKS ||
    request.subtaskCount > MAX_SUBTASKS
  ) {
    return { ok: false, reason: "bad_subtask_count" };
  }
  if (room.members.length === 0) return { ok: false, reason: "no_members" };
  const title = request.title.trim();
  if (!title) return { ok: false, reason: "bad_title" };
  const assignments: DispatchAssignment[] = [];
  for (let index = 0; index < request.subtaskCount; index += 1) {
    assignments.push({
      memberId: room.members[index % room.members.length],
      subtask: `${title} — part ${index + 1} of ${request.subtaskCount}`,
      status: "pending",
      updatedAt: now,
    });
  }
  return {
    ok: true,
    plan: { roomId: room.id, taskId: request.taskId, assignments, createdAt: now, updatedAt: now },
  };
}

const plans = new Map<string, DispatchPlan>();

const copyAssignment = (assignment: DispatchAssignment): DispatchAssignment => ({ ...assignment });

/** Copies on the way out: mutating a returned plan never reaches the store. */
const copyPlan = (plan: DispatchPlan): DispatchPlan => ({
  ...plan,
  assignments: plan.assignments.map(copyAssignment),
});

/** Drop the least-recently-updated plan. Returns whether one was evicted. */
function evictStalest(): boolean {
  let stalest: DispatchPlan | undefined;
  for (const plan of plans.values()) {
    if (!stalest || plan.updatedAt < stalest.updatedAt) stalest = plan;
  }
  if (!stalest) return false;
  plans.delete(stalest.taskId);
  return true;
}

/** Plan a fan-out and file it under the request's taskId. Re-planning a
 * taskId replaces the earlier plan (a retry starts from a clean slate), and
 * the delete-then-set keeps Map insertion order honest for eviction
 * tie-breaks. */
export function createDispatchPlan(room: DispatchRoom, request: DispatchRequest, now: number): PlanResult {
  const planned = planDispatch(room, request, now);
  if (!planned.ok) return planned;
  plans.delete(planned.plan.taskId);
  if (plans.size >= MAX_DISPATCH_PLANS && !evictStalest()) {
    // Defensive only: a map at the cap is never empty, so eviction always
    // succeeds — this branch keeps the cap airtight if that ever breaks.
    return { ok: false, reason: "registry_full" };
  }
  plans.set(planned.plan.taskId, planned.plan);
  return { ok: true, plan: copyPlan(planned.plan) };
}

/** One plan by taskId, or undefined. Always a copy — mutating a result
 * never reaches the store. */
export function getDispatchPlan(taskId: string): DispatchPlan | undefined {
  const plan = plans.get(taskId);
  return plan ? copyPlan(plan) : undefined;
}

/** All plans, most recently active first — what a panel listing reads. */
export function listDispatchPlans(): DispatchPlan[] {
  return [...plans.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(copyPlan);
}

/** The only legal status edges: a member claims work before settling it,
 * and settled work never moves again. A merge trusts these flags, so the
 * gates here are what keep that trust sound. */
function canTransition(from: AssignmentStatus, to: AssignmentTransition): boolean {
  if (from === "pending") return to === "assigned";
  if (from === "assigned") return to === "done" || to === "failed";
  return false; // done and failed are terminal
}

/** Move one assignment along its only legal path: pending → assigned →
 * done | failed. `now` stamps both the assignment and the plan (the plan's
 * stamp doubles as its LRU refresh), and `result` records the member's
 * final word on settlement. */
export function updateAssignment(
  taskId: string,
  memberId: string,
  subtask: string,
  status: AssignmentTransition,
  now: number,
  result?: string,
): UpdateResult {
  const plan = plans.get(taskId);
  if (!plan) return { ok: false, reason: "no_plan" };
  const assignment = plan.assignments.find(
    (candidate) => candidate.memberId === memberId && candidate.subtask === subtask,
  );
  if (!assignment) return { ok: false, reason: "no_assignment" };
  if (!canTransition(assignment.status, status)) return { ok: false, reason: "bad_transition" };
  assignment.status = status;
  if (result !== undefined) assignment.result = result;
  assignment.updatedAt = now;
  plan.updatedAt = now;
  return { ok: true, plan: copyPlan(plan) };
}

/** Merge a settled plan into one summary the chief can post back: a count
 * line, then one line per subtask naming the member, the slice, and how it
 * ended (plus its final word, when it left one). Refuses while any
 * subtask is still pending or assigned — a summary over unfinished work
 * would let the chief report progress nobody made. */
export function mergeDispatchResults(plan: DispatchPlan): MergeResult {
  const unsettled = plan.assignments.some((a) => a.status === "pending" || a.status === "assigned");
  if (unsettled) return { ok: false, reason: "incomplete" };
  const done = plan.assignments.filter((a) => a.status === "done").length;
  const failed = plan.assignments.length - done;
  const lines = plan.assignments.map((assignment) => {
    const detail = assignment.result?.trim();
    return `- ${assignment.memberId}: ${assignment.subtask} — ${assignment.status}${detail ? `: ${detail}` : ""}`;
  });
  const header = `Task ${plan.taskId} (room ${plan.roomId}): ${done} done, ${failed} failed`;
  return { ok: true, summary: [header, ...lines].join("\n") };
}

/** Test helper: forget the in-memory registry. */
export function _resetDispatchPlans(): void {
  plans.clear();
}
