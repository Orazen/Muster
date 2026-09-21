#!/usr/bin/env node
// Run with node --experimental-strip-types scripts/owned-watch-call-acceptance.ts.
// Only freshly created simulators and offline owned host data are touched.
import { z } from "zod";
import type { JsonValue } from "../server/schema.ts";
import { spawn } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { startPairingHarness } from "../e2e/pairing-harness.ts";
import { createProxyHandler } from "../companion/src/proxy.ts";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "muster-watch-call-"));
const reuseIndex = process.argv.indexOf("--derived-data");
const derived = reuseIndex < 0 ? join(scratch, "derived") : realpathSync(process.argv[reuseIndex + 1]);
if (reuseIndex >= 0 && (basename(derived) !== "derived" || !basename(dirname(derived)).startsWith("muster-watch-call-") || dirname(dirname(derived)) !== realpathSync(tmpdir()))) throw new Error("Reuse requires an existing owned Watch fixture derived directory");
const traffic: { method: string; path: string; status: number }[] = [];
let paired = false;
const sims: string[] = [], servers: Server[] = [];
let harness: Awaited<ReturnType<typeof startPairingHarness>> | undefined;
function run(command: string, args: string[], timeoutMs = 120_000, env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const logPath = join(scratch, `${command}-${Date.now()}.log`);
    const collect = (chunk: Buffer) => { output += chunk; appendFileSync(logPath, chunk); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); if (escalation) clearTimeout(escalation); reject(error); });
    child.once("close", code => { clearTimeout(timer); if (escalation) clearTimeout(escalation); if (code === 0) resolve(output); else { writeFileSync(join(scratch, `failure-${Date.now()}.log`), output); reject(new Error(`${command} exited ${code}; ${scratch}/failure-*.log`)); } });
  });
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = z.object({ port: z.number() }).parse(server.address());
  return `http://127.0.0.1:${address.port}`;
}
try {
  console.log(JSON.stringify({ phase: "scratch", scratch }));
  const ui = join(scratch, "ui"); mkdirSync(ui); writeFileSync(join(ui, "index.html"), "Owned Watch call fixture");
  // Paced fake engine: the chat-streaming test observes a deterministic
  // live window (chunk at 3s, settle at 9s — XCTest's existence polling
  // ticks about once a second, and a 1s busy window raced the poller).
  // Real engines take seconds to first token; the fixture mirrors that.
  // The call test is timing-insensitive to it; both ride the same engine.
  harness = await startPairingHarness({ staticDir: ui, calendarFixture: true, streamDelayMs: 3_000 });
  const base = harness.desktopUrl;
  const request = async (path: string, method = "GET", body?: JsonValue) => {
    const init: RequestInit = { method, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(base + path, init);
    if (!response.ok) throw new Error(`Owned host ${method} ${path}: ${response.status}`);
    return response.json();
  };
  const { bot } = await request("/api/bots", "POST", {});
  await request(`/api/bots/${bot.id}`, "PATCH", { name: "Owned Watch Bot", computer: "off", composio: false });
  let code = "", redeemed = false;
  const token = randomBytes(32).toString("hex");
  const calls: Record<string, number> = {};
  const handler = createProxyHandler({ harnessPort: Number(new URL(base).port), serverName: () => "Owned Watch Rig",
    authenticate: value => redeemed && value === token ? { access: "full", cloudDesktopAccess: false } : null,
    redeem: value => {
      if (!code || redeemed || value !== code) return { error: "Invalid owned pairing code" };
      redeemed = true; paired = true; return { token, device: { id: randomUUID(), name: "Owned Watch", createdAt: Date.now(), lastSeenAt: Date.now() } };
    },
  });
  const companion = await listen(createServer((req, res) => {
    if ((req.url ?? "").includes("/calls")) { const key = `${req.method} ${(req.url ?? "").replace(/[0-9a-f-]{36}/g, ":id")}`; calls[key] = (calls[key] ?? 0) + 1; }
    res.on("finish", () => traffic.push({ method: req.method ?? "GET", path: (req.url ?? "/").split("?")[0], status: res.statusCode }));
    handler(req, res);
  }));
  const control = await listen(createServer((req, res) => {
    if (req.method === "POST" && req.url === "/calendar-approve" && !req.headers.origin) {
      void (async () => {
        let body = "";
        for await (const chunk of req) { body += String(chunk); if (body.length > 1024) throw new Error("Oversized owned control request"); }
        const { code: enrollmentCode } = z.object({ code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/) }).strict().parse(JSON.parse(body));
        const fixture = harness?.calendarFixture;
        if (!fixture) throw new Error("Owned Calendar fixture missing");
        for (const [action, payload] of [
          ["inspect", { code: enrollmentCode }],
          ["approve", { code: enrollmentCode, calendarId: fixture.calendarId, label: "Owned Watch" }],
        ] as const) {
          const approved = await fetch(`${base}/api/calendar/enrollment/${action}`, {
            method: "POST", headers: { "content-type": "application/json", cookie: fixture.cookie, origin: base },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000), redirect: "error",
          });
          if (!approved.ok) throw new Error(`Owned Calendar ${action}: ${approved.status}`);
          await approved.arrayBuffer();
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      })().catch(() => res.writeHead(500).end());
      return;
    }
    if (req.method === "GET" && req.url === "/status" && !req.headers.origin) {
      void request(`/api/threads/${bot.threadId}/messages`).then(({ messages }) => {
        const userMessages = messages.filter((value: { role: string; kind: string }) => value.role === "user" && value.kind === "text").length;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ userMessages }));
      }).catch(() => res.writeHead(500).end());
      return;
    }
    if (req.method !== "POST" || req.url !== "/pairing" || req.headers.origin) { res.writeHead(404).end(); return; }
    code = String(randomInt(100000, 1000000)); redeemed = false;
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ code }));
  }));
  const inventory = JSON.parse(await run("xcrun", ["simctl", "list", "--json"]));
  const runtime = inventory.runtimes.find((value: { name: string; isAvailable: boolean }) => value.name.startsWith("watchOS") && value.isAvailable);
  const type = inventory.devicetypes.find((value: { name: string }) => value.name === "Apple Watch Ultra 3 (49mm)");
  if (!runtime || !type) throw new Error("Installed watchOS runtime/device type unavailable");
  const udid = (await run("xcrun", ["simctl", "create", `Muster Owned Call ${randomUUID()}`, type.identifier, runtime.identifier])).trim();
  if (!/^[0-9A-F-]{36}$/i.test(udid)) throw new Error("Invalid created simulator receipt");
  sims.push(udid);
  console.log(JSON.stringify({ phase: "owned-simulator", udid, companion, control }));
  await run("xcodegen", ["generate", "--spec", join(root, "ios/project.yml")]);
  await run("xcodebuild", ["build-for-testing", "-project", join(root, "ios/MusterCompanion.xcodeproj"), "-scheme", "MusterWatchOwnedAcceptance", "-configuration", "Release", "-destination", "generic/platform=watchOS Simulator", "-derivedDataPath", derived], 600_000);
  await run("xcrun", ["simctl", "boot", udid]);
  await run("xcrun", ["simctl", "bootstatus", udid, "-b"], 180_000);
  console.log(JSON.stringify({ phase: "test", udid }));
  const output = await run("xcodebuild", ["test-without-building", "-project", join(root, "ios/MusterCompanion.xcodeproj"), "-scheme", "MusterWatchOwnedAcceptance", "-configuration", "Release", "-destination", `platform=watchOS Simulator,id=${udid}`, "-derivedDataPath", derived, "-resultBundlePath", join(scratch, "acceptance.xcresult"), "-parallel-testing-enabled", "NO"], 600_000, { ...process.env, TEST_RUNNER_MUSTER_WATCH_CONTROL: control, TEST_RUNNER_MUSTER_WATCH_COMPANION: companion, TEST_RUNNER_MUSTER_WATCH_BOT: bot.id });
  writeFileSync(join(scratch, "xcodebuild.log"), output);
  const { messages } = await request(`/api/threads/${bot.threadId}/messages`);
  const userMessages = messages.filter((value: { role: string; kind: string }) => value.role === "user" && value.kind === "text").length;
  if (userMessages !== 2) throw new Error(`Expected exactly two explicit user dispatches (call + chat); got ${userMessages}`);
  console.log(JSON.stringify({ phase: "passed", userMessages, calls, result: join(scratch, "acceptance.xcresult") }));
} finally {
  writeFileSync(join(scratch, "traffic.json"), JSON.stringify({ paired, traffic }, null, 2));
  console.log(JSON.stringify({ phase: "traffic", paired, requests: traffic.length }));
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await harness?.stop();
  for (const udid of sims) {
    await run("xcrun", ["simctl", "shutdown", udid]).catch(() => {});
    await run("xcrun", ["simctl", "delete", udid]);
  }
  console.log(JSON.stringify({ phase: "cleanup", ownedSimulatorsDeleted: sims, evidenceRetained: scratch }));
}
