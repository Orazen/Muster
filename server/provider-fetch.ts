import { lookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import { isPrivateOrReservedIpv4, isPrivateOrReservedIpv6, parseIpv4, parseIpv6 } from "./vm-bootstrap.ts";

// Match auth's startup boundary without importing auth (and opening its DB).
export const HOSTED_PROVIDER_POLICY =
  (process.env.OMB_HOST ?? "127.0.0.1") !== "127.0.0.1" || Boolean(process.env.OMB_PUBLIC_HOST);

type ProviderResolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

// DOM RequestInit omits Node's dispatcher extension. Preserve the Node type
// when available while allowing the shared server helper to typecheck in E2E.
type ProviderRequestInit = RequestInit & { dispatcher?: unknown };

class ProviderPolicyError extends Error {
  readonly code = "ERR_PROVIDER_ENDPOINT";
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** Only ordinary public IPs may back a hosted, user-supplied provider.
 * Reject transition/mapped IPv6 rather than letting embedded IPv4 bypass
 * the IPv4 policy. Hostnames themselves must go through the socket lookup. */
export function isPublicProviderAddress(address: string): boolean {
  const host = normalizedHost(address);
  const family = isIP(host);
  if (family === 4) {
    const octets = parseIpv4(host);
    if (!octets || isPrivateOrReservedIpv4(octets)) return false;
    const [a, b, c] = octets;
    // Protocol assignments, documentation and deprecated 6to4 relay space.
    if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family !== 6 || host.includes("%")) return false;
  const groups = parseIpv6(host);
  if (!groups || isPrivateOrReservedIpv6(groups)) return false;
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  // Global unicast only: excludes unspecified, mapped, NAT64, local and multicast.
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false;
  if (first === 0x2002) return false; // 6to4 can embed a private IPv4 address.
  if (first === 0x3fff && (second & 0xf000) === 0) return false; // Documentation /20.
  return true;
}

/** Resolve at connection time, reject the whole answer if any address is
 * unsafe, then give those exact IPs to the socket. No check-then-resolve gap.
 * Even a caller requesting only IPv4 must not hide an unsafe AAAA answer. */
export function createPublicProviderLookup(resolver: ProviderResolver = lookup): LookupFunction {
  return (hostname, options, callback) => {
    let settled = false;
    const finish: Parameters<LookupFunction>[2] = (error, address, family) => {
      if (settled) return;
      settled = true;
      callback(error, address, family);
    };
    const deny = () => finish(new ProviderPolicyError("Hosted custom providers require a public network address"), "", 0);
    const host = normalizedHost(hostname);
    if (host === "localhost" || host.endsWith(".localhost")) return deny();
    try {
      resolver(host, { all: true, verbatim: true, family: 0 }, (error, addresses) => {
        if (error) {
          finish(new ProviderPolicyError("Provider hostname could not be resolved"), "", 0);
          return;
        }
        if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((record) =>
          (record.family !== 4 && record.family !== 6) || isIP(record.address) !== record.family || !isPublicProviderAddress(record.address),
        )) return deny();
        const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family ?? 0;
        const approved = addresses.filter((record) => family === 0 || record.family === family)
          .map((record) => ({ address: record.address, family: record.family }));
        const first = approved[0];
        if (!first) return deny();
        if (options.all) finish(null, approved);
        else finish(null, first.address, first.family);
      });
    } catch {
      if (!settled) finish(new ProviderPolicyError("Provider hostname could not be resolved"), "", 0);
    }
  };
}

let publicAgent: Agent | undefined;

/** One transport for model listing, chat, tools and streaming. Trusted
 * operator-configured built-ins may use local engines on a hosted machine;
 * tenant custom endpoints always use the public-address connection policy.
 * Desktop custom endpoints remain local-capable. No mode follows redirects. */
export async function providerFetch(url: string | URL, init: RequestInit, customEndpoint = true): Promise<Response> {
  let target: URL;
  try { target = new URL(url); }
  catch { throw new ProviderPolicyError("Provider endpoint must be a valid HTTP or HTTPS URL"); }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new ProviderPolicyError("Provider endpoint must use HTTP or HTTPS");
  }
  if (target.username || target.password) throw new ProviderPolicyError("Provider endpoint must not contain URL credentials");
  const enforcePublic = HOSTED_PROVIDER_POLICY && customEndpoint;
  if (enforcePublic) {
    const host = normalizedHost(target.hostname);
    // IP literals bypass net.lookup; check them before handing off to fetch.
    if (host === "localhost" || host.endsWith(".localhost") || (isIP(host) !== 0 && !isPublicProviderAddress(host))) {
      throw new ProviderPolicyError("Hosted custom providers require a public network address");
    }
    publicAgent ??= new Agent({ connect: { lookup: createPublicProviderLookup() } });
  }
  // The private dispatcher cannot be replaced by caller input or the global
  // dispatcher. Keep native fetch for streaming, aborts and existing mocks.
  const request: ProviderRequestInit = {
    ...init,
    redirect: "error",
    // SAFETY: Node's ambient fetch types use undici-types 8, while this
    // dispatcher is pinned to Undici 7. Their optional handler signatures
    // differ; real socket regressions exercise the pinned Node runtime's
    // Agent/native-fetch boundary. Keep the adaptation on this field.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    dispatcher: (enforcePublic ? publicAgent : undefined) as unknown as ProviderRequestInit["dispatcher"],
  };
  try { return await fetch(url instanceof URL ? target : target.href, request); }
  catch (error) {
    // Undici wraps lookup errors; return the policy message without leaking
    // URL credentials, query strings or resolver diagnostics to the caller.
    if (error instanceof Error && error.cause instanceof ProviderPolicyError) throw error.cause;
    throw error;
  }
}
