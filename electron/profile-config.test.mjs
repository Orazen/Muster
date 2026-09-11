import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { configureProfilePaths, resolveProfileConfiguration } from "./profile-config.mjs";

const scratch = [];
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "muster-profile-"))); scratch.push(base);
  const root = path.join(base, "owned profile");
  const userData = path.join(root, "user-data");
  const env = { MUSTER_PROFILE_ROOT: root, HOME: "/original-home", CODEX_HOME: "/old-codex", APPDATA: "/old-app-data", TOKEN_FIXTURE: "unchanged-test-value" };
  const calls = [];
  const app = {
    isReady: () => false,
    getPath(name) { calls.push(["getPath", name]); return userData; },
    setPath(name, value) { calls.push(["setPath", name, value]); },
    setAppLogsPath(value) { calls.push(["logs", value]); },
  };
  const options = { app, env, argv: ["owned-electron", `--user-data-dir=${userData}`], chdir: (directory) => calls.push(["cwd", directory]) };
  return { base, root, userData, env, calls, app, options, run: () => configureProfilePaths(options) };
}
afterEach(() => { for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function expectNoApplicationMutation(f, originalEnv) {
  expect(f.calls.filter(([name]) => name !== "getPath")).toEqual([]);
  expect(f.env).toEqual(originalEnv);
}

describe("explicit desktop profile layout", () => {
  it("leaves every default untouched when the profile variable is absent", () => {
    const f = fixture(); delete f.env.MUSTER_PROFILE_ROOT;
    f.app.isReady = () => { throw new Error("default must not touch Electron"); };
    const before = { ...f.env };
    expect(f.run()).toBeNull(); expect(f.env).toEqual(before); expect(f.calls).toEqual([]);
    expect(fs.existsSync(f.root)).toBe(false);
  });
  it.each(["", " ", "relative/profile", "/", "/tmp/profile/", "/tmp/../profile", " /tmp/profile", "/tmp/profile\n", "/tmp/profile\0"])("rejects noncanonical root %j without filesystem or app mutation", (value) => {
    const f = fixture(); f.env.MUSTER_PROFILE_ROOT = value; const before = { ...f.env };
    expect(() => f.run()).toThrow("Invalid MUSTER_PROFILE_ROOT");
    expectNoApplicationMutation(f, before); expect(f.calls).toEqual([]); expect(fs.existsSync(f.root)).toBe(false);
  });
  it.each(["missing", "different", "duplicate", "split", "after-terminator"])("requires the exact launch-time switch (%s)", (mode) => {
    const f = fixture();
    if (mode === "missing") f.options.argv = ["electron"];
    if (mode === "different") f.options.argv = ["electron", "--user-data-dir=/other/profile"];
    if (mode === "duplicate") f.options.argv.push(f.options.argv[1]);
    if (mode === "split") f.options.argv = ["electron", "--user-data-dir", f.userData];
    if (mode === "after-terminator") f.options.argv = ["electron", "--", f.options.argv[1]];
    const before = { ...f.env };
    expect(() => f.run()).toThrow("launch with exactly --user-data-dir=");
    expectNoApplicationMutation(f, before); expect(fs.existsSync(f.root)).toBe(false);
  });
  it("computes an absolute Windows profile using the same deterministic contract", () => {
    const root = "C:\\Owned Profile\\Muster";
    const value = resolveProfileConfiguration({ env: { MUSTER_PROFILE_ROOT: root }, argv: [`--user-data-dir=${root}\\user-data`], pathApi: path.win32 });
    expect(value.cwd).toBe(`${root}\\workspace`);
    expect(value.electronPaths.sessionData).toBe(`${root}\\user-data`);
    expect(value.environment.CODEX_HOME).toBe(`${root}\\home\\.codex`);
    expect(() => resolveProfileConfiguration({ env: { MUSTER_PROFILE_ROOT: "C:\\" }, argv: [], pathApi: path.win32 })).toThrow("filesystem root");
  });
});

describe("profile bootstrap with real owned directories and an Electron adapter", () => {
  it("rejects an unapplied Chromium switch before creating paths", () => {
    const f = fixture(); f.app.getPath = () => "/original-user-data"; const before = { ...f.env };
    expect(() => f.run()).toThrow("Electron did not apply");
    expectNoApplicationMutation(f, before); expect(fs.existsSync(f.root)).toBe(false);
  });
  it("rejects setup after app ready before even reading captured paths", () => {
    const f = fixture(); f.app.isReady = () => true; const before = { ...f.env };
    expect(() => f.run()).toThrow("before Electron becomes ready");
    expectNoApplicationMutation(f, before); expect(f.calls).toEqual([]); expect(fs.existsSync(f.root)).toBe(false);
  });
  it("creates the owned layout, sets all Electron paths and overrides old engine roots", () => {
    const f = fixture();
    Object.assign(f.env, { CLAUDE_CONFIG_DIR: "/old-claude", FACTORY_HOME_OVERRIDE: "/old-factory", HERMES_HOME: "/old-hermes", KIMI_CODE_HOME: "/old-kimi", GROK_HOME: "/old-grok", ZDOTDIR: "/old-shell", BASH_ENV: "/old/bashrc", ENV: "/old/rc", appdata: "/old-lowercase", home: "/old-lowercase-home" });
    const config = f.run();
    for (const directory of config.directories) expect(fs.statSync(directory).isDirectory(), directory).toBe(true);
    expect(f.calls).toContainEqual(["setPath", "home", path.join(f.root, "home")]);
    expect(f.calls).toContainEqual(["setPath", "appData", path.join(f.root, "app-data")]);
    expect(f.calls).toContainEqual(["setPath", "userData", f.userData]);
    expect(f.calls).toContainEqual(["setPath", "sessionData", f.userData]);
    expect(f.calls).toContainEqual(["logs", path.join(f.root, "logs")]);
    expect(f.calls).toContainEqual(["setPath", "temp", path.join(f.root, "tmp")]);
    expect(f.calls).toContainEqual(["setPath", "crashDumps", path.join(f.root, "crash-dumps")]);
    expect(f.calls.at(-1)).toEqual(["cwd", path.join(f.root, "workspace")]);
    expect(f.env).toEqual({ TOKEN_FIXTURE: "unchanged-test-value", ...config.environment });
    expect(f.env.OMB_DATA_DIR).toBe(path.join(f.root, "muster"));
    expect(f.env.OMB_COMPANION_DIR).toBe(path.join(f.root, "companion"));
    expect(f.env.MAC_CHROMIUM_TMPDIR).toBe(path.join(f.root, "tmp"));
    expect(f.env.HOME).toBe(path.join(f.root, "home"));
    expect(f.env.FACTORY_HOME_OVERRIDE).toBe(f.env.HOME);
    expect(f.env.CODEX_HOME).toBe(path.join(f.env.HOME, ".codex"));
  });
  it.each(["root", "ancestor", "home", "user-data", "engine-home"])("rejects a linked mapped path (%s) before other directory creation", (mode) => {
    const f = fixture(); const outside = path.join(f.base, "outside"); fs.mkdirSync(outside);
    if (mode === "root") fs.symlinkSync(outside, f.root, "dir");
    else if (mode === "ancestor") {
      const alias = path.join(f.base, "linked-parent"); fs.symlinkSync(outside, alias, "dir");
      f.env.MUSTER_PROFILE_ROOT = path.join(alias, "profile");
      f.options.argv = [`--user-data-dir=${path.join(f.env.MUSTER_PROFILE_ROOT, "user-data")}`];
      f.app.getPath = () => path.join(f.env.MUSTER_PROFILE_ROOT, "user-data");
    } else {
      fs.mkdirSync(f.root);
      const target = mode === "engine-home" ? path.join(f.root, "home", ".codex") : path.join(f.root, mode);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.symlinkSync(outside, target, "dir");
    }
    const before = { ...f.env };
    expect(() => f.run()).toThrow(/linked/); expectNoApplicationMutation(f, before);
    expect(fs.readdirSync(outside)).toEqual([]); expect(fs.existsSync(path.join(f.root, "logs"))).toBe(false);
  });
  it("rejects a mapped directory replaced by an ordinary file", () => {
    const f = fixture(); fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root, "logs"), "preserve me");
    const before = { ...f.env };
    expect(() => f.run()).toThrow(/non-directory/); expectNoApplicationMutation(f, before);
    expect(fs.readFileSync(path.join(f.root, "logs"), "utf8")).toBe("preserve me");
    expect(fs.existsSync(path.join(f.root, "home"))).toBe(false);
  });
  it("rejects unwritable existing directories before any creation", () => {
    const f = fixture(); fs.mkdirSync(f.root); const before = { ...f.env };
    f.options.fileSystem = { ...fs, accessSync(directory, mode) { if (directory === f.root) throw Object.assign(new Error("owned permission failure"), { code: "EACCES" }); fs.accessSync(directory, mode); } };
    expect(() => f.run()).toThrow("owned permission failure"); expectNoApplicationMutation(f, before);
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it.each(["credentials.bin", "config.json", "auth.db", "messages.db-wal", "server.log"])("rejects linked startup-owned %s without modifying its destination", (name) => {
    const f = fixture(); const folder = name === "credentials.bin" ? "user-data" : name === "server.log" ? "logs" : "muster";
    fs.mkdirSync(path.join(f.root, folder), { recursive: true });
    const outside = path.join(f.base, "outside-file"); fs.writeFileSync(outside, "original bytes");
    fs.symlinkSync(outside, path.join(f.root, folder, name));
    const before = { ...f.env };
    expect(() => f.run()).toThrow("startup-owned file is linked"); expectNoApplicationMutation(f, before);
    expect(fs.readFileSync(outside, "utf8")).toBe("original bytes");
    expect(fs.existsSync(path.join(f.root, "workspace"))).toBe(false);
  });
  it("rejects a hardlinked startup-owned file", () => {
    const f = fixture(); fs.mkdirSync(path.join(f.root, "muster"), { recursive: true });
    const outside = path.join(f.base, "outside-db"); fs.writeFileSync(outside, "owned bytes");
    fs.linkSync(outside, path.join(f.root, "muster", "auth.db")); const before = { ...f.env };
    expect(() => f.run()).toThrow("startup-owned file is linked"); expectNoApplicationMutation(f, before);
    expect(fs.readFileSync(outside, "utf8")).toBe("owned bytes");
  });
  it("preserves real workspace dependency links and existing ordinary profile data on restart", () => {
    const f = fixture(); const first = f.run();
    const target = path.join(f.base, "dependency"); fs.mkdirSync(target);
    const modules = path.join(first.cwd, "node_modules"); fs.mkdirSync(modules);
    const linked = path.join(modules, "owned-dependency"); fs.symlinkSync(target, linked, "dir");
    const configFile = path.join(first.environment.OMB_DATA_DIR, "config.json"); fs.writeFileSync(configFile, '{"fixture":true}');
    f.calls.length = 0;
    expect(f.run()).toEqual(first);
    expect(fs.readlinkSync(linked)).toBe(target); expect(fs.readFileSync(configFile, "utf8")).toBe('{"fixture":true}');
  });
  it("does not alter app/environment/cwd if creating an owned directory fails", () => {
    const f = fixture(); const before = { ...f.env };
    f.options.fileSystem = { ...fs, mkdirSync(directory, options) { if (directory === path.join(f.root, "logs")) throw new Error("owned mkdir failed"); return fs.mkdirSync(directory, options); } };
    expect(() => f.run()).toThrow("owned mkdir failed"); expectNoApplicationMutation(f, before);
  });
  it("rejects a mapped link introduced during directory preparation before app changes", () => {
    const f = fixture(); const outside = path.join(f.base, "outside"); fs.mkdirSync(outside); const before = { ...f.env };
    f.options.fileSystem = { ...fs, mkdirSync(directory, options) {
      const result = fs.mkdirSync(directory, options);
      if (directory === path.join(f.root, "home", ".unsloth")) {
        fs.rmdirSync(path.join(f.root, "logs")); fs.symlinkSync(outside, path.join(f.root, "logs"), "dir");
      }
      return result;
    } };
    expect(() => f.run()).toThrow(/linked/); expectNoApplicationMutation(f, before); expect(fs.readdirSync(outside)).toEqual([]);
  });
});
