import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { profilePathEnvironment } from "./profile-environment.ts";

const run = promisify(execFile);
const observationSchema = z.object({ env: z.record(z.string(), z.string()), home: z.string(), cwd: z.string() });
const clientUrl = new URL("./mcp-client.ts", import.meta.url).href;
const bridgeUrl = new URL("./mcp-bridge.ts", import.meta.url).href;
let scratch: string, home: string, workspace: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "muster-mcp-profile-")));
  home = join(scratch, "home");
  workspace = join(scratch, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  writeFileSync(join(home, "keep.txt"), "owned profile sentinel");
});

afterEach(() => {
  expect(readFileSync(join(home, "keep.txt"), "utf8")).toBe("owned profile sentinel");
  rmSync(scratch, { recursive: true, force: true });
});

function selectedPaths() {
  return {
    MUSTER_PROFILE_ROOT: scratch, HOME: home, USERPROFILE: home,
    APPDATA: join(scratch, "app-data"), LOCALAPPDATA: join(scratch, "local-app-data"),
    XDG_CONFIG_HOME: join(scratch, "config"), XDG_CACHE_HOME: join(scratch, "cache"),
    XDG_DATA_HOME: join(scratch, "data"), XDG_STATE_HOME: join(scratch, "state"),
    TMPDIR: scratch, TMP: scratch, TEMP: scratch, MAC_CHROMIUM_TMPDIR: scratch, ZDOTDIR: home,
    OMB_DATA_DIR: join(scratch, "muster"), OMB_USER_DATA: join(scratch, "user-data"),
    OMB_COMPANION_DIR: join(scratch, "companion"), CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"), FACTORY_HOME_OVERRIDE: home,
    HERMES_HOME: join(home, ".hermes"), KIMI_CODE_HOME: join(home, ".kimi-code"), GROK_HOME: join(home, ".grok"),
  };
}

describe("explicit child profile paths", () => {
  it("adds nothing when the profile is unset, even with inherited engine and app paths", () => {
    const paths = { ...selectedPaths(), MUSTER_PROFILE_ROOT: undefined };
    expect(profilePathEnvironment(paths)).toEqual({});
  });

  it("copies explicit paths without inventing unspecified defaults or widening the allowlist", () => {
    const input = { MUSTER_PROFILE_ROOT: scratch, USERPROFILE: home, TEMP: "", OPENAI_API_KEY: "not-a-real-key", NODE_OPTIONS: "--no-warnings", UNKNOWN_HOME: home };
    expect(profilePathEnvironment(input)).toEqual({ MUSTER_PROFILE_ROOT: scratch, USERPROFILE: home, TEMP: "" });
    expect(input.TEMP).toBe("");
  });

  it("preserves native Windows path values without treating them as host paths", () => {
    const paths = { MUSTER_PROFILE_ROOT: "C:\\owned profile", USERPROFILE: "C:\\owned profile\\home", APPDATA: "C:\\owned profile\\app", LOCALAPPDATA: "C:\\owned profile\\local" };
    expect(profilePathEnvironment(paths)).toEqual(paths);
  });

  it("returns a new path map for each profile and never mutates the supplied environment", () => {
    const paths = selectedPaths();
    const first = profilePathEnvironment(paths);
    first.HOME = "changed only in copy";
    expect(paths.HOME).toBe(home);
    const next = { ...paths, MUSTER_PROFILE_ROOT: join(scratch, "second"), HOME: join(scratch, "second", "home") };
    expect(profilePathEnvironment(next)).toEqual(next);
  });
});

async function observe(mode: "client" | "bridge", active: boolean, overrides: Record<string, string> = {}) {
  const target = join(scratch, "target.cjs");
  const observeCode = `const observation = () => ({env: process.env, home: require('node:os').homedir(), cwd: process.cwd()});`;
  // The fixture cannot outlive its wrapper's bounded wait even if a protocol
  // assertion fails. The parent awaits wrapper close before removing scratch.
  const deadline = `setTimeout(() => process.exit(2), 3000).unref();`;
  writeFileSync(target, mode === "bridge" ? `${deadline}\n${observeCode}\nconsole.log(JSON.stringify(observation()));` : `
    ${deadline}
    ${observeCode}
    const lines = require('node:readline').createInterface({input: process.stdin});
    lines.on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = request.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'owned-env-fixture',version:'1'}}
        : request.method === 'tools/list' ? {tools:[{name:'observe',inputSchema:{type:'object'}}]}
          : {content:[{type:'text',text:JSON.stringify(observation())}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
    });
  `);
  const paths = { ...selectedPaths(), MUSTER_PROFILE_ROOT: active ? scratch : undefined };
  const env: NodeJS.ProcessEnv = { ...paths, LANG: "C", VITEST: "1", EXPECT_FIXTURE_HOME: home, PATH: process.env.PATH ?? "" };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
  const script = `
    import {homedir} from 'node:os';
    if (homedir() !== process.env.EXPECT_FIXTURE_HOME) throw new Error('Fixture HOME was not applied');
    // Synthetic values only, set after Node startup. No real provider keys
    // or inherited Node hooks are supplied to either owned process.
    Object.assign(process.env, {OPENAI_API_KEY:'synthetic-provider-sentinel', BETTER_AUTH_SECRET:'synthetic-auth-sentinel', NODE_OPTIONS:'--no-warnings', NODE_PATH:${JSON.stringify(join(scratch, "unused-module-dir"))}, ARBITRARY_SENTINEL:'not-forwarded'});
    ${mode === "client" ? `
      const {connectMcpStdio} = await import(${JSON.stringify(clientUrl)});
      const client = await connectMcpStdio(process.execPath, [${JSON.stringify(target)}], ${JSON.stringify(overrides)}, {timeoutMs:1500});
      try { const result = await client.callTool('observe', {}); console.log(result.content[0].text); }
      finally { client.close(); }
    ` : `
      const {runMcpBridge} = await import(${JSON.stringify(bridgeUrl)});
      runMcpBridge({command:process.execPath,args:[${JSON.stringify(target)}],label:'owned env fixture',env:${JSON.stringify(overrides)}});
    `}
  `;
  const result = await run(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { env, cwd: workspace, timeout: 10000, maxBuffer: 1024 * 1024 });
  return observationSchema.parse(JSON.parse(result.stdout));
}

describe.each(["client", "bridge"] as const)("real MCP %s child environment", (mode) => {
  it("receives profile paths and cwd without automatic provider credentials, hooks, or arbitrary keys", async () => {
    const observation = await observe(mode, true);
    expect(observation.env).toMatchObject(selectedPaths());
    expect(observation.home).toBe(home);
    expect(observation.cwd).toBe(workspace);
    for (const key of ["OPENAI_API_KEY", "BETTER_AUTH_SECRET", "NODE_OPTIONS", "NODE_PATH", "ARBITRARY_SENTINEL", "EXPECT_FIXTURE_HOME", "VITEST"]) {
      expect(observation.env).not.toHaveProperty(key);
    }
  });

  it("retains the original minimal environment when the profile is unset", async () => {
    const observation = await observe(mode, false);
    expect(observation.env).toMatchObject({ HOME: home, LANG: "C", TMPDIR: scratch });
    for (const key of Object.keys(selectedPaths()).filter((key) => key !== "HOME" && key !== "TMPDIR")) {
      expect(observation.env).not.toHaveProperty(key);
    }
    expect(observation.cwd).toBe(workspace);
  });

  it("honors explicit target overrides without importing unrelated inherited settings", async () => {
    const targetHome = join(scratch, "configured target home");
    mkdirSync(targetHome);
    const overrides = { HOME: targetHome, USERPROFILE: targetHome, CODEX_HOME: join(targetHome, ".codex"), ARBITRARY_SENTINEL: "explicit target value" };
    const observation = await observe(mode, true, overrides);
    expect(observation.env).toMatchObject({ ...selectedPaths(), ...overrides });
    expect(observation.home).toBe(targetHome);
    expect(observation.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(observation.env).not.toHaveProperty("NODE_OPTIONS");
  });
});
