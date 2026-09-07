#!/usr/bin/env node
// muster — the CLI surface. Fifth surface of the platform: makes Muster
// callable FROM other agents, scripts, cron, and terminals. Pairing rides
// the same chip-code flow the desktop companion uses; local desktop
// installs work with no pairing at all (loopback session).
//
// Zero dependencies beyond Node's own fetch — this file is copy-installed
// by `curl` users and run by `npm i -g`, so the only contract is Node 22+.
//
//   muster up [--port 8799]        boot the server here + print a phone QR
//   muster pair [--cloud URL]        print/redeem a pairing code
//   muster bots                      roster: name, engine, state, budget
//   muster send <bot> <text>         send a turn, print the reply
//   muster watch <bot>               tail a thread live
//   muster approve [allow|deny]      answer the oldest pending card
//   muster status                    fleet summary
//   muster receipts [n]              last N job receipts
//   muster status --json             machine-readable (agent callers)

import { homedir, networkInterfaces } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderTerminal } from "./qr.mjs";

const CONFIG_PATH = join(homedir(), ".muster", "cli.json");
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
  const headers = { "content-type": "application/json", cookie: cfg.cookie };
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
  // Poll for the settled reply (the SSE stream is overkill for one-shot sends).
  const deadline = Date.now() + 180_000;
  for (;;) {
    const { bots: now } = await asJson(await api(cfg, "/api/bots"));
    const me = now.find((b) => b.id === bot.id);
    const reply = [...(me?.messages ?? [])].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
    if (!me?.busy && reply) {
      console.log(reply.text.trim());
      return;
    }
    if (Date.now() > deadline) {
      console.error("Timed out waiting for the reply — the turn may still be running. Try `muster watch`.");
      process.exit(1);
    }
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
  const rows = [];
  for (const bot of bots.filter((b) => !b.hidden)) {
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
// The one-command self-host: resolve a runtime, boot it, mint the owner's
// claim code, print a QR the phone scans to land straight in the console.
// The laptop can close afterwards — the server keeps running; `muster up`
// prints how to run it detached for real.

const MUSTER_DIR = join(homedir(), ".muster");

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

async function healthWait(port, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.app === "muster") return body;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
    if (child && child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode} during startup`);
  }
  throw new Error(`server did not become healthy within ${timeoutMs / 1000}s`);
}

let child = null;

async function up() {
  const port = await freePort(Number(arg("--port") ?? 8799));
  const runtime = resolveRuntime();

  // Self-host gate: the server refuses to boot on a non-loopback host without
  // BETTER_AUTH_SECRET (resolveSecret throws). Generate once, persist 0600,
  // reuse forever — sessions must survive restarts.
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

  child = spawn(runtime.cmd, runtime.args, { cwd: runtime.cwd, env, stdio: "inherit" });
  const stop = (sig) => {
    if (child && child.exitCode === null) child.kill(sig);
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));

  await healthWait(port);

  // Mint the owner claim code — loopback socket + loopback Host header.
  const create = await fetch(`http://127.0.0.1:${port}/api/pair/claim/create`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
  });
  if (!create.ok) {
    console.error(`Could not mint a claim code (HTTP ${create.status}).`);
    console.error("The server is up — open the printed URL manually and pair from the console.");
  } else {
    const { code } = await create.json();
    const lan = lanAddress();
    const url = `http://${lan ?? "127.0.0.1"}:${port}/claim#${code}`;
    console.log("");
    console.log("  Muster is up. Scan to open the console on your phone:");
    console.log("");
    console.log(url);
    console.log(renderTerminal(url));
    console.log("");
    console.log("  The code expires in 10 minutes and works once.");
    console.log(`  Later: ${url.split("#")[0]}  (same network)`);
    if (!runtime.static) {
      console.log("  No built UI found — API-only boot. Run `npm run build` in the repo for the web console.");
    }
    console.log("");
    console.log("  Keep this terminal open — Ctrl-C stops Muster. Background mode (`muster up -d`) is coming.");
  }
  // Keep the foreground child attached; the exit/forward handlers above own
  // the process lifetime from here.
}

const HELP = `muster — the CLI for your AI workforce

  muster up [--port 8799]          boot the server here; scan the QR with your phone
  muster pair [--local --port 8799 --email .. --password ..]
              [--cloud URL --email .. --password ..] [--redeem CODE]
  muster bots [--json]
  muster send <bot> <text>
  muster approve [allow|deny]
  muster status [--json]
  muster receipts [n] [--json]
  muster help`;

try {
  switch (command) {
    case "up":
      await up();
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
    default:
      console.log(HELP);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
