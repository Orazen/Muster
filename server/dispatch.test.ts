// Dispatch — pure registry logic. Every test drives the injected clock
// directly and starts from an empty registry, so nothing here waits on
// real time or on the store: dispatch knows nothing about bots' threads.
import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_DISPATCH_PLANS,
  _resetDispatchPlans,
  createDispatchPlan,
  getDispatchPlan,
  listDispatchPlans,
  mergeDispatchResults,
  planDispatch,
  updateAssignment,
} from "./dispatch.ts";

const ROOM = (members: string[]) => ({ id: "room-1", members });

const REQUEST = (overrides: Partial<Parameters<typeof planDispatch>[1]> = {}) => ({
  roomId: "room-1",
  taskId: "task-1",
  title: "Ship the release",
  subtaskCount: 3,
  ...overrides,
});

beforeEach(() => {
  _resetDispatchPlans();
});

describe("planDispatch", () => {
  it("deals subtasks round-robin across three members with indexed titles", () => {
    const planned = planDispatch(ROOM(["a", "b", "c"]), REQUEST({ subtaskCount: 5 }), 1_000);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return; // narrow for the expects below
    const { plan } = planned;
    expect(plan.taskId).toBe("task-1");
    expect(plan.roomId).toBe("room-1");
    expect(plan.createdAt).toBe(1_000);
    expect(plan.updatedAt).toBe(1_000);
    expect(plan.assignments.map((a) => a.memberId)).toEqual(["a", "b", "c", "a", "b"]);
    expect(plan.assignments.map((a) => a.subtask)).toEqual([
      "Ship the release — part 1 of 5",
      "Ship the release — part 2 of 5",
      "Ship the release — part 3 of 5",
      "Ship the release — part 4 of 5",
      "Ship the release — part 5 of 5",
    ]);
    expect(plan.assignments.every((a) => a.status === "pending")).toBe(true);
    expect(plan.assignments.every((a) => a.updatedAt === 1_000)).toBe(true);
  });

  it("is deterministic — the same room, request, and clock yield the same plan", () => {
    const first = planDispatch(ROOM(["a", "b"]), REQUEST(), 500);
    const second = planDispatch(ROOM(["a", "b"]), REQUEST(), 500);
    expect(second).toEqual(first);
  });

  it("refuses to fan out to a room with no members", () => {
    expect(planDispatch(ROOM([]), REQUEST(), 1)).toEqual({ ok: false, reason: "no_members" });
  });

  it("rejects a subtaskCount below 2, above 6, or non-integer", () => {
    expect(planDispatch(ROOM(["a"]), REQUEST({ subtaskCount: 1 }), 1)).toEqual({
      ok: false,
      reason: "bad_subtask_count",
    });
    expect(planDispatch(ROOM(["a"]), REQUEST({ subtaskCount: 7 }), 1)).toEqual({
      ok: false,
      reason: "bad_subtask_count",
    });
    expect(planDispatch(ROOM(["a"]), REQUEST({ subtaskCount: 2.5 }), 1)).toEqual({
      ok: false,
      reason: "bad_subtask_count",
    });
  });

  it("rejects a blank title — there is nothing to name subtasks from", () => {
    expect(planDispatch(ROOM(["a"]), REQUEST({ title: "   " }), 1)).toEqual({
      ok: false,
      reason: "bad_title",
    });
  });
});

describe("dispatch registry", () => {
  it("files a plan under its taskId and misses on an unknown lookup", () => {
    const created = createDispatchPlan(ROOM(["a", "b"]), REQUEST(), 1_000);
    expect(created.ok).toBe(true);
    const fetched = getDispatchPlan("task-1");
    expect(fetched).not.toBeUndefined();
    expect(fetched!.assignments).toHaveLength(3);
    expect(getDispatchPlan("ghost")).toBeUndefined();
  });

  it("re-planning a taskId replaces the earlier plan from a clean slate", () => {
    createDispatchPlan(ROOM(["a", "b"]), REQUEST(), 1_000);
    expect(updateAssignment("task-1", "a", "Ship the release — part 1 of 3", "assigned", 1_100).ok).toBe(true);
    const replanned = createDispatchPlan(ROOM(["a", "b"]), REQUEST(), 2_000);
    expect(replanned.ok).toBe(true);
    const plan = getDispatchPlan("task-1")!;
    expect(plan.createdAt).toBe(2_000);
    expect(plan.assignments.every((a) => a.status === "pending")).toBe(true);
  });

  it("runs the full lifecycle pending → assigned → done and records the result", () => {
    createDispatchPlan(ROOM(["a"]), REQUEST({ subtaskCount: 2 }), 1_000);
    const subtask = "Ship the release — part 1 of 2";
    const claimed = updateAssignment("task-1", "a", subtask, "assigned", 1_500);
    expect(claimed.ok).toBe(true);
    const settled = updateAssignment("task-1", "a", subtask, "done", 2_000, "shipped it");
    expect(settled.ok).toBe(true);
    const plan = getDispatchPlan("task-1")!;
    expect(plan.assignments[0]).toEqual({
      memberId: "a",
      subtask,
      status: "done",
      result: "shipped it",
      updatedAt: 2_000,
    });
    expect(plan.assignments[1]!.status).toBe("pending");
    expect(plan.updatedAt).toBe(2_000);
  });

  it("rejects transitions off the legal path — no skipping, no rewinds", () => {
    createDispatchPlan(ROOM(["a", "b"]), REQUEST(), 1_000);
    const subtask = (n: number) => `Ship the release — part ${n} of 3`;
    // pending → done skips the claim.
    expect(updateAssignment("task-1", "a", subtask(1), "done", 1_100)).toEqual({
      ok: false,
      reason: "bad_transition",
    });
    expect(updateAssignment("task-1", "a", subtask(1), "assigned", 1_100).ok).toBe(true);
    // assigned → assigned is not a transition.
    expect(updateAssignment("task-1", "a", subtask(1), "assigned", 1_200)).toEqual({
      ok: false,
      reason: "bad_transition",
    });
    expect(updateAssignment("task-1", "a", subtask(1), "done", 1_300).ok).toBe(true);
    // done is terminal — nothing moves a settled subtask again.
    expect(updateAssignment("task-1", "a", subtask(1), "failed", 1_400)).toEqual({
      ok: false,
      reason: "bad_transition",
    });
    // failed is terminal too.
    expect(updateAssignment("task-1", "b", subtask(2), "assigned", 1_500).ok).toBe(true);
    expect(updateAssignment("task-1", "b", subtask(2), "failed", 1_600).ok).toBe(true);
    expect(updateAssignment("task-1", "b", subtask(2), "done", 1_700)).toEqual({
      ok: false,
      reason: "bad_transition",
    });
  });

  it("rejects updates for an unknown plan or an assignment that is not on it", () => {
    createDispatchPlan(ROOM(["a"]), REQUEST(), 1_000);
    expect(updateAssignment("ghost", "a", "any", "assigned", 1)).toEqual({
      ok: false,
      reason: "no_plan",
    });
    expect(updateAssignment("task-1", "stranger", "any", "assigned", 1)).toEqual({
      ok: false,
      reason: "no_assignment",
    });
    expect(updateAssignment("task-1", "a", "Ship the release — part 9 of 3", "assigned", 1)).toEqual({
      ok: false,
      reason: "no_assignment",
    });
  });

  it("lists plans most recently updated first", () => {
    createDispatchPlan(ROOM(["a"]), REQUEST({ taskId: "old" }), 1_000);
    createDispatchPlan(ROOM(["a"]), REQUEST({ taskId: "new" }), 2_000);
    updateAssignment("old", "a", "Ship the release — part 1 of 3", "assigned", 3_000);
    expect(listDispatchPlans().map((plan) => plan.taskId)).toEqual(["old", "new"]);
  });
});

describe("mergeDispatchResults", () => {
  it("refuses to merge while any subtask is still pending or assigned", () => {
    createDispatchPlan(ROOM(["a", "b"]), REQUEST(), 1_000);
    const part1 = "Ship the release — part 1 of 3";
    const part2 = "Ship the release — part 2 of 3";
    const part3 = "Ship the release — part 3 of 3";
    const fresh = getDispatchPlan("task-1")!;
    expect(mergeDispatchResults(fresh)).toEqual({ ok: false, reason: "incomplete" });
    updateAssignment("task-1", "a", part1, "assigned", 1_100);
    updateAssignment("task-1", "b", part2, "assigned", 1_100);
    updateAssignment("task-1", "a", part3, "assigned", 1_100);
    updateAssignment("task-1", "a", part1, "done", 1_200);
    const midFlight = getDispatchPlan("task-1")!;
    expect(mergeDispatchResults(midFlight)).toEqual({ ok: false, reason: "incomplete" });
  });

  it("merges a settled plan into one summary line per subtask", () => {
    createDispatchPlan(ROOM(["a", "b"]), REQUEST(), 1_000);
    const part1 = "Ship the release — part 1 of 3";
    const part2 = "Ship the release — part 2 of 3";
    const part3 = "Ship the release — part 3 of 3";
    updateAssignment("task-1", "a", part1, "assigned", 1_100);
    updateAssignment("task-1", "b", part2, "assigned", 1_100);
    updateAssignment("task-1", "a", part3, "assigned", 1_100);
    updateAssignment("task-1", "a", part1, "done", 1_200, "tagged v1.2.0");
    updateAssignment("task-1", "b", part2, "done", 1_300);
    updateAssignment("task-1", "a", part3, "failed", 1_400, "changelog conflict");
    const merged = mergeDispatchResults(getDispatchPlan("task-1")!);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return; // narrow for the expects below
    expect(merged.summary).toBe(
      [
        "Task task-1 (room room-1): 2 done, 1 failed",
        `- a: ${part1} — done: tagged v1.2.0`,
        `- b: ${part2} — done`,
        `- a: ${part3} — failed: changelog conflict`,
      ].join("\n"),
    );
  });
});

describe("registry bounds", () => {
  it("evicts the least-recently-updated plan at the cap, updates count as touches", () => {
    for (let i = 0; i < MAX_DISPATCH_PLANS; i += 1) {
      const created = createDispatchPlan(
        ROOM(["a"]),
        REQUEST({ taskId: `task-${i}`, subtaskCount: 2 }),
        i + 1,
      );
      expect(created.ok).toBe(true);
    }
    expect(listDispatchPlans()).toHaveLength(MAX_DISPATCH_PLANS);

    // Touching task-0 (an update) refreshes its stamp, so task-1 — the
    // oldest untouched plan — is what the next creation evicts.
    const touched = updateAssignment(
      "task-0",
      "a",
      "Ship the release — part 1 of 2",
      "assigned",
      10_000,
    );
    expect(touched.ok).toBe(true);
    const overflow = createDispatchPlan(ROOM(["a"]), REQUEST({ taskId: "task-overflow" }), 10_001);
    expect(overflow.ok).toBe(true);
    expect(listDispatchPlans()).toHaveLength(MAX_DISPATCH_PLANS);
    expect(getDispatchPlan("task-0")).not.toBeUndefined();
    expect(getDispatchPlan("task-overflow")).not.toBeUndefined();
    expect(getDispatchPlan("task-1")).toBeUndefined();
  });
});
