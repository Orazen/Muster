#!/usr/bin/env node
// Parser regressions always run in disposable children. No check expects a
// timeout: the owned parser refuses every malformed header promptly, with or
// without the policy loaded, so a timeout means a hanging parser is back.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const configPath = join(projectRoot, "metro.config.cjs");
const workerPath = join(projectRoot, "scripts/metro-transform-worker.cjs");

async function childMain() {
  const [, , , guard, api, assetPath] = process.argv;
  assert(["none", "config", "worker"].includes(guard));
  assert(["buffer", "file", "cache"].includes(api));
  if (guard === "config") require(configPath);
  if (guard === "worker") require(workerPath);
  // Resolve exactly as Expo's config does, including nested installations.
  const expoRequire = createRequire(require.resolve("expo/metro-config"));
  const configRequire = createRequire(expoRequire.resolve("@expo/metro-config"));
  const assets = configRequire("metro/src/Assets");
  process.once("message", async (message) => {
    if (message !== "run") throw new Error("Unexpected fixture command");
    await new Promise((resolve, reject) => process.send({ kind: "started" }, (error) => error ? reject(error) : resolve()));
    let report;
    try {
      let value;
      if (api === "buffer") {
        value = assets.getAssetSize(assetPath.endsWith(".jpg") ? "jpg" : "png", readFileSync(assetPath), assetPath);
      } else if (api === "file") {
        const data = await assets.getAssetData(assetPath, basename(assetPath), [], null, "/assets");
        value = { width: data.width, height: data.height, scales: data.scales, type: data.type, files: data.files };
      } else {
        const config = require(configPath).transformer;
        const worker = require(workerPath);
        const { upstreamTransformerPath } = require(join(projectRoot, "scripts/metro-image-policy.cjs"));
        const upstream = require(upstreamTransformerPath);
        const initial = worker.getCacheKey(config);
        const altered = { ...config, assetPlugins: [...config.assetPlugins, "owned-change-marker"] };
        assert.equal(worker.getCacheKey(config), initial);
        assert.notEqual(upstream.getCacheKey(config), upstream.getCacheKey(altered));
        assert.notEqual(worker.getCacheKey(altered), initial);
        assert.deepEqual(Object.keys(worker).sort(), Object.keys(upstream).sort());
        const policy = readFileSync(join(projectRoot, "scripts/metro-image-policy.cjs"));
        const wrapper = readFileSync(workerPath);
        const copyRoot = join(dirname(assetPath), "cache-copy");
        mkdirSync(copyRoot);
        symlinkSync(join(projectRoot, "node_modules"), join(copyRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
        writeFileSync(join(copyRoot, "metro-image-policy.cjs"), policy);
        const copiedWorker = join(copyRoot, "metro-transform-worker.cjs");
        writeFileSync(copiedWorker, wrapper);
        const copy = require(copiedWorker);
        assert.equal(copy.getCacheKey(config), initial);
        writeFileSync(copiedWorker, Buffer.concat([wrapper, Buffer.from("\n// owned wrapper cache marker\n")]));
        assert.notEqual(copy.getCacheKey(config), initial);
        writeFileSync(copiedWorker, wrapper);
        writeFileSync(join(copyRoot, "metro-image-policy.cjs"), Buffer.concat([policy, Buffer.from("\n// owned policy cache marker\n")]));
        delete require.cache[require.resolve(join(copyRoot, "metro-image-policy.cjs"))];
        delete require.cache[require.resolve(copiedWorker)];
        assert.notEqual(require(copiedWorker).getCacheKey(config), initial);
        value = { stable: true, upstreamOptionsRetained: true, wrapperInvalidates: true, policyInvalidates: true, exportsRetained: true };
      }
      report = { kind: "result", status: "returned", value };
    } catch (error) {
      report = { kind: "result", status: "rejected", name: error.name, message: error.message };
    }
    process.send(report, () => process.disconnect());
  });
  process.send({ kind: "ready" });
}

function runChild(scratch, guard, api, assetPath, abortSignal) {
  return new Promise((resolve, reject) => {
    if (abortSignal.aborted) return reject(new Error("Asset verification cancelled"));
    const home = join(scratch, "home");
    const env = {
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
      TMPDIR: scratch, TMP: scratch, TEMP: scratch, PATH: join(scratch, "no-executables"),
      EXPO_OFFLINE: "1", EXPO_NO_TELEMETRY: "1", NODE_ENV: "test", CI: "1",
    };
    if (process.env.SystemRoot ?? process.env.SYSTEMROOT) env.SystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    const child = spawn(process.execPath, ["--max-old-space-size=256", scriptPath, "--child", guard, api, assetPath], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let ready = false, started = false, timedOut = false, terminating = false, result, failure, stderr = "", stdout = "", killTimer;
    let deadline = setTimeout(() => terminate("startup"), 10000);
    function terminate(stage) {
      if (terminating) return;
      terminating = true;
      clearTimeout(deadline);
      timedOut = stage === "operation";
      if (!timedOut && !failure) failure = new Error(`Asset fixture stopped during ${stage}`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
    }
    const cancel = () => { failure = new Error("Asset verification cancelled"); terminate("cancellation"); };
    abortSignal.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); if (stdout.length > 16384) { failure = new Error("Unexpected fixture output size"); terminate("output"); } });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 16384) { failure = new Error("Unexpected fixture error output size"); terminate("output"); } });
    child.on("message", (message) => {
      if (message.kind === "ready") {
        if (ready || terminating) { failure = new Error("Unexpected child readiness"); terminate("protocol"); return; }
        ready = true;
        clearTimeout(deadline);
        deadline = setTimeout(() => terminate("dispatch"), 10000);
        child.send("run", (error) => { if (error) { failure = error; terminate("IPC"); } });
      } else if (message.kind === "started") {
        if (!ready || started || terminating) { failure = new Error("Unexpected child operation start"); terminate("protocol"); return; }
        started = true;
        clearTimeout(deadline);
        deadline = setTimeout(() => terminate("operation"), guard === "none" ? 500 : 5000);
      } else if (message.kind === "result") {
        result = message;
        clearTimeout(deadline);
        deadline = setTimeout(() => terminate("cleanup"), 1000);
      }
    });
    child.on("error", (error) => { failure = error; });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      abortSignal.removeEventListener("abort", cancel);
      if (failure) return reject(failure);
      if (timedOut) return resolve({ status: "timeout", signal });
      if (!ready || code !== 0 || !result) return reject(new Error(`Asset fixture exited unexpectedly (${code}, ${signal}): ${stderr}\n${stdout}`));
      resolve(result);
    });
  });
}

async function main() {
  const startedAt = performance.now();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "muster-metro-assets-")));
  mkdirSync(join(scratch, "home"));
  mkdirSync(join(scratch, "no-executables"));
  const malformed = {
    icns: "69636e73000000106963703400000000",
    jxl: "0000000c4a584c200d0a870a00000010667479706a786c2000000000000000006a786c70",
    heif: "0000000c66747970686569630000000066726565",
    "jxl-stream": "ff0a",
  };
  // Complete 2x4 PNG/JPEG fixtures; no image encoder or native utility is
  // required when running this script. Both use the same opaque orange fill.
  const valid = {
    png: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAYAAACk7+45AAAAEUlEQVR4nGP40KXyH4QZcDMAeWcU6TNNhmAAAAAASUVORK5CYII=",
    jpg: "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAABAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABAACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A90ooor/O8/uw/9k=",
  };
  let count = 0, passed = 0;
  const failures = [];
  async function check(name, action) {
    count += 1;
    try { await action(); passed += 1; console.log(`ok ${count} - ${name}`); }
    catch (error) { failures.push(name); console.error(`not ok ${count} - ${name}\n${error.stack}`); }
  }
  try {
    for (const [format, hex] of Object.entries(malformed)) writeFileSync(join(scratch, `${format}.png`), Buffer.from(hex, "hex"));
    for (const [format, base64] of Object.entries(valid)) {
      writeFileSync(join(scratch, `valid.${format}`), Buffer.from(base64, "base64"));
      copyFileSync(join(scratch, `valid.${format}`), join(scratch, `scaled@2x.${format}`));
    }
    // These four ran against the upstream parser until `image-size` became the
    // owned copy in `vendor/image-size`; upstream looped forever here, which is
    // what the advisory describes and what the guards below were added for.
    // The property to hold now is stronger: with no config and no worker policy
    // loaded at all, the parser itself must refuse the signature promptly. A
    // timeout would fail the assertion, so a reintroduced loop cannot pass.
    for (const format of ["icns", "jxl"]) for (const api of ["buffer", "file"]) {
      await check(`unguarded ${format} ${api} control refuses without any policy loaded`, async () => {
        const assetPath = join(scratch, `${format}.png`);
        const result = await runChild(scratch, "none", api, assetPath, controller.signal);
        assert.equal(result.status, "rejected");
        // Metro calls the buffer form as `getImageSize(content)` (no path) and
        // the file form with the resolved asset path, which is what the owned
        // parser reports back in the refusal.
        assert.equal(
          result.message,
          api === "buffer"
            ? `unsupported file type: ${format} (file: undefined)`
            : `unsupported file type: ${format} (file: ${assetPath})`,
        );
      });
    }
    for (const guard of ["config", "worker"]) {
      for (const format of Object.keys(malformed)) for (const api of ["buffer", "file"]) {
        await check(`${guard} rejects renamed ${format} through Metro ${api}`, async () => {
          const result = await runChild(scratch, guard, api, join(scratch, `${format}.png`), controller.signal);
          assert.equal(result.status, "rejected");
          assert.equal(result.message, `disabled file type: ${format}`);
        });
      }
      for (const format of Object.keys(valid)) {
        await check(`${guard} retains ordinary ${format} buffer dimensions`, async () => {
          const result = await runChild(scratch, guard, "buffer", join(scratch, `valid.${format}`), controller.signal);
          assert.equal(result.status, "returned");
          assert.deepEqual(result.value, { width: 2, height: 4 });
        });
        await check(`${guard} retains ${format} filename dimensions and @2x scaling`, async () => {
          const asset = join(scratch, `scaled@2x.${format}`);
          const result = await runChild(scratch, guard, "file", asset, controller.signal);
          assert.equal(result.status, "returned");
          assert.deepEqual(result.value, { width: 1, height: 2, scales: [2], type: format, files: [asset] });
        });
      }
    }
    await check("complete worker preserves upstream cache inputs and invalidates policy/wrapper changes", async () => {
      const result = await runChild(scratch, "worker", "cache", join(scratch, "cache-marker"), controller.signal);
      assert.equal(result.status, "returned", result.message);
      assert.deepEqual(result.value, { stable: true, upstreamOptionsRetained: true, wrapperInvalidates: true, policyInvalidates: true, exportsRetained: true });
    });
    console.log(JSON.stringify({ status: failures.length ? "failed" : "passed", checks: count, passed, failed: failures.length, durationMs: Math.round(performance.now() - startedAt), failures, scope: "Disposable Metro API children; no native build or general image-parser assurance" }));
    if (failures.length) process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--child") {
  await childMain();
} else {
  assert.equal(process.argv.length, 2, "Usage: node scripts/verify-metro-assets.mjs");
  await main();
}
