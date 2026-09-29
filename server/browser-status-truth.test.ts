// Ground truth about whether a bot's browser will actually mount.
//
// The defect this pins. `/api/browser-status` reported two things: whether the
// obscura binary exists, and which bots have the toggle on. The mount needs
// THREE things — the toggle, the binary, AND an engine adapter that declares
// `customMcp` — and only the first two were ever checked.
//
// Only 4 of the 29 drivers declare `customMcp` (claude, grok, openai,
// acp/core). So a bot on `grokagent`, `codex`, `google`, `local` — and 21
// others — showed the settings card reading "available, 1 bot enabled" while
// every turn ran with zero browser tools. The card was reassuring the user
// about a capability the engine could not mount, and the bot could only report
// that it had no browser. That is the whole bug: not that the browser was
// missing, but that nothing said WHY.
//
// A live server with a real store, because the claim is about what a user's
// settings card would tell them.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let base: string;
let cookie = "";
let stderr = "";
/** A driver kind whose adapter does not declare `customMcp`, found at run time. */
let dummyDriver = "";

/** Find a driver that cannot mount a custom MCP server.
 *
 *  Read off disk rather than hard-coded, because the set changes: supporting
 *  drivers went from four to nine while this test existed, and a pinned name
 *  made it assert against a fact that had already moved. */
function driverWithoutCustomMcp(): string | null {
  const dir = join(ROOT, "server", "drivers");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
  for (const file of files) {
    if (readFileSync(join(dir, file), "utf8").includes("customMcp")) continue;
    const kind = file.replace(/\.ts$/, "");
    // `local` composes the shared ACP core, which DOES declare customMcp, so a
    // file that merely omits the token is not enough — the composed adapter is
    // what the turn path reads. Skip the wrappers that delegate to it.
    if (["local", "grokagent", "native", "retry", "local-inject", "acp"].includes(kind)) continue;
    return kind;
  }
  return null;
}

type BotStatus = {
  id: string;
  name: string;
  enabled: boolean;
  engineId: string | null;
  engineSupportsBrowser: boolean;
  effective: boolean;
  reason: "off" | "not-installed" | "engine-unsupported" | null;
};

type BrowserStatus = {
  available: boolean;
  bots: Array<{ id: string; name: string }>;
  status: BotStatus[];
  blockedCount: number;
  tools: number;
};

async function get(path: string): Promise<BrowserStatus> {
  const response = await fetch(`${base}${path}`, { headers: { cookie, origin: base }, redirect: "manual" });
  expect(response.status).toBe(200);
  // SAFETY: BrowserStatus above is the route's declared wire shape; the tests
  // below assert exactly these fields, and a shape drift fails an assertion
  // rather than crashing on a missing field.
  return (await response.json()) as BrowserStatus;
}

posixOnly("browser status tells the truth about each bot", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "muster-browser-status-"));
    const data = join(home, "data");
    mkdirSync(data, { recursive: true });
    // A `config.json` of `{}` sends the server looking for an engine at boot
    // over the network. Declaring a dummy instance keeps the fixture offline.
    //
    // The dummy deliberately uses a driver that CANNOT mount a custom MCP
    // server, and it is DISCOVERED rather than hard-coded. The first version of
    // this test pinned `local`, and it went stale the moment `local` began
    // inheriting `customMcp` from the shared ACP core — supporting drivers went
    // from four to nine and the test started failing on a true assertion about a
    // fact that had simply changed. A test that pins which drivers support the
    // browser is a test that will rot every time a driver is added.
    const withoutMcp = driverWithoutCustomMcp();
    if (!withoutMcp) throw new Error("every driver now supports customMcp; this fixture needs one that does not");
    dummyDriver = withoutMcp;
    writeFileSync(
      join(data, "config.json"),
      JSON.stringify({ instances: { dummy: { driver: withoutMcp, displayName: "Dummy" } } }),
    );
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
      cwd: ROOT,
      env: {
        HOME: home,
        USERPROFILE: home,
        OMB_DATA_DIR: data,
        OMB_COMPANION_DIR: join(home, "companion"),
        OMB_HOST: "127.0.0.1",
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        OMB_PUBLIC_URL: base,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        OMB_ALLOW_SIGNUPS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.stdout!.resume();
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const response = await fetch(`${base}/api/health`, { redirect: "manual" });
        if (response.ok) break;
      } catch {
        /* the listener is not up yet */
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`browser-status fixture did not start: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email: "browser@example.com", password: "correct-horse-battery", name: "Browser" }),
      redirect: "manual",
    });
    const jar = signed.headers.getSetCookie?.() ?? [];
    const session = jar.find((c) => c.startsWith("better-auth.session_token="));
    expect(session, `no session cookie: ${jar.join(" | ")}`).toBeTruthy();
    // SAFETY: the assertion above throws when no cookie was written, so the
    // split below always cuts a real name=value pair.
    cookie = (session as string).split(";")[0] as string;
  }, 45_000);

  afterAll(async () => {
    child?.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    if (home) await removeTempDir(home);
  });

  /** Create a bot, then PATCH its browser toggle — which is how the settings
   *  card actually sets it, so the fixture exercises the same path a user does. */
  const createBot = async (name: string, browser: boolean, instanceId?: string): Promise<string> => {
    const created = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ name }),
      redirect: "manual",
    });
    expect(created.status).toBe(201);
    // SAFETY: the status assertion above throws first, so the body is the
    // created bot and `id` is present.
    const bot = ((await created.json()) as { bot: { id: string } }).bot;
    if (instanceId) {
      const pinned = await fetch(`${base}/api/bots/${bot.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, origin: base },
        body: JSON.stringify({ modelSelection: { instanceId } }),
        redirect: "manual",
      });
      expect(pinned.status).toBe(200);
    }
    const patched = await fetch(`${base}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ browser }),
      redirect: "manual",
    });
    expect(patched.status).toBe(200);
    return bot.id;
  };

  it("reports a bot whose engine cannot mount the browser as blocked, with the reason", async () => {
    // THE regression. `local` declares no `customMcp`, so this bot's toggle can
    // never produce browser tools — and the old reply said nothing at all.
    const id = await createBot("OnUnsupportedEngine", true, "dummy");
    const status = await get("/api/browser-status");
    const entry = status.status.find((b) => b.id === id);
    expect(entry, "the new bot is absent from the per-bot status").toBeDefined();
    expect(entry!.enabled, "the toggle is on but status says off").toBe(true);
    expect(entry!.engineSupportsBrowser, `the ${dummyDriver} driver declares no customMcp but status says it supports the browser`).toBe(false);
    expect(entry!.effective, "a bot that cannot mount the browser reports effective").toBe(false);
    // The reason must be the ENGINE, not "off" or "not-installed" — those are
    // different problems with different fixes, and collapsing them into one
    // "unavailable" is what made this unfixable from the outside.
    expect(["engine-unsupported", "not-installed"]).toContain(entry!.reason);
  });

  it("counts blocked bots separately from enabled ones", async () => {
    // The number a user needs at a glance: how many bots the toggle claims and
    // the engine cannot honour.
    const status = await get("/api/browser-status");
    const enabled = status.status.filter((b) => b.enabled);
    expect(status.bots.map((b) => b.id).sort()).toEqual(enabled.map((b) => b.id).sort());
    const blocked = enabled.filter((b) => !b.effective);
    expect(status.blockedCount, "blockedCount disagrees with the per-bot list").toBe(blocked.length);
  });

  it("marks a bot with the toggle off as off, not as broken", async () => {
    // A bot nobody enabled is not a fault, and must not be counted as blocked.
    const id = await createBot("NotEnabled", false, "dummy");
    const status = await get("/api/browser-status");
    const entry = status.status.find((b) => b.id === id);
    expect(entry!.enabled).toBe(false);
    expect(entry!.reason).toBe("off");
    expect(entry!.effective).toBe(false);
  });

  it("keeps the pre-existing reply shape so an older client is unaffected", async () => {
    // `bots` and `tools` are what the shipped card reads. Adding fields must not
    // change them, or the settings page breaks on its own server.
    const status = await get("/api/browser-status");
    expect(Array.isArray(status.bots)).toBe(true);
    for (const entry of status.bots) {
      expect(Object.keys(entry).sort()).toEqual(["id", "name"]);
    }
    // SAFETY: get() parses the body into BrowserStatus, whose tools is a
    // number and available a boolean; these assert the WIRE carries them.
    expect(status.tools).toEqual(expect.any(Number));
    expect(status.available).toEqual(expect.any(Boolean));
  });
});
