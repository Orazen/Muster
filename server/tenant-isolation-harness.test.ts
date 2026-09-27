// A self-hosted deployment with two accounts must not let either account reach
// the other's work — by stream, by unattended scheduling, or by cancelling it.
//
// Four defects from the 2026-09-26 sweep's third sweep, all on one fixture:
//
//   S3-0  the first-run seed ran on a self-hosted deployment and produced an
//         OWNERLESS bot. `!SELF_HOSTED || OMB_ALLOW_SIGNUPS !== "true"` read
//         signups-open (the default) as signups-closed and seeded anyway — on a
//         fresh data directory, where no account exists yet, so the boot
//         ownership migration had no primary to assign it to. Every tenant rule
//         reads a missing ownerId as "shared", so that bot belonged to everyone:
//         readable, renameable and runnable by any account. The filter was never
//         at fault; there was no owner to filter on.
//   S3-1  POST /api/routines had no ownership check while its /run, PATCH and
//         DELETE siblings all had `ownsRoutine` — so any account could schedule
//         unattended, repeating work on another account's bot.
//   S3-2  the SSE filter read only top-level botId/groupId/threadId, so the
//         shape nearly every bot frame takes — `{kind:"bot", bot:{…}}` —
//         matched none of them and fell through to "deployment-wide, send to
//         everyone".
//   S3-3  /api/routine-runs/:id/(cancel|seen) had no guard either: cancel
//         another account's running unattended work, or mark it seen and
//         silence the badge that would have told its owner it needed attention.
//
// THE FIXTURE IS THE POINT. The first attempt at this file booted with
// `pairingServerEnvironment`, which sets OMB_HOST=127.0.0.1 and OMB_PUBLIC_URL
// but NOT OMB_PUBLIC_HOST — so SELF_HOSTED was false, the session gate never
// ran, client.userId was "", and `visibleToClient` returned true on its first
// line. The filter was not weak, it was switched off, and the "leak" that
// produced was an artifact of the harness. `env.OMB_PUBLIC_HOST` below is what
// actually turns isolation on.
//
// Responses are parsed with zod rather than asserted into shape, the idiom the
// other two-account harness uses: the anti-slop lint rules reject a bare
// `as {…}`, and here the payloads are exactly what a regression depends on
// getting right.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pairingServerEnvironment, waitForOwnedServer } from "../e2e/pairing-harness.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { seedConnectedGoogleRow } from "./testing/storage-gate.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const botSchema = z.object({ id: z.string(), name: z.string() }).passthrough();
const botsEnvelope = z.object({ bots: z.array(botSchema) });
const routineSchema = z.object({ id: z.string(), botId: z.string() }).passthrough();
const routinesEnvelope = z.object({ routines: z.array(routineSchema) });
const routineEnvelope = z.object({ routine: routineSchema });
const runEnvelope = z.object({ run: z.object({ id: z.string() }).passthrough() });
const errorEnvelope = z.object({ error: z.string() }).passthrough();

interface Account {
  cookie: string;
  name: string;
  userId: string;
}

/** Collects the frames one account's live stream actually delivered. */
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
        const readerHandle = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await readerHandle.read();
          if (chunk.done) break;
          reader.buffer += decoder.decode(chunk.value, { stream: true });
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

  /** Every frame received, as raw JSON text — the assertions below only ever
   * ask "does this text mention X", which needs no shape at all. */
  raw(): string[] {
    return [...this.seen];
  }

  mentioning(needle: string): string[] {
    return this.seen.filter((frame) => frame.includes(needle));
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
  let dataDir = "";
  let base: string;
  let alice: Account;
  let bob: Account;

  /** A request body this harness actually sends. Named rather than a loose
   * dictionary so the anti-slop rules have a concrete contract to check. */
  interface RequestBody {
    name?: string;
    botId?: string;
    prompt?: string;
    schedule?: { type: "once"; at: number } | { type: "daily"; time: string; weekdays: number[] };
    durationMinutes?: number;
  }

  const call = async (account: Account, method: string, path: string, body?: RequestBody) => {
    // Built by assignment rather than annotated, so the inferred type carries
    // the evidence (the anti-slop rules reject widening it to a dictionary).
    const headers = new Headers({ cookie: account.cookie });
    if (body) headers.set("content-type", "application/json");
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text };
  };

  const botNames = async (account: Account): Promise<string[]> =>
    (botsEnvelope.parse(JSON.parse((await call(account, "GET", "/api/bots")).text)).bots).map((b) => b.name);

  const firstBotId = async (account: Account): Promise<string> =>
    botsEnvelope.parse(JSON.parse((await call(account, "GET", "/api/bots")).text)).bots[0]?.id ?? "";

  const settle = () => new Promise((r) => setTimeout(r, 1_200));

  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "omb-tenant-iso-"));
    dataDir = join(home, "data");
    const companion = join(home, "companion");
    const ui = join(ROOT, "dist");
    for (const dir of [dataDir, companion, ui, join(home, ".muster")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, ".muster", "config.json"), "{}");

    const env = pairingServerEnvironment({
      home,
      dataDirectory: dataDir,
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
      const sessionBody = (await (await fetch(`${base}/api/auth/get-session`, { headers: { cookie } })).text());
      const session = z.object({ user: z.object({ id: z.string() }) }).parse(JSON.parse(sessionBody));
      return { cookie, name, userId: session.user.id };
    };
    alice = await signUp("alice");
    bob = await signUp("bob");

    // No seed any more, so each account hires its own — the shape a hosted
    // deployment intends: the first user builds their own workspace rather than
    // inheriting a bot nobody owns. Hiring sits behind the storage gate, so each
    // account gets the connected-Drive row it would have after doing that for
    // real.
    for (const account of [alice, bob]) {
      seedConnectedGoogleRow(dataDir, account.userId);
      const hired = await call(account, "POST", "/api/bots", { name: `${account.name}'s bot` });
      if (hired.status !== 201) {
        throw new Error(`hiring a bot for ${account.name} failed: ${hired.status} ${hired.text.slice(0, 200)}`);
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("S3-0: a self-hosted deployment with open signups seeds no bot at all", async () => {
    // Asserting "no bot belongs to two accounts" is NOT enough, and the first
    // draft of this case did not discriminate: `ownsRecord` already treats an
    // ownerless record as operator-only, so the seeded bot showed up in the
    // primary's list and nobody else's, and an overlap check passed with the
    // defect in place. The contract the fix actually establishes is narrower
    // and is what matters on a hosted deployment: nobody inherits a workspace
    // they did not build. Both accounts hired exactly one bot in beforeAll.
    // The store picks its own friendly name for a new bot, so the COUNT is the
    // contract, not the name: one hired bot each, and nothing else.
    expect((await botNames(alice)).length, "alice must have only the bot she hired").toBe(1);
    expect((await botNames(bob)).length, "bob must have only the bot he hired").toBe(1);
  }, 60_000);

  it("S3-2: a stream carries no frame about another account's bot, and still carries its own", async () => {
    const bobStream = await StreamReader.open(base, bob.cookie);
    await settle();

    const aliceBotId = await firstBotId(alice);
    expect(aliceBotId, "alice needs a bot to act on").not.toBe("");
    const renamed = await call(alice, "PATCH", `/api/bots/${aliceBotId}`, { name: "Alice Private Project" });
    expect(renamed.status).toBe(200);
    await settle();

    // Stated over raw frame text, because the disclosure a human would actually
    // notice is the name as much as the id.
    expect(bobStream.mentioning(aliceBotId), "no frame about Alice's bot may reach Bob").toEqual([]);
    expect(bobStream.mentioning("Alice Private Project"), "and certainly not her bot's name").toEqual([]);

    // A filter that dropped everything would pass the two assertions above.
    const bobBotId = await firstBotId(bob);
    const bobRenamed = await call(bob, "PATCH", `/api/bots/${bobBotId}`, { name: "Bob Own Bot" });
    expect(bobRenamed.status).toBe(200);
    await settle();
    expect(
      bobStream.mentioning("Bob Own Bot").length,
      "Bob must still receive his own bot frames",
    ).toBeGreaterThan(0);

    bobStream.stop();
  }, 60_000);

  it("S3-1: an account cannot schedule unattended work on another account's bot", async () => {
    const aliceBotId = await firstBotId(alice);
    const refused = await call(bob, "POST", "/api/routines", {
      name: "not mine",
      botId: aliceBotId,
      prompt: "scheduled on someone else's bot",
      schedule: { type: "daily", time: "03:00", weekdays: [1] },
    });
    // 404, not 403: a foreign id must stay indistinguishable from a missing one,
    // or the route becomes a bot-existence oracle across accounts.
    expect(refused.status, "a foreign bot must be refused, never scheduled").toBe(404);
    expect(errorEnvelope.parse(JSON.parse(refused.text)).error).toBe("no such bot");

    // And nothing may exist on Alice's side afterwards.
    const aliceRoutines = routinesEnvelope.parse(JSON.parse((await call(alice, "GET", "/api/routines")).text));
    expect(aliceRoutines.routines.filter((r) => r.botId === aliceBotId).length).toBe(0);
  }, 60_000);

  it("S3-3: an account cannot cancel or mark-seen another account's routine run", async () => {
    const aliceBotId = await firstBotId(alice);

    // Alice schedules and starts a routine, so there is a REAL run id for Bob
    // to try to steal. The first draft used a run id that did not exist, so it
    // answered 404 with or without the guard — it passed vacuously and would
    // have certified a fix that was not there.
    const created = await call(alice, "POST", "/api/routines", {
      name: "alice overnight",
      botId: aliceBotId,
      prompt: "long enough to still be running when bob tries to cancel it",
      schedule: { type: "once", at: Date.now() + 60_000 },
      durationMinutes: 30,
    });
    expect(created.status, "alice must be able to schedule her own work").toBe(201);
    const routineId = routineEnvelope.parse(JSON.parse(created.text)).routine.id;
    const started = await call(alice, "POST", `/api/routines/${routineId}/run`);
    expect(started.status).toBe(201);
    const aliceRunId = runEnvelope.parse(JSON.parse(started.text)).run.id;
    expect(aliceRunId, "alice must have a real run id for this case to mean anything").not.toBe("");

    for (const action of ["cancel", "seen"]) {
      const res = await call(bob, "POST", `/api/routine-runs/${aliceRunId}/${action}`);
      expect(res.status, `${action} on another account's run must 404`).toBe(404);
    }
    // And alice can still act on her own run: a guard that refused everyone
    // would pass the two assertions above while breaking the feature.
    const own = await call(alice, "POST", `/api/routine-runs/${aliceRunId}/seen`);
    expect(own.status, "alice must still be able to mark her own run seen").toBe(200);
  }, 90_000);
});
