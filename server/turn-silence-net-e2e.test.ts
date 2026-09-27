// A turn that completes having produced nothing must say so.
//
// The engine accepted the prompt and returned no output. Every other way a turn
// dies already writes something: the dispatch catch stamps an error, the reaper
// stamps how the process died, the stall watchdog stamps how long it waited,
// the provider-limit branch explains itself. This path wrote nothing — so the
// bot went back to `idle` looking perfectly healthy while the user's message
// simply vanished. No error in the thread, nothing in the server log.
//
// Reproduced deterministically here with the fake ACP CLI's `empty-reply` mode,
// which completes the turn without calling `playTurn()`. The same signature was
// seen live against a real 186MB CLI that starts but never completes the ACP
// handshake: three messages in the thread (greeting, options card, the user's
// own words) and no explanation.
//
// The three cases that must NOT be flagged are the reason this is not simply
// "append a chip when `reply` is empty":
//
//   - a tool-only turn is a legitimate turn that says nothing in prose but
//     leaves its own transcript rows, and flagging it would be noise on a
//     working bot;
//   - an operator who pressed Stop is told nothing because Stop answers with a
//     receipt and writes no row, so without a marker the operator would be
//     told their own Stop was a failure;
//   - a turn the bot answered must not gain a chip claiming otherwise.
//
// Same POSIX gating and boot pattern as server/liveness-e2e.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject } from "./schema.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 21800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

interface Msg {
  role: string;
  kind: string;
  text?: string;
  tool?: { name?: string; ok?: boolean };
}

const SILENCE = "this turn ended without a reply";

posixOnly("a turn that ends in silence must say so (fake ACP fleet)", () => {
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

  const botById = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const threadOf = async (id: string) => (await botById(id)).threadId;
  const messages = async (threadId: string): Promise<Msg[]> =>
    (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];

  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const botOn = async (instanceId: string): Promise<string> => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId, model: "fake-model" } });
    return created.id;
  };

  /** Send, then wait for the turn to settle. */
  const sendAndSettle = async (botId: string, text: string): Promise<Msg[]> => {
    expect((await api("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
    await waitFor(async () => (await botById(botId)).busy === false, "the turn to settle");
    return messages(await threadOf(botId));
  };

  const silenceNotes = (msgs: Msg[]): Msg[] => msgs.filter((m) => (m.tool?.name ?? "").includes(SILENCE));

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-silence-net-"));
    mkdirSync(join(home, ".muster"), { recursive: true });
    writeFileSync(
      join(home, ".muster", "config.json"),
      JSON.stringify({
        instances: {
          // Completes the turn with no output at all.
          quiet: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "empty-reply" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // A normal turn, for the "already answered" control.
          talker: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "happy" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // Never resolves, so the turn can be stopped mid-flight.
          stayer: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "hang" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
      }),
    );
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) };
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
    await removeTempDir(home);
  });

  it("says the turn produced nothing when the engine returns nothing", async () => {
    const botId = await botOn("quiet");
    const msgs = await sendAndSettle(botId, "are you there?");

    const notes = silenceNotes(msgs);
    expect(notes.length, "the silent turn must leave a visible note").toBe(1);
    expect(notes[0]!.tool?.ok).toBe(false);
    // The note has to be actionable, not just present: the operator's message
    // is saved, so telling them to resend is the useful half.
    expect(notes[0]!.tool?.name).toMatch(/send again/i);
    // And the words the operator typed are still in the transcript — the note
    // must not read as if the message was lost.
    expect(msgs.some((m) => m.role === "user" && m.text?.includes("are you there?"))).toBe(true);
  }, 60_000);

  it("stays quiet on a turn the bot answered", async () => {
    // The false-positive guard. Without it the net would be an "everything is
    // broken" chip that trains the operator to ignore it.
    const botId = await botOn("talker");
    const msgs = await sendAndSettle(botId, "hello there");
    expect(msgs.some((m) => m.role === "bot" && m.kind === "text" && (m.text ?? "").length > 0)).toBe(true);
    expect(silenceNotes(msgs).length, "an answered turn must not be flagged").toBe(0);
  }, 60_000);

  it("stays quiet when the operator stopped the turn", async () => {
    // Stop answers with a receipt and writes no transcript row, so a stopped
    // turn is indistinguishable from an abandoned one unless something marks
    // it. Without the marker, pressing Stop is reported back to the operator
    // as a failure they caused.
    const botId = await botOn("stayer");
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "long task" })).status).toBe(202);
    await waitFor(async () => (await botById(botId)).busy === true, "the turn to go busy");

    const stopped = await api("POST", `/api/bots/${botId}/interrupt`);
    expect([200, 202, 503]).toContain(stopped.status);
    await waitFor(async () => (await botById(botId)).busy === false, "the stopped turn to settle", 30_000);

    expect(silenceNotes(await messages(await threadOf(botId))).length, "a stopped turn is not a failure").toBe(0);
  }, 60_000);
});
