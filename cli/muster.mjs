#!/usr/bin/env node
// muster — the CLI surface. Fifth surface of the platform: makes Muster
// callable FROM other agents, scripts, cron, and terminals. Pairing rides
// the same chip-code flow the desktop companion uses; local desktop
// installs work with no pairing at all (loopback session).
//
// Zero dependencies beyond Node's own fetch — this file is copy-installed
// by `curl` users and run by `npm i -g`, so the only contract is Node 22+.
//
//   muster pair [--cloud URL]        print/redeem a pairing code
//   muster bots                      roster: name, engine, state, budget
//   muster send <bot> <text>         send a turn, print the reply
//   muster watch <bot>               tail a thread live
//   muster approve [allow|deny]      answer the oldest pending card
//   muster status                    fleet summary
//   muster receipts [n]              last N job receipts
//   muster status --json             machine-readable (agent callers)

import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

const HELP = `muster — the CLI for your AI workforce

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
