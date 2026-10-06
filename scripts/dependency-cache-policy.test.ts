// Exercise the package resolved by the real builder -> downloader -> Got ->
// cacheable-request chain. No server, network, account or native build is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

type Headers = Record<string, string>;
interface Request { url: string; method: string; headers: Headers }
interface Response { status: number; headers: Headers }
interface SerializedPolicy {
  v: number; t: number; sh: boolean; ch: number; imm: number; icc: boolean;
  st: number; resh: Headers; rescc: Record<string, string | boolean>;
  m: string; u?: string; h?: string; a: boolean; reqh: Headers | null;
  reqcc: Record<string, string | boolean>;
}
interface Evaluation {
  response?: { status: number; headers: Headers };
  revalidation?: { synchronous: boolean; headers: Headers };
}
interface Policy {
  storable(): boolean;
  maxAge(): number;
  stale(): boolean;
  status(): number;
  satisfiesWithoutRevalidation(request: Request): boolean;
  evaluateRequest(request: Request): Evaluation;
  toObject(): SerializedPolicy;
  revalidationHeaders(request: Request): Headers;
  revalidatedPolicy(request: Request, response?: Response): { policy: Policy; modified: boolean; matches: boolean };
}
interface PolicyConstructor {
  new (request: Request, response: Response, options?: { shared?: boolean }): Policy;
  fromObject(serialized: SerializedPolicy): Policy;
}
interface WireRequest extends Request {
  protocol: string;
  hostname: string;
  path: string;
  shared?: boolean;
}
interface WireResponse extends Readable {
  statusCode: number;
  url: string;
  headers: Headers;
  fromCache?: boolean;
}
type Origin = (request: WireRequest, callback: (response: WireResponse) => void) => EventEmitter;
type CacheRequest = (request: WireRequest, callback: (response: WireResponse) => void) => EventEmitter;
interface CacheRequestConstructor { new (origin: Origin, store: MemoryStore): CacheRequest }
interface ResponseConstructor { new (status: number, headers: Headers, body: Buffer, url: string): WireResponse }

const root = fileURLToPath(new URL("..", import.meta.url));
const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const electronBuilderRequire = createRequire(rootRequire.resolve("electron-builder/package.json"));
const builderRequire = createRequire(electronBuilderRequire.resolve("app-builder-lib/package.json"));
const downloaderRequire = createRequire(builderRequire.resolve("@electron/get/package.json"));
const gotRequire = createRequire(downloaderRequire.resolve("got/package.json"));
const cacheEntry = gotRequire.resolve("cacheable-request");
const cacheRequire = createRequire(cacheEntry);
const policyEntry = cacheRequire.resolve("http-cache-semantics");
// SAFETY: This is the fixed 4.3.0 CommonJS API, bound to the reviewed original
// or patched SHA256 by upstreamSource() and the resolution/source test below.
const CachePolicy = cacheRequire("http-cache-semantics") as PolicyConstructor;
// SAFETY: The real Got consumer resolves cacheable-request 7.0.4; its fixed
// constructor/callback API is verified by the version and downstream tests.
const CacheableRequest = gotRequire("cacheable-request") as CacheRequestConstructor;
// SAFETY: This is cacheable-request 7.0.4's own responselike dependency and
// constructor API, exercised by every actual-consumer regression below.
const ResponseStream = cacheRequire("responselike") as ResponseConstructor;
const originalHash = "ede1cc404a492fa348eb9d97a3007a0d72aa717bd22cd86a56bd0824c19729ca";
const patchedHash = "aa800b3e30074032e630f3a9a8edbf7e4d3941fcf95c59ab2ad6dad9dd97d1e6";
const sha256 = (source: string): string => createHash("sha256").update(source).digest("hex");

// Reconstruct the exact unpatched package bytes by reversing the committed
// unified diff, rather than reimplementing its predicate in a mock policy.
function upstreamSource(): string {
  let source = readFileSync(policyEntry, "utf8");
  if (sha256(source) === originalHash) return source;
  assert.equal(sha256(source), patchedHash, "Unexpected installed cache policy source");
  const patch = readFileSync(join(root, "patches/http-cache-semantics@4.3.0.patch"), "utf8");
  for (const hunk of patch.split(/^@@[^\n]*\n/m).slice(1)) {
    const lines = hunk.split("\n").filter((line) => /^[ +-]/.test(line));
    const before = lines.filter((line) => line[0] !== "+").map((line) => line.slice(1)).join("\n") + "\n";
    const after = lines.filter((line) => line[0] !== "-").map((line) => line.slice(1)).join("\n") + "\n";
    assert.equal(source.split(after).length, 2, "Patch hunk must reverse exactly once");
    source = source.replace(after, before);
  }
  assert.equal(sha256(source), originalHash, "Baseline must be the published 4.3.0 bytes");
  return source;
}
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "muster-cache-policy-")));
const originalEntry = join(scratch, "original-policy.cjs");
writeFileSync(originalEntry, upstreamSource());
// SAFETY: The SHA256 check above binds this fixture to the exact original
// standalone 4.3.0 module and therefore the same fixed CommonJS policy API.
const OriginalPolicy = createRequire(originalEntry)(originalEntry) as PolicyConstructor;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const request = (headers: Headers = {}, overrides: Partial<Request> = {}): Request => ({
  url: "https://cache-fixture.invalid/item", method: "GET",
  headers: { host: "cache-fixture.invalid", ...headers }, ...overrides,
});
const response = (cacheControl: string, age = 15, headers: Headers = {}): Response => ({
  status: 200, headers: {
    "cache-control": cacheControl, date: new Date().toUTCString(), age: String(age),
    etag: '"owned-validator"', ...headers,
  },
});
interface Scenario { name: string; cacheControl: string; headers?: Headers; shared?: boolean }
const protectedScenarios: Scenario[] = [
  { name: "response no-cache", cacheControl: "no-cache, max-age=600" },
  { name: "shared cookie without opt-in", cacheControl: "max-age=600", headers: { "set-cookie": "owned=fixture" } },
  { name: "stale must-revalidate", cacheControl: "max-age=10, must-revalidate" },
  { name: "stale shared proxy-revalidate", cacheControl: "max-age=10, proxy-revalidate" },
  { name: "stale shared s-maxage", cacheControl: "max-age=600, s-maxage=10" },
];
const policyFor = (scenario: Scenario, Constructor = CachePolicy, age = 15): Policy =>
  new Constructor(request(), response(scenario.cacheControl, age, scenario.headers), { shared: scenario.shared ?? true });
function expectValidation(policy: Policy, incoming = request({ "cache-control": "max-stale" })): void {
  expect(policy.satisfiesWithoutRevalidation(incoming)).toBe(false);
  expect(policy.evaluateRequest(incoming)).toMatchObject({ response: undefined, revalidation: { synchronous: true } });
}

class MemoryStore {
  readonly values = new Map<string, string>();
  private writes = 0;
  private waiting: Array<{ count: number; resolve: () => void }> = [];
  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async set(key: string, value: string): Promise<boolean> {
    this.values.set(key, value);
    this.writes += 1;
    for (const waiter of this.waiting.filter((entry) => entry.count <= this.writes)) waiter.resolve();
    this.waiting = this.waiting.filter((entry) => entry.count > this.writes);
    return true;
  }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async clear(): Promise<void> { this.values.clear(); }
  written(count: number): Promise<void> {
    if (this.writes >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push({ count, resolve }));
  }
}
interface OriginReply { status: number; headers: Headers; body: string }
const responseChunk = z.union([z.instanceof(Buffer), z.string().transform((value) => Buffer.from(value))]);
function consumer(replies: OriginReply[], shared = true) {
  const store = new MemoryStore();
  const originRequests: WireRequest[] = [];
  const cached = new CacheableRequest((options, callback) => {
    originRequests.push({ ...options, headers: { ...options.headers } });
    const reply = replies.shift();
    assert(reply, "Unexpected synthetic origin request");
    const operation = new EventEmitter();
    queueMicrotask(() => callback(new ResponseStream(reply.status, reply.headers, Buffer.from(reply.body), options.url)));
    return operation;
  }, store);
  const round = (incoming = request()): Promise<{ body: string; fromCache: boolean; status: number }> =>
    new Promise((resolve, reject) => {
      const parsed = new URL(incoming.url);
      const options: WireRequest = { ...incoming, protocol: parsed.protocol, hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`, shared };
      cached(options, (result) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of result) {
            chunks.push(responseChunk.parse(chunk));
          }
          resolve({ body: Buffer.concat(chunks).toString(), fromCache: result.fromCache === true, status: result.statusCode });
        })().catch(reject);
      }).once("error", reject);
    });
  return { store, originRequests, round };
}
const reply = (cacheControl: string, body: string, age = 15, headers: Headers = {}): OriginReply => ({
  status: 200, headers: response(cacheControl, age, headers).headers, body,
});

describe("resolved http-cache-semantics protected revalidation backport", () => {
  it("binds the real consumer to patched 4.3.0 and keeps the public API and serialization", () => {
    expect(JSON.parse(readFileSync(cacheRequire.resolve("http-cache-semantics/package.json"), "utf8")))
      .toMatchObject({ name: "http-cache-semantics", version: "4.3.0" });
    expect(JSON.parse(readFileSync(gotRequire.resolve("cacheable-request/package.json"), "utf8")))
      .toMatchObject({ name: "cacheable-request", version: "7.0.4" });
    expect(realpathSync(policyEntry).startsWith(`${realpathSync(join(root, "node_modules"))}${sep}`)).toBe(true);
    expect(sha256(readFileSync(policyEntry, "utf8"))).toBe(patchedHash);
    const policy = new CachePolicy(request(), response("public, max-age=600", 0));
    expect(policy.status()).toBe(200);
    expect(policy.evaluateRequest(request()).response?.status).toBe(200);
    expect(Object.keys(policy.toObject()).sort()).toEqual(Object.keys(new OriginalPolicy(request(), response("public, max-age=600", 0)).toObject()).sort());
    expect(CachePolicy.fromObject(policy.toObject()).status()).toBe(200);
  });

  it.each(protectedScenarios.filter((scenario) => scenario.name !== "stale must-revalidate"))
    ("reproduces the upstream max-stale bypass for $name on exact original bytes", (scenario) => {
      const policy = policyFor(scenario, OriginalPolicy);
      expect(policy.satisfiesWithoutRevalidation(request({ "cache-control": "max-stale" }))).toBe(true);
    });

  it.each(protectedScenarios)("requires successful validation for $name, including old serialized policies", (scenario) => {
    const old = policyFor(scenario, OriginalPolicy);
    for (const policy of [policyFor(scenario), CachePolicy.fromObject(old.toObject()), CachePolicy.fromObject(JSON.parse(JSON.stringify(old.toObject())))]) {
      for (const permission of ["max-stale", "max-stale=600"]) expectValidation(policy, request({ "cache-control": permission }));
    }
  });

  it.each(protectedScenarios)("does not allow stale-while-revalidate to bypass $name", (scenario) => {
    expectValidation(policyFor({ ...scenario, cacheControl: `${scenario.cacheControl}, stale-while-revalidate=600` }), request());
  });

  it.each(["must-revalidate", "proxy-revalidate", "s-maxage=600"])("preserves fresh legitimate %s responses", (directive) => {
    const policy = new CachePolicy(request(), response(`public, max-age=600, ${directive}`, 0));
    expect(policy.maxAge()).toBe(600);
    expect(policy.satisfiesWithoutRevalidation(request())).toBe(true);
  });

  it.each([
    { name: "ordinary stale public", cacheControl: "public, max-age=10" },
    { name: "private-cache proxy-revalidate", cacheControl: "max-age=10, proxy-revalidate", shared: false },
    { name: "private-cache s-maxage", cacheControl: "max-age=10, s-maxage=1", shared: false },
    { name: "private-cache cookie", cacheControl: "max-age=10", headers: { "set-cookie": "owned=fixture" }, shared: false },
    { name: "explicit public cookie", cacheControl: "public, max-age=10", headers: { "set-cookie": "owned=fixture" } },
    { name: "explicit immutable cookie", cacheControl: "immutable, max-age=10", headers: { "set-cookie": "owned=fixture" } },
  ])("preserves permitted max-stale reuse for $name", (scenario) => {
    expect(policyFor(scenario).satisfiesWithoutRevalidation(request({ "cache-control": "max-stale" }))).toBe(true);
  });

  it("preserves ordinary stale-while-revalidate with an asynchronous validation result", () => {
    const result = new CachePolicy(request(), response("public, max-age=10, stale-while-revalidate=600")).evaluateRequest(request());
    expect(result.response?.status).toBe(200);
    expect(result.revalidation?.synchronous).toBe(false);
  });

  it.each(["private, max-age=600", "no-store, max-age=600"])("refuses unvalidated reuse of a non-storable %s policy from old serialization", (control) => {
    const old = new OriginalPolicy(request(), response(control, 0));
    expectValidation(CachePolicy.fromObject(old.toObject()));
  });

  it("retains shared Authorization storage restrictions and legal explicit public reuse", () => {
    const authenticated = request({ authorization: "owned synthetic credential" });
    const privatePolicy = new CachePolicy(authenticated, response("max-age=600", 0));
    expect(privatePolicy.storable()).toBe(false);
    expectValidation(privatePolicy, authenticated);
    const publicPolicy = new CachePolicy(authenticated, response("public, max-age=600", 0));
    expect(publicPolicy.storable()).toBe(true);
    expect(publicPolicy.satisfiesWithoutRevalidation(request({ authorization: "another synthetic credential" }))).toBe(true);
  });

  it.each([
    { name: "URL", changed: request({}, { url: "https://cache-fixture.invalid/other" }) },
    { name: "host", changed: request({ host: "other-fixture.invalid" }) },
    { name: "method", changed: request({}, { method: "POST" }) },
    { name: "Vary Authorization", changed: request({ authorization: "second" }) },
  ])("preserves $name identity matching before cache reuse", ({ changed }) => {
    const policy = new CachePolicy(request({ authorization: "first" }), response("public, max-age=600", 0, { vary: "authorization" }));
    expectValidation(policy, changed);
    expect(policy.revalidationHeaders(changed)["if-none-match"]).toBeUndefined();
  });

  it("retains Vary own-property protections, including wildcard among multiple fields", () => {
    const inherited: Headers = Object.create({ authorization: "owned" });
    inherited.host = "cache-fixture.invalid";
    const policy = new CachePolicy(request({ authorization: "owned" }), response("public, max-age=600", 0, { vary: "authorization" }));
    expectValidation(policy, request({}, { headers: inherited }));
    expectValidation(new CachePolicy(request(), response("public, max-age=600", 0, { vary: "accept, *" })));
  });

  it.each(protectedScenarios)("does not reuse $name after a failed origin validation", (scenario) => {
    const policy = policyFor({ ...scenario, cacheControl: `${scenario.cacheControl}, stale-if-error=600` });
    const result = policy.revalidatedPolicy(request(), { status: 503, headers: {} });
    expect(result.modified).toBe(true);
    expect(result.matches).toBe(false);
    expect(result.policy.status()).toBe(503);
  });

  it("reproduces upstream stale-if-error reuse despite response no-cache", () => {
    const result = new OriginalPolicy(request(), response("no-cache, max-age=10, stale-if-error=600"))
      .revalidatedPolicy(request(), { status: 503, headers: {} });
    expect(result.modified).toBe(false);
    expect(result.matches).toBe(true);
    expect(result.policy.status()).toBe(200);
  });

  it("preserves permitted public stale-if-error and rejects mismatched Vary identity or request no-cache", () => {
    const policy = new CachePolicy(request({ authorization: "first" }), response("public, max-age=10, stale-if-error=600", 15, { vary: "authorization" }));
    const failure = { status: 503, headers: {} };
    expect(policy.revalidatedPolicy(request({ authorization: "first" }), failure)).toMatchObject({ modified: false, matches: true });
    for (const changed of [request({ authorization: "second" }), request({ authorization: "first", "cache-control": "no-cache" }), request({ authorization: "first", pragma: "no-cache" })]) {
      expect(policy.revalidatedPolicy(changed, failure).modified).toBe(true);
    }
  });

  it.each([
    { name: "URL", changed: request({}, { url: "https://cache-fixture.invalid/other" }) },
    { name: "host", changed: request({ host: "other-fixture.invalid" }) },
    { name: "method", changed: request({}, { method: "POST" }) },
  ])("does not reuse an old body after an error for a mismatched $name", ({ changed }) => {
    const policy = new CachePolicy(request(), response("public, max-age=10, stale-if-error=600"));
    expect(policy.revalidatedPolicy(changed, { status: 503, headers: {} }).modified).toBe(true);
    expect(() => policy.revalidatedPolicy(changed, undefined)).toThrow("Response headers missing");
  });

  it("handles an absent origin response without bypassing protected validation", () => {
    const protectedPolicy = new CachePolicy(request(), response("no-cache, max-age=10, stale-if-error=600"));
    expect(() => protectedPolicy.revalidatedPolicy(request(), undefined)).toThrow("Response headers missing");
    const publicPolicy = new CachePolicy(request(), response("public, max-age=10, stale-if-error=600"));
    expect(publicPolicy.revalidatedPolicy(request(), undefined)).toMatchObject({ modified: false, matches: true, policy: publicPolicy });
  });

  it("accepts matching 304 validation, preserves status/body policy, and retains no-cache for the next request", () => {
    const policy = new CachePolicy(request(), response("no-cache, max-age=600"));
    const validated = policy.revalidatedPolicy(request(), { status: 304, headers: { etag: '"owned-validator"' } });
    expect(validated).toMatchObject({ modified: false, matches: true });
    expect(validated.policy.status()).toBe(200);
    expectValidation(CachePolicy.fromObject(validated.policy.toObject()));
  });

  it("refreshes an expired shared s-maxage policy through a matching 304", () => {
    const validated = new CachePolicy(request(), response("public, s-maxage=10"))
      .revalidatedPolicy(request(), { status: 304, headers: { etag: '"owned-validator"', "cache-control": "public, s-maxage=600", age: "0", date: new Date().toUTCString() } });
    expect(validated).toMatchObject({ modified: false, matches: true });
    expect(CachePolicy.fromObject(validated.policy.toObject()).satisfiesWithoutRevalidation(request())).toBe(true);
  });

  it.each(protectedScenarios)("the actual serialized consumer validates $name rather than returning an unvalidated body", async (scenario) => {
    const harness = consumer([reply(scenario.cacheControl, "first body", 15, scenario.headers), reply("public, max-age=600", "validated body", 0)]);
    const written = harness.store.written(1);
    await harness.round();
    await written;
    expect(await harness.round(request({ "cache-control": "max-stale" })))
      .toEqual({ body: "validated body", fromCache: false, status: 200 });
    expect(harness.originRequests).toHaveLength(2);
    expect(harness.originRequests[1]?.headers["if-none-match"]).toBe('"owned-validator"');
  });

  it("the actual consumer preserves ordinary public cache hits", async () => {
    const harness = consumer([reply("public, max-age=600", "public body", 0)]);
    const written = harness.store.written(1);
    await harness.round();
    await written;
    expect(await harness.round()).toEqual({ body: "public body", fromCache: true, status: 200 });
    expect(harness.originRequests).toHaveLength(1);
  });

  it.each([
    { name: "URL", changed: request({}, { url: "https://cache-fixture.invalid/other" }) },
    { name: "host", changed: request({ host: "other-fixture.invalid" }) },
    { name: "method", changed: request({}, { method: "POST" }) },
  ])("the actual consumer validates a changed $name rather than reusing another cached body", async ({ changed }) => {
    const harness = consumer([reply("public, max-age=600", "first body", 0), reply("public, max-age=600", "different request body", 0)]);
    const written = harness.store.written(1);
    await harness.round();
    await written;
    expect(await harness.round(changed)).toEqual({ body: "different request body", fromCache: false, status: 200 });
    expect(harness.originRequests).toHaveLength(2);
    expect(harness.originRequests[1]?.headers["if-none-match"]).toBeUndefined();
  });

  it("the actual consumer allows explicitly public responses across Authorization values without Vary", async () => {
    const harness = consumer([reply("public, max-age=600", "explicitly public body", 0)]);
    const written = harness.store.written(1);
    await harness.round(request({ authorization: "first synthetic credential" }));
    await written;
    expect(await harness.round(request({ authorization: "second synthetic credential" })))
      .toEqual({ body: "explicitly public body", fromCache: true, status: 200 });
    expect(harness.originRequests).toHaveLength(1);
  });

  it("the actual consumer preserves legal public Authorization reuse and validates Vary changes", async () => {
    const harness = consumer([reply("public, max-age=600", "first identity", 0, { vary: "authorization" }), reply("public, max-age=600", "second identity", 0, { vary: "authorization" })]);
    const written = harness.store.written(1);
    await harness.round(request({ authorization: "first" }));
    await written;
    expect((await harness.round(request({ authorization: "first" }))).fromCache).toBe(true);
    expect(await harness.round(request({ authorization: "second", "cache-control": "max-stale" })))
      .toEqual({ body: "second identity", fromCache: false, status: 200 });
    expect(harness.originRequests[1]?.headers["if-none-match"]).toBeUndefined();
  });

  it("the actual consumer never stores shared private or unapproved authenticated responses", async () => {
    for (const [control, headers] of [["private, max-age=600", {}], ["max-age=600", { authorization: "owned synthetic credential" }]] as const) {
      const harness = consumer([reply(control, "first body", 0), reply(control, "second body", 0)]);
      await harness.round(request(headers));
      expect(await harness.round(request(headers))).toEqual({ body: "second body", fromCache: false, status: 200 });
      expect(harness.originRequests).toHaveLength(2);
      expect(harness.store.values.size).toBe(0);
    }
  });

  it("the actual consumer accepts a matching 304 while revalidating no-cache on each subsequent request", async () => {
    const notModified = { status: 304, headers: { etag: '"owned-validator"' }, body: "" };
    const harness = consumer([reply("no-cache, max-age=600", "validated cached body"), notModified, notModified]);
    const written = harness.store.written(1);
    await harness.round();
    await written;
    expect(await harness.round(request({ "cache-control": "max-stale" }))).toEqual({ body: "validated cached body", fromCache: true, status: 200 });
    expect(harness.originRequests).toHaveLength(2);
    await harness.store.written(2);
    expect(await harness.round()).toEqual({ body: "validated cached body", fromCache: true, status: 200 });
    expect(harness.originRequests).toHaveLength(3);
  });

  it("the actual consumer returns a validation error response rather than a protected stale body", async () => {
    const harness = consumer([reply("no-cache, max-age=10, stale-if-error=600", "protected body"), { status: 503, headers: {}, body: "origin unavailable" }]);
    const written = harness.store.written(1);
    await harness.round();
    await written;
    expect(await harness.round()).toEqual({ body: "origin unavailable", fromCache: false, status: 503 });
  });

  it("the actual consumer retains a permitted public stale-if-error body after origin failure", async () => {
    const harness = consumer([reply("public, max-age=10, stale-if-error=600", "permitted public body"), { status: 503, headers: {}, body: "origin unavailable" }]);
    const written = harness.store.written(1);
    await harness.round();
    await written;
    expect(await harness.round()).toEqual({ body: "permitted public body", fromCache: true, status: 200 });
    expect(harness.originRequests).toHaveLength(2);
  });
});
