import { z } from "zod";
import type { JsonValue } from "./contracts";

export const DEFAULT_PORT = 8810;
export type ConnectionScheme = "http" | "https";
export interface ParsedAddress { host: string; port: number; scheme: ConnectionScheme }
export interface Connection { host: string; port: number; token: string; scheme?: ConnectionScheme }

const hostSchema = z.union([z.ipv4(), z.ipv6(), z.hostname()]);
const portSchema = z.number().int().min(1).max(65535);
const connectionSchema = z.object({
  host: hostSchema, port: portSchema, token: z.string().min(1).regex(/^\S+$/),
  scheme: z.enum(["http", "https"]).optional(),
});
export function parseConnection(value: JsonValue): Connection | null {
  const parsed = connectionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseAddress(input: string): ParsedAddress {
  const value = input.trim();
  const explicit = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  const scheme = explicit ? explicit[1].toLowerCase() : "http";
  if (scheme !== "http" && scheme !== "https") throw new Error("Use an HTTP or HTTPS server address");
  const authority = (explicit ? value.slice(explicit[0].length) : value).replace(/\/+$/, "");
  // Credentials, paths, query strings and fragments are not server addresses.
  const match = /^(\[[0-9a-f:.]+\]|[^\s/:?#@\\]+)(?::([0-9]+))?$/i.exec(authority);
  if (!match) throw new Error("Enter a server host and optional port; put IPv6 addresses in brackets");
  const port = match[2] ? Number(match[2]) : scheme === "https" ? 443 : DEFAULT_PORT;
  if (!portSchema.safeParse(port).success) throw new Error("Port must be an integer from 1 to 65535");
  let host: string;
  try {
    const url = new URL(`${scheme}://${match[1]}:${port}`);
    host = url.hostname.replace(/^\[|\]$/g, "");
  } catch { throw new Error("Enter a valid server host"); }
  if (!hostSchema.safeParse(host).success) throw new Error("Enter a valid server host");
  return { host, port, scheme };
}

export function connectionOrigin(address: Pick<Connection, "host" | "port" | "scheme">): string {
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `${address.scheme ?? "http"}://${host}:${address.port}`;
}
