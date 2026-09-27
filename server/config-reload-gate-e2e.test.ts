// Saving a cosmetic config section must not destroy work in progress.
//
// `PUT /api/config` reloaded the provider registry whenever the patch carried
// any key besides `profile`/`tts`. The registry reload is destructive BY
// DESIGN: it disposes every engine on purpose and settles busy bots with
// "turn interrupted — provider settings changed". That is the right behaviour
// when a credential changes, because the engines hold the old one.
//
// But the exemption list was a denylist of two, and four more sections are read
// live and never baked into an engine: `branding`, `parallelThreads`,
// `eventLogRetention` and `bots.defaultEffort`. So typing an organisation name
// and clicking away mid-turn killed that turn. Fleet-wide, for everyone, with
// no error — the operator had done nothing that could possibly affect a turn.
//
// This drives the real server with the fake ACP CLI in `hang` mode, which never
// resolves a prompt, so there is a genuinely in-flight turn to interrupt. Both
// halves are pinned: a cosmetic save must leave it running, and a real
// credential change must still settle it honestly. Without the second half this
// file would pass just as well against a server that never reloads at all.
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
const PORT = 20800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

interface Msg {
  role: string;
  kind: string;
  text?: string;
  tool?: { name?: string; ok?: boolean };
}

/** The chip `reloadProviders()` stamps when it settles a running turn. */
const INTERRUPTED = "turn interrupted — provider settings changed";

posixOnly("cosmetic config saves do not interrupt in-flight turns (fake ACP fleet)", () => {
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

  /** Start a turn on a fresh bot and wait until it is genuinely running. */
  const startHangingTurn = async (text: string): Promise<string> => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "hanger", model: "fake-model" },
    });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, `"${text}" to go busy`);
    return created.id;
  };

  const interruptedNotes = async (botId: string): Promise<Msg[]> => {
    const thread = await messages((await getBot(botId)).threadId);
    return thread.filter((m: Msg) => (m.tool?.name ?? "").includes(INTERRUPTED));
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-config-gate-"));
    mkdirSync(join(home, ".muster"), { recursive: true });
    // `hang` never resolves a prompt, so a turn started here stays running
    // until something settles it. That is the point: the turn has to survive a
    // settings edit, which means the engine must be one that will not finish on
    // its own.
    writeFileSync(
      join(home, ".muster", "config.json"),
      JSON.stringify({
        instances: {
          hanger: {
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

  it("leaves a running turn alone when a cosmetic section is saved", async () => {
    const botId = await startHangingTurn("long task that must survive a rename");

    // The four sections the 2026-09-26 sweep found: none is read by a driver,
    // and every one of them is editable from Settings while a turn is running.
    // The two that were already exempt are kept in the list so the set cannot
    // quietly lose them.
    const cosmetic: JsonObject[] = [
      { branding: { orgName: "Acme" } },
      { parallelThreads: { default: 3 } },
      { eventLogRetention: { deleteArchivedAfterDays: 30 } },
      { bots: { defaultEffort: "high" } },
      { profile: { name: "Renamed Operator" } },
      { tts: { voice: "alloy" } },
    ];
    for (const patch of cosmetic) {
      const label = Object.keys(patch)[0]!;
      expect((await api("PUT", "/api/config", patch)).status, `saving ${label}`).toBe(200);
      // No settling window: the reload was synchronous with the save, so an
      // immediate read is a fair test and there is nothing to wait for.
      const bot = await getBot(botId);
      expect(bot.busy, `${label} must not settle the turn`).toBe(true);
      expect(bot.activity, `${label} must not idle the bot`).not.toBe("idle");
      expect((await interruptedNotes(botId)).length, `${label} must not stamp an interrupt`).toBe(0);
    }

    // And it is still live after a settle window, not merely un-interrupted at
    // the instant of each save — an async settle would still count as a
    // destroyed turn. Deliberately NOT verified by sending Stop: whether Stop
    // reaps a hanging engine is a separate defect with its own fix, and leaning
    // on it here would fail this test for a reason that has nothing to do with
    // the reload gate.
    await new Promise((r) => setTimeout(r, 2_000));
    const settled = await getBot(botId);
    expect(settled.busy, "the turn must still be running 2s after the last save").toBe(true);
    expect(settled.activity).not.toBe("idle");
    expect((await interruptedNotes(botId)).length).toBe(0);
    // The operator's own words are still in the thread, unsullied by a chip
    // claiming a settings change stopped the work.
    const thread = await messages(settled.threadId);
    expect(thread.some((m: Msg) => m.text?.includes("must survive a rename"))).toBe(true);
  }, 60_000);

  it("still settles a running turn honestly when a provider credential changes", async () => {
    // The other half of the gate. If this stopped passing, the fix above would
    // be indistinguishable from "never reload", and a saved API key would
    // silently do nothing until the next restart.
    const botId = await startHangingTurn("long task interrupted by a real credential change");

    // `xai.key` is injected as XAI_API_KEY per-instance environment at
    // registry-load time, so it is one of the sections that genuinely has to
    // rebuild the engines.
    const saved = await api("PUT", "/api/config", { xai: { key: "xai-gate-test-key" } });
    expect(saved.status).toBe(200);

    await waitFor(async () => (await getBot(botId)).busy === false, "the reload to settle the turn", 30_000);
    const notes = await interruptedNotes(botId);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]!.tool?.ok).toBe(false);
    // The chip must be honest about WHY, or the operator cannot tell a settings
    // change from a provider outage.
    expect((await getBot(botId)).activity).toBe("idle");
  }, 60_000);
});
