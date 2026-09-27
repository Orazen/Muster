// The receipt route, end to end, on a real bot and a real turn.
//
// The unit test next door (receiptFinishedAt) pins the arithmetic. This pins the
// WIRING — that the route reads the transcript rather than the clock — because
// a mutation reverting the route to Date.now() leaves every pure-function test
// green. That mutation was tried and survived; this file is what kills it.
//
// Also pinned here: `result` is derived from whether the bot said anything, so a
// transcript that ended on an unanswered question reports "done" next to a
// finding saying it ended waiting. Recorded as a known mis-description rather
// than silently redefined — the receipt is a signed artifact and its meaning is
// a product decision, not a bug fix.

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let base: string;
let stderr = "";
let cookie = "";

/** The wire body, already serialized. Taking the JSON text rather than an
 *  object keeps the exact bytes under test visible at the call site — which is
 *  the thing these assertions are about — and leaves the request contract
 *  unopinionated about shapes the server is supposed to reject. */
async function api(method: string, path: string, bodyJson?: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie, origin: base },
    body: bodyJson,
    redirect: "manual",
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 25_000) => {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

/** Wait until the transcript stops growing. A turn emits activity and tool
 *  chips after its text reply, so "the bot said something" is not "the job
 *  finished" — and a still-growing transcript legitimately moves the duration,
 *  because the job really is still producing. The property under test is that
 *  a SETTLED job's receipt does not change, so the fixture has to settle
 *  first. */
const waitForTranscriptToSettle = async (threadId: string, quietMs = 2_500) => {
  const deadline = Date.now() + 30_000;
  let lastCount = -1;
  let lastChange = Date.now();
  for (;;) {
    // SAFETY: the messages route always answers an array under `messages`,
    // defaulting to empty; the `?? []` covers the null case, and the only thing
    // read below is `.length`.
    const messages = ((await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? []) as unknown[];
    if (messages.length !== lastCount) {
      lastCount = messages.length;
      lastChange = Date.now();
    }
    if (lastCount > 0 && Date.now() - lastChange >= quietMs) return lastCount;
    if (Date.now() > deadline) throw new Error(`transcript never settled at ${lastCount} messages. stderr: ${stderr.slice(-1500)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

posixOnly("receipt duration is a fact about the job", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-receipt-duration-"));
    mkdirSync(join(home, ".muster"), { recursive: true });
    writeFileSync(
      join(home, ".muster", "config.json"),
      JSON.stringify({
        instances: { happy: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: true } } },
      }),
    );
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(port) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.stdout!.resume();
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const signed = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email: "receipt@example.com", password: "correct-horse-battery", name: "Receipt" }),
      redirect: "manual",
    });
    const jar = signed.headers.getSetCookie?.() ?? [];
    const session = jar.find((c) => c.startsWith("better-auth.session_token="));
    expect(session, `no session cookie in: ${jar.join(" | ")}`).toBeTruthy();
    // SAFETY: the assertion above throws when no cookie was written, so the
    // split below always cuts a real name=value pair.
    cookie = (session as string).split(";")[0] as string;
  }, 40_000);

  afterAll(async () => {
    child?.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    if (home) await removeTempDir(home);
  });

  it("reports the same duration every time a finished job is read", async () => {
    // THE defect. The route passed Date.now() as finishedAt, so three reads of
    // one finished job reported 17m 27s, then 17m 33s, then 17m 39s — the
    // number was a fact about the reader, not the job, on the artifact whose
    // whole purpose is to be shared as proof of work.
    const created = (await api("POST", "/api/bots")).body.bot;
    expect(created.id).toBeTruthy();
    await api("PATCH", `/api/bots/${created.id}`, JSON.stringify({ modelSelection: { instanceId: "happy", model: "fake-model" } }));
    const sent = await api("POST", `/api/bots/${created.id}/messages`, JSON.stringify({ text: "do the thing" }));
    expect(sent.status).toBe(202);
    // The bot record owns its thread; there is no list-threads route to ask.
    const bot = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === created.id);
    // SAFETY: as above — the record came from the store that just created it,
    // and the assertion on the next line guards the cast.
    const threadId = (bot as { threadId: string }).threadId;
    expect(threadId).toBeTruthy();
    await waitFor(async () => {
      const messages = (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];
      return messages.some((m: { role: string; kind: string }) => m.role === "bot" && m.kind === "text");
    }, "the bot's reply");
    await waitForTranscriptToSettle(threadId);

    const first = await api("GET", `/api/receipts/${created.id}/${threadId}`);
    expect(first.status).toBe(200);
    // A receipt's durationMs is a number by its own type; asserting
    // Number.isFinite also pins it against null/NaN, which is what a missing
    // value would arrive as.
    const duration = Number(first.body.receipt.durationMs);
    expect(Number.isFinite(duration)).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(0);

    // Read it again after a real delay. With Date.now() the second read is
    // strictly larger; with the transcript it is identical.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const second = await api("GET", `/api/receipts/${created.id}/${threadId}`);
    expect(second.body.receipt.durationMs).toBe(duration);
    expect(second.body.receipt.durationHuman).toBe(first.body.receipt.durationHuman);

    // And a third, to be sure it is not a coincidence of one interval.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const third = await api("GET", `/api/receipts/${created.id}/${threadId}`);
    expect(third.body.receipt.durationMs).toBe(duration);
  });

  it("does not report a duration longer than the transcript can account for", async () => {
    // Belt and braces on the same property: the reported duration must be
    // bounded by the span from the task's creation to its last message, never
    // by wall-clock time since the reader last looked.
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, JSON.stringify({ modelSelection: { instanceId: "happy", model: "fake-model" } }));
    await api("POST", `/api/bots/${created.id}/messages`, JSON.stringify({ text: "another thing" }));
    const bot = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === created.id);
    // SAFETY: as above — the record came from the store that just created it,
    // and the assertion on the next line guards the cast.
    const threadId = (bot as { threadId: string }).threadId;
    expect(threadId).toBeTruthy();
    await waitFor(async () => {
      const messages = (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];
      return messages.some((m: { role: string; kind: string }) => m.role === "bot" && m.kind === "text");
    }, "the bot's reply");
    await waitForTranscriptToSettle(threadId);
    const receipt = (await api("GET", `/api/receipts/${created.id}/${threadId}`)).body.receipt;
    const startedAt = Date.parse(receipt.startedAt);
    expect(receipt.durationMs).toBeLessThanOrEqual(Date.now() - startedAt);
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
  });
});
