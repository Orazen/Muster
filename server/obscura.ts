// Obscura (github.com/h4ckf0r0day/obscura, Apache-2.0) — a Rust headless
// browser engine for AI agents: 14 browser_* tools over MCP, CDP server,
// native stealth. Apache-2.0 is compatible with Muster's BSL license.
//
// This module is the declarative mount spec builder: it produces the exact
// command/args/env a cloud VM bootstrap or local MCP config needs to run
// `obscura mcp`. It executes nothing itself — the VM bootstrap runs the
// script, and the MCP layer consumes the mount.
//
// Safety: the only user-influenceable input is the proxy URL, which is
// validated as http(s) with a host — and `--allow-private-network` is
// NEVER set by default (SSRF guard; Obscura blocks private-IP fetches
// unless it is explicitly passed).

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const OBSCURA_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_evaluate",
  "browser_screenshot",
  "browser_pdf",
  "browser_network_requests",
  "browser_console_messages",
  "browser_tabs",
  "browser_wait",
  "browser_scroll",
  "browser_back",
  "browser_close",
] as const;

const proxyUrlSchema = z
  .string()
  .url()
  .refine((url) => /^https?:$/.test(new URL(url).protocol), "proxy must be http(s)");

export interface ObscuraMount {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ObscuraMountOptions {
  mode: "stdio" | "http";
  /** http mode only — the port `obscura mcp --http` listens on. */
  port?: number;
  stealth?: boolean;
  proxy?: string;
  allowPrivateNetwork?: boolean;
}

export function buildObscuraMcpMount(opts: ObscuraMountOptions): ObscuraMount {
  const args = ["mcp"];
  if (opts.mode === "http") {
    args.push("--http", "--port", String(Math.min(65_535, Math.max(1, Math.round(opts.port ?? 8_080)))));
  }
  if (opts.stealth) args.push("--stealth");
  if (opts.proxy) {
    // Throws on a malformed or non-http(s) proxy — the caller sees the
    // error instead of spawning a browser with a bad upstream.
    const validated = proxyUrlSchema.parse(opts.proxy);
    args.push("--proxy", validated);
  }
  if (opts.allowPrivateNetwork) args.push("--allow-private-network");
  return { command: "obscura", args, env: {} };
}

/** Local desktop mount: resolve the user-installed `obscura` binary on the
 * augmented PATH and build the stdio mount for one bot's turn. Returns
 * undefined when the binary is absent — a bot that never installed it
 * must not be advertised 14 tools that cannot spawn. `command` is the
 * resolved absolute path so the MCP spawn never depends on the child's
 * PATH. */
export function resolveLocalObscuraMount(
  findFirst: (name: string) => string | undefined,
): ObscuraMount | undefined {
  const bin = findFirst("obscura");
  if (!bin) return undefined;
  const mount = buildObscuraMcpMount({ mode: "stdio" });
  return { ...mount, command: bin };
}

/** Server-side mount resolution: the augmented PATH first, then the
 * auto-installed binary under <dataDir>/bin (installObscuraLocal's target).
 * Returns undefined when neither exists — same silent-degrade contract as
 * resolveLocalObscuraMount. */
export function resolveObscuraMount(
  dataDir: string,
  findFirst: (name: string) => string | undefined,
): ObscuraMount | undefined {
  const bin = findFirst("obscura") ?? (existsSync(obscuraBinPath(dataDir)) ? obscuraBinPath(dataDir) : undefined);
  if (!bin) return undefined;
  const mount = buildObscuraMcpMount({ mode: "stdio" });
  return { ...mount, command: bin };
}

/** The cloud VM bootstrap: install the release binary over https, verify
 * it runs, no credentials embedded. The caller supplies version + arch. */
export function cloudVmInstallScript(version: string, arch: "x86_64" | "aarch64", build = "stealth"): string {
  // Strip everything except alphanumerics, dots and dashes, then collapse
  // repeated dots — a hostile version string cannot inject shell syntax
  // (no spaces, no `;`, no `$`) or path-travel (`..`).
  const cleanVersion = version.replace(/[^0-9A-Za-z.-]/g, "").replace(/\.{2,}/g, ".").replace(/^-+|-+$/g, "");
  const cleanArch = arch === "aarch64" ? "aarch64" : "x86_64";
  const cleanBuild = build === "render" ? "render" : "stealth";
  const url = `https://github.com/h4ckf0r0day/obscura/releases/download/v${cleanVersion}/obscura-v${cleanVersion}-${cleanArch}-unknown-linux-gnu-${cleanBuild}.tar.gz`;
  return [
    "set -eu",
    `curl -fsSL ${url} -o /tmp/obscura.tar.gz`,
    "mkdir -p /usr/local/bin /tmp/obscura",
    "tar -xzf /tmp/obscura.tar.gz -C /tmp/obscura",
    "install -m 0755 /tmp/obscura/obscura /usr/local/bin/obscura",
    "rm -rf /tmp/obscura /tmp/obscura.tar.gz",
    "obscura --version",
  ].join("\n");
}

/** The release asset matching this machine, or undefined where no official
 * build exists (Windows — the README says extract the .zip manually).
 * URLs are constants pointing at the project's releases; no user input
 * reaches them. */
export function obscuraInstallAsset(
  platform: string = process.platform,
  arch: string = process.arch,
): { url: string; archive: string } | undefined {
  const machine = platform === "darwin" ? "macos" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  if (!machine || !cpu) return undefined;
  const archive = `obscura-${cpu}-${machine}.tar.gz`;
  return {
    archive,
    url: `https://github.com/h4ckf0r0day/obscura/releases/latest/download/${archive}`,
  };
}

/** Where the desktop auto-install puts the binary. Kept inside the data
 * dir so no admin rights are needed and upgrades never touch /usr/local. */
export function obscuraBinPath(dataDir: string): string {
  return join(dataDir, "bin", "obscura");
}

async function runFile(file: string, args: string[], timeoutMs = 15_000): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(-1);
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(-1);
    });
  });
}

let installing: Promise<{ ok: boolean; command?: string; error?: string }> | null = null;

/**
 * One-shot local install: download the official release tarball for this
 * platform, extract, drop the binary into <dataDir>/bin, verify it runs.
 * Concurrent calls share one flight (mirrors resolveChrome's dedupe).
 * Windows has no automated path — returns a not-supported error.
 */
export function installObscuraLocal(
  dataDir: string,
): Promise<{ ok: boolean; command?: string; error?: string }> {
  installing ??= doInstallObscura(dataDir).finally(() => {
    installing = null;
  });
  return installing;
}

async function doInstallObscura(dataDir: string): Promise<{ ok: boolean; command?: string; error?: string }> {
  const asset = obscuraInstallAsset();
  if (!asset) return { ok: false, error: "No automated obscura install for this platform." };
  const tmp = mkdtempSync(join(dataDir, "tmp-obscura-"));
  try {
    const response = await fetch(asset.url, { redirect: "follow" });
    if (!response.ok) return { ok: false, error: `Download failed (HTTP ${response.status}).` };
    const tarball = Buffer.from(await response.arrayBuffer());
    if (tarball.length < 1_000) return { ok: false, error: "Download was truncated." };
    const tarPath = join(tmp, asset.archive);
    writeFileSync(tarPath, tarball);
    const tarCode = await runFile("/usr/bin/tar", ["-xzf", tarPath, "-C", tmp], 120_000);
    if (tarCode !== 0) return { ok: false, error: "Could not extract the release archive." };
    const extracted = readdirSync(tmp, { recursive: true }).find((name) => {
      const file = String(name);
      return file === "obscura" || file.endsWith("/obscura");
    });
    if (!extracted) return { ok: false, error: "The archive did not contain an obscura binary." };
    const dest = obscuraBinPath(dataDir);
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileSync(join(tmp, String(extracted)), dest);
    chmodSync(dest, 0o755);
    const versionCode = await runFile(dest, ["--version"]);
    if (versionCode !== 0) {
      rmSync(dest, { force: true });
      return { ok: false, error: "The installed binary did not run — it may not match this machine." };
    }
    return { ok: true, command: dest };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
