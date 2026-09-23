// Queue-and-steer for busy 1:1 bots, at two levels:
//
// Unit: the steer-queue module against a fake store — queue bookkeeping,
// the drain-once property, and the joined single-prompt shape.
//
// e2e: the real harness server with the grokAgent driver on the fake ACP
// CLI in echo-gated mode, whose turns stay open until a gate file exists —
// a deterministic busy window. The echo reply carries the FULL prompt
// (system + turn text), which pins both what a drained turn was sent (the
// queued texts joined with newlines, in ONE turn) and what it was not (the
// webhook untrusted-data paragraph an attended turn must never get).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { drainSteeredMessages, queueSteeredMessage, removeQueuedSend, setSteerQueuePaused, steerQueueSnapshot, _queuedCount, type SteerStore } from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

// ── unit: the queue module against a fake store ────────────────────────
function fakeBot(id: string, threadId: string, busy: boolean): BotRecord {
  return {
    id,
    threadId,
    name: id,
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "fake", model: "fake-model" },
    resumeCursors: {},
    busy,
    createdAt: 0,
  };
}

function fakeStore(bots: BotRecord[]): SteerStore & { messages: Message[] } {
  const messages: Message[] = [];
  let nextId = 0;
  return {
    messages,
    bot: (id) => bots.find((b) => b.id === id) ?? null,
    appendMessage: (threadId, message) => {
      const full: Message = { id: `m${(nextId += 1)}-${threadId}`, at: Date.now(), ...message };
      messages.push(full);
      return full;
    },
    patchMessage: (_threadId, messageId, patch) => {
      const at = messages.findIndex((m) => m.id === messageId);
      if (at === -1) return null;
      messages[at] = { ...messages[at], ...patch };
      return messages[at];
    },
  };
}

describe("steer-queue module", () => {
  it("appends a queued user message to the thread immediately", () => {
    const bot = fakeBot("bot-a", "thread-a", true);
    const store = fakeStore([bot]);
    const message = queueSteeredMessage(store, bot, "hold that thought");
    expect(message).toMatchObject({ role: "user", kind: "text", text: "hold that thought", queued: true });
    expect(store.messages).toHaveLength(1);
    expect(_queuedCount("thread-a")).toBe(1);
    // consume it so module state never leaks into another test
    drainSteeredMessages(fakeStore([fakeBot("bot-a", "thread-a", false)]), () => {});
  });

  it("holds the queue while the bot is busy and drains it once when idle", () => {
    const bot = fakeBot("bot-b", "thread-b", true);
    const store = fakeStore([bot]);
    queueSteeredMessage(store, bot, "first note");
    queueSteeredMessage(store, bot, "second note");
    const run = vi.fn();

    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedCount("thread-b")).toBe(2);

    bot.busy = false;
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    const [botId, threadId, prompt, userMessage] = run.mock.calls[0];
    expect(botId).toBe("bot-b");
    expect(threadId).toBe("thread-b");
    // ONE turn for the whole burst: the texts joined with newlines
    expect(prompt).toBe("first note\nsecond note");
    // the last queued message, so the caller appends nothing new
    expect(userMessage.text).toBe("second note");
    // the affordance is cleared the moment the queue is consumed
    expect(store.messages.every((m) => !m.queued)).toBe(true);
    expect(_queuedCount("thread-b")).toBe(0);

    // drain-once: a second settle finds nothing and fires nothing
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires nothing when nothing is queued", () => {
    const run = vi.fn();
    drainSteeredMessages(fakeStore([fakeBot("bot-c", "thread-c", false)]), run);
    expect(run).not.toHaveBeenCalled();
  });

  it("drops the queue of a deleted bot without running it", () => {
    const bot = fakeBot("bot-d", "thread-d", true);
    const store = fakeStore([bot]);
    queueSteeredMessage(store, bot, "orphaned");
    const run = vi.fn();
    drainSteeredMessages(fakeStore([]), run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedCount("thread-d")).toBe(0);
  });

  it("skips the run when the queued messages vanished from the store", () => {
    const bot = fakeBot("bot-e", "thread-e", true);
    const store = fakeStore([bot]);
    queueSteeredMessage(store, bot, "gone soon");
    store.messages.length = 0; // the thread was deleted under the queue
    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedCount("thread-e")).toBe(0);
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const busyRefusal = () =>
    Promise.reject(Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 }));

  it("re-queues a transient busy refusal and runs it on the next settle", async () => {
    const bot = fakeBot("bot-r1", "thread-r1", true);
    const store = fakeStore([bot]);
    const message = queueSteeredMessage(store, bot, "steer me");
    bot.busy = false;
    let attempts = 0;
    const giveUp = vi.fn();
    drainSteeredMessages(store, () => { attempts += 1; return busyRefusal(); }, giveUp);
    await flush();
    expect(attempts).toBe(1);
    expect(giveUp).not.toHaveBeenCalled();
    // back on the queue with the affordance restored — the promise is visible again
    expect(_queuedCount("thread-r1")).toBe(1);
    expect(store.messages.find((m) => m.id === message.id)?.queued).toBe(true);
    // the next settle succeeds
    const okRun = vi.fn();
    drainSteeredMessages(store, okRun, giveUp);
    expect(okRun).toHaveBeenCalledTimes(1);
    expect(_queuedCount("thread-r1")).toBe(0);
    expect(giveUp).not.toHaveBeenCalled();
  });

  it("gives up with a note after the requeue budget, never silently", async () => {
    const bot = fakeBot("bot-r2", "thread-r2", true);
    const store = fakeStore([bot]);
    queueSteeredMessage(store, bot, "stubborn");
    bot.busy = false;
    const giveUp = vi.fn();
    let attempts = 0;
    // 1 dispatch + MAX_REQUEUES(3) retries, then the give-up note
    for (let i = 0; i < 4; i += 1) {
      drainSteeredMessages(store, () => { attempts += 1; return busyRefusal(); }, giveUp);
      await flush();
    }
    expect(attempts).toBe(4);
    expect(giveUp).toHaveBeenCalledTimes(1);
    expect(giveUp.mock.calls[0][0]).toBe("thread-r2");
    expect(_queuedCount("thread-r2")).toBe(0);
  });

  it("gives up immediately on a final failure like a spent budget", async () => {
    const bot = fakeBot("bot-r3", "thread-r3", true);
    const store = fakeStore([bot]);
    queueSteeredMessage(store, bot, "broke");
    bot.busy = false;
    const run = vi.fn(() => Promise.reject(Object.assign(new Error("token budget spent"), { status: 402 })));
    const giveUp = vi.fn();
    drainSteeredMessages(store, run, giveUp);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(giveUp).toHaveBeenCalledTimes(1);
    expect(_queuedCount("thread-r3")).toBe(0);
  });

  it("runs re-queued words before anything queued after the refusal", async () => {
    const bot = fakeBot("bot-r4", "thread-r4", true);
    const store = fakeStore([bot]);
    queueSteeredMessage(store, bot, "old steer");
    bot.busy = false;
    drainSteeredMessages(store, busyRefusal, () => {});
    await flush();
    queueSteeredMessage(store, bot, "new steer");
    const okRun = vi.fn();
    drainSteeredMessages(store, okRun, () => {});
    expect(okRun).toHaveBeenCalledTimes(1);
    expect(okRun.mock.calls[0][2]).toBe("old steer\nnew steer");
  });
});

describe("steer-queue snapshot, per-item remove, and hold", () => {
  it("snapshots every waiting send for the bot, in queue order", () => {
    const bot = fakeBot("bot-snap", "thread-snap", true);
    const store = fakeStore([bot]);
    const first = queueSteeredMessage(store, bot, "first note");
    const second = queueSteeredMessage(store, bot, "second note");
    expect(steerQueueSnapshot("bot-snap")).toEqual({
      botId: "bot-snap",
      paused: false,
      items: [
        { messageId: first.id, threadId: "thread-snap", text: "first note" },
        { messageId: second.id, threadId: "thread-snap", text: "second note" },
      ],
    });
    // nothing waiting for anyone else — the strip renders NOTHING, not an
    // empty promise (a flag stranded by a restart looks the same)
    expect(steerQueueSnapshot("bot-elsewhere")).toBeNull();
    // consume so module state never leaks into another test
    bot.busy = false;
    drainSteeredMessages(store, () => {});
    expect(_queuedCount("thread-snap")).toBe(0);
  });

  it("removes ONE send: words stay in the thread, the rest still drain joined", () => {
    const bot = fakeBot("bot-rm", "thread-rm", true);
    const store = fakeStore([bot]);
    const keepA = queueSteeredMessage(store, bot, "keep a");
    const dropB = queueSteeredMessage(store, bot, "drop b");
    const keepC = queueSteeredMessage(store, bot, "keep c");
    const result = removeQueuedSend(store, "bot-rm", dropB.id);
    expect(result.removed).toBe(true);
    expect(result.queue?.items.map((item) => item.text)).toEqual(["keep a", "keep c"]);
    // the survivors (keep a / keep c) are still the ones waiting to send
    expect(result.queue?.items.map((item) => item.messageId)).toEqual([keepA.id, keepC.id]);
    // the words are never deleted — only the auto-run intent leaves with it
    expect(store.messages.find((m) => m.id === dropB.id)).toMatchObject({ text: "drop b" });
    expect(store.messages.find((m) => m.id === dropB.id)?.queued).toBeUndefined();
    expect(store.messages.find((m) => m.id === keepA.id)?.queued).toBe(true);
    // a double-click (or a drain that already ran) can never remove twice
    expect(removeQueuedSend(store, "bot-rm", dropB.id).removed).toBe(false);
    expect(removeQueuedSend(store, "bot-nobody", keepA.id).removed).toBe(false);
    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toBe("keep a\nkeep c");
    expect(store.messages.filter((m) => m.queued)).toHaveLength(0);
  });

  it("drops the queue entry when its last send is removed", () => {
    const bot = fakeBot("bot-last", "thread-last", true);
    const store = fakeStore([bot]);
    const only = queueSteeredMessage(store, bot, "only note");
    expect(removeQueuedSend(store, "bot-last", only.id)).toEqual({ removed: true, queue: null });
    expect(_queuedCount("thread-last")).toBe(0);
    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
  });

  it("holds a paused queue across a settle and resumes into one joined turn", () => {
    const bot = fakeBot("bot-hold", "thread-hold", true);
    const store = fakeStore([bot]);
    queueSteeredMessage(store, bot, "held one");
    queueSteeredMessage(store, bot, "held two");
    expect(setSteerQueuePaused("bot-hold", true)).toBe(true);
    // the settle arrives — the hold wins over the default drain
    bot.busy = false;
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedCount("thread-hold")).toBe(2);
    expect(store.messages.every((m) => m.queued)).toBe(true);
    expect(steerQueueSnapshot("bot-hold")).toMatchObject({
      paused: true,
      items: [{ text: "held one" }, { text: "held two" }],
    });
    // resume releases the hold: the next drain spends them together
    expect(setSteerQueuePaused("bot-hold", false)).toBe(true);
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toBe("held one\nheld two");
    expect(_queuedCount("thread-hold")).toBe(0);
    // nothing waiting — holding a queue that does not exist says so
    expect(setSteerQueuePaused("bot-hold", true)).toBe(false);
  });
});

// ── e2e: the real server on the gated fake ACP fleet ───────────────────
describe("steer-queue e2e (fake ACP fleet)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let drainGate: string;
  let stopGate: string;
  let stopRpcDump: string;
  let holdGate: string;
  let holdRpcDump: string;

  /** the flat command payloads these tests POST/PATCH */
  type ApiBody = Record<string, string | boolean | { instanceId: string; model: string }>;

  const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const botById = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);

  const echoes = (bot: any): any[] =>
    bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text?.startsWith("echo: "));

  const until = async (probe: () => Promise<boolean>, what: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe()) return;
      if (Date.now() > deadline) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const newBot = async (instanceId: string, name: string) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model: "fake-model" } });
    return bot;
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-test-"));
    mkdirSync(join(home, ".muster"), { recursive: true });
    mkdirSync(join(home, "gates"), { recursive: true });
    drainGate = join(home, "gates", "drain.gate");
    stopGate = join(home, "gates", "stop.gate");
    stopRpcDump = join(home, "gates", "stop.rpc");
    holdGate = join(home, "gates", "hold.gate");
    holdRpcDump = join(home, "gates", "hold.rpc");
    writeFileSync(
      join(home, ".muster", "config.json"),
      JSON.stringify({
        instances: {
          steer: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: drainGate },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // the RPC dump lets the interrupt test wait for session/prompt to
          // be in flight — interrupting earlier would be a no-op on a turn
          // the driver has not registered yet
          steerStop: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "echo-gated",
              FAKE_ACP_GATE_FILE: stopGate,
              FAKE_ACP_RPC_DUMP: stopRpcDump,
            },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // its own gate + RPC dump for the hold/resume e2e, so the gates
          // earlier tests open cannot leak into this one's busy window
          steerHold: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "echo-gated",
              FAKE_ACP_GATE_FILE: holdGate,
              FAKE_ACP_RPC_DUMP: holdRpcDump,
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
    // Without SystemRoot, winsock fails to initialize in the child.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it(
    "queues sends while busy and drains them into exactly one attended turn",
    async () => {
      const bot = await newBot("steer", "Steerable");

      // the first send starts a turn that stays open until the gate exists
      const first = await api("POST", `/api/bots/${bot.id}/messages`, { text: "first task please" });
      expect(first.status).toBe(202);
      expect(first.body.queued).toBeUndefined();
      expect((await botById(bot.id)).busy).toBe(true);

      // sends while busy land in the transcript at once, marked queued
      const second = await api("POST", `/api/bots/${bot.id}/messages`, { text: "steer two" });
      expect(second.status).toBe(202);
      expect(second.body).toMatchObject({ ok: true, queued: true });
      const third = await api("POST", `/api/bots/${bot.id}/messages`, { text: "steer three" });
      expect(third.body.queued).toBe(true);

      let snapshot = await botById(bot.id);
      expect(snapshot.busy).toBe(true);
      const queuedTexts = snapshot.messages
        .filter((m: any) => m.role === "user" && m.queued)
        .map((m: any) => m.text);
      expect(queuedTexts).toEqual(["steer two", "steer three"]);
      expect(echoes(snapshot)).toHaveLength(0); // nothing has answered yet

      // open the gate: turn 1 settles, and the queue drains into ONE turn
      writeFileSync(drainGate, "open");
      await until(async () => {
        snapshot = await botById(bot.id);
        return !snapshot.busy && echoes(snapshot).length >= 2;
      }, "the queued turn");

      const replies = echoes(snapshot);
      // exactly one drained turn for two queued messages — not one each
      expect(replies).toHaveLength(2);
      expect(replies[0].text).toContain("first task please");
      // the drained prompt is the queued texts joined with newlines
      expect(replies[1].text).toContain("steer two\nsteer three");
      // ...and it is an ordinary attended turn: no webhook untrusted-data
      // framing, no rewind replay wrapper
      expect(replies[1].text).not.toContain("authenticated external webhook");
      expect(replies[1].text).not.toContain("[The user rewound");
      // consumed: the queued affordance is gone from both messages
      expect(snapshot.messages.some((m: any) => m.queued)).toBe(false);

      // an idle send with an empty queue runs one normal turn — the drain
      // adds nothing behind it
      const followUp = await api("POST", `/api/bots/${bot.id}/messages`, { text: "plain follow-up" });
      expect(followUp.body.queued).toBeUndefined();
      await until(async () => {
        snapshot = await botById(bot.id);
        return !snapshot.busy && echoes(snapshot).length >= 3;
      }, "the follow-up turn");
      expect(echoes(snapshot)).toHaveLength(3);
    },
    60_000,
  );

  it(
    "drains the queue after an interrupt — stop-then-steer",
    async () => {
      const bot = await newBot("steerStop", "Stoppable");

      const first = await api("POST", `/api/bots/${bot.id}/messages`, { text: "long job" });
      expect(first.status).toBe(202);
      expect((await botById(bot.id)).busy).toBe(true);

      const queued = await api("POST", `/api/bots/${bot.id}/messages`, { text: "after stop please" });
      expect(queued.body.queued).toBe(true);

      // wait for the prompt to be genuinely in flight before stopping it
      await until(async () => {
        try {
          return readFileSync(stopRpcDump, "utf8").includes("session/prompt");
        } catch {
          return false;
        }
      }, "the hung prompt");
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);

      // the interrupt settles the hung turn (ACP cancel grace), and the
      // drain consumes the queue: its message loses the queued flag while
      // the steered turn waits on the still-missing gate
      await until(async () => {
        const snapshot = await botById(bot.id);
        const message = snapshot.messages.find((m: any) => m.text === "after stop please");
        return Boolean(message) && !message.queued;
      }, "the post-interrupt drain");

      writeFileSync(stopGate, "open");
      let snapshot: any;
      await until(async () => {
        snapshot = await botById(bot.id);
        return !snapshot.busy && echoes(snapshot).length >= 1;
      }, "the steered turn");

      // the interrupted turn produced no reply; the steered one answers
      const replies = echoes(snapshot);
      expect(replies).toHaveLength(1);
      expect(replies[0].text).toContain("after stop please");
    },
    60_000,
  );

  it(
    "holds the queue across an interrupt and resumes it into one joined turn",
    async () => {
      const bot = await newBot("steerHold", "Holdable");

      const first = await api("POST", `/api/bots/${bot.id}/messages`, { text: "job to stop" });
      expect(first.status).toBe(202);
      expect((await botById(bot.id)).busy).toBe(true);

      const one = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hold entry" });
      const two = await api("POST", `/api/bots/${bot.id}/messages`, { text: "survivor note" });
      expect(one.body.queued).toBe(true);
      expect(two.body.queued).toBe(true);

      // the strip's snapshot: both waiting, not held
      let queue = (await api("GET", `/api/bots/${bot.id}/queue`)).body.queue;
      expect(queue.paused).toBe(false);
      expect(queue.items.map((i: any) => i.text)).toEqual(["hold entry", "survivor note"]);

      // per-item remove: one send leaves the queue, its words stay put
      const removed = await api("DELETE", `/api/bots/${bot.id}/queue/${one.body.messageId}`);
      expect(removed.status).toBe(200);
      expect(removed.body.queue.items.map((i: any) => i.text)).toEqual(["survivor note"]);
      let snapshot = await botById(bot.id);
      const dropped = snapshot.messages.find((m: any) => m.id === one.body.messageId);
      expect(dropped.text).toBe("hold entry");
      expect(dropped.queued).toBeUndefined();

      // hold the survivor, then stop the turn mid-flight
      const held = await api("PATCH", `/api/bots/${bot.id}/queue`, { paused: true });
      expect(held.status).toBe(200);
      expect(held.body.queue.paused).toBe(true);

      // wait for the prompt to be genuinely in flight before stopping it
      await until(async () => {
        try {
          return readFileSync(holdRpcDump, "utf8").includes("session/prompt");
        } catch {
          return false;
        }
      }, "the hung prompt");
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);

      // AFTER STOP the hold wins: the bot settles idle and the survivor
      // still waits — exactly what the strip's resume chip acts on
      await until(async () => !(await botById(bot.id)).busy, "the interrupt to settle");
      snapshot = await botById(bot.id);
      expect(snapshot.messages.find((m: any) => m.id === two.body.messageId).queued).toBe(true);
      queue = (await api("GET", `/api/bots/${bot.id}/queue`)).body.queue;
      expect(queue.paused).toBe(true);
      expect(echoes(snapshot)).toHaveLength(0);

      // resume releases the hold AND drains at once (the bot is idle — no
      // settle is coming), then let the joined turn finish
      expect((await api("PATCH", `/api/bots/${bot.id}/queue`, { paused: false })).status).toBe(200);
      writeFileSync(holdGate, "open");
      await until(async () => {
        snapshot = await botById(bot.id);
        return !snapshot.busy && echoes(snapshot).length >= 1;
      }, "the resumed turn");

      const replies = echoes(snapshot);
      // ONE joined turn for the survivor; the removed send never ran
      expect(replies).toHaveLength(1);
      expect(replies[0].text).toContain("survivor note");
      expect(replies[0].text).not.toContain("hold entry");
      // consumed: the snapshot the strip renders is gone, not stale
      expect((await api("GET", `/api/bots/${bot.id}/queue`)).body.queue).toBeNull();
    },
    60_000,
  );
});
