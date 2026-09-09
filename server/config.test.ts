import { describe, expect, it, vi } from "vitest";

import {
  instanceConfigs,
  parseConfigPatch,
  parseStoredConfig,
  withInstanceCli,
  type AppConfig,
} from "./config.ts";

describe("configuration boundaries", () => {
  it("keeps supported stored settings and drops unrelated top-level data", () => {
    expect(
      parseStoredConfig({
        profile: { name: "Ada", email: "ada@example.com" },
        instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
        unrelated: { secret: "not part of the config contract" },
      }),
    ).toEqual({
      profile: { name: "Ada", email: "ada@example.com" },
      instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
    });
  });

  it("rejects malformed stored instances and API patches", () => {
    expect(() => parseStoredConfig({ instances: { claude: { driver: 42 } } })).toThrow("instances.claude.driver");
    expect(() => parseConfigPatch({ opencodeGo: { apiKey: 42 } })).toThrow("opencodeGo.apiKey");
    expect(() => parseConfigPatch({ profile: [] })).toThrow("profile");
  });

  it("persists customProviders as a whole array (regression: saveConfig dropped the key, BYOK providers vanished on reload)", async () => {
    // saveConfig is the only path that could lose this key: its section
    // merge had no branch for customProviders, so the write silently
    // persisted customProviders:null while the key record survived — the
    // exact "added a provider, nothing appeared" bug. Round-trip through
    // the real file on a throwaway DATA_DIR.
    const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "config-custom-providers-"));
    const prevDataDir = process.env.OMB_DATA_DIR;
    process.env.OMB_DATA_DIR = dir;
    try {
      vi.resetModules();
      const { saveConfig, loadConfig } = await import("./config.ts");
      const registry = [
        { id: "mock-gateway", name: "Mock Gateway", baseUrl: "http://127.0.0.1:29111/v1", format: "openai" as const, models: ["test-model-1"] },
      ];
      saveConfig({ customProviders: registry });
      saveConfig({ providers: { "custom-mock-gateway": { apiKey: "sk-test" } } });

      // the on-disk file must carry BOTH halves
      const disk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(disk.customProviders).toHaveLength(1);
      expect(disk.customProviders[0].id).toBe("mock-gateway");
      expect(disk.providers["custom-mock-gateway"].apiKey).toBe("sk-test");

      // and loadConfig must hand instanceConfigs() what it needs
      const cfg = loadConfig();
      const map = instanceConfigs(cfg);
      expect(map["custom-mock-gateway"]).toBeDefined();
      expect(map["custom-mock-gateway"]!.driver).toBe("customOpenai");
      expect(map["custom-mock-gateway"]!.environment!.CUSTOM_PROVIDER_MOCK_GATEWAY_API_KEY).toBe("sk-test");
    } finally {
      process.env.OMB_DATA_DIR = prevDataDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("default fleet", () => {
  it("ships Qwen, Hermes and Vibe as custom-only engines", () => {
    const map = instanceConfigs({});
    expect(map.qwen).toEqual({ driver: "qwenAgent", environment: {} });
    expect(map.hermes).toEqual({ driver: "hermesAgent", environment: {} });
    expect(map.vibe).toEqual({ driver: "vibeAgent", environment: {} });
  });

  it("adds missing custom-only engines onto an existing product fleet", () => {
    const map = instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } });
    expect(map.claude.driver).toBe("claudeAgent");
    expect(map.qwen?.driver).toBe("qwenAgent");
    expect(map.hermes?.driver).toBe("hermesAgent");
    expect(map.vibe?.driver).toBe("vibeAgent");
  });

  it("does not expand a one-off shadow fleet", () => {
    const map = instanceConfigs({ instances: { ghost: { driver: "not-a-real-driver" } } });
    expect(Object.keys(map)).toEqual(["ghost"]);
  });

  it("adds a Grok (API) engine when an xAI key is present", () => {
    const map = instanceConfigs({ xai: { key: "xai-secret" } });
    expect(map.grokApi).toEqual({
      driver: "grok",
      displayName: "Grok (API)",
      environment: { XAI_API_KEY: "xai-secret" },
    });
    // the CLI Grok stays the default "grok" instance
    expect(map.grok.driver).toBe("grokAgent");
  });

  it("does not add a Grok (API) engine without an xAI key", () => {
    const map = instanceConfigs({});
    expect(map.grokApi).toBeUndefined();
    expect(map.grok.driver).toBe("grokAgent");
  });

  it("adds an OpenAI (API) engine when an OpenAI provider key is present", () => {
    const map = instanceConfigs({ providers: { openai: { apiKey: "sk-secret" } } });
    expect(map.openaiApi).toEqual({
      driver: "openai",
      displayName: "OpenAI (API)",
      environment: { OPENAI_API_KEY: "sk-secret" },
    });
    // the CLI Codex stays the default "codex" instance
    expect(map.codex.driver).toBe("codex");
  });

  it("does not add an OpenAI (API) engine without a provider key", () => {
    const map = instanceConfigs({});
    expect(map.openaiApi).toBeUndefined();
  });

  it("adds an Anthropic (API) engine when an Anthropic provider key is present", () => {
    const map = instanceConfigs({ providers: { anthropic: { apiKey: "sk-ant-secret" } } });
    expect(map.anthropicApi).toEqual({
      driver: "anthropic",
      displayName: "Anthropic (API)",
      environment: { ANTHROPIC_API_KEY: "sk-ant-secret" },
    });
    // the CLI Claude stays the default "claude" instance
    expect(map.claude.driver).toBe("claudeAgent");
  });

  it("does not add an Anthropic (API) engine without a provider key", () => {
    const map = instanceConfigs({});
    expect(map.anthropicApi).toBeUndefined();
  });

  it.each([
    ["google", "googleApi", "google", "GOOGLE_API_KEY"],
    ["deepseek", "deepseekApi", "deepseek", "DEEPSEEK_API_KEY"],
    ["mistral", "mistralApi", "mistral", "MISTRAL_API_KEY"],
    ["cohere", "cohereApi", "cohere", "COHERE_API_KEY"],
    ["groq", "groqApi", "groq", "GROQ_API_KEY"],
    ["together", "togetherApi", "together", "TOGETHER_API_KEY"],
    ["fireworks", "fireworksApi", "fireworks", "FIREWORKS_API_KEY"],
    ["openrouter", "openrouterApi", "openrouter", "OPENROUTER_API_KEY"],
    ["opencodeZen", "opencodeZenApi", "opencodeZen", "OPENCODE_API_KEY"],
  ])("adds a %s (API) engine only when its provider key is present, injecting %s", (providerKey, instanceKey, driverKind, envVar) => {
    const without = instanceConfigs({});
    expect(without[instanceKey]).toBeUndefined();

    const withKey = instanceConfigs({ providers: { [providerKey]: { apiKey: "secret" } } });
    expect(withKey[instanceKey]).toMatchObject({ driver: driverKind, environment: { [envVar]: "secret" } });
  });
});

describe("Instance CLI override", () => {
  it("sets, replaces, and clears config.cli on a default-fleet instance", () => {
    const cfg: AppConfig = {};
    const set = withInstanceCli(cfg, "claude", "/opt/claude-2.1/bin/claude");
    expect(set.ok).toBe(true);
    expect(set.config.instances!.claude.config).toEqual({ cli: "/opt/claude-2.1/bin/claude" });

    const replaced = withInstanceCli(set.config, "claude", "~/bin/claude");
    expect(replaced.config.instances!.claude.config).toEqual({ cli: "~/bin/claude" });

    const cleared = withInstanceCli(replaced.config, "claude", "");
    expect(cleared.config.instances!.claude.config).toBeUndefined();
  });

  it("preserves sibling config keys when clearing only cli", () => {
    const cfg: AppConfig = {
      instances: { claude: { driver: "claudeAgent", config: { cli: "/x/claude", permissionMode: "bypassPermissions" } } },
    };
    const cleared = withInstanceCli(cfg, "claude", "");
    expect(cleared.config.instances!.claude.config).toEqual({ permissionMode: "bypassPermissions" });
  });

  it("leaves the original config untouched and rejects unknown instances", () => {
    const cfg: AppConfig = { instances: { codex: { driver: "codex" } } };
    const result = withInstanceCli(cfg, "codex", "/new/codex");
    expect(result.config.instances!.codex.config).toEqual({ cli: "/new/codex" });
    expect(cfg.instances!.codex.config).toBeUndefined();

    expect(withInstanceCli(cfg, "nope", "/x").ok).toBe(false);
  });

  it("never persists the credential env instanceConfigs injects", () => {
    // instanceConfigs() copies xai/box/opencodeGo keys into every entry's
    // environment for the live fleet; withInstanceCli must strip them back
    // out, or saving a CLI override would copy secrets into the instances
    // section of config.json.
    const cfg: AppConfig = {
      xai: { key: "SECRET-XAI" },
      box: { token: "SECRET-BOX" },
    };
    const set = withInstanceCli(cfg, "claude", "/opt/claude");
    expect(set.ok).toBe(true);
    for (const entry of Object.values(set.config.instances!)) {
      expect(entry.environment ?? {}).toEqual({});
    }
    // user-authored env survives
    const custom = { instances: { claude: { driver: "claudeAgent", environment: { MY_FLAG: "1" } } } };
    const kept = withInstanceCli(custom, "claude", "/x");
    expect(kept.config.instances!.claude.environment).toEqual({ MY_FLAG: "1" });
  });

  it("never persists OpenAI/Anthropic provider keys either", () => {
    const cfg: AppConfig = {
      providers: { openai: { apiKey: "SECRET-OPENAI" }, anthropic: { apiKey: "SECRET-ANTHROPIC" } },
    };
    const set = withInstanceCli(cfg, "claude", "/opt/claude");
    expect(set.ok).toBe(true);
    for (const entry of Object.values(set.config.instances!)) {
      expect(entry.environment ?? {}).toEqual({});
    }
  });

  it("never persists any of the remaining provider catalog keys either", () => {
    const cfg: AppConfig = {
      providers: {
        google: { apiKey: "SECRET-GOOGLE" },
        deepseek: { apiKey: "SECRET-DEEPSEEK" },
        mistral: { apiKey: "SECRET-MISTRAL" },
        cohere: { apiKey: "SECRET-COHERE" },
        groq: { apiKey: "SECRET-GROQ" },
        together: { apiKey: "SECRET-TOGETHER" },
        fireworks: { apiKey: "SECRET-FIREWORKS" },
        openrouter: { apiKey: "SECRET-OPENROUTER" },
      },
    };
    const set = withInstanceCli(cfg, "claude", "/opt/claude");
    expect(set.ok).toBe(true);
    for (const entry of Object.values(set.config.instances!)) {
      expect(entry.environment ?? {}).toEqual({});
    }
  });
});

describe("OpenCode Go configuration", () => {
  it("injects the key only into OpenCode Go instances", () => {
    const cfg: AppConfig = {
      opencodeGo: { apiKey: "secret-value" },
      instances: {
        opencode: { driver: "opencodeGo" },
        grok: { driver: "grokAgent" },
      },
    };

    const instances = instanceConfigs(cfg);
    expect(instances.opencode.environment).toEqual({ OPENCODE_API_KEY: "secret-value" });
    expect(instances.grok.environment).toEqual({});
  });
});
