// Three places where the server answered in a way that described the wrong
// thing: a 500 for a body the caller got wrong, a raw JS TypeError in a user
// error slot, and a receipt whose duration climbed while you read it.
//
// All three are boot-a-real-server tests, because the defect in each case is
// the status line or the header, not the return value.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { receiptFinishedAt } from "./receipts.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let directory: string;
let base: string;
let cookie: string;
let stderr = "";

async function startServer(): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), "muster-client-errors-"));
  const data = join(directory, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({}));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    OMB_DATA_DIR: data,
    OMB_COMPANION_DIR: join(directory, "companion"),
    OMB_HOST: "127.0.0.1",
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_PUBLIC_URL: base,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    // A real session, so these assertions are about the handlers and not about
    // the auth gate: a 401 here would be the gate, not the bug.
    OMB_ALLOW_SIGNUPS: "true",
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env,
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
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error(`client-error fixture did not start: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const signed = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    // The same-origin guard rejects a mutation with no Origin, so the fixture
    // has to present one; without it the sign-up 403s and every assertion below
    // is about the auth gate rather than the handler.
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: "fixture@example.com", password: "correct-horse-battery", name: "Fixture" }),
    redirect: "manual",
  });
  expect(signed.status).toBe(200);
  const jar = signed.headers.getSetCookie?.() ?? [];
  const session = jar.find((c) => c.startsWith("better-auth.session_token="));
  expect(session, `no session cookie in: ${jar.join(" | ")}`).toBeTruthy();
  // SAFETY: the assertion above throws before this line when the sign-up wrote
  // no session cookie, so the split below always cuts a real name=value pair.
  cookie = (session as string).split(";")[0] as string;
}

/** The wire body, already serialized. Taking JSON text keeps the exact bytes
 *  under test visible at each call site, which is the thing being asserted —
 *  including `null`, which a typed parameter could not express and which is
 *  one of the cases that used to leak a TypeError. */
function post(path: string, bodyJson: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: base },
    body: bodyJson,
    redirect: "manual",
  });
}

posixOnly("client errors describe the client", () => {
  beforeAll(startServer, 40_000);
  afterAll(async () => {
    child?.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    if (directory) await removeTempDir(directory);
  });

  it("answers 400, not 500, when the caller sent a body with no routine in it", async () => {
    // Pre-fix: 500 with the text "Give the routine a name" — a 5xx that tells
    // an operator the server broke, when nothing broke.
    const response = await post("/api/routines", JSON.stringify({ foo: "bar" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Give the routine a name" });
  });

  it("never leaks a raw JavaScript TypeError as the user-facing error", async () => {
    // Pre-fix: 500 "Cannot read properties of null (reading 'name')" — the
    // server narrating its own stack trace to the client, with a null-pointer
    // message a user can do nothing with.
    const response = await post("/api/routines", "null");
    expect(response.status).toBe(400);
    // SAFETY: every handler in this file answers an object with an `error`
    // string — the 400s and the 500s alike — so the shape is fixed by the
    // server, not chosen here.
    const text = ((await response.json()) as { error: string }).error;
    expect(text).not.toMatch(/Cannot read propert|undefined is not|is not a function/);
    expect(text).toMatch(/name|required|missing/i);
  });

  it("still rejects a well-formed body for the reason that actually applies", async () => {
    // The point of the fix is to move the STATUS, not to flatten every answer
    // to 400 or to stop checking. A body that names a routine but omits its
    // schedule must still be refused, and refused for THAT reason — proving the
    // validation chain still runs rather than short-circuiting to a generic 400.
    const response = await post("/api/routines", JSON.stringify({ name: "x", prompt: "y", botId: "z", runOn: "agent" }));
    expect(response.status).toBe(400);
    // SAFETY: as above — the routines handlers always answer `{ error }`.
    expect(((await response.json()) as { error: string }).error).toMatch(/schedule/i);
  });

  it("does not turn a non-string into a speakable utterance", async () => {
    // Pre-fix: 200 with utterances: ["[object Object]"] — a 2xx promising
    // speech-ready text built from String({}). A caller passing the wrong type
    // gets an empty list or an error, not a stringified object.
    const response = await post("/api/tts/prepare", JSON.stringify({ text: { a: { b: 1 } } }));
    expect(response.status).toBe(200);
    // SAFETY: /api/tts/prepare always answers `{ ready, utterances }`; the
    // route is the only writer of that shape.
    const body = (await response.json()) as { utterances: string[] };
    expect(body.utterances).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("[object Object]");
  });

  it("still splits a real string into utterances", async () => {
    // The guard must not be a blanket rejection — the normal path is the one
    // that has to keep working.
    const response = await post("/api/tts/prepare", JSON.stringify({ text: "First sentence. Second one!" }));
    expect(response.status).toBe(200);
    // SAFETY: as above — the same fixed prepare-route shape.
    const body = (await response.json()) as { utterances: string[] };
    expect(body.utterances.length).toBeGreaterThan(0);
    expect(body.utterances.join(" ")).toContain("Second one");
  });
});

describe("receiptFinishedAt", () => {
  it("reads the finish time off the transcript, so a GET cannot change it", () => {
    // THE defect. The route passed Date.now() as finishedAt, so three reads of
    // the same finished job reported 17m 27s, then 17m 33s, then 17m 39s.
    const created = 1_757_000_000_000;
    const transcript = [{ at: created + 1_047_215 }];
    expect(receiptFinishedAt(created, transcript)).toBe(created + 1_047_215);
    // Read again an hour later — with a real clock argument this time.
    expect(receiptFinishedAt(created, transcript, created + 3_600_000)).toBe(created + 1_047_215);
  });

  it("takes the LAST message, not the first or an arbitrary one", () => {
    const created = 1_757_000_000_000;
    const transcript = [
      { at: created + 10 },
      { at: created + 900 },
      { at: created + 400 },
    ];
    expect(receiptFinishedAt(created, transcript)).toBe(created + 900);
  });

  it("never claims a job finished before it started", () => {
    // A clock skew, a restored transcript, or a message stamped early: a
    // negative duration is a different lie, and formatDuration hides it as an
    // em-dash, which reads as "unknown" rather than "wrong".
    const created = 1_757_000_000_000;
    expect(receiptFinishedAt(created, [{ at: created - 60_000 }])).toBe(created);
  });

  it("falls back to the clock only when there is nothing to read", () => {
    const now = 1_757_000_999_000;
    expect(receiptFinishedAt(1_757_000_000_000, [], now)).toBe(now);
  });
});
