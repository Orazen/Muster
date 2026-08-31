// Reproduces the exact production bug reported live on muster.orazen.online:
// a bot created while zero engines were configured is permanently stuck with
// modelSelection.instanceId "" -- "provider instance \"\" is unavailable --
// pick another model in settings" -- even minutes after the operator adds a
// real, working provider key. Root cause: bootSelection (and therefore every
// bot's default modelSelection at creation time) is computed once at server
// boot and never refreshed. Uses production's actual config shape: no
// explicit "instances" override, so instanceConfigs()'s DEFAULT_FLEET (and
// its provider-key-driven additions) is what's actually in play, unlike the
// shared harness in index.test.ts which seeds an explicit instances map for
// other tests' own determinism needs.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "./schema.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 19900 + Math.floor(Math.random() * 5000);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;
let home: string;

const api = async (method: string, path: string, body?: JsonValue): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "muster-model-heal-"));
  mkdirSync(join(home, ".muster"), { recursive: true });
  // Deliberately no config.json at all -- boots with zero engines
  // configured, exactly like a fresh install, so bootSelection resolves
  // empty and the onboarding bot's modelSelection is stuck at "".

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      // Deliberately a minimal system PATH, not the dev machine's real one:
      // this test needs zero agent CLIs discoverable so defaultSelection()
      // resolves empty regardless of what's actually installed locally
      // (this dev machine has a real, logged-in `claude` CLI, which would
      // otherwise get picked and make the test's premise false).
      PATH: "/usr/bin:/bin",
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(PORT + 1000),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 100));
  }
}, 30_000);

afterAll(async () => {
  child.kill();
  await waitForExit(child);
  removeTempDir(home);
});

describe("model-selection self-heal", () => {
  it("stuck bot recovers once a provider key is saved, no manual reassignment needed", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    expect(bot.modelSelection.instanceId).toBe(""); // reproduces the bug's starting state

    const stillStuck = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(stillStuck.status).toBe(409);
    expect(stillStuck.body.error).toContain('provider instance ""');

    const saved = await api("PUT", "/api/config", {
      providers: { openai: { apiKey: "sk-test-not-a-real-key" } },
    });
    expect(saved.status).toBe(200);

    // no manual model reassignment — same bot, same endpoint
    const healed = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(healed.status).toBe(202);

    // persisted onto the bot record, not just a one-off in-memory
    // resolution for this one request
    const { body: after } = await api("GET", "/api/bots");
    const refetched = after.bots.find((b: any) => b.id === bot.id);
    expect(refetched.modelSelection.instanceId).toBe("openaiApi");
  });

  it("a brand-new bot created after the key was saved gets the right default immediately", async () => {
    const created = await api("POST", "/api/bots", {});
    expect(created.status).toBe(201);
    expect(created.body.bot.modelSelection.instanceId).toBe("openaiApi");
  });
});
