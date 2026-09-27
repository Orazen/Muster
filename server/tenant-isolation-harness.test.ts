// A self-hosted deployment with two accounts must not let either account reach
// the other's work — by stream, by unattended scheduling, or by cancelling it.
//
// Three defects from the 2026-09-26 sweep's third sweep, all on one fixture:
//
//   S3-0  the first-run seed ran on a self-hosted deployment and produced an
//         OWNERLESS bot. `if (!SELF_HOSTED || OMB_ALLOW_SIGNUPS !== "true")`
//         read signups-open (the default) as signups-closed and seeded anyway —
//         on a fresh data directory, where no account exists yet, so the boot
//         ownership migration had no primary to assign it to. Every tenant rule
//         reads a missing ownerId as "shared", so that bot belonged to everyone:
//         readable, renameable and runnable by any account. The filter was never
//         at fault; there was no owner to filter on.
//   S3-1  POST /api/routines had no ownership check while its /run, PATCH and
//         DELETE siblings all had `ownsRoutine` — so any account could schedule
//         unattended, repeating work on another account's bot.
//   S3-3  /api/routine-runs/:id/(cancel|seen) had no guard either: cancel
//         another account's running work, or mark it seen and silence the badge
//         that would have told its owner it needed attention.
//
// THE FIXTURE IS THE POINT. The first attempt at this file booted with
// `pairingServerEnvironment`, which sets OMB_HOST=127.0.0.1 and OMB_PUBLIC_URL
// but NOT OMB_PUBLIC_HOST — so SELF_HOSTED was false, the session gate never
// ran, client.userId was "", and `visibleToClient` returned true on its first
// line. The filter was not weak, it was switched off, and the "leak" that
// produced was an artifact of the harness. `env.OMB_PUBLIC_HOST` below is what
// actually turns isolation on, and the case that proves it is on (Bob still
// receives his own frames) is what stops a filter that simply drops everything
// from passing.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { freePortBlock } from "./testing/ports.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import type { JsonObject } from "./schema.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

interface Account {
  cookie: string;
  name: string;
  userId: string;
}

class StreamReader {
  private readonly seen: string[] = [];
  private buffer = "";
  private stopped = false;

  constructor(private readonly controller: AbortController) {}

  static async open(base: string, cookie: string): Promise<StreamReader> {
    const controller = new AbortController();
    const reader = new StreamReader(controller);
    void (async () => {
      try {
        const res = await fetch(`${base}/api/events`, {
          headers: { cookie, accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;
        const decoded = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await decoded.read();
          if (done) break;
          reader.buffer += decoder.decode(value, { stream: true });
          let split = reader.buffer.indexOf("\n\n");
          while (split !== -1) {
            const frame = reader.buffer.slice(0, split);
            reader.buffer = reader.buffer.slice(split + 2);
            for (const line of frame.split("\n")) {
              if (line.startsWith("data: ")) reader.seen.push(line.slice(6));
            }
            split = reader.buffer.indexOf("\n\n");
          }
        }
      } catch {
        /* aborted at teardown */
      }
    })();
    return reader;
  }

  frames(): JsonObject[] {
    const out: JsonObject[] = [];
    for (const raw of this.seen) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") out.push(parsed as JsonObject);
      } catch {
        /* unparseable is not evidence either way */
      }
    }
    return out;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
  }
}

describe("tenant isolation on a self-hosted deployment", () => {
  let child: ChildProcess;
  let home: string;
  let base: string;
  let dataDir: string;
  let alice: Account;
  let bob: Account;

  const api = async (account: Account, method: string, path: string, body?: JsonObject) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { cookie: account.cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as JsonObject };
  };

  const settle = () => new Promise((r) => setTimeout(r, 1_200));

  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "omb-tenant-iso-"));
    const data = join(home, "data");
    dataDir = data;
    const companion = join(home, "companion");
    const ui = join(ROOT, "dist");
    for (const dir of [data, companion, ui, join(home, ".muster")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, ".muster", "config.json"), "{}");

    const env = pairingServerEnvironment({
      home,
      dataDirectory: data,
      companionDirectory: companion,
      staticDir: ui,
      port,
      webhookPort: port + 1,
      secret: randomBytes(32).toString("hex"),
    });
    // Without this SELF_HOSTED is false and the whole file tests nothing.
    env.OMB_PUBLIC_HOST = `127.0.0.1:${port}`;

    child = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (c) => (stderr += c));
    await waitForOwnedServer(child, base);

    const signUp = async (name: string): Promise<Account> => {
      const res = await fetch(`${base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `${name}@example.com`, password: "correct-horse-battery", name }),
      });
      const header = res.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
      if (!header) throw new Error(`signup for ${name} did not return a session: ${res.status}`);
      const cookie = header.split(";")[0]!;
      const session = (await (await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).json()) as {
        user: { id: string };
      };
      return { cookie, name, userId: session.user.id };
    };
    alice = await signUp("alice");
    bob = await signUp("bob");
    // No seed any more, so each account hires its own — the shape the product
    // intends for a hosted deployment: the first user builds their own
    // workspace rather than inheriting a bot nobody owns. Hiring is behind the
    // storage gate, so each account gets the connected-Drive row it would have
    // after doing that for real.
    for (const account of [alice, bob]) {
      seedConnectedGoogleRow(dataDir, account.userId);
      const hired = await api(account, "POST", "/api/bots", { name: `${account.name}'s bot` });
      if (hired.status !== 201) {
        throw new Error(`hiring a bot for ${account.name} failed: ${hired.status} ${JSON.stringify(hired.body).slice(0, 200)}`);
      }
    }
  }, 90_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("S3-0: a self-hosted deployment with open signups seeds no bot at all", async () => {
    // Asserting "no bot belongs to two accounts" is NOT enough and did not
    // discriminate: `ownsRecord` already treats an ownerless record as
    // operator-only, so the seeded bot showed up in the primary's list and
    // nobody else's, and an overlap check passed with the defect in place.
    //
    // The contract the fix actually establishes is narrower and is what matters
    // on a hosted deployment: nobody inherits a workspace they did not build.
    // Both accounts hired exactly one bot each in beforeAll, so one bot each is
    // the whole truth; before the fix the primary also had the unowned seed.
    const aliceBots = (await api(alice, "GET", "/api/bots")).body.bots as JsonObject[];
    const bobBots = (await api(bob, "GET", "/api/bots")).body.bots as JsonObject[];
    expect(aliceBots.length, "alice must have only the bot she hired").toBe(1);
    expect(bobBots.length, "bob must have only the bot he hired").toBe(1);
    const aliceIds = new Set(aliceBots.map((b) => String(b.id)));
    expect(
      bobBots.filter((b) => aliceIds.has(String(b.id))).map((b) => String(b.name)),
      "and no bot may belong to two accounts",
    ).toEqual([]);
  }, 60_000);

  it("S3-2: a stream carries no frame about another account's bot, and still carries its own", async () => {
    const bobStream = await StreamReader.open(base, bob.cookie);
    await settle();

    // Each account hires its own bot; POST is refused for the operator on a
    // self-hosted deployment without a key, so fall back to whatever the
    // account can legitimately see and act on.
    const aliceBots = (await api(alice, "GET", "/api/bots")).body.bots as JsonObject[];
    expect(aliceBots.length, "alice needs a bot to act on").toBeGreaterThan(0);
    const aliceBotId = String(aliceBots[0]!.id);
    const renamed = await api(alice, "PATCH", `/api/bots/${aliceBotId}`, { name: "Alice Private Project" });
    expect(renamed.status).toBe(200);
    await settle();

    const leaked = bobStream.frames().filter((f) => JSON.stringify(f).includes(aliceBotId));
    const named = bobStream.frames().filter((f) => JSON.stringify(f).includes("Alice Private Project"));
    expect(leaked.map((f) => String(f.kind)), "no frame about Alice's bot may reach Bob").toEqual([]);
    expect(named, "and certainly not her bot's name").toEqual([]);

    // A filter that dropped everything would pass the two assertions above.
    const bobBots = (await api(bob, "GET", "/api/bots")).body.bots as JsonObject[];
    expect(bobBots.length, "bob needs a bot of his own").toBeGreaterThan(0);
    const bobBotId = String(bobBots[0]!.id);
    const bobRenamed = await api(bob, "PATCH", `/api/bots/${bobBotId}`, { name: "Bob Own Bot" });
    expect(bobRenamed.status).toBe(200);
    await settle();
    expect(
      bobStream.frames().filter((f) => JSON.stringify(f).includes("Bob Own Bot")).length,
      "Bob must still receive his own bot frames",
    ).toBeGreaterThan(0);

    bobStream.stop();
  }, 60_000);

  it("S3-1: an account cannot schedule unattended work on another account's bot", async () => {
    const aliceBots = (await api(alice, "GET", "/api/bots")).body.bots as JsonObject[];
    const aliceBotId = String(aliceBots[0]!.id);

    const routine = await api(bob, "POST", "/api/routines", {
      name: "not mine",
      botId: aliceBotId,
      prompt: "scheduled on someone else's bot",
      schedule: { type: "daily", time: "03:00", weekdays: [1] },
    });
    // 404, not 403: a foreign id must stay indistinguishable from a missing
    // one, or the route becomes a bot-existence oracle across accounts.
    expect(routine.status, "a foreign bot must be refused, never scheduled").toBe(404);
    // And nothing may have been created on Alice's side.
    const aliceRoutines = (await api(alice, "GET", "/api/routines")).body.routines as JsonObject[];
    expect(aliceRoutines.filter((r) => String(r.botId) === aliceBotId).length).toBe(0);
  }, 60_000);

  it("S3-3: an account cannot cancel or mark-seen another account's routine run", async () => {
    const aliceBots = (await api(alice, "GET", "/api/bots")).body.bots as JsonObject[];
    const aliceBotId = String(aliceBots[0]!.id);

    // Alice schedules and starts a routine, so there is a REAL run id for Bob
    // to try to steal. The earlier version of this case used a run id that did
    // not exist, so it answered 404 with or without the guard — it passed
    // vacuously and would have certified a fix that was not there.
    const created = await api(alice, "POST", "/api/routines", {
      name: "alice overnight",
      botId: aliceBotId,
      prompt: "long enough to still be running when bob tries to cancel it",
      schedule: { type: "once", at: Date.now() + 60_000 },
      durationMinutes: 30,
    });
    expect(created.status, "alice must be able to schedule her own work").toBe(201);
    const routineId = String((created.body.routine as JsonObject).id);
    // The run id comes from the run response itself, so the case never has to
    // guess at a listing shape or wait for a run to become observable.
    const started = await api(alice, "POST", `/api/routines/${routineId}/run`);
    expect(started.status).toBe(201);
    const aliceRunId = String((started.body.run as JsonObject).id);
    expect(aliceRunId, "alice must have a real run id for this case to mean anything").not.toBe("");

    for (const action of ["cancel", "seen"]) {
      const res = await api(bob, "POST", `/api/routine-runs/${aliceRunId}/${action}`);
      expect(res.status, `${action} on another account's run must 404`).toBe(404);
    }
    // And alice can still act on her own run: a guard that refused everyone
    // would pass the two assertions above while breaking the feature.
    expect(
      (await api(alice, "POST", `/api/routine-runs/${aliceRunId}/seen`)).status,
      "alice must still be able to mark her own run seen",
    ).toBe(200);
  }, 90_000);
});
