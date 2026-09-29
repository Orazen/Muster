// A: the "test connection" fetch for a custom provider must not become a way
// to reach an address the SSRF line already refused.
//
// Two transport facts make the pre-fix behavior wrong, and both are pinned
// here against REAL loopback fixture servers rather than a stubbed
// globalThis.fetch, because the defect lives in the transport, not in the
// argument object the stub would have received:
//
//   1. `fetch` follows redirects by default. `validateProviderBaseUrl` is a
//      string check run BEFORE the request, so a base URL that answers 302 to
//      `http://127.0.0.1:<port>/...` is fetched anyway and the second
//      fixture's body is handed back as a model list. That is the
//      loopback/private refusal being bypassed by one HTTP hop, and it is why
//      the server's own rule for user-supplied hosts is `redirect: "error"`
//      (server/team-library.ts, server/drive-sync.ts, server/decision-client.ts).
//
//   2. The host check is lexical. `new URL("http://localhost./v1").hostname`
//      is "localhost." — a trailing root dot, which every resolver still sends
//      to loopback (confirmed with dns.lookup) and which no `=== "localhost"`
//      test catches. Same class as the IPv6 literals: an address that IS
//      loopback or private wearing a spelling the predicate does not match.
//
// Neither needs a real provider, a real key, or the network: an owned fixture
// on an ephemeral port is the whole threat model here.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchProviderModelIds, validateProviderBaseUrl } from "./custom-providers.ts";

/** The private target the redirect points at. Records what it was asked, so
 *  "the second fixture was never reached" is asserted rather than assumed. */
const internalHits: Array<{ url: string; authorization: string | undefined }> = [];

const internalServer = createServer((req, res) => {
  internalHits.push({ url: req.url ?? "", authorization: req.headers.authorization });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "internal-only-model" }] }));
});

/** The public-looking base URL the user typed. Records the first hop. */
const frontHits: Array<{ url: string; authorization: string | undefined }> = [];

const frontServer = createServer((req, res) => {
  frontHits.push({ url: req.url ?? "", authorization: req.headers.authorization });
  // SAFETY: both fixtures are bound to loopback on an ephemeral port in
  // beforeAll, and `address()` on a listening server is a socket address —
  // this closure only ever runs after the redirect fixture is up.
  const internalPort = (internalServer.address() as AddressInfo).port;
  res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/v1/models` });
  res.end();
});

const listen = (server: Server) =>
  // SAFETY: a bound net.Server always reports a SocketAddress here, and the
  // port is read inside the listen callback — after the bind has completed.
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe("custom-provider test-connection transport", () => {
  let internalPort = 0;
  let frontPort = 0;

  beforeAll(async () => {
    internalPort = await listen(internalServer);
    frontPort = await listen(frontServer);
  });

  afterAll(async () => {
    await close(frontServer);
    await close(internalServer);
  });

  it("does not follow a redirect off a validated host into the private target", async () => {
    frontHits.length = 0;
    internalHits.length = 0;
    // It REJECTS rather than resolving to []: the pre-fix fetch followed the
    // 302 and returned ["internal-only-model"] — the private target's body,
    // read through a hop no SSRF check ever saw. A rejection is also the only
    // honest answer, because an empty list is what the UI renders as "the
    // endpoint answered, list the models by hand".
    await expect(fetchProviderModelIds(`http://127.0.0.1:${frontPort}/v1`, "sk-user-supplied")).rejects.toThrow(/redirect/i);
    // The load-bearing assertion: the second fixture was never asked at all.
    expect(internalHits).toEqual([]);
    // Only the host the caller named was contacted, and only its /models path.
    expect(frontHits.map((hit) => hit.url)).toEqual(["/v1/models"]);
  });

  it("does not carry the supplied API key to the redirect target", async () => {
    frontHits.length = 0;
    internalHits.length = 0;
    await fetchProviderModelIds(`http://127.0.0.1:${frontPort}/v1`, "sk-user-supplied").catch(() => []);
    // The key DOES go to the host the user typed — they typed it, that is the
    // point. What it must never do is reach a host only a 302 named. Before
    // the fix both fixtures recorded a hit carrying the key; now only the
    // first one is contacted at all.
    expect(frontHits.map((hit) => hit.authorization)).toEqual(["Bearer sk-user-supplied"]);
    expect(internalHits).toEqual([]);
  });

  it("still reads a straight 200 from the provider itself", async () => {
    // The control. Without it, "always fails" would pass every case above and
    // the fix would be indistinguishable from a broken fetch.
    internalHits.length = 0;
    const ids = await fetchProviderModelIds(`http://127.0.0.1:${internalPort}/v1`, "sk-user-supplied");
    expect(ids).toEqual(["internal-only-model"]);
    expect(internalHits).toHaveLength(1);
  });

  it("rejects the resolvable spellings of a loopback host", () => {
    // "localhost." is the same host as "localhost": the trailing dot is the
    // DNS root, resolvers ignore it, and dns.lookup("localhost.") answers ::1
    // and 127.0.0.1. The check tested `h === "localhost"`, so this passed and
    // the fetch that followed reached loopback on a self-hosted deployment
    // that had just refused the plain spelling.
    expect(validateProviderBaseUrl("http://localhost./v1", true).ok).toBe(false);
    expect(validateProviderBaseUrl("http://foo.localhost./v1", true).ok).toBe(false);
    // Case folding was already handled by toLowerCase; pinned beside the dot
    // case because both were the same one-character miss.
    expect(validateProviderBaseUrl("http://LocalHost./v1", true).ok).toBe(false);
  });

  it("rejects bracketed IPv6 literals the raw hostname test could not read", () => {
    // new URL("http://[fc00::1]/v1").hostname is "[fc00::1]", and parseIpv6
    // cannot parse the brackets — so every bracketed literal skipped the
    // private/reserved check on self-hosted while the IPv4 spellings of the
    // same ranges were refused. fc00::/7 is unique-local and fe80::/10 is the
    // link-local range cloud metadata answers on.
    expect(validateProviderBaseUrl("http://[fc00::1]:8000/v1", true).ok).toBe(false);
    expect(validateProviderBaseUrl("http://[fe80::1]/v1", true).ok).toBe(false);
    expect(validateProviderBaseUrl("http://[::ffff:169.254.169.254]/v1", true).ok).toBe(false);
  });

  it("leaves desktop installs able to point at a local model server", () => {
    // The reason the check is not simply "reject everything local": Ollama on
    // 127.0.0.1 is the headline local-models case and only the operator can
    // reach it. Both spellings must keep working there.
    expect(validateProviderBaseUrl("http://127.0.0.1:11434/v1", false).ok).toBe(true);
    expect(validateProviderBaseUrl("http://localhost./v1", false).ok).toBe(true);
    expect(validateProviderBaseUrl("http://[::1]:1234/v1", false).ok).toBe(true);
  });
});
