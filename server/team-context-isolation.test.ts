// The team brief, over real HTTP, as two real accounts.
//
// The unit tests prove the store keys by owner. This proves the ROUTE resolves
// the owner — which is the half that was missing, and the half a store-level
// test cannot reach. A store fix with an unscoped route still leaks: both
// accounts would write to, and read from, the same bucket.
//
// The dangerous part of this brief is that teamContextSystemPrompt injects it
// into every turn of every bot, so a cross-account read here is a cross-account
// read into a model's prompt, not merely a settings page.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let directory: string;
let base: string;
let stderr = "";
let dataDir = "";
let secret = "";
const cookies = new Map<string, string>();

async function signUp(email: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: email.split("@")[0] }),
    redirect: "manual",
  });
  expect(response.status, `sign-up for ${email} answered ${response.status}: ${await response.text()}`).toBe(200);
  const jar = response.headers.getSetCookie?.() ?? [];
  const session = jar.find((c) => c.startsWith("better-auth.session_token="));
  // SAFETY: the status assertion above throws first, so a jar without a
  // session cookie is a server defect this test should fail on, not a
  // silently empty cookie that makes every later GET a 401.
  expect(session, `no session cookie for ${email}`).toBeTruthy();
  // SAFETY: guarded by the assertion immediately above.
  return (session as string).split(";")[0] as string;
}

async function brief(email: string): Promise<{ text: string; updatedAt: number }> {
  const response = await fetch(`${base}/api/team-context`, {
    headers: { cookie: cookies.get(email)!, origin: base },
    redirect: "manual",
  });
  expect(response.status).toBe(200);
  // SAFETY: the status assertion above is the guard — the route answers 200
  // with exactly `{text, updatedAt}` (or the 0-updatedAt default), never an
  // error body, so the shape is fixed by the route rather than chosen here.
  return (await response.json()) as { text: string; updatedAt: number };
}

async function putBrief(email: string, text: string): Promise<Response> {
  return fetch(`${base}/api/team-context`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: cookies.get(email)!, origin: base },
    body: JSON.stringify({ text }),
    redirect: "manual",
  });
}

posixOnly("the team brief belongs to one account", () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "muster-team-context-"));
    const data = join(directory, "data");
    dataDir = data;
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({}));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    secret = randomBytes(32).toString("hex");
    const env: NodeJS.ProcessEnv = {
      HOME: directory,
      USERPROFILE: directory,
      OMB_DATA_DIR: data,
      OMB_COMPANION_DIR: join(directory, "companion"),
      OMB_HOST: "127.0.0.1",
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_PUBLIC_URL: base,
      BETTER_AUTH_SECRET: secret,
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
        throw new Error(`team-context fixture did not start: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    for (const email of ["ada@example.com", "zoe@example.com"]) {
      cookies.set(email, await signUp(email));
    }
  }, 45_000);

  afterAll(async () => {
    child?.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    if (directory) await removeTempDir(directory);
  });

  it("starts with both accounts seeing an empty brief", async () => {
    expect((await brief("ada@example.com")).text).toBe("");
    expect((await brief("zoe@example.com")).text).toBe("");
  });

  it("does not read one account's brief as the other", async () => {
    // THE regression, end to end. Pre-fix the route wrote and read one
    // deployment-global file, so ZOE read ADA's text — and because the brief is
    // injected into every turn of every bot, that text also reached a model.
    const put = await putBrief("ada@example.com", "ADA_PRIVATE_MERGER_TALKS_9931");
    expect(put.status).toBe(200);
    expect((await brief("ada@example.com")).text).toBe("ADA_PRIVATE_MERGER_TALKS_9931");
    expect((await brief("zoe@example.com")).text).toBe("");
  });

  it("does not let one account overwrite the other's", async () => {
    await putBrief("zoe@example.com", "ZOE_OWN_NOTES");
    expect((await brief("ada@example.com")).text).toBe("ADA_PRIVATE_MERGER_TALKS_9931");
    expect((await brief("zoe@example.com")).text).toBe("ZOE_OWN_NOTES");
  });

  it("clears only the caller's own brief", async () => {
    // Last-writer-wins on a shared file is the same bug wearing a different
    // hat: clearing must not take the other account's brief with it.
    const cleared = await putBrief("zoe@example.com", "");
    expect(cleared.status).toBe(200);
    expect((await brief("zoe@example.com")).text).toBe("");
    expect((await brief("ada@example.com")).text).toBe("ADA_PRIVATE_MERGER_TALKS_9931");
  });

  it("survives a restart with both briefs still separated", async () => {
    // The store is on disk; a boot must not merge or drop the two records.
    child.kill("SIGKILL");
    await waitForExit(child).catch(() => {});
    const port = Number(new URL(base).port);
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
      cwd: ROOT,
      env: {
        HOME: directory,
        USERPROFILE: directory,
        // The SAME data dir the first boot wrote. Omitting OMB_DATA_DIR here
        // sent the restart to $HOME/.muster instead, and the brief "vanished" —
        // which was the test lying, not the store losing data.
        OMB_DATA_DIR: dataDir,
        OMB_HOST: "127.0.0.1",
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        OMB_PUBLIC_URL: base,
        // The SAME secret as the first boot. Regenerating it here invalidated
        // both session cookies, so the post-restart reads resolved to no owner
        // and reported an empty brief — the test lying about data loss, again.
        BETTER_AUTH_SECRET: secret,
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
      if (Date.now() > deadline) throw new Error(`restarted fixture did not come up: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect((await brief("ada@example.com")).text).toBe("ADA_PRIVATE_MERGER_TALKS_9931");
    expect((await brief("zoe@example.com")).text).toBe("");
  });
});
