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
