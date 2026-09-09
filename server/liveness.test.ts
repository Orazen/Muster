// Liveness reaper: unit contracts for crash attribution, the process-death
// journal in procs.ts, and the startup-loss record bots leave behind when
// the previous process exited mid-turn.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { LivenessReaper } from "./liveness.ts";
import { deathsSince, deathMark, describeProcessDeath, spawnCli, type ProcessDeath } from "./procs.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store } from "./store.ts";
import type { WatchedTurn } from "./turn-watchdog.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

function turn(overrides: Partial<WatchedTurn> = {}): WatchedTurn {
  return {
    threadId: "t1",
    botId: "b1",
    startedAt: 10_000,
    lastEventAt: 10_000,
    waitingOnHuman: false,
    ...overrides,
  };
}

function death(overrides: Partial<ProcessDeath> = {}): ProcessDeath {
  return {
    pid: 4321,
    cli: "fake-cli",
    spawnedAt: 10_500,
    exitedAtSeq: deathMark(),
    code: 137,
    signal: null,
    ...overrides,
  };
}

describe("LivenessReaper", () => {
  it("attributes a process death to the turn the process was spawned for", () => {
    const lost: Array<{ turn: WatchedTurn; death: ProcessDeath }> = [];
    const reaper = new LivenessReaper({
      checkMs: 1_000,
      deathsSince: () => [death()],
      snapshotTurns: () => [turn()],
      onLost: (t, d) => lost.push({ turn: t, death: d }),
    });
    reaper.sweep();
    expect(lost).toHaveLength(1);
    expect(lost[0]!.turn.threadId).toBe("t1");
    expect(lost[0]!.death.pid).toBe(4321);
  });

  it("ignores a death whose process predates the turn's dispatch (minus skew)", () => {
    const lost: Array<WatchedTurn> = [];
    const reaper = new LivenessReaper({
      checkMs: 1_000,
      deathsSince: () => [
        // spawned long before this turn started — an unrelated helper CLI
        death({ spawnedAt: turn().startedAt - 60_000 }),
      ],
      snapshotTurns: () => [turn()],
      onLost: (t) => lost.push(t),
    });
    reaper.sweep();
    expect(lost).toHaveLength(0);
  });

  it("settles at most one turn per death, so a burst cannot cascade", () => {
    const lost: Array<WatchedTurn> = [];
    const reaper = new LivenessReaper({
      checkMs: 1_000,
      deathsSince: () => [death(), death({ pid: 4322 })],
      snapshotTurns: () => [turn(), turn({ threadId: "t2", botId: "b2" })],
      onLost: (t) => lost.push(t),
    });
    reaper.sweep();
    // two deaths, two turns: each turn absorbs one death, never both
    expect(lost.map((t) => t.threadId).sort()).toEqual(["t1", "t2"]);
  });

  it("does not attribute a death to a turn already settled before the sweep", () => {
    const lost: Array<WatchedTurn> = [];
    const reaper = new LivenessReaper({
      checkMs: 1_000,
      deathsSince: () => [death()],
      snapshotTurns: () => [],
      onLost: (t) => lost.push(t),
    });
    reaper.sweep();
    expect(lost).toHaveLength(0);
  });

  it("attributes a death to the newest matching turn, not the delegating ancestor", () => {
    const lost: Array<WatchedTurn> = [];
    const reaper = new LivenessReaper({
      checkMs: 1_000,
      deathsSince: () => [
        // the delegated child's engine died right after its spawn; the
        // delegating parent's older turn also satisfies the lower bound
        death({ spawnedAt: 50_000 }),
      ],
      snapshotTurns: () => [
        turn({ threadId: "parent", startedAt: 10_000 }),
        turn({ threadId: "child", startedAt: 49_800 }),
      ],
      onLost: (t) => lost.push(t),
    });
    reaper.sweep();
    expect(lost.map((t) => t.threadId)).toEqual(["child"]);
  });

  it("an exact pid match wins over the newest spawn-window candidate", () => {
    const lost: Array<WatchedTurn> = [];
    const reaper = new LivenessReaper({
      checkMs: 1_000,
      deathsSince: () => [death({ pid: 777, spawnedAt: 50_000 })],
      snapshotTurns: () => [
        // newest by the spawn window, but its own engine (pid 999) is alive
        turn({ threadId: "newer", startedAt: 49_900, pid: 999 }),
        // an older turn explicitly bound to the dying process
        turn({ threadId: "bound", startedAt: 10_000, pid: 777 }),
      ],
      onLost: (t) => lost.push(t),
    });
    reaper.sweep();
    expect(lost.map((t) => t.threadId)).toEqual(["bound"]);
  });

  it("a pid-bound turn is never blamed for a different process's exit", () => {
    const lost: Array<WatchedTurn> = [];
    const reaper = new LivenessReaper({
      checkMs: 1_000,
      deathsSince: () => [death({ pid: 9999, spawnedAt: 50_000 })],
      snapshotTurns: () => [
        // the spawn window would match this turn, but pid 4321 is its own
        // still-running engine — the exit belongs to nobody watched
        turn({ threadId: "bound", startedAt: 49_000, pid: 4321 }),
      ],
      onLost: (t) => lost.push(t),
    });
    reaper.sweep();
    expect(lost).toHaveLength(0);
  });

  it("with no pid match, an unbound turn still absorbs the death by spawn window", () => {
    const lost: Array<WatchedTurn> = [];
    const reaper = new LivenessReaper({
      checkMs: 1_000,
      deathsSince: () => [death({ pid: 9999, spawnedAt: 50_000 })],
      snapshotTurns: () => [
        // bound to another (still-alive) engine — excluded from fallback
        turn({ threadId: "child", startedAt: 49_800, pid: 888 }),
        turn({ threadId: "parent", startedAt: 10_000 }),
      ],
      onLost: (t) => lost.push(t),
    });
    reaper.sweep();
    expect(lost.map((t) => t.threadId)).toEqual(["parent"]);
  });

  it("suspend() blanks attribution; resume() consumes deaths journalled meanwhile", () => {
    const lost: Array<WatchedTurn> = [];
    const journal: ProcessDeath[] = [];
    let seq = 0;
    const reaper = new LivenessReaper({
      checkMs: 1_000,
      deathsSince: (m) => journal.filter((d) => d.exitedAtSeq > m),
      snapshotTurns: () => [turn()],
      onLost: (t) => lost.push(t),
    });
    reaper.start();
    reaper.suspend();
    // a fleet disposal kill lands while suspended; a manual sweep must
    // attribute nothing, and resume must swallow it rather than replay it
    journal.push(death({ exitedAtSeq: ++seq }));
    reaper.sweep();
    expect(lost).toHaveLength(0);
    reaper.resume();
    reaper.sweep();
    expect(lost).toHaveLength(0);
  });

  it("start() consumes pre-existing journal entries instead of replaying them", () => {
    let mark = 0;
    const lost: Array<WatchedTurn> = [];
    const reaper = new LivenessReaper({
      checkMs: 1_000,
      deathsSince: (m) => (m === 0 ? [death({ exitedAtSeq: ++mark })] : []),
      snapshotTurns: () => [],
      onLost: (t) => lost.push(t),
    });
    reaper.start();
    reaper.sweep();
    reaper.stop();
    expect(lost).toHaveLength(0);
  });
});

describe("process death journal (procs)", () => {
  it("records a real child's exit after spawnCli", async () => {
    const mark = deathMark();
    const child = spawnCli(process.execPath, ["-e", "process.exit(7)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // the exit handler runs on the same event-loop turn as 'exit' itself
    await new Promise((r) => setTimeout(r, 20));
    const found = deathsSince(mark).find((d) => d.code === 7 && d.cli === process.execPath);
    expect(found).toBeDefined();
    expect(found?.spawnedAt).toBeLessThanOrEqual(Date.now());
  });

  it("wording distinguishes signals, clean exits, and error codes", () => {
    expect(describeProcessDeath(death({ signal: "SIGKILL", code: null }))).toContain("killed by SIGKILL");
    expect(describeProcessDeath(death({ code: 0, signal: null }))).toContain("exited cleanly");
    expect(describeProcessDeath(death({ code: 3, signal: null }))).toContain("code 3");
  });
});

describe("startup losses (store)", () => {
  it("a bot persisted mid-turn is reported once and idled on load", () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const first = new Store(selection);
    const bot = first.createBot({}, { seedMessages: false });

    // simulate a crash: busy state written to disk by the previous process
    const file = join(DATA_DIR, "bots.json");
    // Minimal view of the persisted records this test edits.
    // SAFETY: the file was just written by Store.saveBots (BotRecord[]),
    // so every entry carries id.
    const saved = JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string; busy?: boolean; activity?: string }>;
    const mine = saved.find((b) => b.id === bot.id)!;
    mine.busy = true;
    mine.activity = "working";
    writeFileSync(file, JSON.stringify(saved));

    const second = new Store(selection);
    expect(second.takeStartupLosses()).toEqual([bot.id]);
    // consumed once — a second load cycle must not re-report
    expect(second.takeStartupLosses()).toEqual([]);
    expect(second.bot(bot.id)?.busy).toBe(false);
  });

  it("an idle bot leaves no startup loss", () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const first = new Store(selection);
    first.createBot();
    const second = new Store(selection);
    expect(second.takeStartupLosses()).toEqual([]);
  });
});
