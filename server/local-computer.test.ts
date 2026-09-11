import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readCuaConnection } from "./local-computer.ts";
import type { JsonValue } from "./schema.ts";

afterEach(() => vi.unstubAllEnvs());

function isolatedPaths() {
  const home = mkdtempSync(join(process.env.HOME!, "local-computer-descriptor-"));
  return { home, userData: join(home, "desktop-profile") };
}

function descriptor(directory: string, value: JsonValue) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "cua-connection.json"), JSON.stringify(value));
}

const legacyDescriptor = { mode: "standalone", mcpCommand: "/legacy/cua-driver", mcpArgs: ["mcp"] };

describe("local computer descriptor", () => {
  it("fails closed on Linux even when a valid-looking descriptor exists", () => {
    const userData = join(process.env.HOME!, "linux-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "/tmp/cua-driver",
        mcpArgs: ["mcp", "--embedded"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
    );

    expect(readCuaConnection({ platform: "linux", userData })).toBeNull();
  });

  it("reads and validates an exact platform userData descriptor", () => {
    const userData = join(process.env.HOME!, "windows-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "C:\\cua-driver.exe",
        mcpArgs: ["mcp"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
    );

    expect(readCuaConnection({ platform: "win32", userData })).toEqual({
      command: "C:\\cua-driver.exe",
      args: ["mcp"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
    });
  });

  it("rejects malformed argv and environment values", () => {
    const userData = join(process.env.HOME!, "invalid-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({ mode: "embedded", mcpCommand: "cua-driver", mcpArgs: "mcp" }),
    );

    expect(readCuaConnection({ platform: "win32", userData })).toBeNull();
  });

  it("rejects an array environment descriptor", () => {
    const userData = join(process.env.HOME!, "array-environment-user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "cua-driver",
        mcpEnv: ["CUA_DRIVER_EMBEDDED=1"],
      }),
    );

    expect(readCuaConnection({ platform: "win32", userData })).toBeNull();
  });

  it.each(["embedded", "standalone"])("uses the exact profile's %s connection before any legacy descriptor", (mode) => {
    const { home, userData } = isolatedPaths();
    descriptor(join(home, "Library", "Application Support", "Muster"), legacyDescriptor);
    descriptor(userData, {
      mode,
      mcpCommand: "/owned profile/cua-driver",
      mcpArgs: ["mcp", "--socket", "/owned profile/cua.sock"],
      mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
    });

    expect(readCuaConnection({ platform: "darwin", home, userData })).toEqual({
      command: "/owned profile/cua-driver",
      args: ["mcp", "--socket", "/owned profile/cua.sock"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
    });
  });

  it.each([
    ["missing", undefined],
    ["unavailable", { ...legacyDescriptor, mode: "unavailable" }],
    ["off", { ...legacyDescriptor, mode: "off" }],
    ["unknown mode", { ...legacyDescriptor, mode: "ready" }],
    ["missing mode", { mcpCommand: "cua-driver" }],
    ["empty command", { ...legacyDescriptor, mcpCommand: "" }],
    ["whitespace command", { ...legacyDescriptor, mcpCommand: " \t " }],
    ["malformed arguments", { ...legacyDescriptor, mcpArgs: [1] }],
    ["malformed environment", { ...legacyDescriptor, mcpEnv: { TOKEN: 42 } }],
    ["null", null],
    ["array", []],
  ])("does not use a legacy connection when the explicit profile is %s", (_label, value) => {
    const { home, userData } = isolatedPaths();
    descriptor(join(home, "Library", "Application Support", "Muster"), legacyDescriptor);
    if (value !== undefined) descriptor(userData, value);

    expect(readCuaConnection({ platform: "darwin", home, userData })).toBeNull();
  });

  it("does not use a legacy connection when the exact descriptor is corrupt JSON", () => {
    const { home, userData } = isolatedPaths();
    descriptor(join(home, "Library", "Application Support", "Muster"), legacyDescriptor);
    mkdirSync(userData);
    writeFileSync(join(userData, "cua-connection.json"), "{broken");

    expect(readCuaConnection({ platform: "darwin", home, userData })).toBeNull();
  });

  it.each(["Muster", "muster", "OpenGrokBot", "opengrokbot"])("keeps legacy %s discovery when no profile is supplied", (directory) => {
    vi.stubEnv("OMB_USER_DATA", undefined);
    const { home } = isolatedPaths();
    descriptor(join(home, "Library", "Application Support", directory), legacyDescriptor);

    expect(readCuaConnection({ platform: "darwin", home })).toEqual({
      command: legacyDescriptor.mcpCommand,
      args: ["mcp"],
      env: {},
    });
  });

  it("keeps legacy discovery for an empty profile setting", () => {
    const { home } = isolatedPaths();
    descriptor(join(home, "Library", "Application Support", "Muster"), legacyDescriptor);

    expect(readCuaConnection({ platform: "darwin", home, userData: "" })?.command).toBe(legacyDescriptor.mcpCommand);
  });

  it("treats the packaged OMB_USER_DATA environment as an authoritative profile", () => {
    const { home, userData } = isolatedPaths();
    vi.stubEnv("OMB_USER_DATA", userData);
    descriptor(join(home, "Library", "Application Support", "Muster"), legacyDescriptor);
    expect(readCuaConnection({ platform: "darwin", home })).toBeNull();

    descriptor(userData, { mode: "embedded", mcpCommand: "/owned/cua-driver" });
    expect(readCuaConnection({ platform: "darwin", home })).toEqual({
      command: "/owned/cua-driver", args: ["mcp"], env: {},
    });
  });
});
