// Stall-watchdog contract: activity keeps a turn alive indefinitely, human
// approvals pause the clock but not past the hard cap, silence past the
// ceiling stalls exactly once.
import { describe, expect, it } from "vitest";

import { TurnWatchdog, type WatchedTurn } from "./turn-watchdog.ts";

const STALL = 10_000;
const HARD_CAP = 50_000;

function rig() {
  let now = 0;
  const stalls: WatchedTurn[] = [];
  const dog = new TurnWatchdog({
    stallMs: STALL,
    hardCapMs: HARD_CAP,
    checkMs: 60_000,
    onStall: (turn) => stalls.push(turn),
    now: () => now,
  });
  return { dog, stalls, tick: (ms: number) => (now += ms) };
}

describe("TurnWatchdog", () => {
  it("stalls a silent turn once, and only once", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ threadId: "t1", botId: "bot1" })]);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    expect(dog.watching("t1")).toBe(false);
  });

  it("any event on the thread resets the clock", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    for (let i = 0; i < 10; i++) {
      tick(STALL - 1);
      dog.touch("t1");
    }
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("waits on a human well past the stall window, but not past the hard cap", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnHuman("t1", true);
    // Long past the stall window, still under the cap: not a stall.
    tick(HARD_CAP - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    // the answer restarts the clock rather than inheriting the wait
    dog.setWaitingOnHuman("t1", false);
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("stalls a wedged permission request once the hard cap passes", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnHuman("t1", true);
    // Far past the cap with no request.resolved ever arriving — the entry
    // must be reaped instead of holding the busy flag forever.
    tick(HARD_CAP + 1);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ threadId: "t1" })]);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("a settled turn is forgotten", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.settle("t1");
    tick(STALL * 2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("re-watching a thread replaces the previous turn", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.watch("t1", "bot2");
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(STALL);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ botId: "bot2" })]);
  });

  it("settleIfCurrent: a matching turnId settles the turn", () => {
    const { dog } = rig();
    dog.watch("t1", "bot1");
    dog.noteTurnStarted("t1", "gen-1");
    dog.settleIfCurrent("t1", "gen-1");
    expect(dog.watching("t1")).toBe(false);
  });

  it("a lost turn's late completion does not unwatch its replacement", () => {
    const { dog, stalls, tick } = rig();
    // generation 1 in flight, then lost by the stall sweep
    dog.watch("t1", "bot1");
    dog.noteTurnStarted("t1", "gen-1");
    tick(STALL + 1);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    // the harness's loss path arms the guard (settleLostTurn)
    dog.suppressStaleSettles("t1", 60_000);
    // a replacement turn is dispatched and its started event lands
    dog.watch("t1", "bot1");
    dog.noteTurnStarted("t1", "gen-2");
    // the interrupted-but-alive gen-1 provider finally completes
    dog.settleIfCurrent("t1", "gen-1");
    // gen-2 must STILL be watched — the stale completion clears nothing
    expect(dog.watching("t1")).toBe(true);
    // and gen-2's own completion settles it
    dog.settleIfCurrent("t1", "gen-2");
    expect(dog.watching("t1")).toBe(false);
  });

  it("settleIfCurrent: matching ids settle even inside the guard window", () => {
    const { dog } = rig();
    dog.watch("t1", "bot1");
    dog.suppressStaleSettles("t1", 60_000);
    dog.noteTurnStarted("t1", "gen-2");
    dog.settleIfCurrent("t1", "gen-2");
    expect(dog.watching("t1")).toBe(false);
  });

  it("settleIfCurrent: inside the guard window an undecided completion is ignored", () => {
    const { dog, tick } = rig();
    dog.watch("t1", "bot1");
    dog.suppressStaleSettles("t1", 60_000);
    // neither side knows a turnId — the window decides
    dog.settleIfCurrent("t1");
    expect(dog.watching("t1")).toBe(true);
    // past the window the same undecided completion may settle
    tick(61_000);
    dog.settleIfCurrent("t1");
    expect(dog.watching("t1")).toBe(false);
  });

  it("noteEnginePid binds the engine pid; snapshot carries it for the reaper", () => {
    const { dog } = rig();
    dog.watch("t1", "bot1");
    dog.noteEnginePid("t1", 4711);
    expect(dog.snapshot()).toEqual([expect.objectContaining({ threadId: "t1", pid: 4711 })]);
    // a turn that never saw the event carries no pid
    dog.watch("t2", "bot1");
    expect(dog.snapshot().find((t) => t.threadId === "t2")?.pid).toBeUndefined();
  });
});
