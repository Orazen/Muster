#!/usr/bin/env node
// Boots an isolated Muster harness server for the Mac app's live transport
// tests, then signs in and prints connection facts as KEY=value lines:
//
//   origin=http://127.0.0.1:<port>
//   cookieName=better-auth.session_token
//   cookieValue=<session cookie>
//   botId=<seeded bot id>
//
// Owned everything: temp HOME/DATA/COMPANION/STATIC dirs, a free port pair,
// a fixture bot on the fake ACP CLI (happy mode — no provider calls), a
// signed-in account via the real sign-up route (storage gate pre-satisfied
// with a fixture Drive grant, same as the server's own harness tests).
//
// This process STAYS ALIVE: it owns the server child's lifecycle, so the
// Swift test harness must terminate it when the test finishes. Terminating
// this process stops the server (bounded wait, SIGKILL escalation) and only
// then removes the temp directory — shutdown is provable, never assumed.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const directory = mkdtempSync(join(tmpdir(), "muster-mac-live-"));
const data = join(directory, "data");
const home = join(directory, "home");
const companion = join(directory, "companion");
const ui = join(directory, "ui");
for (const path of [data, home, companion, ui]) mkdirSync(path, { recursive: true, mode: 0o700 });
writeFileSync(join(ui, "index.html"), "<!doctype html><title>Owned Mac live fixture</title>");
writeFileSync(join(data, "config.json"), JSON.stringify({
  instances: { held: { driver: "grokAgent", config: { cli: join(ROOT, "server/testing/fake-acp-cli.ts"), fullAuto: true } } },
}), { mode: 0o600 });

const { pairingServerEnvironment, waitForOwnedServer } = await import("file://" + join(ROOT, "e2e/pairing-harness.ts"));
const { freePortBlock } = await import("file://" + join(ROOT, "server/testing/ports.ts"));
const port = await freePortBlock([0, 1, 2], 47000, 9000);
const env = pairingServerEnvironment({
  home, dataDirectory: data, companionDirectory: companion, staticDir: ui,
  port, webhookPort: port + 1, secret: randomBytes(32).toString("hex"),
});
Object.assign(env, { OMB_ALLOW_SIGNUPS: "true" });
const server = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
  cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", () => {});
server.stderr.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-4_000); });
const url = `http://127.0.0.1:${port}`;
try {
  await waitForOwnedServer(server, url, { timeoutMs: 60_000 });
} catch (error) {
  console.error(String(error));
  console.error(serverLog);
  server.kill("SIGTERM");
  process.exit(1);
}

const email = `mac-${randomBytes(6).toString("hex")}@example.test`;
const password = randomBytes(24).toString("base64url");
const signup = await fetch(`${url}/api/auth/sign-up/email`, {
  method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
  headers: { "content-type": "application/json", origin: url },
  body: JSON.stringify({ email, password, name: "Mac Live" }),
});
if (signup.status !== 200) throw new Error(`sign-up failed: ${signup.status}`);
const cookieName = "better-auth.session_token";
// SAFETY: better-auth always sets this cookie name on email signup over HTTP.
const cookie = (signup.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${cookieName}=`))?.split(";")[0] ?? "";
if (!cookie) throw new Error("no session cookie from sign-up");
const cookieValue = cookie.slice(cookieName.length + 1);

const headers = { "content-type": "application/json", origin: url, cookie };
const created = await fetch(`${url}/api/bots`, {
  method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers,
  body: JSON.stringify({ name: "Scout" }),
});
if (created.status !== 201) throw new Error(`bot create failed: ${created.status}`);
const { bot } = await created.json();

// Shutdown must be provable: SIGTERM stops the server child, waits (bounded)
// for its exit, escalates to SIGKILL if it hangs, and only then removes the
// fixture files — a QA audit found this handler leaving the helper process
// alive because the keep-alive interval held the event loop open, and the
// temp directory being deleted while the server was still running.
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  try { server.kill("SIGTERM"); } catch {}
  const deadline = Date.now() + 10_000;
  while (server.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (server.exitCode === null) {
    try { server.kill("SIGKILL"); } catch {}
    const killDeadline = Date.now() + 5_000;
    while (server.exitCode === null && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { rmSync(directory, { recursive: true, force: true }); } catch {}
  process.exit(0);
};
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
console.log(`origin=${url}`);
console.log(`cookieName=${cookieName}`);
console.log(`cookieValue=${cookieValue}`);
console.log(`botId=${bot.id}`);
// Stay alive: the tests own this process's lifetime. stop() exits explicitly,
// so the interval never lingers past shutdown.
