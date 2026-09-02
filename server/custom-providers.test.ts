// BYOK custom model providers — unit contracts for the pieces the routes
// assemble: id sanitization, baseUrl validation (the SSRF line between
// desktop Ollama and self-hosted multi-tenant), instance wiring, and the
// model-list wire parser.
import { describe, expect, it } from "vitest";

import {
  customProviderInstances,
  customProviderKeyEnv,
  fetchProviderModelIds,
  sanitizeCustomProviderId,
  validateProviderBaseUrl,
} from "./custom-providers.ts";

type FetchInput = Parameters<typeof fetch>[0];

describe("sanitizeCustomProviderId", () => {
  it("slugs names into url-safe ids", () => {
    expect(sanitizeCustomProviderId("My Gateway")).toBe("my-gateway");
    expect(sanitizeCustomProviderId("DeepSeek")).toBe("deepseek");
  });

  it("drops characters that would poison env vars or instance ids", () => {
    expect(sanitizeCustomProviderId("Acme/Models; drop TABLE")).toBe("acme-models-drop-table");
    expect(sanitizeCustomProviderId("__proto__")).toBe("proto");
  });

  it("falls back to provider when nothing usable remains", () => {
    expect(sanitizeCustomProviderId("✨🔥✨")).toBe("provider");
  });
});

describe("customProviderKeyEnv", () => {
  it("is deterministic and env-var safe", () => {
    expect(customProviderKeyEnv("my-gateway")).toBe("CUSTOM_PROVIDER_MY_GATEWAY_API_KEY");
    expect(customProviderKeyEnv("my.gateway/2")).toBe("CUSTOM_PROVIDER_MY_GATEWAY_2_API_KEY");
  });
});

describe("validateProviderBaseUrl", () => {
  it("accepts https public endpoints everywhere", () => {
    const check = validateProviderBaseUrl("https://api.example.com/v1", true);
    expect(check.ok).toBe(true);
  });

  it("requires an absolute http(s) URL", () => {
    expect(validateProviderBaseUrl("api.example.com/v1", false).ok).toBe(false);
    expect(validateProviderBaseUrl("ftp://api.example.com", false).ok).toBe(false);
    expect(validateProviderBaseUrl("not a url", false).ok).toBe(false);
  });

  it("lets desktop installs point at Ollama on loopback", () => {
    expect(validateProviderBaseUrl("http://127.0.0.1:11434/v1", false).ok).toBe(true);
    expect(validateProviderBaseUrl("http://localhost:1234/v1", false).ok).toBe(true);
  });

  it("rejects loopback and private targets on self-hosted multi-tenant", () => {
    expect(validateProviderBaseUrl("http://127.0.0.1:11434/v1", true).ok).toBe(false);
    expect(validateProviderBaseUrl("http://localhost:11434/v1", true).ok).toBe(false);
    expect(validateProviderBaseUrl("http://10.0.0.5:8000/v1", true).ok).toBe(false);
    expect(validateProviderBaseUrl("http://192.168.1.10:8000/v1", true).ok).toBe(false);
    expect(validateProviderBaseUrl("http://[::1]:8000/v1", true).ok).toBe(false);
  });

  it("does not reject public hostnames that merely contain numeric octets", () => {
    expect(validateProviderBaseUrl("https://10.0.0.1.example.com/v1", true).ok).toBe(true);
  });
});

describe("customProviderInstances", () => {
  it("wires each provider as a first-class instance with key + catalog in config", () => {
    const map = customProviderInstances(
      [{ id: "my-gateway", name: "My Gateway", baseUrl: "https://gw.example.com/v1", format: "openai", models: ["m1", "m2"] }],
      (id) => (id === "my-gateway" ? "sk-secret" : undefined),
    );
    const entry = map["custom-my-gateway"];
    expect(entry).toBeDefined();
    expect(entry!.driver).toBe("customOpenai");
    expect(entry!.displayName).toBe("My Gateway");
    expect(entry!.environment).toEqual({ CUSTOM_PROVIDER_MY_GATEWAY_API_KEY: "sk-secret" });
    // SAFETY: entry.config came from customProviderInstances, whose contract
    // stamps { url, apiKeyEnv, models } for every custom instance — the
    // assertion only narrows what the producer already wrote.
    const config = entry!.config as { url: string; apiKeyEnv: string; models: { default: string; options: Array<{ id: string }> } };
    expect(config.url).toBe("https://gw.example.com/v1");
    expect(config.models.default).toBe("m1");
    expect(config.models.options.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("routes anthropic-format providers to the anthropic driver", () => {
    const map = customProviderInstances(
      [{ id: "gw", name: "GW", baseUrl: "https://gw.example.com", format: "anthropic", models: ["claude-x"] }],
      () => undefined,
    );
    expect(map["custom-gw"]!.driver).toBe("anthropic");
  });

  it("omits the key env when none is configured (keyless local endpoints)", () => {
    const map = customProviderInstances(
      [{ id: "local", name: "Local", baseUrl: "http://127.0.0.1:11434/v1", format: "openai", models: ["llama3"] }],
      () => undefined,
    );
    expect(map["custom-local"]!.environment).toEqual({});
  });
});

describe("fetchProviderModelIds", () => {
  it("parses the { data: [{ id }] } wire shape and dedupes", async () => {
    const originalFetch = globalThis.fetch;
    // SAFETY: the stub's signature matches fetch's call shape exactly, so
    // the assertion only satisfies the compiler — the runtime object is a
    // genuine async function.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, { id: "m1" }] }), { status: 200 })) as typeof fetch;
    try {
      const ids = await fetchProviderModelIds("https://api.example.com/v1", "sk-test");
      expect(ids).toEqual(["m1", "m2"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("appends /models to the base URL path", async () => {
    let called = "";
    const originalFetch = globalThis.fetch;
    // SAFETY: same stub pattern — a real async function, cast only for the
    // compiler.
    globalThis.fetch = (async (input: FetchInput) => {
      called = String(input);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await fetchProviderModelIds("https://api.example.com/v1/", "sk");
      expect(called).toBe("https://api.example.com/v1/models");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("yields an empty list on HTTP errors and malformed payloads", async () => {
    const originalFetch = globalThis.fetch;
    // SAFETY: the stub's signature matches fetch's call shape exactly, so
    // the assertion only satisfies the compiler — the runtime object is a
    // genuine async function.
    globalThis.fetch = (async (input: FetchInput) => {
      if (String(input).includes("bad")) return new Response("nope", { status: 500 });
      return new Response('{"nope":1}', { status: 200 });
    }) as typeof fetch;
    try {
      expect(await fetchProviderModelIds("https://bad.example.com/v1", undefined)).toEqual([]);
      expect(await fetchProviderModelIds("https://malformed.example.com/v1", undefined)).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
