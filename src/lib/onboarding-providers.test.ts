import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus, InstanceInfo } from "@/state/store";
import { onboardingEngine, readOnboardingProviders, saveOnboardingProvider } from "./onboarding-providers";
import { sessionRecheck } from "./session-recheck";
import { createSessionRecovery, type SessionPayload, type SessionSnapshot } from "./session-recovery";

const provider = { id: "openai-label", configKey: "openai", label: "OpenAI", placeholder: "API key" };
const catalog = { providers: [provider, { ...provider, id: "elevenlabs", configKey: "elevenlabs" }] };
const hostedConfig = { storageGate: { required: true } };
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

describe("onboarding provider destination", () => {
  it("requires the server's hosted capability and a successful vault contract", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(Response.json(hostedConfig))
      .mockResolvedValueOnce(Response.json(catalog));
    const signal = new AbortController().signal;
    await expect(readOnboardingProviders(signal, fetcher)).resolves.toEqual({ providers: [provider], destination: "/api/user-keys" });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/providers", "/api/config", "/api/user-keys"]);
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ method: "GET", credentials: "include", cache: "no-store", redirect: "error", signal });
  });

  it.each([
    { storageGate: { required: false } },
    {},
    { storageGate: null },
    { storageGate: { required: "true" } },
    { storageGate: { required: 1 } },
  ])("offers Settings without probing the vault for absent or invalid hosted capability %j", async (config) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(Response.json(config));
    await expect(readOnboardingProviders(new AbortController().signal, fetcher)).resolves.toEqual({ providers: [provider], destination: null });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/providers", "/api/config"]);
  });

  it("does not probe or write the vault when config cannot provide a capability", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(readOnboardingProviders(new AbortController().signal, fetcher)).resolves.toEqual({ providers: [provider], destination: null });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/providers", "/api/config"]);
  });

  it.each([401, 403, 404])("offers Settings instead of an inline write when the vault returns %s", async (status) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(Response.json(hostedConfig))
      .mockResolvedValueOnce(new Response(null, { status }));
    await expect(readOnboardingProviders(new AbortController().signal, fetcher)).resolves.toEqual({ providers: [provider], destination: null });
  });

  it("does not treat an outage as permission to write installation config", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(Response.json(hostedConfig))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(readOnboardingProviders(new AbortController().signal, fetcher)).rejects.toThrow("could not be confirmed");
  });

  it.each([0, 2])("refuses a malformed successful response from endpoint %s", async (index) => {
    const responses = [Response.json(catalog), Response.json(hostedConfig), Response.json(catalog)];
    responses[index] = Response.json({ ok: true });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(responses[0]).mockResolvedValueOnce(responses[1]).mockResolvedValueOnce(responses[2]);
    await expect(readOnboardingProviders(new AbortController().signal, fetcher)).rejects.toThrow();
  });

  it("saves once with the server's config key and returns its config receipt", async () => {
    const config: ConfigStatus = { composio: { configured: false }, box: { configured: false }, providers: { openai: { configured: true } } };
    const request = vi.fn().mockResolvedValue(config);
    await expect(saveOnboardingProvider("/api/user-keys", provider, " fixture-key ", request)).resolves.toBe(config);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/user-keys", { method: "PUT", body: JSON.stringify({ providerId: "openai", apiKey: "fixture-key" }) });
  });

  it("never retries a rejected personal save through global config", async () => {
    const request = vi.fn().mockRejectedValue(new Error("403 refused"));
    await expect(saveOnboardingProvider("/api/user-keys", provider, "fixture-key", request)).rejects.toThrow("403 refused");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("/api/user-keys");
  });

  it("does not write when destination or key is missing", async () => {
    const request = vi.fn();
    await expect(saveOnboardingProvider(null, provider, "fixture-key", request)).rejects.toThrow("Providers settings");
    await expect(saveOnboardingProvider("/api/user-keys", provider, "  ", request)).rejects.toThrow("Enter an API key");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("provider discovery session recovery", () => {
  const identity: SessionPayload = {
    user: { id: "provider-owner", name: "Fixture", email: "fixture@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() },
    session: { id: "provider-session", userId: "provider-owner", token: "fixture-token", expiresAt: new Date(Date.now() + 60_000) },
  };

  for (const endpoint of [0, 1, 2]) {
    it.each(["valid", "expired", "unavailable"] as const)(`rechecks endpoint ${endpoint} 401 with a %s session`, async (outcome) => {
      const states: SessionSnapshot[] = [];
      const request = vi.fn<() => Promise<SessionPayload | null>>().mockResolvedValueOnce(identity)
        .mockImplementation(async () => {
          if (outcome === "unavailable") throw new Error("Session service unavailable");
          return outcome === "expired" ? null : identity;
        });
      const recovery = createSessionRecovery((snapshot) => states.push(snapshot), request);
      await recovery.refresh();
      states.length = 0;
      let completed = false;
      const check = vi.fn(async () => { await recovery.refresh({ background: true }); completed = true; });
      cleanups.push(sessionRecheck.register(check));
      const replies = [Response.json(catalog), Response.json(hostedConfig), Response.json(catalog)];
      replies[endpoint] = new Response(null, { status: 401 });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(replies[0]).mockResolvedValueOnce(replies[1]).mockResolvedValueOnce(replies[2]);
      const discovery = readOnboardingProviders(new AbortController().signal, fetcher);
      if (endpoint === 0) await expect(discovery).rejects.toThrow("Provider choices could not be loaded");
      else await expect(discovery).resolves.toEqual({ providers: [provider], destination: null });
      await vi.waitFor(() => expect(completed).toBe(true));
      expect(check).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(states).toEqual(outcome === "unavailable" ? [] : [{
        status: "ready", user: outcome === "valid" ? identity.user : null,
        session: outcome === "valid" ? identity.session : null,
      }]);
    });
  }

  it.each([0, 1, 2])("does not recheck an aborted endpoint %s 401 when transport ignores abort", async (endpoint) => {
    const check = vi.fn(async () => {});
    cleanups.push(sessionRecheck.register(check));
    const controller = new AbortController();
    let reply!: (value: Response) => void;
    const deferred = new Promise<Response>((resolve) => { reply = resolve; });
    const replies = [Promise.resolve(Response.json(catalog)), Promise.resolve(Response.json(hostedConfig)), Promise.resolve(Response.json(catalog))];
    replies[endpoint] = deferred;
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(replies[0]).mockReturnValueOnce(replies[1]).mockReturnValueOnce(replies[2]);
    const pending = readOnboardingProviders(controller.signal, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(endpoint === 2 ? 3 : 2));
    controller.abort();
    reply(new Response(null, { status: 401 }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(check).not.toHaveBeenCalled();
  });

  it("keeps a retired discovery response from checking the replacement account", async () => {
    const original = vi.fn(async () => {}), replacement = vi.fn(async () => {});
    cleanups.push(sessionRecheck.register(original));
    let reply!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(catalog))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { reply = resolve; }));
    const pending = readOnboardingProviders(new AbortController().signal, fetcher);
    cleanups.push(sessionRecheck.register(replacement));
    reply(new Response(null, { status: 401 }));
    await expect(pending).resolves.toMatchObject({ destination: null });
    expect(original).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    // A fresh request still checks the replacement binding.
    const current = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(Response.json(hostedConfig))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    await readOnboardingProviders(new AbortController().signal, current);
    await vi.waitFor(() => expect(replacement).toHaveBeenCalledTimes(1));
  });

  it("checks a config 401 even when catalog discovery rejects at transport", async () => {
    const check = vi.fn(async () => {});
    cleanups.push(sessionRecheck.register(check));
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("Catalog network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(readOnboardingProviders(new AbortController().signal, fetcher)).rejects.toThrow("Catalog network unavailable");
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
  });

  it("does not check identity for missing or forbidden vault capabilities", async () => {
    const check = vi.fn(async () => {});
    cleanups.push(sessionRecheck.register(check));
    for (const status of [403, 404]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(catalog))
        .mockResolvedValueOnce(Response.json(hostedConfig))
        .mockResolvedValueOnce(new Response(null, { status }));
      await expect(readOnboardingProviders(new AbortController().signal, fetcher)).resolves.toMatchObject({ destination: null });
    }
    expect(check).not.toHaveBeenCalled();
  });
});

describe("onboarding account engine selection", () => {
  const make = (instanceId: string, authenticated: boolean, access?: "custom"): InstanceInfo => ({ instanceId, driverKind: "codex", displayName: "Codex", models: { default: "model", options: [] }, snapshot: { state: "available", authenticated }, access });

  it("prefers an actually signed-in account and excludes local-model injection", () => {
    const unsigned = make("unsigned", false);
    const local = make("local", true, "custom");
    const signed = make("signed", true);
    expect(onboardingEngine([unsigned, local, signed], "codex")).toBe(signed);
    expect(onboardingEngine([local], "codex")).toBeUndefined();
    expect(onboardingEngine(null, "codex")).toBeUndefined();
  });
});
