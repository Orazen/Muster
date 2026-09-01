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
