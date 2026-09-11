import { describe, expect, it } from "vitest";

import {
  buildObscuraMcpMount,
  cloudVmInstallScript,
  OBSCURA_TOOLS,
} from "./obscura.ts";

describe("buildObscuraMcpMount", () => {
  it("stdio mode: mcp with no extra flags", () => {
    const mount = buildObscuraMcpMount({ mode: "stdio" });
    expect(mount.command).toBe("obscura");
    expect(mount.args).toEqual(["mcp"]);
  });

  it("http mode carries the port", () => {
    const mount = buildObscuraMcpMount({ mode: "http", port: 9_090 });
    expect(mount.args).toEqual(["mcp", "--http", "--port", "9090"]);
  });

  it("gates optional flags", () => {
    const stealth = buildObscuraMcpMount({ mode: "stdio", stealth: true });
    expect(stealth.args).toContain("--stealth");
    const plain = buildObscuraMcpMount({ mode: "stdio" });
    expect(plain.args).not.toContain("--stealth");
  });

  it("accepts an http(s) proxy, rejects anything else", () => {
    const withProxy = buildObscuraMcpMount({ mode: "stdio", proxy: "http://proxy.local:3128" });
    expect(withProxy.args).toContain("--proxy");
    expect(() => buildObscuraMcpMount({ mode: "stdio", proxy: "ftp://x" })).toThrow();
    expect(() => buildObscuraMcpMount({ mode: "stdio", proxy: "not a url" })).toThrow();
  });

  it("never sets allow-private-network unless explicitly asked", () => {
    expect(buildObscuraMcpMount({ mode: "stdio" }).args).not.toContain("--allow-private-network");
    const allowed = buildObscuraMcpMount({ mode: "stdio", allowPrivateNetwork: true });
    expect(allowed.args).toContain("--allow-private-network");
  });
});

describe("cloudVmInstallScript", () => {
  it("downloads over https from the pinned release, no secrets", () => {
    const script = cloudVmInstallScript("1.2.3", "x86_64");
    expect(script).toContain("https://github.com/h4ckf0r0day/obscura/releases/download/v1.2.3/");
    expect(script).not.toMatch(/token|secret|password/i);
    expect(script).toContain("obscura --version");
  });

  it("sanitizes version and pins the build variant", () => {
    const script = cloudVmInstallScript("1..2;rm -rf /", "aarch64", "render");
    // The security property: the version interpolation carries no shell
    // syntax or path travel, so the URL line is inert.
    const urlLine = script.split("\n").find((l) => l.includes("releases/download")) ?? "";
    expect(urlLine).not.toContain(";");
    expect(urlLine).not.toContain("..");
    expect(urlLine).toContain("aarch64");
    expect(script).toContain("render");
  });
});

describe("OBSCURA_TOOLS", () => {
  it("names the 14 browser tools", () => {
    expect(OBSCURA_TOOLS).toHaveLength(14);
    expect(OBSCURA_TOOLS.every((t) => t.startsWith("browser_"))).toBe(true);
  });
});

describe("resolveLocalObscuraMount", () => {
  it("resolves the first candidate into the mount command", async () => {
    const { resolveLocalObscuraMount } = await import("./obscura.ts");
    // The finder contract: return the FIRST candidate's path (the caller
    // does findCliCandidates(name)[0]), or undefined when absent.
    const mount = resolveLocalObscuraMount((name) => (name === "obscura" ? "/usr/local/bin/obscura" : undefined));
    expect(mount).toBeDefined();
    expect(mount!.command).toBe("/usr/local/bin/obscura");
    expect(mount!.args).toEqual(["mcp"]);
    expect(mount!.env).toEqual({});
  });

  it("returns undefined when the binary is absent — no tools that cannot spawn", async () => {
    const { resolveLocalObscuraMount } = await import("./obscura.ts");
    expect(resolveLocalObscuraMount(() => undefined)).toBeUndefined();
  });
});

describe("obscuraInstallAsset", () => {
  it("maps this machine's platform/arch onto the official release asset", async () => {
    const { obscuraInstallAsset } = await import("./obscura.ts");
    const macArm = obscuraInstallAsset("darwin", "arm64");
    expect(macArm).toEqual({
      archive: "obscura-aarch64-macos.tar.gz",
      url: "https://github.com/h4ckf0r0day/obscura/releases/latest/download/obscura-aarch64-macos.tar.gz",
    });
    expect(obscuraInstallAsset("linux", "x64")!.archive).toBe("obscura-x86_64-linux.tar.gz");
  });

  it("has no automated path for Windows", async () => {
    const { obscuraInstallAsset } = await import("./obscura.ts");
    expect(obscuraInstallAsset("win32", "x64")).toBeUndefined();
  });
});

describe("resolveObscuraMount", () => {
  it("prefers the PATH candidate over the auto-installed binary", async () => {
    const { resolveObscuraMount } = await import("./obscura.ts");
    const mount = resolveObscuraMount("/data", (name) => (name === "obscura" ? "/usr/local/bin/obscura" : undefined));
    expect(mount!.command).toBe("/usr/local/bin/obscura");
  });

  it("falls back to the auto-installed binary under <dataDir>/bin", async () => {
    const { resolveObscuraMount } = await import("./obscura.ts");
    const { mkdtempSync, writeFileSync, mkdirSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "obscura-mount-"));
    mkdirSync(join(dir, "bin"), { recursive: true });
    const bin = join(dir, "bin", "obscura");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const mount = resolveObscuraMount(dir, () => undefined);
    expect(mount!.command).toBe(bin);
  });

  it("returns undefined when neither PATH nor the data dir has a binary", async () => {
    const { resolveObscuraMount } = await import("./obscura.ts");
    expect(resolveObscuraMount("/nonexistent-omb-data", () => undefined)).toBeUndefined();
  });
});
