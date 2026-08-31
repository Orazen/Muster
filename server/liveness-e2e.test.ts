// Liveness reaper, end to end: boots the real harness server with the fake
// ACP CLI and proves the two guarantees plan 2.1 was written for —
//
//   1. killing the driver process externally mid-turn settles the bot
//      within one reaper tick, with a visible crash note (previously this
//      hung the bot until the 20-minute stall watchdog fired);
//   2. a restart reconciles a bot that was persisted mid-turn: it comes
//      back idle, and its thread says the turn did not survive, instead of
//      silently idling like the old blanket clear.
//
// Same POSIX gating and boot pattern as branching.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject } from "./schema.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 19800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

interface Msg {
  role: string;
  kind: string;
  text?: string;
  tool?: { name?: string; ok?: boolean };
}

posixOnly("liveness reaper e2e (fake ACP fleet)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: JsonObject): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const getBot = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);

  const messages = async (threadId: string): Promise<Msg[]> =>
    (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];

  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-liveness-test-"));
    mkdirSync(join(home, ".muster"), { recursive: true });
    writeFileSync(
      join(home, ".muster", "config.json"),
      JSON.stringify({
        instances: {
          happy: {
            driver: "grokAgent",
            environment: {
              // engine dies mid-prompt with stdio held open by a grandchild:
              // the only settler is the reaper
              FAKE_ACP_MODE: "die-midturn",
              FAKE_ACP_PIDFILE: join(home, "engine.pid"),
            },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/bots`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server did not start. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  afterAll(async () => {
    child?.kill("SIGTERM");
    // the die-midturn grandchild holds the engine's pipes open forever —
    // reap it so it does not outlive the test run
    for (const suffix of ["", ".gc"]) {
      try {
        const pid = Number(readFileSync(join(home, `engine.pid${suffix}`), "utf8").trim());
        if (pid > 0) process.kill(pid, "SIGKILL");
      } catch {
        /* never written or already gone */
      }
    }
    await removeTempDir(home);
  });

  it("settles a bot within a tick when its driver process dies mid-turn", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "happy", model: "fake-model" },
    });

    // die-midturn: the engine exits code 9 while a grandchild holds its
    // stdio open, so no terminal event reaches the harness — the only way
    // this turn settles is the reaper noticing the death
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "long task" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the turn to go busy");
    await waitFor(async () => readFileSync(join(home, "engine.pid"), "utf8").trim().length > 0, "the engine pidfile");

    // the reaper's tick is 5s; settle + grace release must land well under
    // the old 20-minute stall ceiling
    await waitFor(async () => {
      const b = await getBot(created.id);
      return b.busy === false && b.activity === "idle";
    }, "the reaper to settle the dead turn", 20_000);

    const thread = await messages((await getBot(created.id)).threadId);
    const crashNotes = thread.filter(
      (m: Msg) => m.kind === "activity" && (m.tool?.name ?? "").includes("exited with code 9"),
    );
    expect(crashNotes.length).toBeGreaterThanOrEqual(1);
    expect(crashNotes[0]!.tool?.name).toContain("the turn was stopped");
  }, 45_000);

  it("reconciles a bot persisted mid-turn across a restart with a visible note", async () => {
    // stop the live server; its state file is the restart's starting point
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));

    const botsFile = join(home, ".muster", "bots.json");
    // Minimal view of the persisted records this test edits.
    // SAFETY: the file was written by the server under test (Store.saveBots
    // persists BotRecord[]), so every entry carries id and threadId.
    const bots = JSON.parse(readFileSync(botsFile, "utf8")) as Array<{ id: string; threadId: string; busy?: boolean; activity?: string }>;
    const victim = bots[0]!;
    victim.busy = true;
    victim.activity = "working";
    writeFileSync(botsFile, JSON.stringify(bots));
    const threadId = victim.threadId;

    // boot the "next run" of the app against the same data dir
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/bots`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server did not restart. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 250));
    }

    const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === victim.id);
    expect(bot.busy).toBe(false);
    const thread = await messages(threadId);
    expect(
      thread.some(
        (m: Msg) => m.kind === "activity" && (m.tool?.name ?? "").includes("restarted while this task was running"),
      ),
    ).toBe(true);
  }, 45_000);
});
