import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pairingServerEnvironment } from "./pairing-harness.ts";
import { startOnboardingHarness } from "./onboarding-harness.ts";

const run = promisify(execFile);
const posix = describe.skipIf(process.platform === "win32");
let root: string;
let marker: string;
let env: NodeJS.ProcessEnv;

posix("owned fixture container boundary", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "muster-no-container-"));
    marker = join(root, "runtime-was-executed");
    const bin = join(root, "bin");
    await mkdir(bin);
    await mkdir(join(root, "home"));
    // Harmless stand-ins prove execution, without invoking any real runtime.
    for (const command of ["docker", "podman", "container"]) {
      await writeFile(join(bin, command), '#!/bin/sh\nprintf invoked > "$MUSTER_RUNTIME_MARKER"\nprintf fixture\n', { mode: 0o700 });
    }
    env = pairingServerEnvironment({ home: join(root, "home"), dataDirectory: join(root, "data"),
      companionDirectory: join(root, "companion"), staticDir: root, port: 45100, webhookPort: 45101, secret: "owned-test-secret" });
    env.PATH = [bin, env.PATH].join(delimiter);
    env.OMB_EXTRA_PATH = bin;
    env.MUSTER_RUNTIME_MARKER = marker;
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("the harmless runtime is reachable when the explicit fixture guard is removed", async () => {
    const { NODE_OPTIONS: _guard, ...unguarded } = env;
    const result = await run(process.execPath, ["--input-type=module", "-e", `
      import { execFileSync } from 'node:child_process';
      process.stdout.write(execFileSync('podman', ['info']));
    `], { env: unguarded });
    expect(result.stdout).toBe("fixture");
    expect(existsSync(marker)).toBe(true);
  });

  for (const method of ["execFile", "execFileSync", "spawn", "spawnSync", "promisify"] as const) {
    it(`${method} refuses runtime discovery and execution without touching host storage`, async () => {
      const result = await run(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
        import { promisify } from 'node:util';
        import { join } from 'node:path';
        const attempts = [];
        for (const runtime of ['docker', 'podman', 'container']) {
          attempts.push([runtime, ['info']], [join(process.env.OMB_EXTRA_PATH, runtime), ['info']],
            ['/usr/bin/which', [runtime]], ['where.exe', [runtime + '.exe']]);
        }
        for (const [command, args] of attempts) {
          const method = ${JSON.stringify(method)};
          if (method === 'execFileSync') assert.throws(() => execFileSync(command, args), {code: 'ENOENT'});
          else if (method === 'spawnSync') assert.equal(spawnSync(command, args).error?.code, 'ENOENT');
          else if (method === 'promisify') await assert.rejects(promisify(execFile)(command, args), {code: 'ENOENT'});
          else if (method === 'execFile') await new Promise((resolve, reject) => {
            execFile(command, args, error => {
              try { assert.equal(error?.code, 'ENOENT'); resolve(); } catch (error) { reject(error); }
            });
          });
          else await new Promise((resolve, reject) => {
            const child = spawn(command, args);
            child.once('error', error => {
              try { assert.equal(error.code, 'ENOENT'); resolve(); } catch (error) { reject(error); }
            });
            child.once('spawn', () => reject(new Error('Runtime launched')));
          });
        }
        const promise = promisify(execFile)(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']);
        assert.ok(promise.child);
        assert.deepEqual(await promise, {stdout: 'out', stderr: 'err'});
        console.log(attempts.length);
      `], { env });
      expect(result.stdout.trim()).toBe("12");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(root, "home", ".local", "share", "containers"))).toBe(false);
    });
  }

  it("the real status module cannot discover even the harmless installed runtimes", async () => {
    const module = new URL("../server/container-computer.ts", import.meta.url).href;
    const result = await run(process.execPath, ["--input-type=module", "-e", `
      const { containerComputerStatus } = await import(${JSON.stringify(module)});
      const status = await containerComputerStatus();
      console.log(JSON.stringify({available: status.available, runtime: status.runtime, daemonUp: status.daemonUp}));
    `], { env });
    expect(JSON.parse(result.stdout)).toEqual({ available: [], runtime: null, daemonUp: false });
    expect(existsSync(marker)).toBe(false);
  });

  it("the onboarding server starts, answers status and removes its whole temporary home", async () => {
    await writeFile(join(root, "index.html"), "<!doctype html><title>Owned fixture</title>");
    const harness = await startOnboardingHarness(root);
    try {
      const response = await harness.api("/api/local-computer");
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ available: [], runtime: null, daemonUp: false });
      expect(existsSync(join(harness.rootDirectory, "home", ".local", "share", "containers"))).toBe(false);
    } finally { await harness.stop(); }
    expect(existsSync(harness.rootDirectory)).toBe(false);
    await expect(fetch(`${harness.serverUrl}/api/health`)).rejects.toThrow();
  });
});
