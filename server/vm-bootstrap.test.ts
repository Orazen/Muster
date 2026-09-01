import { describe, expect, it } from "vitest";

import {
  bootstrapInputSchema,
  buildBootstrapBundle,
  mcpConfigFor,
  validateDownloadHost,
} from "./vm-bootstrap.ts";

describe("validateDownloadHost", () => {
  it("accepts the GitHub release hosts", () => {
    expect(validateDownloadHost("https://github.com/h4ckf0r0day/obscura/releases")).toEqual({
      ok: true,
      host: "github.com",
    });
    expect(
      validateDownloadHost("https://objects.githubusercontent.com/some/object.tar.gz"),
    ).toEqual({ ok: true, host: "objects.githubusercontent.com" });
  });

  it("rejects http:// — downloads must be https-only", () => {
    const result = validateDownloadHost("http://github.com/h4ckf0r0day/obscura/releases");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("https");
  });

  it("rejects localhost and loopback IPv4", () => {
    expect(validateDownloadHost("https://localhost/obscura.tar.gz").ok).toBe(false);
    expect(validateDownloadHost("https://127.0.0.1/obscura.tar.gz").ok).toBe(false);
    expect(validateDownloadHost("https://127.8.8.8/obscura.tar.gz").ok).toBe(false);
  });

  it("rejects RFC1918 and link-local (metadata) targets", () => {
    expect(validateDownloadHost("https://10.1.2.3/obscura.tar.gz").ok).toBe(false);
    expect(validateDownloadHost("https://192.168.1.5/obscura.tar.gz").ok).toBe(false);
    expect(validateDownloadHost("https://172.16.0.9/obscura.tar.gz").ok).toBe(false);
    expect(validateDownloadHost("https://169.254.169.254/latest/meta-data").ok).toBe(false);
  });

  it("rejects IPv6 loopback and unique-local", () => {
    expect(validateDownloadHost("https://[::1]/obscura.tar.gz").ok).toBe(false);
    expect(validateDownloadHost("https://[fc00::1]/obscura.tar.gz").ok).toBe(false);
  });

  it("rejects a bogus host outside the allowlist", () => {
    const result = validateDownloadHost("https://evil.example.com/obscura.tar.gz");
    expect(result.ok).toBe(false);
    // A suffix-impostor must not ride a substring match.
    expect(validateDownloadHost("https://notgithub.com/obscura.tar.gz").ok).toBe(false);
  });
});

describe("bootstrapInputSchema", () => {
  it("accepts a valid stdio input", () => {
    expect(
      bootstrapInputSchema.safeParse({
        vmId: "vm-123",
        arch: "x64",
        obscuraVersion: "1.2.3",
        mode: "stdio",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty vmId", () => {
    expect(
      bootstrapInputSchema.safeParse({ vmId: "", arch: "arm64", obscuraVersion: "1.2.3", mode: "stdio" }).success,
    ).toBe(false);
  });

  it("requires mcpEndpoint when mode is http", () => {
    const missing = bootstrapInputSchema.safeParse({
      vmId: "vm-123",
      arch: "arm64",
      obscuraVersion: "1.2.3",
      mode: "http",
    });
    expect(missing.success).toBe(false);
    const present = bootstrapInputSchema.safeParse({
      vmId: "vm-123",
      arch: "arm64",
      obscuraVersion: "1.2.3",
      mode: "http",
      mcpEndpoint: "http://127.0.0.1:8080/mcp",
    });
    expect(present.success).toBe(true);
  });
});

describe("mcpConfigFor", () => {
  it("stdio mode: obscura mount under mcpServers", () => {
    const config = mcpConfigFor({
      vmId: "vm-123",
      arch: "x64",
      obscuraVersion: "1.2.3",
      mode: "stdio",
    });
    expect(config.mcpServers.obscura.command).toBe("obscura");
    expect(config.mcpServers.obscura.args).toEqual(["mcp"]);
    expect(config.mcpServers.obscura.env).toEqual({});
  });

  it("http mode: carries the endpoint port", () => {
    const config = mcpConfigFor({
      vmId: "vm-123",
      arch: "x64",
      obscuraVersion: "1.2.3",
      mode: "http",
      mcpEndpoint: "http://127.0.0.1:9090/mcp",
    });
    expect(config.mcpServers.obscura.args).toEqual(["mcp", "--http", "--port", "9090"]);
  });
});

describe("buildBootstrapBundle", () => {
  const stdioInput = {
    vmId: "vm-123",
    arch: "x64" as const,
    obscuraVersion: "1.2.3",
    mode: "stdio" as const,
  };

  it("rejects invalid input with a reason", () => {
    const result = buildBootstrapBundle({ ...stdioInput, mode: "http" });
    expect(result.ok).toBe(false);
  });

  it("produces a hardened POSIX sh script with a READY marker", () => {
    const result = buildBootstrapBundle(stdioInput);
    if (!result.ok) throw new Error("expected ok bundle");
    const { script } = result.bundle;
    expect(script.startsWith("#!/bin/sh")).toBe(true);
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("id -u");
    expect(script.split("\n").at(-2)).toBe('echo "READY obscura-bootstrap"');
    // No credentials ever ride the bootstrap.
    expect(script).not.toMatch(/token|secret|password|api[_-]?key/i);
  });

  it("interpolates only the sanitized release URL and the config JSON", () => {
    const hostile = buildBootstrapBundle({
      vmId: "vm-123",
      arch: "arm64",
      // Same hostile version obscura.test.ts uses: no shell syntax, no path
      // travel may survive into the URL line.
      obscuraVersion: "1..2;rm -rf /",
      mode: "stdio",
    });
    if (!hostile.ok) throw new Error("expected ok bundle");
    const urlLines = hostile.bundle.script.split("\n").filter((line) => line.includes("https://"));
    expect(urlLines.length).toBeGreaterThan(0);
    for (const line of urlLines) {
      expect(line).not.toContain("..");
      expect(line).not.toContain(";");
      expect(line).toContain("https://github.com/h4ckf0r0day/obscura/releases");
    }
    // Writes the MCP config 0600.
    expect(hostile.bundle.script).toContain("chmod 0600 /etc/muster/mcp.json");
  });

  it("embeds the mcpServers config JSON for the requested mode", () => {
    const result = buildBootstrapBundle({
      ...stdioInput,
      mode: "http",
      mcpEndpoint: "http://127.0.0.1:8080/mcp",
    });
    if (!result.ok) throw new Error("expected ok bundle");
    expect(result.bundle.script).toContain('"mcpServers"');
    expect(result.bundle.script).toContain('"--http"');
  });
});
