/** Owned, offline fixtures for the cloud-to-desktop browser pairing tests. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { freePortBlock } from "../server/testing/ports.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_LIMIT = 16_384;
const pause = (ms: number) => new Promise<void>((resolvePause) => setTimeout(resolvePause, ms));

interface ServerEnvironmentOptions {
  home: string;
  dataDirectory: string;
  companionDirectory: string;
  staticDir: string;
  port: number;
  webhookPort: number;
  secret: string;
}

/** Deliberately do not inherit provider credentials, proxies or Node hooks. */
export function pairingServerEnvironment(options: ServerEnvironmentOptions): NodeJS.ProcessEnv {
  return {
    HOME: options.home,
    USERPROFILE: options.home,
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    // Prevent the server's GUI PATH discovery from loading a login shell.
    VITEST: "true",
    NODE_ENV: "test",
    OMB_HOST: "127.0.0.1",
    OMB_PORT: String(options.port),
    OMB_WEBHOOK_PORT: String(options.webhookPort),
    OMB_PUBLIC_URL: `http://127.0.0.1:${options.port}`,
    OMB_DATA_DIR: options.dataDirectory,
    OMB_COMPANION_DIR: options.companionDirectory,
    OMB_STATIC_DIR: options.staticDir,
    BETTER_AUTH_SECRET: options.secret,
  };
}

interface ReadinessOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** A healthy unrelated listener cannot satisfy this child's startup. */
export async function waitForOwnedServer(
  child: ChildProcess,
  baseUrl: string,
  { timeoutMs = 25_000, fetch: fetchHealth = fetch }: ReadinessOptions = {},
): Promise<void> {
  const marker = `muster server on ${baseUrl}`;
  let output = "";
  let stdout = "";
  let owned = false;
  let failure: Error | undefined;
  const appendOutput = (chunk: Buffer | string) => { output = (output + String(chunk)).slice(-OUTPUT_LIMIT); };
  const onStdout = (chunk: Buffer | string) => {
    appendOutput(chunk);
    stdout = (stdout + String(chunk)).slice(-OUTPUT_LIMIT);
    owned ||= stdout.split(/\r?\n/).some((line) => line === marker);
  };
  const onError = (error: Error) => { failure = error; };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    failure = new Error(`fixture exited before readiness (${signal ?? code})`);
  };
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", appendOutput);
  child.on("error", onError);
  child.on("exit", onExit);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("fixture is no longer running");
      if (Date.now() >= deadline) throw new Error(`timed out waiting for owned fixture at ${baseUrl}`);
      if (owned) {
        try {
          const response = await fetchHealth(`${baseUrl}/api/health`, {
            redirect: "error",
            signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now()))),
          });
          const body = z.object({ app: z.literal("muster") }).safeParse(await response.json());
          if (response.ok && body.success && !failure && child.exitCode === null && child.signalCode === null) return;
        } catch {
          // The owned listener may not yet serve requests; retry within the bound.
        }
      }
      await pause(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.slice(-2_000)}`);
  } finally {
    child.stdout?.off("data", onStdout);
    child.stderr?.off("data", appendOutput);
    child.off("error", onError);
    child.off("exit", onExit);
  }
}

// Every guard is a child-only preload. It never patches the test runner.
function outboundGuard(cloudUrl?: string): string {
  return `
import { Socket } from "node:net";
const allowed = ${JSON.stringify(cloudUrl ? `${cloudUrl}/api/pair/verify` : null)};
const fetchOriginal = globalThis.fetch;
const connectOriginal = Socket.prototype.connect;
const blocked = () => { throw new Error("Outbound network disabled in pairing fixture"); };
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (!allowed || request.url !== allowed || request.method !== "POST" || request.redirect === "follow") blocked();
  return fetchOriginal(request);
};
Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  const options = first && typeof first === "object" ? first : { port: first, host: values[1] };
  const target = allowed ? new URL(allowed) : null;
  if (!target || options.path || options.host !== target.hostname || String(options.port) !== target.port) blocked();
  return Reflect.apply(connectOriginal, this, args);
};
`;
}

interface OwnedChild {
  process: ChildProcess;
  output: string;
  closed: Promise<void>;
  didClose: boolean;
  failure?: Error;
}

async function stopChild(owned: OwnedChild): Promise<void> {
  const child = owned.process;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid || owned.didClose) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  const waitClosed = async (ms: number): Promise<boolean> => {
    if (owned.didClose) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        owned.closed.then(() => true),
        new Promise<boolean>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), ms); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  // Each server owns a fresh process group. ACP engines have their own groups;
  // the temporary engine watchdog below also waits for loss of its server.
  signalGroup("SIGTERM");
  if (!(await waitClosed(3_000))) {
    signalGroup("SIGKILL");
    if (!(await waitClosed(2_000))) throw new Error(`pairing fixture process ${child.pid} did not close`);
  }
}

async function waitForEngines(directory: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const records = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const alive = records.filter((name) => {
      const pid = Number(name);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid fixture engine PID record");
      try { process.kill(pid, 0); return true; } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
        throw error;
      }
    });
    if (!alive.length) return;
    if (Date.now() >= deadline) throw new Error("Pairing fixture engines did not exit after their servers");
    await pause(25);
  }
}

export interface PairingHarness {
  cloudUrl: string;
  desktopUrl: string;
  rootDirectory: string;
  email: string;
  password: string;
  stop(): Promise<void>;
}

export async function startPairingHarness(
  { staticDir = join(ROOT, "dist") }: { staticDir?: string } = {},
  { waitForServer = waitForOwnedServer }: { waitForServer?: typeof waitForOwnedServer } = {},
): Promise<PairingHarness> {
  if (process.platform === "win32") throw new Error("Pairing fixture requires POSIX process groups");
  const builtUi = resolve(staticDir);
  await access(join(builtUi, "index.html"));
  const rootDirectory = await mkdtemp(join(tmpdir(), "muster-pairing-e2e-"));
  const children: OwnedChild[] = [];
  let stopping = false;
  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      stopping = true;
      const results = await Promise.allSettled(children.map(stopChild));
      const failedCleanup = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failedCleanup.length) throw new AggregateError(failedCleanup.map((result) => result.reason), `Fixture cleanup failed; retained ${rootDirectory}`);
      await waitForEngines(join(rootDirectory, "engine-pids"));
      await rm(rootDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      const failedChildren = children.filter((child) => child.failure);
      if (failedChildren.length) throw new AggregateError(failedChildren.map((child) => child.failure), "Pairing fixture exited unexpectedly");
    })();
    return stopped;
  };
  try {
    const basePort = await freePortBlock([0, 1, 2, 3], 24_000, 10_000);
    const cloudUrl = `http://127.0.0.1:${basePort}`;
    const desktopUrl = `http://127.0.0.1:${basePort + 2}`;
    const email = `pairing-${randomBytes(12).toString("hex")}@example.test`;
    const password = randomBytes(32).toString("base64url");
    const noNetwork = join(rootDirectory, "no-network.mjs");
    await writeFile(noNetwork, outboundGuard(), { mode: 0o600 });
    const enginePids = join(rootDirectory, "engine-pids");
    await mkdir(enginePids, { mode: 0o700 });
    const engineWatchdog = join(rootDirectory, "engine-watchdog.mjs");
    await writeFile(engineWatchdog, `
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const owner = process.ppid;
const record = join(${JSON.stringify(enginePids)}, String(process.pid));
writeFileSync(record, "", { mode: 0o600 });
process.once("exit", () => rmSync(record, { force: true }));
setInterval(() => { if (process.ppid !== owner) process.exit(0); }, 100).unref();
`, { mode: 0o600 });
    const fakeCli = join(rootDirectory, "fake-acp");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(fakeCli, `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(noNetwork)} --import ${quote(engineWatchdog)} --experimental-strip-types ${quote(join(ROOT, "server/testing/fake-acp-cli.ts"))} "$@"\n`, { mode: 0o700 });

    const boot = async (kind: "cloud" | "desktop", port: number) => {
      const directory = join(rootDirectory, kind);
      const home = join(directory, "home");
      const dataDirectory = join(directory, "data");
      const companionDirectory = join(directory, "companion");
      // Sequential creation leaves no unfinished filesystem writes if setup
      // fails and immediately starts tearing this fixture down.
      for (const path of [home, dataDirectory, companionDirectory]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
      }
      await writeFile(join(dataDirectory, "config.json"), JSON.stringify({
        instances: kind === "cloud"
          ? { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } }
          : { gemini: { driver: "geminiAgent", displayName: "Pairing test engine", environment: {
            FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: join(directory, "fake-acp.json"),
          }, config: { cli: fakeCli, fullAuto: false, workspace: home } } },
      }), { mode: 0o600 });
      const guard = join(directory, "block-outbound.mjs");
      await writeFile(guard, outboundGuard(kind === "desktop" ? cloudUrl : undefined), { mode: 0o600 });
      const env = pairingServerEnvironment({ home, dataDirectory, companionDirectory, staticDir: builtUi, port, webhookPort: port + 1, secret: randomBytes(32).toString("hex") });
      if (kind === "cloud") {
        env.OMB_ALLOW_SIGNUPS = "true";
        env.GOOGLE_CLIENT_ID = randomBytes(24).toString("hex");
        env.GOOGLE_CLIENT_SECRET = randomBytes(32).toString("hex");
      } else {
        env.OMB_DESKTOP_APP = "true";
        env.OMB_PAIR_CLOUD_URL = cloudUrl;
      }
      const child = spawn(process.execPath, ["--import", guard, "--experimental-strip-types", join(ROOT, "server/index.ts")], {
        cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let closed!: () => void;
      const owned: OwnedChild = {
        process: child, output: "", didClose: false,
        closed: new Promise<void>((resolveClosed) => { closed = resolveClosed; }),
      };
      children.push(owned);
      const append = (chunk: Buffer | string) => { owned.output = (owned.output + String(chunk)).slice(-OUTPUT_LIMIT); };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (error) => { if (!stopping) owned.failure = error; });
      child.on("exit", (code, signal) => {
        if (!stopping) owned.failure = new Error(`${kind} fixture exited (${signal ?? code}): ${owned.output.slice(-2_000)}`);
      });
      child.once("close", () => { owned.didClose = true; closed(); });
      await waitForServer(child, `http://127.0.0.1:${port}`);
    };
    await boot("cloud", basePort);
    await boot("desktop", basePort + 2);
    const signup = await fetch(`${cloudUrl}/api/auth/sign-up/email`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", origin: cloudUrl },
      body: JSON.stringify({ email, password, name: "Pairing E2E Owner" }),
    });
    if (!signup.ok) throw new Error(`Pairing fixture signup failed (${signup.status})`);
    await signup.arrayBuffer();
    return { cloudUrl, desktopUrl, rootDirectory, email, password, stop };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Pairing fixture startup and cleanup failed"); }
    throw error;
  }
}
