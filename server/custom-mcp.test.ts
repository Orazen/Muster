// custom-mcp.ts tests: command-safety validation, registry invariants, the
// redacted-env wire round trip, disk persistence, and a real tools/list
// against a throwaway stdio fixture server (a mock would hide exactly the
// handshake behavior the test-connection button depends on).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  customMcpForBot,
  mergeWireEnv,
  parseAndValidateCustomMcp,
  toWire,
  upsertCustomMcpServer,
  validateMcpCommand,
  type CustomMcpServer,
} from "./custom-mcp.ts";
import { connectMcpStdio } from "./mcp-client.ts";

const server = (over: Partial<CustomMcpServer>): CustomMcpServer => ({
  id: "srv-1",
  name: "files",
  command: "/usr/local/bin/files-server",
  args: [],
  env: {},
  enabled: true,
  ...over,
});

describe("validateMcpCommand", () => {
  it("accepts an absolute path, even with spaces", () => {
    expect(() => validateMcpCommand("/usr/local/bin/my server")).not.toThrow();
    expect(() => validateMcpCommand("C:\\tools\\server.exe")).not.toThrow();
  });

  it("accepts a bare name that PATH lookup can resolve", () => {
    expect(() => validateMcpCommand("npx")).not.toThrow();
  });

  it("rejects relative paths — they would resolve against whatever cwd a turn runs in", () => {
    expect(() => validateMcpCommand("./serve")).toThrow("relative path");
    expect(() => validateMcpCommand("bin/serve")).toThrow("relative path");
  });

  it("rejects anything that is not a plain bare name", () => {
    // the slash makes this a rejected relative path before metachars even matter
    expect(() => validateMcpCommand("echo hi && rm -rf /")).toThrow(/relative path/);
    expect(() => validateMcpCommand("foo;bar")).toThrow(/plain command name/);
    expect(() => validateMcpCommand("")).toThrow("command is required");
  });

  it("rejects directory names and control characters", () => {
    expect(() => validateMcpCommand("..")).toThrow("directory");
    expect(() => validateMcpCommand("node\n--flag")).toThrow("control characters");
  });
});

describe("parseAndValidateCustomMcp", () => {
  it("rejects names that would break driver tool prefixes", () => {
    expect(() => parseAndValidateCustomMcp({ name: "has spaces", command: "npx", args: [], env: {} })).toThrow("name");
  });

  it("rejects env keys that are not valid variable names", () => {
    expect(() =>
      parseAndValidateCustomMcp({ name: "ok-name", command: "npx", args: [], env: { "BAD KEY": "v" } }),
  ).toThrow(/BAD KEY/);
  });

  it("rejects non-string args at the boundary", () => {
    expect(() => parseAndValidateCustomMcp({ name: "ok-name", command: "npx", args: [42], env: {} })).toThrow(/args/);
  });
});

describe("upsertCustomMcpServer", () => {
  it("refuses two servers with the same name — one would silently win", () => {
    const result = upsertCustomMcpServer([server({})], server({ id: "srv-2", command: "npx" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('named "files"');
  });

  it("replaces by id and trims the fields it stores", () => {
    const result = upsertCustomMcpServer(
      [server({ command: "  /old/bin  ", args: ["x"] })],
      server({ command: "  /new/bin  ", args: [] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toHaveLength(1);
      expect(result.next[0]!.command).toBe("/new/bin");
      expect(result.next[0]!.args).toEqual([]);
    }
  });
});

describe("env redaction round trip", () => {
  it("toWire drops values; mergeWireEnv restores true-marked keys from storage", () => {
    const wire = toWire(server({ env: { API_TOKEN: "sekret", REGION: "eu" } }));
    expect(wire.env).toEqual({ API_TOKEN: true, REGION: true });
    const merged = mergeWireEnv({ API_TOKEN: true, REGION: "ap" }, { API_TOKEN: "sekret", REGION: "eu" });
    expect(merged).toEqual({ API_TOKEN: "sekret", REGION: "ap" });
  });

  it("a true for a key with nothing stored degrades to empty, not garbage", () => {
    expect(mergeWireEnv({ GHOST: true }, {})).toEqual({ GHOST: "" });
  });
});

describe("customMcpForBot", () => {
  it("mounts enabled servers globally and filters bot-scoped or disabled ones out", () => {
    const list = [
      server({ id: "a", name: "global_one", command: "/bin/g1" }),
      server({ id: "b", name: "scoped", command: "/bin/s", bots: ["bot-9"] }),
      server({ id: "c", name: "off", command: "/bin/off", enabled: false }),
    ];
    const forEveryone = customMcpForBot(list, "bot-1");
    expect(forEveryone.map((s) => s.name)).toEqual(["global_one"]);
    const forNine = customMcpForBot(list, "bot-9");
    expect(forNine.map((s) => s.name)).toEqual(["global_one", "scoped"]);
    // copies, never live references into the registry
    forNine[0]!.args.push("mutated");
    expect(list[0]!.args).toEqual([]);
  });
});

describe("persistence round trip through config.json", () => {
  it("saveConfig writes the array wholesale and loadConfig reads it back identically", async () => {
    process.env.OMB_DATA_DIR = mkdtempSync(join(tmpdir(), "muster-mcp-cfg-"));
    const { saveConfig, loadConfig } = await import("./config.ts");
    const entry = server({
      id: "srv-rt",
      name: "roundtrip",
      command: "/opt/tools/server",
      args: ["--root", "/tmp"],
      env: { TOKEN: "t-abc" },
      bots: ["bot-1", "bot-2"],
    });
    saveConfig({ mcpServers: [entry] });
    // a second save must REPLACE, not merge with, the first array
    const second = { ...entry, id: "srv-rt2", name: "second" };
    saveConfig({ mcpServers: [second] });
    const loaded = loadConfig();
    expect(loaded.mcpServers).toHaveLength(1);
    expect(loaded.mcpServers?.[0]).toEqual(second);
    rmSync(process.env.OMB_DATA_DIR, { recursive: true, force: true });
  });
});

// A real stdio MCP server in ~20 lines of CommonJS: proves connectMcpStdio's
// handshake AND that the env we pass actually reaches the spawned process
// (the fixture echoes its FIXTURE_TOKEN into a tool description).
const FIXTURE_SERVER = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\\n");
  } else if (msg.method === "notifications/initialized") {
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "greet", description: "token:" + (process.env.FIXTURE_TOKEN || "missing"), inputSchema: { type: "object" } }
    ] } }) + "\\n");
  }
});
`;

describe("test-connection path against a fixture server", () => {
  it("spawns via absolute node path, completes the handshake, lists tools with env delivered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muster-mcp-fixture-"));
    const script = join(dir, "fixture.cjs");
    writeFileSync(script, FIXTURE_SERVER);
    // SAFETY: process.execPath is this Node binary's absolute path — the same
    // spawn contract the drivers themselves use for proxies.
    const client = await connectMcpStdio(process.execPath, [script], { FIXTURE_TOKEN: "tok-123" });
    try {
      expect(client.tools).toHaveLength(1);
      expect(client.tools[0]!.name).toBe("greet");
      expect(client.tools[0]!.description).toBe("token:tok-123");
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects before spawning when the command fails safety validation", () => {
    expect(() => validateMcpCommand("./relative-server")).toThrow("relative path");
  });
});
