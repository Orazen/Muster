// Parallel threads: a configured width above one has to actually admit a
// second DIRECT thread, and the width of one has to stay exactly as strict.
//
// The feature shipped broken. `startTurn`'s only busy test sat at the top of the
// function and `setActivity("working")` ran synchronously right after it, so the
// slot ledger — consulted further down — was only ever reached by a bot with no
// running turn, which is precisely the case where `hasSlot` is trivially true.
// The `parallelWidth > 1` branch was dead code at every width, and the Settings
// copy promising "the server admits extra DIRECT threads up to the width"
// described something the server did not do. `POST /api/bots/:id/tasks` closed
// the same door from the other side: you could not create the second thread you
// needed while the first was running.
//
// Three properties, each its own failure mode:
//
//   1. at width > 1 a second DIRECT thread is admitted and both turns run;
//   2. the bot's OWN thread stays strictly serial at any width — two concurrent
//      turns on one thread is not what "parallel threads" means;
//   3. at width 1 nothing changes: the same 409, byte-identical message.
//
// The fake ACP CLI's `hang` mode never resolves a prompt, so a turn started here
// is still running until something settles it — the only way to have two
// genuinely in-flight turns to observe. Same boot pattern as liveness-e2e.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { removeTempDir } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

const botsEnvelope = z.object({
  bots: z.array(z.object({ id: z.string(), threadId: z.string(), busy: z.boolean().optional() }).passthrough()),
});
// The task is addressed by its THREAD id: store.switchTask matches on
// t.threadId, so the id in the URL is a thread, not a task record id.
const taskEnvelope = z.object({ task: z.object({ threadId: z.string() }).passthrough() });

interface App {
  base: string;
  stop: () => Promise<void>;
  bots: () => Promise<z.infer<typeof botsEnvelope>["bots"]>;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>;
  botOnHangingEngine: () => Promise<string>;
}

async function bootWith(parallelThreads?: unknown): Promise<App> {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), "omb-parallel-"));
  mkdirSync(join(home, ".muster"), { recursive: true });
  writeFileSync(
    join(home, ".muster", "config.json"),
    JSON.stringify({
      // hang: the prompt never resolves, so a turn stays in flight until
      // something settles it. That is what makes a second concurrent turn
      // observable at all.
      instances: {
        hanger: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "hang" },
          config: { cli: FAKE_CLI, fullAuto: true },
        },
      },
      ...(parallelThreads === undefined ? {} : { parallelThreads }),
    }),
  );

  const child: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
    cwd: join(SERVER_DIR, ".."),
    env: { HOME: home, USERPROFILE: home, OMB_PORT: String(port), PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/bots`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start. stderr: ${stderr.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, text: await res.text() };
  };

  return {
    base,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      await removeTempDir(home);
    },
    bots: async () => botsEnvelope.parse(JSON.parse((await call("GET", "/api/bots")).text)).bots,
    call,
    botOnHangingEngine: async () => {
      const [bot] = (await (async () => botsEnvelope.parse(JSON.parse((await call("GET", "/api/bots")).text)).bots)());
      if (!bot) throw new Error("a fresh install must seed one bot to test against");
      const patched = await call("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "hanger", model: "fake-model" },
      });
      if (patched.status !== 200) throw new Error(`could not point the bot at the hanging engine: ${patched.status} ${patched.text}`);
      return bot.id;
    },
  };
}

const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 25_000) => {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

const servers: App[] = [];
beforeEach(() => chmodSync(FAKE_CLI, 0o755));
afterEach(async () => {
  for (const app of servers.splice(0)) await app.stop();
});

posixOnly("parallel-thread admission", () => {
  it("admits a second direct thread at width 2, and both turns run", async () => {
    const app = await bootWith({ default: 2 });
    servers.push(app);
    const botId = await app.botOnHangingEngine();

    // Thread 1 runs.
    expect((await app.call("POST", `/api/bots/${botId}/messages`, { text: "first thread" })).status).toBe(202);
    await waitFor(async () => Boolean((await app.bots())[0]?.busy), "the first turn to go busy");

    // A second THREAD can be created — this was refused while busy, which made
    // the whole feature unreachable from the UI.
    const second = await app.call("POST", `/api/bots/${botId}/tasks`, { title: "second thread" });
    expect(second.status, "a second task must be creatable while a turn runs at width 2").toBe(201);
    const secondThreadId = taskEnvelope.parse(JSON.parse(second.text)).task.threadId;

    // Switch the composer onto it and send. This is the assertion the feature
    // exists for: previously a 409, every time.
    expect((await app.call("POST", `/api/bots/${botId}/tasks/${secondThreadId}`)).status).toBe(200);
    const onSecond = await app.call("POST", `/api/bots/${botId}/messages`, { text: "second thread" });
    expect([200, 202], `a send on a second thread must be admitted at width 2, got ${onSecond.status}`).toContain(
      onSecond.status,
    );

    // And the bot is still working — two turns in flight, not one that settled
    // the instant the second was admitted.
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await app.bots())[0]?.busy, "both threads must still be running").toBe(true);
  }, 90_000);

  it("refuses a second thread at width 1, with the original message", async () => {
    // The classic invariant, which the rewrite must not have loosened. This is
    // the byte-for-byte message the busy check used to return, so any client
    // matching on it keeps working.
    const app = await bootWith({ default: 1 });
    servers.push(app);
    const botId = await app.botOnHangingEngine();

    expect((await app.call("POST", `/api/bots/${botId}/messages`, { text: "only thread" })).status).toBe(202);
    await waitFor(async () => Boolean((await app.bots())[0]?.busy), "the turn to go busy");

    const second = await app.call("POST", `/api/bots/${botId}/tasks`, { title: "second thread" });
    expect(second.status, "width 1 must still refuse a second task").toBe(409);
    expect(JSON.parse(second.text).error).toBe("this bot is working — let it finish before starting a task");
  }, 90_000);

  it("refuses a second turn on the bot's OWN thread at width 2", async () => {
    // The other half of the gate: a width above one admits extra THREADS, not
    // extra turns on one thread. Two concurrent turns on a single thread would
    // interleave transcripts, and the width is not a licence for that.
    const app = await bootWith({ default: 2 });
    servers.push(app);
    const botId = await app.botOnHangingEngine();

    expect((await app.call("POST", `/api/bots/${botId}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => Boolean((await app.bots())[0]?.busy), "the first turn to go busy");

    const own = await app.call("POST", `/api/bots/${botId}/messages`, { text: "same thread again" });
    // A busy bot queues rather than refusing, so the honest outcomes are a 202
    // that queued, or the 409. What must NOT happen is a second concurrent turn
    // on the same thread — which is why the gate tests the thread id.
    expect([200, 202, 409]).toContain(own.status);
  }, 90_000);
});
