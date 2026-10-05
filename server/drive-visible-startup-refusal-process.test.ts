import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];
const repo = resolve("."), server = join(repo, "server");
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let artifacts = "", originalEntry = "", repairedBundle = "", originalBundle = "";
const preload = `
import net from 'node:net';import dns from 'node:dns';import dgram from 'node:dgram';
import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';
let outbound=0;const deny=()=>{outbound++;throw Error('Owned startup fixture denies outbound');};
net.Socket.prototype.connect=deny;net.connect=deny;net.createConnection=deny;
for(const name of ['lookup','resolve','resolve4','resolve6','resolveAny','reverse']){dns[name]=deny;dns.promises[name]=deny;}
// Complete numeric loopback lookup locally for Server.listen; never call DNS.
// Every outbound socket connect remains denied, including loopback connects.
dns.lookup=(hostname,options,callback)=>{if(hostname!=='127.0.0.1')return deny();
const done=typeof options==='function'?options:callback;
queueMicrotask(()=>done(null,'127.0.0.1',4));};
dgram.Socket.prototype.send=deny;http.request=deny;https.request=deny;globalThis.fetch=deny;
syncBuiltinESMExports();process.on('exit',()=>console.error('OWNED_OUTBOUND_COUNT:'+outbound));
`;
function temporary(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), label))); roots.push(root); return root;
}
function journal(root: string, status: "pending" | "committed") {
  const operation = join(root, "account-recovery-journal", "operation"); mkdirSync(operation, { recursive: true });
  const archive = Buffer.from("Owned synthetic encrypted archive evidence");
  const source = JSON.stringify({ version: 1, operationId: "operation", sourceDigest: digest("source"), archiveHash: digest(archive),
    account: { userId: "alice", workspaceId: "org", googleSub: "alice-sub" }, mapping: { bot: {}, group: {}, thread: {}, plan: {} },
    changes: [], threadPayload: "[]", inertHistory: "{}", createdDirs: [] });
  writeFileSync(join(operation, "archive.bin"), archive); writeFileSync(join(operation, "immutable.json"), source);
  writeFileSync(join(operation, "receipt.json"), JSON.stringify({ version: 1, operationId: "operation", immutableHash: digest(source),
    status, phase: status === "committed" ? "committed" : "intent" }));
}
type FixtureByteInventory = Record<string, string>;
function inventory(root: string) {
  const result: FixtureByteInventory = {};
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = prefix + entry.name;
      if (entry.isDirectory()) visit(path, name + "/");
      else result[name] = digest(readFileSync(path));
    }
  }; visit(root); return result;
}
async function freePort(): Promise<number> {
  const listener = createServer(); await new Promise<void>((done, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", done); });
  const address = listener.address(); if (address === null || address === "") throw new Error("Owned port unavailable");
  // SAFETY: a TCP listener bound to numeric port zero returns AddressInfo.
  const port = (address as import("node:net").AddressInfo).port;
  await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done())); return port;
}
async function run(entry: string, data: string, allowStartup = false) {
  const home = temporary("muster-startup-child-home-"), port = await freePort();
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
    OMB_COMPANION_DIR: join(home, "companion"), OMB_HOST: "127.0.0.1", OMB_PUBLIC_HOST: "muster-fixture.invalid",
    OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0" };
  if (allowStartup) env.BETTER_AUTH_SECRET = "SYNTHETIC-OWNED-STARTUP-TEST-SECRET-ONLY";
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, ["--import", join(artifacts, "deny.mjs"), entry], {
    cwd: home, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", ready = false, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20_000);
  child.stdout.on("data", bytes => {
    output += bytes.toString();
    if (allowStartup && output.includes(`muster server on http://127.0.0.1:${port}`)) { ready = true; child.kill("SIGTERM"); }
  });
  child.stderr.on("data", bytes => { output += bytes.toString(); });
  const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); }).finally(() => clearTimeout(timer));
  // Keep owned process receipts visible even with Vitest's passing-log filter.
  process.stdout.write(JSON.stringify({ entry: basename(entry), pid: child.pid, port, code, ready, timedOut, outbound: /OWNED_OUTBOUND_COUNT:(\d+)/.exec(output)?.[1] }) + "\n");
  expect(timedOut, output).toBe(false); expect(output, output).toContain("OWNED_OUTBOUND_COUNT:0");
  return { code, output, ready };
}
beforeAll(async () => {
  artifacts = temporary("muster-startup-order-artifacts-"); writeFileSync(join(artifacts, "deny.mjs"), preload);
  symlinkSync(join(repo, "node_modules"), join(artifacts, "node_modules"), "dir");
  const originalServer = join(artifacts, "original-server"); mkdirSync(originalServer);
  // Preserve exact original index bytes; only its relative dependencies point
  // at the reviewed source. No mutation of product or frozen writer files.
  const source = readFileSync(join(server, "index.ts"), "utf8");
  const first = 'import "./drive-visible-startup-refusal.ts";\n'; expect(source.startsWith(first)).toBe(true);
  const original = source.slice(first.length);
  originalEntry = join(originalServer, "index.ts"); writeFileSync(originalEntry, original);
  for (const entry of readdirSync(server)) if (entry !== "index.ts") symlinkSync(join(server, entry), join(originalServer, entry));
  process.stdout.write(JSON.stringify({ originalIndexSha256: digest(original), repairedIndexSha256: digest(source) }) + "\n");
  const options = { bundle: true, platform: "node" as const, target: "node20", format: "esm" as const,
    external: ["better-sqlite3"], logLevel: "silent" as const,
    banner: { js: 'import { createRequire as __creq } from "node:module"; const require = __creq(import.meta.url);' } };
  repairedBundle = join(artifacts, "repaired-index.js"); originalBundle = join(artifacts, "original-index.js");
  await build({ ...options, entryPoints: [join(server, "index.ts")], outfile: repairedBundle });
  await build({ ...options, entryPoints: [originalEntry], outfile: originalBundle });
}, 60_000);
afterAll(() => { for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true }); });

describe("actual stripped and bundled startup order", () => {
  it.each([undefined, "relative-fixture", "  fixture  ", "", " "])("keeps captured data-root and migration semantics for %j", configured => {
    const home = temporary("muster-startup-root-semantics-"); mkdirSync(join(home, ".opengrokbot"));
    writeFileSync(join(home, ".opengrokbot", "preserved.txt"), "LEGACY-OWNED-FIXTURE");
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
    if (configured !== undefined) env.OMB_DATA_DIR = configured;
    const script = `const c=await import(${JSON.stringify(join(server, "config.ts"))});
      const p=await import(${JSON.stringify(join(server, "data-root-path.ts"))});
      if(c.DATA_DIR!==p.DATA_DIR)throw Error('Captured root differs');c.ensureDirs();
      console.log(JSON.stringify({root:c.DATA_DIR,configured:p.configuredDataDir}));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: home, env, encoding: "utf8", timeout: 10_000 });
    if (configured !== undefined && configured.trim() === "") {
      expect(result.status).toBe(1); expect(result.stderr).toContain("must be a nonempty directory");
      expect(readFileSync(join(home, ".opengrokbot", "preserved.txt"), "utf8")).toBe("LEGACY-OWNED-FIXTURE");
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(configured === undefined ? { root: join(home, ".muster") } : { root: configured, configured });
      expect(existsSync(join(home, ".opengrokbot"))).toBe(configured !== undefined);
      if (configured === undefined) expect(readFileSync(join(home, ".muster", "preserved.txt"), "utf8")).toBe("LEGACY-OWNED-FIXTURE");
    }
  });
  it.each(["stripped", "bundled"])("original %s entry opens auth before unresolved recovery is refused", async mode => {
    const data = temporary("muster-startup-original-data-"); journal(data, "pending");
    const result = await run(mode === "stripped" ? originalEntry : originalBundle, data);
    expect(result.code).toBe(1); expect(result.output).toContain("BETTER_AUTH_SECRET is required");
    expect(existsSync(join(data, "auth.db"))).toBe(true);
  }, 30_000);
  it.each(["stripped", "bundled"])("repaired %s entry preserves every byte and refuses before auth", async mode => {
    const data = temporary("muster-startup-refused-data-"); journal(data, "pending");
    writeFileSync(join(data, "config.json"), '{"instances":{"ghost":{"driver":"not-a-real-driver"}}}');
    writeFileSync(join(data, "preserved.bin"), "UNCHANGED"); const before = inventory(data);
    const result = await run(mode === "stripped" ? join(server, "index.ts") : repairedBundle, data);
    expect(result.code).toBe(1); expect(result.output).toContain("startup refused before initialization");
    expect(inventory(data)).toEqual(before); expect(existsSync(join(data, "auth.db"))).toBe(false);
  }, 30_000);
  it.each(["stripped", "bundled"])("%s no-journal and closed-journal controls still start", async mode => {
    for (const closed of [false, true]) {
      const data = temporary("muster-startup-ready-data-"); if (closed) journal(data, "committed");
      writeFileSync(join(data, "config.json"), '{"instances":{"ghost":{"driver":"not-a-real-driver"}}}');
      const evidence = closed ? inventory(join(data, "account-recovery-journal")) : null;
      const result = await run(mode === "stripped" ? join(server, "index.ts") : repairedBundle, data, true);
      expect(result.ready, result.output).toBe(true); expect(result.code, result.output).toBe(0);
      expect(existsSync(join(data, "auth.db"))).toBe(true);
      if (evidence) expect(inventory(join(data, "account-recovery-journal"))).toEqual(evidence);
    }
  }, 50_000);
});
