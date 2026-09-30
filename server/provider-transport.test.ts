import { createServer, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import dns, { type LookupAddress, type LookupAllOptions } from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface Hit { path: string; method: string; body: string; authorization?: string; apiKey?: string }
const targetHits: Hit[] = [];
const frontHits: Hit[] = [];
let targetPort = 0;
let frontPort = 0;
let redirectStatus = 307;
let hangingRequest: (() => void) | undefined;
const target = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  targetHits.push({ path: req.url ?? "", method: req.method ?? "", body, authorization: req.headers.authorization, apiKey: String(req.headers["x-api-key"] ?? "") });
  if (req.url === "/stream") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: fixture\n\n"); res.end("data: [DONE]\n\n"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "fixture-model" }], choices: [{ message: { content: "local fixture response" } }], content: [{ type: "text", text: "local fixture response" }] }));
});
const front = createServer(async (req, res) => {
  if (req.url === "/wait") { hangingRequest?.(); return; }
  let body = ""; for await (const chunk of req) body += chunk;
  frontHits.push({ path: req.url ?? "", method: req.method ?? "", body, authorization: req.headers.authorization, apiKey: String(req.headers["x-api-key"] ?? "") });
  res.writeHead(redirectStatus, { location: `http://127.0.0.1:${targetPort}/private-target` }); res.end();
});
const listen = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  // SAFETY: after a successful TCP listen, address is an AddressInfo.
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
});
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

beforeAll(async () => { targetPort = await listen(target); frontPort = await listen(front); });
beforeEach(() => {
  vi.stubEnv("OMB_HOST", "127.0.0.1"); vi.stubEnv("OMB_PUBLIC_HOST", undefined); vi.resetModules();
  targetHits.length = 0; frontHits.length = 0; redirectStatus = 307;
});
afterEach(() => { hangingRequest = undefined; vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });
afterAll(async () => { await Promise.all([close(front), close(target)]); });

async function customInstance(format: "openai" | "anthropic", baseUrl: string) {
  const { customProviderInstances } = await import("./custom-providers.ts");
  const driver = format === "openai" ? (await import("./drivers/custom-openai.ts")).CustomOpenaiDriver : (await import("./drivers/anthropic.ts")).AnthropicDriver;
  const map = customProviderInstances([{ id: "transport-fixture", name: "Fixture", baseUrl, format, models: ["fixture-model"] }], () => "synthetic-provider-key");
  const config = map["custom-transport-fixture"]!;
  return driver.create({ displayName: undefined, instanceId: "custom-transport-fixture", environment: config.environment ?? {}, enabled: true, config: driver.decodeConfig(config.config) });
}

describe("actual custom provider transport", () => {
  it.each(["models", "openai", "anthropic"] as const)("blocks actual hosted %s DNS-to-loopback connection before reaching the fixture", async operation => {
    vi.stubEnv("OMB_HOST", "0.0.0.0");
    const fakeHost = "provider.muster-fixture.invalid";
    const lookup = vi.fn((_hostname: string, _options: LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    });
    // SAFETY: the transport calls only dns.lookup's all:true overload. Replace
    // that real service interface for this isolated test, then synchronize its
    // native ESM binding; afterEach restores it before any later test runs.
    const dnsService: { lookup: (hostname: string, options: LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void } = dns;
    vi.spyOn(dnsService, "lookup").mockImplementation(lookup);
    syncBuiltinESMExports();
    const originalDispatcher = getGlobalDispatcher();
    // If the owned Agent is accidentally omitted, the control routes only our
    // synthetic hostname to the owned server; it never queries real DNS.
    const trapLookup: LookupFunction = vi.fn((hostname, options, callback) => {
      if (hostname !== fakeHost) { callback(new Error("unexpected fixture hostname"), "", 0); return; }
      if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
      else callback(null, "127.0.0.1", 4);
    });
    const trap = new Agent({ connect: { lookup: trapLookup } });
    setGlobalDispatcher(trap);
    try {
      const baseUrl = `http://${fakeHost}:${targetPort}/v1`;
      if (operation === "models") {
        const { fetchProviderModelIds } = await import("./custom-providers.ts");
        await expect(fetchProviderModelIds(baseUrl, "synthetic-provider-key")).rejects.toThrow(/public network address/);
      } else {
        const instance = await customInstance(operation, baseUrl);
        try { await expect(instance.generateText!("synthetic private prompt")).rejects.toThrow(/public network address/); }
        finally { await instance.dispose(); }
      }
      expect(lookup).toHaveBeenCalled();
      expect(lookup.mock.calls.every(call => call[0] === fakeHost && call[1].all === true)).toBe(true);
      expect(trapLookup).not.toHaveBeenCalled();
      expect(targetHits).toEqual([]);
    } finally {
      setGlobalDispatcher(originalDispatcher);
      await trap.close();
    }
  });

  it.each(["openai", "anthropic"] as const)("refuses a307 %s chat redirect before sending body or credentials to another origin", async format => {
    const instance = await customInstance(format, `http://127.0.0.1:${frontPort}/v1`);
    try {
      await expect(instance.generateText!("synthetic private prompt")).rejects.toThrow();
      expect(frontHits).toHaveLength(1);
      expect(frontHits[0]?.method).toBe("POST");
      expect(frontHits[0]?.body).toContain("synthetic private prompt");
      expect(targetHits).toEqual([]);
    } finally { await instance.dispose(); }
  });

  it.each(["openai", "anthropic"] as const)("preserves direct desktop-local %s completion", async format => {
    const instance = await customInstance(format, `http://127.0.0.1:${targetPort}/v1`);
    try {
      expect(await instance.generateText!("synthetic local prompt")).toBe("local fixture response");
      expect(targetHits).toHaveLength(1);
      expect(targetHits[0]?.body).toContain("synthetic local prompt");
    } finally { await instance.dispose(); }
  });

  it.each([302, 307])("keeps model-list redirect refusal for status%s", async status => {
    redirectStatus = status;
    const { fetchProviderModelIds } = await import("./custom-providers.ts");
    await expect(fetchProviderModelIds(`http://127.0.0.1:${frontPort}/v1`, "synthetic-provider-key")).rejects.toThrow();
    expect(frontHits).toHaveLength(1);
    expect(targetHits).toEqual([]);
  });

  it("preserves direct desktop-local model discovery", async () => {
    const { fetchProviderModelIds } = await import("./custom-providers.ts");
    expect(await fetchProviderModelIds(`http://127.0.0.1:${targetPort}/v1`, undefined)).toEqual(["fixture-model"]);
    expect(targetHits).toHaveLength(1);
  });

  it("preserves explicit operator local-engine selection even on a hosted server", async () => {
    vi.stubEnv("OMB_HOST", "0.0.0.0");
    const { LocalDriver } = await import("./drivers/local.ts");
    const instance = await LocalDriver.create({ displayName: undefined, instanceId: "local-operator", environment: {}, enabled: true, config: LocalDriver.decodeConfig({ url: `http://127.0.0.1:${targetPort}/v1` }) });
    try {
      expect(await instance.generateText!("synthetic operator local prompt")).toBe("local fixture response");
      expect(targetHits.some(hit => hit.body.includes("synthetic operator local prompt"))).toBe(true);
    } finally { await instance.dispose(); }
  });

  it("preserves a real desktop-local event stream body", async () => {
    const { providerFetch } = await import("./provider-fetch.ts");
    const response = await providerFetch(`http://127.0.0.1:${targetPort}/stream`, {});
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: fixture\n\ndata: [DONE]\n\n");
    expect(targetHits).toHaveLength(1);
  });

  it("aborts a real pending desktop-local request without following another endpoint", async () => {
    const { providerFetch } = await import("./provider-fetch.ts");
    const controller = new AbortController();
    const arrived = new Promise<void>(resolve => { hangingRequest = resolve; });
    const pending = providerFetch(`http://127.0.0.1:${frontPort}/wait`, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await arrived; controller.abort(); await rejected;
    expect(targetHits).toEqual([]);
  });
});
