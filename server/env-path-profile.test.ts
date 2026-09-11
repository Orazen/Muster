import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform === "win32")("profile-aware engine discovery", () => {
  function probe(profile: boolean, late = false) {
    const root = mkdtempSync(join(tmpdir(), "muster-profile-path-"));
    const home = join(root, "home"), bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const shell = join(root, "shell");
    writeFileSync(shell, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const moduleUrl = pathToFileURL(join(process.cwd(), "server/env-path.ts")).href;
    // Observe the actual Node ESM builtin binding in an owned child. The
    // intercepted shell never executes; this verifies discovery policy, not
    // an installed user's shell or startup scripts.
    const script = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      let calls = 0, complete;
      cp.execFile = (...args) => { calls++; complete = args.at(-1); };
      syncBuiltinESMExports();
      const { augmentedPath, resetPathCache } = await import(${JSON.stringify(moduleUrl)});
      const first = augmentedPath();
      if (${late}) {
        process.env.MUSTER_PROFILE_ROOT = ${JSON.stringify(root)};
        complete(null, '__OMB_PATH__/owned-old-login-path');
      }
      resetPathCache();
      const second = augmentedPath();
      console.log(JSON.stringify({ calls, first, second }));
    `;
    try {
      const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, PATH: "/usr/bin:/bin", SHELL: shell };
      if (profile) env.MUSTER_PROFILE_ROOT = root;
      const result = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
        cwd: root, encoding: "utf8", timeout: 10_000,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }));
      return { ...result, bin };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it("keeps profile-local binaries discoverable without invoking a login shell, including rescans", () => {
    const result = probe(true);
    expect(result.calls).toBe(0);
    expect(result.first.split(delimiter)).toContain(result.bin);
    expect(result.second.split(delimiter)).toContain(result.bin);
  });
  it("preserves normal login-shell discovery outside an explicit profile", () => {
    expect(probe(false).calls).toBe(2);
  });
  it("discards an old shell callback if an explicit profile becomes active", () => {
    const result = probe(false, true);
    expect(result.calls).toBe(1);
    expect(result.second).not.toContain("/owned-old-login-path");
  });
});
