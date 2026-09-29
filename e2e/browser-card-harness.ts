/** Owned single-server runtime for the browser capability card's mounted
 *  acceptance check.
 *
 *  - an explicit, probed free port block; the demo server's 8845 is asserted
 *    clear of and never bound
 *  - an owned HOME, data dir, companion dir and static dir, all removed on stop
 *  - a stand-in for the Obscura binary, so /api/browser-status reports the
 *    machine as having it and the card can reach a per-bot verdict
 *  - TWO engines: one that composes the shared ACP core (customMcp: true) and
 *    one discovered at run time that does not, so an engine change flips the
 *    card's verdict for real
 *
 * No provider credential is inherited and no real provider is contacted: the
 * supporting engine runs a fake local ACP CLI.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePortBlock } from "../server/testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STATIC_DIR = join(ROOT, "dist");
/** OBSCURA_TOOLS.length. Not taken on trust from the card: the run asserts the
 *  number the real endpoint reports is the number the card printed. */
export const TOOL_COUNT = 14;
export const SUPPORTED_ENGINE = "supported";
export const UNSUPPORTED_ENGINE = "unsupported";

/** A driver whose adapter does not declare `customMcp`, discovered at run time
 *  exactly as the server truth test does: the supporting set changes as drivers
 *  are added, and a pinned name rots into a false assertion. */
function driverWithoutCustomMcp(): string {
  const dir = join(ROOT, "server", "drivers");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
    if (readFileSync(join(dir, file), "utf8").includes("customMcp")) continue;
    const kind = file.replace(/\.ts$/, "");
    // These compose the shared ACP core, which DOES declare customMcp, so a
    // file that merely omits the token is not a driver that lacks support.
    if (["local", "grokagent", "native", "retry", "local-inject", "acp"].includes(kind)) continue;
    return kind;
  }
  throw new Error("every driver now supports customMcp; this fixture needs one that does not");
}

export type BrowserCardFixture = { base: string; port: number; obscura: string; root: string; pid: number | undefined };

export async function startOwnedFixture(): Promise<BrowserCardFixture> {
  if (!existsSync(STATIC_DIR)) throw new Error(`run \`npx vite build\` first: ${STATIC_DIR} is missing`);
  const root = mkdtempSync(join(tmpdir(), "muster-browser-card-"));
  const home = join(root, "home");
  const data = join(root, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const cli = join(root, "fake-acp");
  writeFileSync(cli, `#!/bin/sh\nexec ${quote(process.execPath)} --experimental-strip-types ${quote(join(ROOT, "server/testing/fake-acp-cli.ts"))} "$@"\n`);
  chmodSync(cli, 0o700);
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {
    [SUPPORTED_ENGINE]: { driver: "geminiAgent", displayName: "Supporting engine",
      environment: { FAKE_ACP_MODE: "happy" }, config: { cli, fullAuto: false, workspace: home } },
    [UNSUPPORTED_ENGINE]: { driver: driverWithoutCustomMcp(), displayName: "Non-supporting engine" },
  } }));
  writeFileSync(join(data, "license.json"), JSON.stringify({ firstLaunchAt: "2020-01-01T00:00:00.000Z", license: null }));
  // A stand-in for the Obscura binary. This harness never executes it; the
  // server only resolves the path. Removing it later is how the spec reaches
  // the card's install prompt against the REAL endpoint.
  mkdirSync(join(data, "bin"), { recursive: true });
  const obscura = join(data, "bin", "obscura");
  writeFileSync(obscura, "#!/bin/sh\nexit 0\n");
  chmodSync(obscura, 0o700);

  // Probed, not assumed, and asserted clear of the demo server's port.
  const port = await freePortBlock([0, 1, 2]);
  if (port === 8845) throw new Error("refusing to bind the demo server's port");
  if (port <= 8845) throw new Error(`owned fixture port ${port} is not clear of 8845`);
  const base = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      VITEST: "true",
      NODE_ENV: "test",
      OMB_HOST: "127.0.0.1",
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_PUBLIC_URL: base,
      OMB_DATA_DIR: data,
      OMB_COMPANION_DIR: join(root, "companion"),
      OMB_STATIC_DIR: STATIC_DIR,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      OMB_ALLOW_SIGNUPS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout?.resume();
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`, { redirect: "manual" })).ok) break;
    } catch { /* not listening yet */ }
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`owned browser-card fixture did not start: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { base, port, obscura, root, pid: child.pid };
}
