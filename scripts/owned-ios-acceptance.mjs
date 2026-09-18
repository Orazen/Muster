#!/usr/bin/env node
// Owned-simulator acceptance rig for the iOS/Watch companion.
//
//   node scripts/owned-ios-acceptance.mjs [--device "iPhone 17 Pro"]
//        [--owned-device "Muster Owned Rig"] [--skip-build --derived-data /tmp/muster-ios-rig-dd]
//
// Boots a real desktop-mode harness and companion sidecar on probed free
// ports against a throwaway HOME, creates and renames a bot, mints a one-time
// pairing deep link, then drives the three owned UI tests in the documented
// order (pair → identity tour → Walkie tour) on one simulator, and tears
// everything down with receipts.
//
// Ownership rules honored here:
// - ports are probed free; the user's live companion (8810/8811) is never
//   touched — if a probed port is occupied the probe picks another;
// - only a simulator the rig booted is shut down; pre-existing devices are
//   left exactly as they were;
// - every spawned PID, every port and every temp root is printed as a
//   receipt and removed at exit, successful or not.
//
// A `muster up` self-hosted harness does NOT work for the pairing test: it
// gates proxied requests behind a web session the sidecar does not carry
// (root-caused in Loop 58) — the desktop-mode harness is the rig.
//
// Pairing windows expire after two minutes, so the deep link is minted only
// after the test build exists and is consumed immediately by phase 1.
import { execFileSync, execSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── arguments ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true);
};
const DEVICE = flag("--device") || "iPhone 17 Pro";
// When set, the rig CREATES its own simulator of the same device type, tests
// on it and DELETES it at cleanup — a fresh keychain, and no user simulator
// state is ever touched. This is the loop45 ownership pattern.
const OWNED_DEVICE = flag("--owned-device");
const SKIP_BUILD = Boolean(flag("--skip-build"));
const KEEP = Boolean(flag("--keep"));
const DERIVED_DATA = flag("--derived-data") || null;
// Release by default for UI runs: the Debug bundle ships Xcode preview
// instrumentation (MusterCompanion.debug.dylib, __preview.dylib) whose
// re-render hooks can saturate the app's main thread during streaming and
// starve XCUITest queries ("process main thread busy for 30.0s").
const CONFIGURATION = flag("--configuration") || "Release";
const BOT_NAME = "Mimi";

// ── process/port plumbing ──────────────────────────────────────────────────
const children = [];
const portsUsed = [];
const roots = [];
let bootedSimUdid = null;
let simWasRunning = false;
let ownedSimCreated = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = (cmd, argv, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd: ROOT, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    if (opts.timeoutMs) setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs).unref();
  });

/** Probe genuinely free loopback ports. A port is only reported when a
 * listen(0) succeeds on it; the window before the service binds is small
 * and owned by this script alone. */
const probePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => (portsUsed.push(port), resolve(port)));
    });
    server.on("error", reject);
  });

const start = (label, argv, env) => {
  const child = spawn(process.execPath, argv, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  children.push({ label, child, err: () => err });
  return child;
};

const waitFor = async (url, label, child) => {
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error(`${label} exited ${child.exitCode}:\n${child.err()}`);
    if (Date.now() > deadline) throw new Error(`${label} never came up:\n${child.err()}`);
    await sleep(200);
  }
};

const json = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
};

// ── simulator ownership ────────────────────────────────────────────────────
const findSim = async () => {
  if (OWNED_DEVICE) {
    const { out: types } = await run("xcrun", ["simctl", "list", "devicetypes"]);
    const typeLine = types.split("\n").find((l) => l.includes(DEVICE));
    if (!typeLine) throw new Error(`no device type named "${DEVICE}"`);
    const deviceType = typeLine.match(/com\.apple\.CoreSimulator\.SimDeviceType\.[\w-]+/)?.[0];
    const { out: runtimes } = await run("xcrun", ["simctl", "list", "runtimes"]);
    const runtimeLine = runtimes.split("\n").find((l) => l.includes("iOS") && l.includes("–") === false && /iOS \d/.test(l)) || runtimes.split("\n").find((l) => l.includes("iOS -")) || runtimes.split("\n").find((l) => l.trim().startsWith("iOS"));
    const runtime = runtimeLine?.match(/com\.apple\.CoreSimulator\.SimRuntime\.iOS-\d+-\d+/)?.[0];
    if (!deviceType || !runtime) throw new Error(`could not resolve device type/runtime:\n${typeLine}\n${runtimeLine}`);
    const created = await run("xcrun", ["simctl", "create", OWNED_DEVICE, deviceType, runtime]);
    if (created.code !== 0) throw new Error(`could not create the owned simulator: ${created.out}`);
    ownedSimCreated = true;
    simWasRunning = false;
    return { udid: created.out.trim(), name: OWNED_DEVICE };
  }
  const { out } = await run("xcrun", ["simctl", "list", "devices", "available"]);
  const line = out.split("\n").find((l) => l.includes(`(${DEVICE} `) || l.trim().startsWith(`${DEVICE} (`));
  if (!line) throw new Error(`no available simulator named "${DEVICE}"`);
  const udid = line.match(/([0-9A-F-]{36})/)?.[1];
  if (!udid) throw new Error(`could not parse a UDID from: ${line.trim()}`);
  simWasRunning = line.includes("(Booted)");
  return { udid, name: DEVICE };
};

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "muster-ios-rig-"));
  roots.push(scratch);
  const home = mkdtempSync(join(tmpdir(), "muster-ios-rig-home-"));
  roots.push(home);
  const data = mkdtempSync(join(tmpdir(), "muster-ios-rig-data-"));
  roots.push(data);
  mkdirSync(data, { recursive: true });

  // The server reads config.json ONLY from OMB_DATA_DIR (server/config.ts
  // DATA_DIR, line 170/243). The fake ACP engine instance lives there — the
  // same arrangement the repo's own harness tests use (e2e/pairing-harness.ts
  // pairingServerEnvironment + brain-dispatch-harness.test.ts), and the one
  // proven to settle a real turn by scripts/turn-probe.mjs.
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      rig: {
        driver: "grokAgent",
        config: { cli: join(ROOT, "server", "testing", "fake-acp-cli.ts"), fullAuto: true },
      },
    },
  }), { mode: 0o600 });

  const HARNESS_PORT = await probePort();
  const COMPANION_PORT = await probePort();
  const CONTROL_PORT = await probePort();
  const WEBHOOK_PORT = await probePort();
  const HARNESS = `http://127.0.0.1:${HARNESS_PORT}`;
  const COMPANION = `http://127.0.0.1:${COMPANION_PORT}`;
  const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;

  console.log(JSON.stringify({ scope: "ios-acceptance-rig", phase: "plan", HARNESS_PORT, COMPANION_PORT, CONTROL_PORT, WEBHOOK_PORT, device: DEVICE }));

  // The companion drives the harness; a throwaway HOME keeps the user's real
  // profile, keys and tokens out of the rig entirely.
  const harness = start("harness", ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(HARNESS_PORT),
    OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
    OMB_DATA_DIR: data,
  });
  await waitFor(`${HARNESS}/api/health`, "harness", harness);

  const sidecar = start("companion", ["--experimental-strip-types", join(ROOT, "companion", "src", "index.ts")], {
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(HARNESS_PORT),
    OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
    OMB_DATA_DIR: data,
    OMB_COMPANION_PORT: String(COMPANION_PORT),
    OMB_CONTROL_PORT: String(CONTROL_PORT),
    OMB_COMPANION_DIR: join(home, "companion"),
  });
  await waitFor(`${CONTROL}/state`, "companion", sidecar);

  // A named bot for the roster/tour tests. Created and renamed on the
  // harness directly — general bot PATCH is exactly what the sidecar refuses
  // to expose to devices, so this is setup a phone cannot do (like the boot).
  const created = await json(`${HARNESS}/api/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const bot = created.body.bot;
  if (!bot) throw new Error(`could not create a bot: ${JSON.stringify(created.body)}`);
  const renamed = await json(`${HARNESS}/api/bots/${bot.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    // The fake engine instance from the config above, so the Walkie turn
    // runs and settles without any provider, credential or network.
    body: JSON.stringify({ name: BOT_NAME, modelSelection: { instanceId: "rig", model: "fake-acp-model" }, computer: "off" }),
  });
  if (renamed.body.bot?.name !== BOT_NAME) throw new Error(`could not rename the bot: ${renamed.status}`);
  console.log(JSON.stringify({ scope: "ios-acceptance-rig", phase: "bot", botId: bot.id, name: BOT_NAME }));

  // ── the simulator: boot only ours, clean only our app ────────────────────
  const sim = await findSim();
  bootedSimUdid = sim.udid;
  if (!simWasRunning) {
    const boot = await run("xcrun", ["simctl", "boot", sim.udid]);
    if (boot.code !== 0 && !boot.out.includes("already booted")) throw new Error(`could not boot ${sim.name}: ${boot.out}`);
  }
  // A previously paired app state would make the invite honestly refused —
  // the pairing test must start from a clean install of OUR app.
  await run("xcrun", ["simctl", "uninstall", sim.udid, "com.muster.companion"]);
  console.log(JSON.stringify({ scope: "ios-acceptance-rig", phase: "sim", udid: sim.udid, bootedByRig: !simWasRunning }));

  // ── build for testing (unless resuming with a prepared derived-data) ─────
  const dd = DERIVED_DATA || join(scratch, "dd");
  if (!SKIP_BUILD || DERIVED_DATA === null) {
    console.log(JSON.stringify({ scope: "ios-acceptance-rig", phase: "build-for-testing", dd }));
    const build = await run(
      "xcodebuild",
      [
        "build-for-testing",
        "-project", join(ROOT, "ios", "MusterCompanion.xcodeproj"),
        "-scheme", "MusterOwnedAcceptance",
        "-configuration", CONFIGURATION,
        "-destination", `platform=iOS Simulator,name=${DEVICE}`,
        "-derivedDataPath", dd,
        "CODE_SIGNING_ALLOWED=NO",
      ],
      { timeoutMs: 600_000 },
    );
    if (build.code !== 0 || !build.out.includes("TEST BUILD SUCCEEDED")) {
      throw new Error(`build-for-testing failed:\n${build.out.slice(-4000)}`);
    }
  }

  // Pre-install both bundles while the pairing window is NOT yet open: on a
  // freshly created simulator the first boot/install inside xcodebuild can
  // eat most of the two-minute window and the redeem lands after expiry
  // ("no pairing is in progress"). After a pre-install, test-without-building
  // only has to launch, so mint → redeem stays tight. The runner bundle is
  // named after the UI-test target, not the scheme, so match it by suffix.
  const products = join(dd, "Build", "Products", `${CONFIGURATION}-iphonesimulator`);
  const bundles = readdirSync(products).filter((n) => n === "MusterCompanion.app" || n.endsWith("-Runner.app"));
  if (bundles.length < 2) throw new Error(`expected the app and a test runner in ${products}, found: ${bundles.join(", ")}`);
  for (const app of bundles) {
    const inst = await run("xcrun", ["simctl", "install", sim.udid, join(products, app)]);
    if (inst.code !== 0) throw new Error(`could not pre-install ${app}: ${inst.out}`);
  }
  // Best-effort permission pre-grants so first-launch prompts cannot eat the
  // window either; a refusal here is not fatal (the prompts simply appear).
  for (const service of ["notifications", "LocalNetwork"]) {
    await run("xcrun", ["simctl", "privacy", sim.udid, "grant", service, "com.muster.companion"]);
  }

  // ── mint the invite and run phase 1 immediately (two-minute window) ──────
  const opened = await json(`${CONTROL}/pairing`, { method: "POST" });
  const { code, token } = opened.body;
  if (!token) throw new Error(`could not open a pairing window: ${JSON.stringify(opened.body)}`);
  const pairUrl =
    `muster://pair?address=${encodeURIComponent(COMPANION)}` +
    `&token=${encodeURIComponent(token)}&name=${encodeURIComponent("Owned Rig")}`;
  console.log(JSON.stringify({ scope: "ios-acceptance-rig", phase: "invite", code, sidecar: COMPANION }));

  const dest = ["-destination", `platform=iOS Simulator,name=${OWNED_DEVICE || DEVICE}`];
  const common = [
    "test-without-building",
    "-configuration", CONFIGURATION,
    "-project", join(ROOT, "ios", "MusterCompanion.xcodeproj"),
    "-scheme", "MusterOwnedAcceptance",
    "-derivedDataPath", dd,
    ...dest,
  ];
  // TEST_RUNNER_-prefixed variables are forwarded to the xctest runner only
  // from xcodebuild's environment — as VAR=value argv they would be read as
  // build settings and never reach the test process.
  const testEnv = {
    ...process.env,
    TEST_RUNNER_MUSTER58_PAIR_URL: pairUrl,
    TEST_RUNNER_MUSTER58_BOT_NAME: BOT_NAME,
  };

  // The verdict comes from the xcresult's structured test nodes, not from
  // stdout: xcodebuild's final line has been observed missing on a run whose
  // result bundle records every case as Passed.
  const verdict = (bundle) => {
    try {
      const raw = execFileSync("xcrun", ["xcresulttool", "get", "test-results", "tests", "--path", bundle], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = JSON.parse(raw);
      let any = false;
      let ok = true;
      const walk = (node) => {
        if (node.nodeType === "Test Case") {
          any = true;
          if (node.result !== "Passed") ok = false;
        }
        for (const child of node.children ?? []) walk(child);
      };
      for (const node of parsed.testNodes ?? []) walk(node);
      return any && ok;
    } catch {
      return false;
    }
  };

  const phases = [
    { name: "pair", only: "-only-testing:MusterOwnedUITests/IdentityAcceptance/testPairAcceptsInvite" },
    { name: "identity", only: "-only-testing:MusterOwnedUITests/IdentityAcceptance/testIdentityTour" },
    { name: "walkie", only: "-only-testing:MusterOwnedUITests/WalkieAcceptance/testWalkieTour" },
  ];
  const results = [];
  for (const phase of phases) {
    const resultPath = join(scratch, `${phase.name}.xcresult`);
    const runArgs = [...common, phase.only, "-resultBundlePath", resultPath];
    console.log(JSON.stringify({ scope: "ios-acceptance-rig", phase: "test-start", test: phase.name }));
    const t = await run("xcodebuild", runArgs, { timeoutMs: 480_000, env: testEnv });
    const passed = verdict(resultPath) || t.out.includes("** TEST SUCCEEDED **");
    results.push({ test: phase.name, passed });
    console.log(JSON.stringify({ scope: "ios-acceptance-rig", phase: "test-end", test: phase.name, passed, resultBundle: resultPath }));
    if (!passed) {
      // surface the failing lines so the transcript carries the evidence
      const lines = t.out.split("\n").filter((l) => /error:|failed \(|Test Suite .* failed/.test(l));
      console.log(lines.slice(0, 20).join("\n"));
    }
  }

  const allGreen = results.every((r) => r.passed);
  console.log(JSON.stringify({ scope: "ios-acceptance-rig", phase: "summary", results, allGreen }));
  if (!allGreen) process.exitCode = 1;
}

// ── cleanup receipts ───────────────────────────────────────────────────────
const cleanup = (error) => {
  for (const { child } of children) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  if (bootedSimUdid && !simWasRunning) {
    try { execSync(`xcrun simctl shutdown ${bootedSimUdid}`, { stdio: "ignore" }); } catch { /* best effort */ }
  }
  if (ownedSimCreated && bootedSimUdid) {
    try { execSync(`xcrun simctl delete ${bootedSimUdid}`, { stdio: "ignore" }); } catch { /* best effort */ }
  }
  for (const root of (KEEP ? [] : roots)) rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({
    scope: "ios-acceptance-rig cleanup",
    pids: children.map((c) => c.child.pid),
    ports: portsUsed,
    sim: bootedSimUdid ? { udid: bootedSimUdid, owned: ownedSimCreated, bootedByRig: !simWasRunning, shutDown: !simWasRunning, deleted: ownedSimCreated } : null,
    rootsRemoved: KEEP ? 0 : roots.length,
    rootsKept: KEEP ? roots : [],
    error: error ? String(error instanceof Error ? error.message : error) : null,
  }));
};

main().then(
  () => cleanup(null),
  (error) => {
    cleanup(error);
    process.exit(1);
  },
);
