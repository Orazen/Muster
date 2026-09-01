// VM bootstrap — the bundle a Muster cloud computer fetches and runs to
// become a browsing bot: install Obscura from its GitHub release, then write
// the MCP config the bot's MCP layer consumes (mcpServers shape built from
// the declarative mount spec in ./obscura.ts).
//
// This module is pure: it produces strings and JSON objects and executes
// nothing. The VM fetches `script` over https and runs it as root.
//
// Safety constraints baked in below:
// - Downloads are https-only, and the host must sit under the GitHub
//   release hosts. Every private, loopback and reserved IP range is
//   rejected before the allowlist even runs, so a hostile input can never
//   pivot the bootstrap at link-local metadata (169.254.169.254), the VM's
//   own loopback services, or RFC1918 infrastructure. No DNS resolution
//   happens here — parsing only — because the check runs at config-build
//   time, not at fetch time; the VM's own resolver does the final say.
// - The only interpolations into the script are (a) the release URL line
//   produced by cloudVmInstallScript, whose version sanitization we reuse
//   verbatim, and (b) the validated MCP config JSON. No credentials are
//   ever embedded: bootstrap VMs pull install material from a public
//   release, and bot credentials arrive through other channels.

import { z } from "zod";

import { buildObscuraMcpMount, cloudVmInstallScript, type ObscuraMount } from "./obscura.ts";

export const bootstrapInputSchema = z
  .object({
    vmId: z.string().min(1),
    arch: z.enum(["x64", "arm64"]),
    obscuraVersion: z.string().min(1),
    mode: z.enum(["stdio", "http"]),
    // http mode only — where the bot's MCP client reaches `obscura mcp --http`.
    mcpEndpoint: z.string().optional(),
  })
  .check((ctx) => {
    // http mode without an endpoint would produce a mount no client can reach.
    if (ctx.value.mode === "http" && !(ctx.value.mcpEndpoint && ctx.value.mcpEndpoint.length > 0)) {
      ctx.issues.push({ code: "custom", input: ctx.value, path: ["mcpEndpoint"], message: "mcpEndpoint is required when mode is http" });
    }
  });

export type BootstrapInput = z.infer<typeof bootstrapInputSchema>;

/** Discriminated result of validateDownloadHost — `ok:false` carries a
 * human-readable reason for the audit log. */
export type HostValidation = { ok: true; host: string } | { ok: false; reason: string };

// The release artifact lives on these hosts and nowhere else. "Under"
// includes subdomains (e.g. a future objects.<region>.githubusercontent.com
// style split) but requires the dotted suffix, never a bare substring —
// "notgithub.com" must not pass.
const ALLOWED_HOST_SUFFIXES = ["github.com", "objects.githubusercontent.com"] as const;

/** Parse a dotted-quad IPv4 address into octets, decimal only. Leading
 * zeros are rejected because some resolvers read them as octal — "017.0.0.1"
 * must not sneak past a 127.0.0.0/8 mental model. Returns null for anything
 * that is not exactly four plain decimal octets. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value > 255) return null;
    octets.push(value);
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

/** True for every IPv4 range a download must never target: loopback,
 * RFC1918 private, link-local (cloud metadata), CGNAT, benchmarking,
 * multicast, reserved and the unroutable broadcast. */
function isPrivateOrReservedIpv4(o: [number, number, number, number]): boolean {
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254/16 link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, broadcast
  return false;
}

/** Parse an IPv6 literal into its eight 16-bit groups. Accepts the standard
 * "::" elision and a trailing IPv4 tail (::ffff:127.0.0.1). Returns null
 * for anything unparseable. */
function parseIpv6(literal: string): number[] | null {
  let text = literal;
  let v4Tail: [number, number, number, number] | null = null;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    v4Tail = parseIpv4(tail);
    if (!v4Tail) return null;
    const hi = ((v4Tail[0] ?? 0) << 8) | (v4Tail[1] ?? 0);
    const lo = ((v4Tail[2] ?? 0) << 8) | (v4Tail[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  // The elided "::" run contributes `missing` all-zero groups.
  const zeros = Array<string>(halves.length === 2 ? missing : 0).fill("0");
  const groups: number[] = [];
  for (const group of [...left, ...zeros, ...right]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    groups.push(parseInt(group, 16));
  }
  return groups;
}

/** True for loopback (::1), unique-local (fc00::/7), link-local
 * (fe80::/10) and IPv4-mapped forms whose embedded IPv4 is
 * private/reserved — the IPv6 disguises of the ranges above. */
function isPrivateOrReservedIpv6(groups: number[]): boolean {
  const leadingZeros = groups.findIndex((g) => g !== 0);
  const tail = leadingZeros === -1 ? [] : groups.slice(leadingZeros);
  if (tail.length === 1 && tail[0] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d — classify the embedded IPv4.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    const mapped: [number, number, number, number] = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
    return isPrivateOrReservedIpv4(mapped);
  }
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  return false;
}

/** Allowlist check for the host a bootstrap download URL may point at.
 * https-only (the bundle ships binaries — cleartext fetches would let a
 * network attacker swap the payload), IP literals and every private,
 * loopback, link-local or reserved range are rejected with a distinct
 * reason, and only hosts under the GitHub release hosts pass. Parsing
 * only: no DNS resolution happens here. */
export function validateDownloadHost(raw: string): HostValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: `only https is allowed, got ${url.protocol}` };
  }
  let host = url.hostname.toLowerCase();
  let isV6 = false;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
    isV6 = true;
  }
  if (!isV6) {
    const v4 = parseIpv4(host);
    if (v4) {
      if (isPrivateOrReservedIpv4(v4)) {
        return { ok: false, reason: "download host is a private or reserved IP range" };
      }
      return { ok: false, reason: "download host must be a name, not an IP literal" };
    }
  }
  const v6 = parseIpv6(host);
  if (v6) {
    if (isPrivateOrReservedIpv6(v6)) {
      return { ok: false, reason: "download host is a private or reserved IP range" };
    }
    return { ok: false, reason: "download host must be a name, not an IP literal" };
  }
  // hostname "v4-embedded" forms like "127.000.0.1" already fail parseIpv4's
  // leading-zero rule above, so nothing decimal survives to the allowlist.
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "localhost is not an allowed download host" };
  }
  const allowed = ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!allowed) {
    return { ok: false, reason: `host ${host} is not under the allowed release hosts` };
  }
  return { ok: true, host };
}

/** The config object a bot's MCP layer reads — named contract shared by
 * mcpConfigFor and the bootstrap script's embedded JSON. */
export type McpConfig = { mcpServers: { obscura: ObscuraMount } };

/** The JSON object a bot's MCP layer reads — kept separate from the shell
 * script so tests can assert structure without parsing sh. */
export function mcpConfigFor(input: BootstrapInput): McpConfig {
  if (input.mode === "http") {
    // The schema guarantees mcpEndpoint for http mode; derive the listen
    // port from it so the mount and the bot's client URL agree.
    const endpoint = new URL(input.mcpEndpoint ?? "");
    const port = endpoint.port ? Number(endpoint.port) : 8080;
    return { mcpServers: { obscura: buildObscuraMcpMount({ mode: "http", port }) } };
  }
  return { mcpServers: { obscura: buildObscuraMcpMount({ mode: "stdio" }) } };
}

const BOOTSTRAP_CONFIG_PATH = "/etc/muster/mcp.json";

/** Build the full bootstrap bundle. Returns the shell script a VM runs as
 * root plus the file name it should be fetched under. Reuses
 * cloudVmInstallScript's version sanitization by lifting its release URL
 * line — the hostile-input surface (version, arch) never reaches the shell
 * unsanitized, and the config JSON is produced by mcpConfigFor from
 * schema-validated input only. */
export function buildBootstrapBundle(
  raw: z.input<typeof bootstrapInputSchema>,
): { ok: true; bundle: { fileName: string; script: string } } | { ok: false; reason: string } {
  const parsed = bootstrapInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
  }
  const input = parsed.data;

  const arch = input.arch === "arm64" ? "aarch64" : "x86_64";
  // cloudVmInstallScript owns version sanitization; reuse its output rather
  // than re-implementing the charset rules here.
  const installScript = cloudVmInstallScript(input.obscuraVersion, arch);
  const urlLine = installScript.split("\n").find((line) => line.includes("releases/download"));
  if (!urlLine) {
    return { ok: false, reason: "install script did not yield a release URL" };
  }

  const config = mcpConfigFor(input);
  const configJson = JSON.stringify(config, null, 2);

  const script = [
    "#!/bin/sh",
    `# Muster VM bootstrap for Obscura (${arch}, ${input.mode} mode).`,
    "# Installs the release binary over https and writes the MCP config.",
    "# No credentials are embedded here — bot credentials arrive separately.",
    "",
    "set -euo pipefail",
    "",
    "# The bootstrap touches /usr/local/bin and /etc/muster: root only, or",
    "# re-exec through sudo when the caller is a sudo-capable admin.",
    'if [ "$(id -u)" -ne 0 ]; then',
    '  if ! command -v sudo >/dev/null 2>&1; then',
    '    echo "obscura-bootstrap: must run as root or with sudo available" >&2',
    "    exit 1",
    "  fi",
    '  exec sudo -E /bin/sh "$0"',
    "fi",
    "",
    urlLine,
    "mkdir -p /usr/local/bin /tmp/obscura",
    "tar -xzf /tmp/obscura.tar.gz -C /tmp/obscura",
    "install -m 0755 /tmp/obscura/obscura /usr/local/bin/obscura",
    "rm -rf /tmp/obscura /tmp/obscura.tar.gz",
    "obscura --version",
    "",
    `# MCP config written 0600 (umask 077 below): the mount spec names the`,
    `# binary the bot will exec, and the file sits beside other sensitive`,
    `# state under /etc/muster.`,
    "umask 077",
    "mkdir -p /etc/muster",
    `cat > ${BOOTSTRAP_CONFIG_PATH} <<'MCP_CONFIG_EOF'`,
    configJson,
    "MCP_CONFIG_EOF",
    `chmod 0600 ${BOOTSTRAP_CONFIG_PATH}`,
    "",
    'echo "READY obscura-bootstrap"',
    "",
  ].join("\n");

  return { ok: true, bundle: { fileName: "muster-obscura-bootstrap.sh", script } };
}
