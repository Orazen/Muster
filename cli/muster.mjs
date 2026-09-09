#!/usr/bin/env node
// muster — the CLI surface. Fifth surface of the platform: makes Muster
// callable FROM other agents, scripts, cron, and terminals. Pairing rides
// the same chip-code flow the desktop companion uses; local desktop
// installs work with no pairing at all (loopback session).
//
// Zero dependencies beyond Node's own fetch — this file is copy-installed
// by `curl` users and run by `npm i -g`, so the only contract is Node 22+.
//
//   muster up [-d] [--port 8799]   boot the server here + print a phone QR;
//                                  -d keeps it running after the terminal closes
//   muster stop                      stop the background server
//   muster logs [n]                  last n lines of the background log
//   muster pair [--cloud URL]        print/redeem a pairing code
//   muster bots                      roster: name, engine, state, budget
//   muster send <bot> <text>         send a turn, print the reply
//   muster watch <bot>               tail a thread live
//   muster approve [allow|deny]      answer the oldest pending card
//   muster status                    fleet summary
//   muster receipts [n]              last N job receipts
//   muster sessions                  active sign-ins; --revoke <prefix|other|all>
//   muster status --json             machine-readable (agent callers)

import { homedir, networkInterfaces } from "node:os";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderTerminal } from "./qr.mjs";

// Every on-disk path hangs off MUSTER_DIR (default ~/.muster). The env
// override keeps multi-instance testing and second installs off a real one.
const MUSTER_DIR = process.env.MUSTER_DIR ? resolve(process.env.MUSTER_DIR) : join(homedir(), ".muster");
const CONFIG_PATH = join(MUSTER_DIR, "cli.json");
const RUN_DIR = join(MUSTER_DIR, "run");
const RUNTIME_PATH = join(RUN_DIR, "up.json"); // { pid, port, detached, started }
const LOG_PATH = join(RUN_DIR, "up.log");
const CLOUD_DEFAULT = "https://muster.orazen.online";

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const has = (flag) => process.argv.includes(flag);
const [command = "help", subject, ...rest] = process.argv.slice(2);

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  mkdirSync(join(CONFIG_PATH, ".."), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...loadConfig(), ...patch }, null, 2) + "\n");
}

function apiConfig() {
  const cfg = loadConfig();
  if (!cfg.base || !cfg.cookie) {
    console.error("Not paired. Run `muster pair` first (local: `muster pair --local --port 8799`).");
    process.exit(2);
  }
  return cfg;
}

async function api(cfg, path, init = {}) {
  const headers = { "content-type": "application/json", cookie: cfg.cookie, origin: cfg.base };
  if (init.headers) Object.assign(headers, init.headers);
  const res = await fetch(`${cfg.base}${path}`, { ...init, headers });
  if (res.status === 401) {
    console.error("Session expired. Run `muster pair` again.");
    process.exit(2);
  }
  return res;
}

const asJson = async (res) => {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${JSON.stringify(body)?.slice(0, 300)}`);
    process.exit(1);
  }
  return body;
};

const lifetimeTokens = (bot) =>
  (bot.tasks ?? []).reduce((sum, t) => sum + (t.usage?.input ?? 0) + (t.usage?.output ?? 0), 0);

// ── commands ────────────────────────────────────────────────────────────

async function pair() {
  const local = has("--local");
  if (local) {
    const base = `http://127.0.0.1:${arg("--port") ?? 8799}`;
    // Local desktop installs have no session gate on a loopback owner
    // account; a CLI on the same machine just works once a user exists.
    const signin = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email: arg("--email"), password: arg("--password") }),
    });
    if (!signin.ok) {
      console.error(`Local sign-in failed (${signin.status}). Pass --email/--password of the desktop account.`);
      process.exit(1);
    }
    const raw = signin.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
    const cookie = raw ? raw.split(";")[0] : "";
    saveConfig({ base, cookie });
    console.log(`Paired with local harness at ${base}. Config: ${CONFIG_PATH}`);
    return;
  }
  const cloud = arg("--cloud") ?? CLOUD_DEFAULT;
  const email = arg("--email") ?? console.error("usage: muster pair --email you@example.com --password ... [--cloud URL]") ?? process.exit(1);
  const password = arg("--password") ?? process.exit(1);
  const signin = await fetch(`${cloud}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: cloud },
    body: JSON.stringify({ email, password }),
  });
  if (!signin.ok) {
    console.error(`Cloud sign-in failed (${signin.status}).`);
    process.exit(1);
  }
  const raw = signin.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
  const cookie = raw ? raw.split(";")[0] : "";
  const create = await fetch(`${cloud}/api/pair/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
  });
  const { code } = await asJson(create);
  console.log(`Pairing code: ${code}\nOpen muster.orazen.online/pair on a signed-in device, or run: muster pair --redeem ${code} --cloud ${cloud}`);
  saveConfig({ cloud, cloudEmail: email });
}

async function pairRedeem() {
  const cloud = arg("--cloud") ?? CLOUD_DEFAULT;
  const code = arg("--redeem") ?? process.exit(1);
  const verify = await fetch(`${cloud}/api/pair/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const raw = verify.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
  if (!verify.ok || !raw) {
    console.error("Redeem failed — the code may be consumed or expired.");
    process.exit(1);
  }
  const pair = raw.split(";")[0];
  const eq = pair.indexOf("=");
  saveConfig({ base: cloud, cookie: `${pair.slice(0, eq)}=${pair.slice(eq + 1)}` });
  console.log(`Paired. Config: ${CONFIG_PATH}`);
}

async function bots() {
  const cfg = apiConfig();
  const { bots } = await asJson(await api(cfg, "/api/bots"));
  const jsonOut = has("--json");
  const rows = bots
    .filter((b) => !b.hidden)
    .map((b) => ({
      name: b.name,
      engine: b.modelSelection?.instanceId ?? "",
      state: b.busy ? "busy" : b.activity ?? "idle",
      spentTokens: lifetimeTokens(b),
      budget: b.tokenBudget ?? null,
      browser: Boolean(b.browser),
    }));
  if (jsonOut) return console.log(JSON.stringify(rows, null, 2));
  for (const r of rows) {
    const budget = r.budget ? ` budget ${Math.max(0, r.budget - r.spentTokens).toLocaleString()} left` : "";
    console.log(`${r.name.padEnd(16)} ${r.state.padEnd(10)} ${r.engine.padEnd(14)} ${r.spentTokens.toLocaleString()} tok${budget}${r.browser ? " [browser]" : ""}`);
  }
}

async function send() {
  const cfg = apiConfig();
  const { bots } = await asJson(await api(cfg, "/api/bots"));
  const bot = bots.find((b) => b.name.toLowerCase() === (subject ?? "").toLowerCase());
  if (!bot) {
    console.error(`No bot named "${subject}". Run \`muster bots\`.`);
    process.exit(1);
  }
  const text = rest.join(" ");
  if (!text) {
    console.error("usage: muster send <bot> <text>");
    process.exit(1);
  }
  await asJson(await api(cfg, `/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) }));
  const { text: reply, error } = await waitForReply(cfg, bot.id, 180_000);
  if (error) {
    console.error(`Engine error: ${error}`);
    process.exit(1);
  }
  if (!reply) {
    console.error("Timed out waiting for the reply — the turn may still be running. Try `muster watch`.");
    process.exit(1);
  }
  console.log(reply.trim());
}

/** Poll until the bot's thread settles after the turn we just sent (the SSE
 *  stream is overkill for one-shot sends). The wait is scoped to THIS turn:
 *  the newest user text is the one just posted, and only bot messages newer
 *  than it can be its reply — a fresh bot's seeded greeting is a bot text
 *  too, and the driver takes a moment to flip `busy`, so "newest bot text"
 *  alone returns the greeting mid-spin-up. A hard engine failure lands as an
 *  activity chip with tool.ok === false, not as a reply. */
/** CLI drivers disagree on where failures land: codex-style ones raise a
 *  runtime.error (the activity chip above), but the claude driver captures
 *  the CLI's own auth failure as the turn's text output. A text that opens
 *  like this is not a hello — classify it as the error it is. Some drivers
 *  (droid) do both at once: chip AND the provider's HTTP error as text, so
 *  the text check keeps those from passing as replies too. */
const LOOKS_LIKE_FAILURE = /^(failed to authenticate|not logged in|please (run|sign in to)|unauthorized|invalid api key|error[:\s])/i;

async function waitForReply(cfg, botId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let turnAt = 0;
  for (;;) {
    const { bots: now } = await asJson(await api(cfg, "/api/bots"));
    const me = now.find((b) => b.id === botId);
    const mine = [...(me?.messages ?? [])].reverse();
    if (!turnAt) turnAt = (mine.find((m) => m.role === "user" && m.kind === "text")?.at ?? 0) + 1;
    const textReply = mine.find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim() && m.at >= turnAt);
    const reply = textReply && !LOOKS_LIKE_FAILURE.test(textReply.text.trim()) ? textReply : null;
    const busted = textReply && !reply
      ? { tool: { name: `error: ${textReply.text.trim().slice(0, 240)}`, setup: false } }
      : mine.find((m) => m.role === "bot" && m.kind === "activity" && m.tool && m.tool.ok === false && m.at >= turnAt);
    if (!me?.busy && (reply || busted)) {
      return {
        text: reply?.text?.trim() ?? null,
        error: reply ? null : String(busted?.tool?.name ?? "").replace(/^error:\s*/, "").slice(0, 240) || "engine error",
        setup: reply ? false : Boolean(busted?.tool?.setup),
      };
    }
    if (Date.now() > deadline) return { text: null, error: null, setup: false };
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

async function approve() {
  const cfg = apiConfig();
  const behavior = subject === "deny" ? "deny" : "allow";
  const { bots } = await asJson(await api(cfg, "/api/bots"));
  for (const bot of bots) {
    const pending = (bot.messages ?? []).find(
      (m) => m.kind === "options" && m.card?.requestId && m.card?.tool,
    );
    if (!pending) continue;
    await asJson(
      await api(cfg, `/api/bots/${bot.id}/respond`, {
        method: "POST",
        body: JSON.stringify({ requestId: pending.card.requestId, behavior, message: behavior === "deny" ? "Denied by the user (CLI)." : undefined }),
      }),
    );
    console.log(`${behavior === "allow" ? "Allowed" : "Denied"} ${bot.name}: ${pending.card.tool}`);
    return;
  }
  console.log("No pending approvals.");
}

// The session cookie is `token.signature`; the DB and the list/revoke
// endpoints speak raw tokens, so peel the token back out for "current" marking.
const currentToken = (cfg) => {
  const value = decodeURIComponent((cfg.cookie || "").split("=").slice(1).join("="));
  return value.split(".")[0] || "";
};

const shortDate = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "?");

async function sessions() {
  const cfg = apiConfig();
  const json = has("--json");
  const revoke = arg("--revoke");
  if (revoke === "all") {
    await asJson(await api(cfg, "/api/auth/revoke-sessions", { method: "POST" }));
    if (json) return console.log(JSON.stringify({ revoked: "all" }, null, 2));
    console.log("All sessions revoked (including this CLI's — run `muster pair` to re-pair).");
    return;
  }
  if (revoke !== undefined) {
    const list = await asJson(await api(cfg, "/api/auth/list-sessions"));
    const current = currentToken(cfg);
    const targets =
      revoke === "other"
        ? list.filter((s) => s.token !== current)
        : list.filter((s) => s.token.startsWith(revoke) || s.id === revoke);
    if (!targets.length) {
      console.error(`No matching session. Run \`muster sessions\` to see active tokens.`);
      process.exit(1);
    }
    for (const s of targets) {
      await asJson(
        await api(cfg, "/api/auth/revoke-session", {
          method: "POST",
          body: JSON.stringify({ token: s.token }),
        }),
      );
    }
    const revoked = targets.map((s) => ({ id: s.id, token: s.token.slice(0, 6) + "…" }));
    if (json) return console.log(JSON.stringify({ revoked }, null, 2));
    for (const r of revoked) console.log(`Revoked ${r.token}`);
    return;
  }
  const list = await asJson(await api(cfg, "/api/auth/list-sessions"));
  const current = currentToken(cfg);
  if (json) return console.log(JSON.stringify({ sessions: list }, null, 2));
  console.log(
    `${list.length} active session${list.length === 1 ? "" : "s"} (current marked *):`,
  );
  for (const s of list) {
    const mark = s.token === current ? "*" : " ";
    const ua = String(s.userAgent ?? "?").slice(0, 48);
    console.log(
      `${mark} ${String(s.token ?? s.id).slice(0, 6)}…  ${shortDate(s.createdAt)} → ${shortDate(s.expiresAt)}  ` +
        `${s.ipAddress ?? "?"}  ${ua}`,
    );
  }
}

async function status() {
  const cfg = apiConfig();
  const { bots } = await asJson(await api(cfg, "/api/bots"));
  const visible = bots.filter((b) => !b.hidden);
  const summary = {
    fleet: visible.length,
    busy: visible.filter((b) => b.busy).length,
    waitingOnYou: visible.filter((b) => b.activity === "waiting-on-you").length,
    totalTokens: visible.reduce((sum, b) => sum + lifetimeTokens(b), 0),
    uncapped: visible.filter((b) => !b.tokenBudget).length,
    browsers: visible.filter((b) => b.browser).length,
  };
  if (has("--json")) return console.log(JSON.stringify(summary, null, 2));
  console.log(
    `${summary.fleet} bots · ${summary.busy} busy · ${summary.waitingOnYou} waiting on you · ` +
      `${summary.totalTokens.toLocaleString()} tokens spent · ${summary.uncapped} uncapped · ${summary.browsers} with browser`,
  );
}

async function receipts() {
  const cfg = apiConfig();
  const n = Number(subject) || 3;
  const { bots } = await asJson(await api(cfg, "/api/bots"));
  const rows = [];  for (const bot of bots.filter((b) => !b.hidden)) {
    for (const task of (bot.tasks ?? []).slice(0, n)) {
      rows.push({ bot: bot.name, task: task.title, usage: task.usage ?? {} });
    }
  }
  if (has("--json")) return console.log(JSON.stringify(rows.slice(0, n), null, 2));
  for (const r of rows.slice(0, n)) {
    const u = r.usage;
    console.log(
      `${r.bot.padEnd(14)} ${String(r.task).slice(0, 40).padEnd(42)} ` +
        `${u.turns ?? 0} turns · ${((u.input ?? 0) + (u.output ?? 0)).toLocaleString()} tok` +
        (u.costUsd != null ? ` · $${u.costUsd.toFixed(4)}` : ""),
    );
  }
}

// ── muster up ───────────────────────────────────────────────────────────
// The one-command self-host: resolve a runtime, boot it — foreground, or
// detached with `-d` — mint the owner's claim code, print a QR the phone
// scans to land straight in the console. Detached survives the terminal
// closing (that's the "close the laptop, the bots keep working" part);
// `muster stop` ends it, `muster logs` reads its output.

function lanAddress() {
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

function freePort(preferred) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(preferred, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function resolveRuntime() {
  // 1. npm install layout: dist-server ships alongside cli/ in the package.
  const pkgRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const bundled = join(pkgRoot, "dist-server", "index.js");
  if (existsSync(bundled)) return { cmd: process.execPath, args: [bundled], cwd: pkgRoot, static: join(pkgRoot, "dist") };
  // 2. repo checkout: run TypeScript directly, build assets if present.
  const cwd = process.cwd();
  if (existsSync(join(cwd, "server", "index.ts"))) {
    const staticDir = existsSync(join(cwd, "dist", "index.html")) ? join(cwd, "dist") : null;
    return {
      cmd: process.execPath,
      args: ["--experimental-strip-types", join(cwd, "server", "index.ts")],
      cwd,
      static: staticDir,
    };
  }
  console.error(
    "No Muster runtime found. Run this from a Muster repo checkout, or `npm i -g muster` for the packaged build.",
  );
  process.exit(1);
}

let child = null;

/** Read the run record ({pid, port, started} JSON) or null. A record whose
 *  server no longer answers /api/health is treated as gone (crash, reboot,
 *  manual kill) — the health endpoint is the truth, not the PID. */
function readRunRecord() {
  try {
    const rec = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
    if (typeof rec?.pid === "number" && typeof rec?.port === "number") return rec;
  } catch {
    // no record or garbage — fall through
  }
  return null;
}

async function liveServer(rec) {
  if (!rec) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.app === "muster") return rec;
  } catch {
    // not answering — gone or still booting
  }
  return null;
}

function clearRunRecord() {
  try {
    unlinkSync(RUNTIME_PATH);
  } catch {
    // already gone
  }
}

/** Stop the detached server: SIGTERM, wait for the health endpoint to go
 *  quiet, escalate to SIGKILL after 10s. */
async function stopDaemon() {
  const rec = readRunRecord();
  if (!rec) {
    console.log("No background Muster found. (`muster up -d` starts one.)");
    return;
  }
  const wasLive = Boolean(await liveServer(rec));
  try {
    process.kill(rec.pid, "SIGTERM");
  } catch {
    // already gone
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await liveServer(rec))) {
    await new Promise((r) => setTimeout(r, 300));
  }
  if (await liveServer(rec)) {
    try {
      process.kill(rec.pid, "SIGKILL");
    } catch {
      // already gone
    }
    console.log(`Force-stopped Muster (port ${rec.port} ignored SIGTERM).`);
  } else {
    console.log(`Stopped Muster${wasLive ? "" : " (it was already down)"} — port ${rec.port} free.`);
  }
  clearRunRecord();
}

function logs() {
  const n = Number(subject) || 40;
  if (!existsSync(LOG_PATH)) {
    console.log("No background log yet. (`muster up -d` creates one.)");
    return;
  }
  const lines = readFileSync(LOG_PATH, "utf8").split("\n");
  console.log(lines.slice(Math.max(0, lines.length - 1 - n)).join("\n"));
}

/** Readiness probe shared by foreground and detached boots. */
async function waitHealthy(port, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child && child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode} during startup`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.app === "muster") return body;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server did not become healthy within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Mint a claim code and print the onboarding banner — identical for
 *  foreground and detached so the phone flow never depends on run mode. */
async function mintAndPrint(port, { detached }) {
  const create = await fetch(`http://127.0.0.1:${port}/api/pair/claim/create`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
  });
  console.log("");
  console.log(`  Muster is up${detached ? " in the background" : ""} on port ${port}.`);
  if (!create.ok) {
    console.error(`  Could not mint a claim code (HTTP ${create.status}).`);
    console.error("  The server is up — open the URL below and pair from the console.");
  } else {
    const { code } = await create.json();
    const lan = lanAddress();
    const url = `http://${lan ?? "127.0.0.1"}:${port}/claim#${code}`;
    console.log("  Scan to open the console on your phone:");
    console.log("");
    console.log(url);
    console.log(renderTerminal(url));
    console.log("");
    console.log("  The code expires in 5 minutes and works once. Re-run `muster up` for a fresh QR anytime.");
    console.log(`  Later: ${url.split("#")[0]}  (same network)`);
  }
  if (detached) {
    console.log("  Close the terminal — Muster keeps running. `muster stop` ends it, `muster logs` reads its output.");
  } else {
    console.log("  Keep this terminal open — Ctrl-C stops Muster. (`muster up -d` keeps it after the terminal closes.)");
  }
  console.log("");
  console.log("  Next: `muster setup` picks an engine and meets your first bot — or open Settings → Engines.");
}

/** Auth secret + server env shared by every boot path (up foreground, up -d,
 *  setup). The server refuses to boot on a non-loopback host without
 *  BETTER_AUTH_SECRET (resolveSecret throws): generate once, persist 0600,
 *  reuse forever — sessions must survive restarts. */
function serverEnv(port, runtime) {
  const secretPath = join(MUSTER_DIR, "auth.secret");
  mkdirSync(MUSTER_DIR, { recursive: true });
  if (!existsSync(secretPath)) {
    writeFileSync(secretPath, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  const env = {
    ...process.env,
    OMB_PORT: String(port),
    OMB_HOST: "0.0.0.0", // all interfaces: loopback claim-create AND the phone's LAN access
    BETTER_AUTH_SECRET: readFileSync(secretPath, "utf8").trim(),
    OMB_STATIC_DIR: runtime.static ?? "",
    OMB_DATA_DIR: arg("--data-dir") ?? process.env.OMB_DATA_DIR ?? join(MUSTER_DIR, "data"),
  };
  if (arg("--public-host")) env.OMB_PUBLIC_HOST = arg("--public-host");
  return env;
}

/** Spawn the server detached — own process group, output to the log file,
 *  survives the terminal closing (SIGHUP ignored via detached+unref on
 *  POSIX) — record the run record, wait for health. Shared by `up -d` and
 *  `setup`. Returns { pid, port }. */
async function bootDetached(port, runtime) {
  const env = serverEnv(port, runtime);
  mkdirSync(RUN_DIR, { recursive: true });
  const log = openSync(LOG_PATH, "a");
  const daemon = spawn(runtime.cmd, runtime.args, {
    cwd: runtime.cwd,
    env,
    stdio: ["ignore", log, log],
    detached: true,
  });
  daemon.unref();
  writeFileSync(
    RUNTIME_PATH,
    JSON.stringify({ pid: daemon.pid, port, started: new Date().toISOString() }, null, 2) + "\n",
    { mode: 0o600 },
  );
  await waitHealthy(port);
  return { pid: daemon.pid, port };
}

async function up() {
  const detached = has("-d") || has("--detach");

  // Already-running awareness: a re-run is NEVER a second server — it
  // re-points the QR at the live one (fresh claim code, fresh QR) instead
  // of double-booting onto a random port.
  const existing = await liveServer(readRunRecord());
  if (existing && detached) {
    await mintAndPrint(existing.port, { detached });
    return;
  }
  if (existing) {
    console.log(`Muster is already running on port ${existing.port}. Re-printing the QR against it.`);
    await mintAndPrint(existing.port, { detached: false });
    console.log("  (This foreground shell is only printing — Ctrl-C will not stop the running server.)");
    return;
  }
  clearRunRecord();

  const port = await freePort(Number(arg("--port") ?? 8799));
  const runtime = resolveRuntime();

  if (detached) {
    await bootDetached(port, runtime);
    await mintAndPrint(port, { detached: true });
    return;
  }

  child = spawn(runtime.cmd, runtime.args, { cwd: runtime.cwd, env: serverEnv(port, runtime), stdio: "inherit" });
  const stop = (sig) => {
    if (child && child.exitCode === null) child.kill(sig);
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));

  await waitHealthy(port);
  await mintAndPrint(port, { detached: false });
  // Keep the foreground child attached; the exit/forward handlers above own
  // the process lifetime from here.
}

// ── muster setup ────────────────────────────────────────────────────────
// Guided first run: connect to (or boot) the local server, sign in as the
// owner the way the QR does, pick an engine, meet the first bot — with the
// one paid thing (a test turn) strictly behind an ask-first gate.

// `ask` must tolerate piped stdin (an agent or CI driving `muster setup`):
// readline drops `line` events that arrive before any question is pending,
// and once stdin ends, `rl.question` after that rejects with
// "readline was closed". So: buffer early lines into a queue, and treat
// stdin-EOF as "take the default" instead of a crash.
function makeAsker() {
  const buffered = [];
  let eof = false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (l) => buffered.push(l));
  rl.on("close", () => { eof = true; });
  const ask = async (question, fallback) => {
    process.stdout.write(question);
    if (buffered.length) return buffered.shift().trim() || fallback;
    if (eof) return fallback;
    const a = await rl.question("");
    return a.trim() || fallback;
  };
  ask.close = () => rl.close();
  return ask;
}

/** Owner session without the phone: mint a claim code over loopback and
 *  redeem it — the exact ride the QR takes, driven from the machine itself.
 *  Saves {base, cookie} and returns the config. */
async function claimSession(port) {
  const base = `http://127.0.0.1:${port}`;
  const create = await fetch(`${base}/api/pair/claim/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (!create.ok) {
    console.error(`Could not mint a claim code (HTTP ${create.status}). Is the server on this machine?`);
    console.error("Alternatively: `muster pair --local --port <port> --email .. --password ..`");
    process.exit(1);
  }
  const { code } = await create.json();
  const redeem = await fetch(`${base}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const raw = redeem.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
  if (!redeem.ok || !raw) {
    console.error("Claim redemption failed — run `muster up` and pair by QR instead.");
    process.exit(1);
  }
  const cfg = { base, cookie: raw.split(";")[0] };
  saveConfig(cfg);
  return cfg;
}

async function setup() {
  const ask = makeAsker();
  try {
    // ── connect ──
    let rec = await liveServer(readRunRecord());
    if (!rec) {
      const answer = await ask("No Muster server is running. Start one now? [Y/n] ", "y");
      if (!/^y/i.test(answer)) {
        console.log("Okay — run `muster up` (or `muster up -d`) first, then `muster setup` again.");
        return;
      }
      const port = await freePort(Number(arg("--port") ?? 8799));
      console.log(`Booting Muster on port ${port} in the background — it survives this terminal, \`muster stop\` ends it…`);
      rec = await bootDetached(port, resolveRuntime());
    }
    const base = `http://127.0.0.1:${rec.port}`;

    // ── sign in ── keep a saved session if it already works here, else ride
    // the claim flow (the owner account is provisioned server-side on first
    // redemption if the install has none).
    let cfg = loadConfig();
    let signedIn = cfg.base === base && Boolean(cfg.cookie);
    if (signedIn) {
      const probe = await fetch(`${base}/api/auth/get-session`, { headers: { cookie: cfg.cookie } });
      signedIn = probe.ok && Boolean(await probe.json().catch(() => null));
    }
    if (signedIn) {
      cfg = { base, cookie: cfg.cookie };
      console.log(`Connected to ${base} with the saved session.`);
    } else {
      console.log("Signing in as the owner (claim code over loopback)…");
      cfg = await claimSession(rec.port);
    }

    // ── engine ──
    const { instances } = await asJson(await api(cfg, "/api/instances"));
    const available = instances.filter((i) => i.snapshot?.state === "available");
    if (!available.length) {
      console.log("");
      console.log("No engine is available yet — that's the one thing Muster can't do for you.");
      console.log("Install a CLI (Claude Code, Codex CLI, …) and sign in to it, or open the console's");
      console.log("Settings → Engines to add a provider. Then run `muster setup` again.");
      return;
    }
    console.log("");
    console.log("Connect your AI provider — pick an engine:");
    available.forEach((inst, i) => console.log(`  ${i + 1}) ${inst.displayName} · ${inst.driverKind}`));
    const pick = Number(await ask(`Engine [1]: `, "1")) - 1;
    const engine = available[Number.isInteger(pick) && pick >= 0 && pick < available.length ? pick : 0];
    let model = engine.models?.default ?? "";
    // options entries are {id,label} objects on every current driver; accept
    // bare strings too so a driver that ships plain ids still renders.
    const options = (engine.models?.options ?? []).map((mo) =>
      typeof mo === "string" ? { id: mo, label: mo } : { id: String(mo.id), label: String(mo.label ?? mo.id) },
    );
    if (options.length > 1) {
      console.log("  Models:");
      options.forEach((mo, i) => console.log(`    ${i + 1}) ${mo.label}${mo.id === model ? "  (default)" : ""}`));
      const mi = Number(await ask(`Model [1]: `, "1")) - 1;
      if (Number.isInteger(mi) && mi >= 0 && mi < options.length) model = options[mi].id;
    }
    console.log(`  → ${engine.displayName}${model ? ` on ${model}` : ""}`);

    // ── first bot ──
    const { bots } = await asJson(await api(cfg, "/api/bots"));
    const visible = bots.filter((b) => !b.hidden);
    let bot;
    let created = false;
    if (visible.length) {
      console.log("");
      console.log("Bots on this server:");
      visible.slice(0, 5).forEach((b, i) => console.log(`  ${i + 1}) ${b.name}${b.modelSelection?.instanceId ? ` · ${b.modelSelection.instanceId}` : " · no engine"}`));
      const choice = await ask(`Who should run on ${engine.displayName}? [number, or Enter for a new bot] `, "new");
      const bi = Number(choice) - 1;
      bot = Number.isInteger(bi) && bi >= 0 && bi < visible.length ? visible[bi] : null;
    }
    if (!bot) {
      const made = await api(cfg, "/api/bots", { method: "POST", body: "{}" });
      if (!made.ok) {
        const body = await made.json().catch(() => null);
        console.error(body?.error ?? `could not create a bot (HTTP ${made.status})`);
        process.exit(1);
      }
      bot = (await made.json()).bot;
      created = true;
      const name = await ask(`Name it [${bot.name}]: `, "");
      if (name && name !== bot.name) {
        bot = (await asJson(await api(cfg, `/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ name }) }))).bot;
      }
    }
    if (bot.modelSelection?.instanceId !== engine.instanceId || (model && bot.modelSelection?.model !== model)) {
      await asJson(
        await api(cfg, `/api/bots/${bot.id}`, {
          method: "PATCH",
          body: JSON.stringify({ modelSelection: { instanceId: engine.instanceId, model } }),
        }),
      );
    }
    console.log(`${bot.name} runs on ${engine.displayName}${model ? ` (${model})` : ""}.${created ? "" : " (model selection updated)"}`);

    // ── test turn, strictly opt-in: this calls the real provider ──
    console.log("");
    const go = await ask(`Send ${bot.name} a short hello now? It calls ${engine.displayName} and may use your plan's credits. [y/N] `, "n");
    if (/^y/i.test(go)) {
      console.log("Sent — waiting for the reply…");
      await asJson(
        await api(cfg, `/api/bots/${bot.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ text: "Introduce yourself in one short sentence — you're part of my Muster workforce." }),
        }),
      );
      const { text: reply, error } = await waitForReply(cfg, bot.id, 120_000);
      console.log("");
      if (error) {
        console.log(`  ${bot.name} could not run that turn: ${error}`);
        console.log("");
        console.log(
          engine.driverKind === "claudeAgent" || engine.driverKind === "codex"
            ? "Sign in to the CLI on this machine (`claude` / `codex login`), or pick a different engine — then `muster send` will go through."
            : "Check the engine's credentials, or pick a different engine — then `muster send` will go through.",
        );
        console.log(`The console shows the full trace: http://${lanAddress() ?? "127.0.0.1"}:${rec.port}/app`);
      } else if (reply) {
        console.log(`  ${bot.name}: ${reply}`);
        console.log("");
        console.log("That's the workforce working. Give it real work with `muster send <bot> <text>`.");
      } else {
        console.log("No reply within two minutes — the turn may still be running.");
        console.log(`Check \`muster watch\` or the console: http://${lanAddress() ?? "127.0.0.1"}:${rec.port}/app`);
      }
    } else {
      console.log(`Skipped. Anytime: muster send ${bot.name} "hello"`);
    }
    console.log("");
    console.log("Pair your phone anytime with `muster up` — it prints the QR. Config: " + CONFIG_PATH);
  } finally {
    ask.close();
  }
}

// ── mcp ─────────────────────────────────────────────────────────────────
// `muster mcp` prints a ready-to-paste MCP client config; `muster mcp
// --serve` becomes the stdio fleet server itself. Either way the auth is
// the paired session in ~/.muster/cli.json — nothing new to log into, and
// the tool surface is the bounded read/work set (no approvals, deletes,
// credentials, or memory writes), so a connected external agent can work
// the fleet but never gut it.

function resolveFleetRuntime(entry = "fleet-mcp") {
  // Same layout logic as resolveRuntime(): packaged build ships
  // dist-server/ beside cli/, a repo checkout runs TypeScript directly.
  const pkgRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const bundled = join(pkgRoot, "dist-server", `${entry}.js`);
  if (existsSync(bundled)) return { cmd: process.execPath, args: [bundled], cwd: pkgRoot };
  for (const cwd of [pkgRoot, process.cwd()]) {
    if (existsSync(join(cwd, "server", `${entry}.ts`))) {
      return {
        cmd: process.execPath,
        args: ["--experimental-strip-types", join(cwd, "server", `${entry}.ts`)],
        cwd,
      };
    }
  }
  console.error("No Muster fleet runtime found (expected dist-server/ or a repo checkout).");
  process.exit(1);
}

async function mcpCommand() {
  if (has("--serve")) {
    const rt = resolveFleetRuntime();
    const child = spawn(rt.cmd, rt.args, { cwd: rt.cwd, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  const cfg = apiConfig();
  const rt = resolveFleetRuntime();
  const config = {
    mcpServers: {
      "muster-fleet": {
        command: rt.cmd,
        args: rt.args,
        env: { MUSTER_DIR: join(homedir(), ".muster") },
      },
    },
  };
  console.log(JSON.stringify(config, null, 2));
  console.error(
    `\nSession: ${cfg.base} (the cookie in ~/.muster/cli.json — pair with \`muster pair\` first).\n` +
      "Paste the mcpServers block into Claude Desktop / Cursor / any MCP client.\n" +
      "Tools: fleet_status, send_task, wait_for_conversation, get_receipt, read_memory, get_approval_history, get_why_journal, get_scorecard.\n" +
      "Run `muster mcp --serve` to host the stdio server yourself.",
  );
}

async function evalCommand() {
  if (!subject || !rest[0] || rest.length !== 1) {
    console.error("Usage: muster eval capture.json scorecard.json (see the fleet eval playbook)");
    process.exitCode = 2;
    return;
  }
  const input = resolve(subject);
  const output = resolve(rest[0]);
  const rt = resolveFleetRuntime("fleet-eval");
  process.exitCode = await new Promise((finish) => {
    const child = spawn(rt.cmd, [...rt.args, input, output], { cwd: rt.cwd, stdio: "inherit" });
    child.on("error", () => finish(2));
    child.on("exit", (code) => finish(code ?? 2));
  });
}

const HELP = `muster — the CLI for your AI workforce

  muster up [-d] [--port 8799]    boot the server here; scan the QR with your phone.
                                  -d keeps it running after the terminal closes.
  muster setup                    guided first run: connect, pick an engine, meet your first bot
  muster stop                     stop the background server started with up -d
  muster logs [n]                 last n lines of the background server log (default 40)
  muster pair [--local --port 8799 --email .. --password ..]
              [--cloud URL --email .. --password ..] [--redeem CODE]
  muster bots [--json]
  muster send <bot> <text>
  muster approve [allow|deny]
  muster status [--json]
  muster receipts [n] [--json]
  muster sessions [--json]        active sign-in sessions; --revoke <prefix|other|all>
  muster mcp [--serve]            print MCP client config for Muster (--serve runs the stdio server)
  muster eval capture.json scorecard.json  grade captured fleet probes locally; no fleet actions
  muster help`;

try {
  switch (command) {
    case "up":
      await up();
      break;
    case "setup":
      await setup();
      break;
    case "stop":
      await stopDaemon();
      break;
    case "logs":
      logs();
      break;
    case "pair": {
      if (has("--redeem")) await pairRedeem();
      else await pair();
      break;
    }
    case "bots":
      await bots();
      break;
    case "send":
      await send();
      break;
    case "approve":
      await approve();
      break;
    case "status":
      await status();
      break;
    case "receipts":
      await receipts();
      break;
    case "sessions":
      await sessions();
      break;
    case "eval":
      await evalCommand();
      break;
    case "mcp":
      await mcpCommand();
      break;
    default:
      console.log(HELP);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
