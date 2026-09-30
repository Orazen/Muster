import type { LookupAddress, LookupAllOptions, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

type ResolveAll = (hostname: string, options: LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
const publicV4 = { address: "8.8.8.8", family: 4 };
const publicV6 = { address: "2606:4700:4700::1111", family: 6 };

async function transport(host = "0.0.0.0", publicHost: string | undefined = undefined) {
  vi.stubEnv("OMB_HOST", host);
  vi.stubEnv("OMB_PUBLIC_HOST", publicHost);
  vi.resetModules();
  return import("./provider-fetch.ts");
}

function resolverWith(addresses: LookupAddress[]) {
  const resolver = vi.fn<ResolveAll>((_hostname, _options, callback) => callback(null, addresses));
  return { spy: resolver, resolver };
}

function resolveThrough(lookup: LookupFunction, options: LookupOptions = {}) {
  return new Promise<{ address: string | LookupAddress[]; family?: number }>((resolve, reject) => {
    lookup("provider.example", options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("hosted provider connection address boundary", () => {
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("accepts public literal %s", async address => {
    expect((await transport()).isPublicProviderAddress(address)).toBe(true);
  });

  it.each([
    "", "provider.example", "not-an-address", "127.0.0.1", "0.0.0.0", "10.8.0.2", "100.64.0.1",
    "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.0.8", "192.0.2.1", "192.88.99.1",
    "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fd00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8",
    "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "3fff::1",
  ])("rejects private, reserved or non-IP value %s", async address => {
    expect((await transport()).isPublicProviderAddress(address)).toBe(false);
  });

  it("returns the vetted address itself and resolves all records before family selection", async () => {
    const { createPublicProviderLookup } = await transport();
    const { spy, resolver } = resolverWith([publicV4, publicV6]);
    const lookup = createPublicProviderLookup(resolver);
    expect(await resolveThrough(lookup, { family: 6 })).toEqual({ address: publicV6.address, family: 6 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("provider.example");
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ all: true });
  });

  it("honors all:true without returning unvalidated answers", async () => {
    const { createPublicProviderLookup } = await transport();
    const { resolver } = resolverWith([publicV4, publicV6]);
    expect((await resolveThrough(createPublicProviderLookup(resolver), { all: true })).address).toEqual([publicV4, publicV6]);
  });

  it.each([
    { answers: [{ address: "127.0.0.1", family: 4 }] },
    { answers: [publicV4, { address: "10.0.0.7", family: 4 }] },
    { answers: [publicV4, { address: "fd00::1", family: 6 }] },
  ])("refuses the whole mixed/private answer set even with requested family4: %j", async ({ answers }) => {
    const { createPublicProviderLookup } = await transport();
    const { resolver } = resolverWith(answers);
    await expect(resolveThrough(createPublicProviderLookup(resolver), { family: 4 })).rejects.toThrow();
  });

  it("rejects an empty DNS answer, a missing requested family, and a resolver error", async () => {
    const { createPublicProviderLookup } = await transport();
    await expect(resolveThrough(createPublicProviderLookup(resolverWith([]).resolver))).rejects.toThrow();
    await expect(resolveThrough(createPublicProviderLookup(resolverWith([publicV4]).resolver), { family: 6 })).rejects.toThrow();
    const resolver = resolverWith([]);
    resolver.spy.mockImplementation((_host, _options, callback) => callback(new Error("fixture DNS failure"), []));
    await expect(resolveThrough(createPublicProviderLookup(resolver.resolver))).rejects.toThrow("Provider hostname could not be resolved");
  });

  it("rechecks a later connection after DNS changes from public to private", async () => {
    const { createPublicProviderLookup } = await transport();
    const { spy, resolver } = resolverWith([publicV4]);
    const lookup = createPublicProviderLookup(resolver);
    expect((await resolveThrough(lookup)).address).toBe(publicV4.address);
    spy.mockImplementation((_host, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]));
    await expect(resolveThrough(lookup)).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("provider fetch policy", () => {
  it.each(["ftp://provider.example/private?token=synthetic-secret", "https://synthetic-user:synthetic-password@provider.example/v1?token=synthetic-secret", "not a URL synthetic-secret"])("refuses malformed/protocol/credential URL without leaking input: %s", async url => {
    const { providerFetch } = await transport();
    const fetcher = vi.spyOn(globalThis, "fetch");
    const error = await providerFetch(url, {}).then(() => null, reason => reason);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("synthetic-");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["http://127.0.0.1/v1", "http://2130706433/v1", "http://localhost./v1", "http://[::1]/v1", "http://[::ffff:127.0.0.1]/v1"])("refuses hosted private destination before fetch: %s", async url => {
    const { providerFetch } = await transport();
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(providerFetch(url, {})).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not let caller redirect or dispatcher settings override the hosted boundary", async () => {
    const { providerFetch } = await transport();
    const response = new Response("fixture");
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const untrustedDispatcher = { dispatch: vi.fn() };
    const options: RequestInit = { redirect: "follow", headers: { "x-fixture": "kept" } };
    // Model an untyped runtime caller inserting an invalid dispatcher.
    Reflect.set(options, "dispatcher", untrustedDispatcher);
    expect(await providerFetch("https://provider.example/v1", options)).toBe(response);
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toMatchObject({ redirect: "error", headers: { "x-fixture": "kept" } });
    expect(init).toHaveProperty("dispatcher");
    expect(init).not.toHaveProperty("dispatcher", untrustedDispatcher);
    expect(untrustedDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("keeps trusted built-in APIs on global fetch while still refusing redirects", async () => {
    const { providerFetch } = await transport();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fixture"));
    await providerFetch("https://api.openai.com/v1/models", {}, false);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("dispatcher", expect.anything());
  });

  it("allows desktop local models and preserves streaming response and cancellation signal", async () => {
    const { providerFetch } = await transport("127.0.0.1");
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode("data: fixture\n\n")); stream.close(); } }));
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const result = await providerFetch("http://127.0.0.1:11434/v1/chat/completions", { signal: controller.signal });
    expect(result).toBe(response);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("dispatcher", expect.anything());
    expect(await result.text()).toBe("data: fixture\n\n");
  });

  it("matches the public-host startup policy and cannot be disabled by a later environment edit", async () => {
    const { providerFetch } = await transport("127.0.0.1", "muster.example");
    vi.stubEnv("OMB_PUBLIC_HOST", undefined);
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(providerFetch("http://127.0.0.1/v1", {})).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
