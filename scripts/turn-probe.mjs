#!/usr/bin/env node
// Harness-only probe (no simulator): does a turn settle with the fake ACP
// engine when the rig boots the harness exactly as owned-ios-acceptance does?
// Prints the frames that decide it: turn-start, message chunks, settle.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
const children = [];
const start = (label, argv, env) => {
  const child = spawn(process.execPath, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  children.push({ label, child, err: () => err });
  return child;
};
const waitFor = async (url, label, child) => {
  const deadline = Date.now() + 45_000;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch {}
    if (child.exitCode !== null) throw new Error(`${label} exited: ${child.err()}`);
    if (Date.now() > deadline) throw new Error(`${label} never came up: ${child.err()}`);
    await sleep(200);
  }
};

const home = mkdtempSync(join(tmpdir(), "muster-turnprobe-home-"));
const data = mkdtempSync(join(tmpdir(), "muster-turnprobe-data-"));
const HP = await probePort(), CP = await probePort(), KP = await probePort(), WP = await probePort();
// The server reads config.json from OMB_DATA_DIR (server/config.ts:170,243) —
// NOT from $HOME/.muster when OMB_DATA_DIR is set. Instances live there.
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "config.json"), JSON.stringify({
  instances: { rig: { driver: "grokAgent", config: { cli: join(ROOT, "server", "testing", "fake-acp-cli.ts"), fullAuto: true } } },
}), { mode: 0o600 });
writeFileSync(join(home, ".muster-config-marker"), "x");

const env = {
  HOME: home, USERPROFILE: home,
  OMB_PORT: String(HP), OMB_WEBHOOK_PORT: String(WP),
  OMB_DATA_DIR: data,
  OMB_COMPANION_PORT: String(CP), OMB_CONTROL_PORT: String(KP),
  OMB_COMPANION_DIR: join(home, "companion"),
};
const harness = start("harness", ["--experimental-strip-types", join(ROOT, "server", "index.ts")], env);
await waitFor(`http://127.0.0.1:${HP}/api/health`, "harness", harness);
const sidecar = start("sidecar", ["--experimental-strip-types", join(ROOT, "companion", "src", "index.ts")], env);
await waitFor(`http://127.0.0.1:${KP}/state`, "sidecar", sidecar);

// pair exactly as the phone does
const { code } = (await (await fetch(`http://127.0.0.1:${KP}/pairing`, { method: "POST" })).json());
const paired = await (await fetch(`http://127.0.0.1:${CP}/api/pair`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ code, deviceName: "probe" }),
})).json();
if (!paired.token) throw new Error(`pairing failed: ${JSON.stringify(paired)}`);
const H = { authorization: `Bearer ${paired.token}`, "content-type": "application/json" };

// bot + engine binding, mirroring the rig
const created = (await (await fetch(`http://127.0.0.1:${CP}/api/bots`, { method: "POST", headers: H })).json()).bot;
await fetch(`http://127.0.0.1:${HP}/api/bots/${created.id}`, {
  method: "PATCH", headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Mimi", modelSelection: { instanceId: "rig", model: "fake-acp-model" }, computer: "off" }),
});

// the turn: send a user message, fold the stream, watch for the reply
const controller = new AbortController();
const res = await fetch(`http://127.0.0.1:${CP}/api/events`, { headers: H, signal: controller.signal });
const reader = res.body.getReader();
const decoder = new TextDecoder();
const frames = [];
const pump = (async () => {
  let buf = "";
  outer: for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, cut); buf = buf.slice(cut + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const f = JSON.parse(line.slice(5).trim());
          frames.push(f);
          if (f.kind === "message" && f.message?.botId === created.id && f.message.role !== "user") break outer;
        } catch {}
      }
    }
  }
})();
await sleep(500);
await fetch(`http://127.0.0.1:${CP}/api/bots/${created.id}/messages`, {
  method: "POST", headers: { ...H }, body: JSON.stringify({ text: "Reply with exactly one word: lighthouse" }),
});
await Promise.race([pump, sleep(30_000)]);
controller.abort();

const settled = frames.filter((f) => f.kind === "message" && f.message?.botId === created.id);
const patches = frames.filter((f) => f.kind === "message.patch");
const runtime = frames.filter((f) => f.kind === "runtime");
// Post-hoc REST truth: is the fake instance available, and what does the
// thread actually hold? This is what decides "engine never started" vs
// "reply not observed on the stream".
const fleet = (await (await fetch(`http://127.0.0.1:${CP}/api/bots`, { headers: H })).json());
const mimi = Array.isArray(fleet) ? fleet.find((b) => b.id === created.id) ?? fleet[0] : null;
const instances = (await (await fetch(`http://127.0.0.1:${HP}/api/instances`, { headers: { "content-type": "application/json" } })).json());
const thread = (await (await fetch(`http://127.0.0.1:${CP}/api/threads/${created.threadId}/messages?limit=10`, { headers: H })).json());
const msgs = Array.isArray(thread) ? thread : thread.messages ?? [];
console.log(JSON.stringify({
  scope: "turn-probe", frameKinds: [...new Set(frames.map((f) => f.kind))],
  settledMessages: settled.map((m) => (m.message.text ?? "").slice(0, 140)),
  patchCount: patches.length, runtimeCount: runtime.length,
  mimiModelSelection: mimi?.modelSelection ?? null,
  mimiState: mimi?.state ?? mimi?.busy ?? null,
  instancesSummary: JSON.stringify(instances).slice(0, 600),
  threadTail: msgs.slice(-4).map((m) => ({ role: m.role, text: (m.text ?? "").slice(0, 120) })),
}, null, 2));

for (const { child } of children) child.kill("SIGKILL");
rmSync(home, { recursive: true, force: true });
rmSync(data, { recursive: true, force: true });
