import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  addUserCustomProvider,
  allUserCustomInstanceConfigs,
  listUserCustomProviders,
  removeUserCustomProvider,
  userCustomInstanceConfigs,
  userCustomProviderUsers,
} from "./user-custom-providers.ts";
import { CUSTOM_PROVIDER_MAX } from "./custom-providers.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "user-custom-providers-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const input = {
  name: "Bai",
  baseUrl: "https://api.b.ai/v1",
  format: "openai" as const,
  models: ["glm-4.5", "glm-4.6"],
};

describe("per-user custom provider store", () => {
  it("adds with a derived id, lists, and removes", () => {
    const p = addUserCustomProvider(dir, "alice", input);
    expect(p).toMatchObject({ id: "bai", name: "Bai" });
    expect(listUserCustomProviders(dir, "alice")).toHaveLength(1);
    expect(removeUserCustomProvider(dir, "alice", "bai")).toBe(true);
    expect(listUserCustomProviders(dir, "alice")).toEqual([]);
    expect(removeUserCustomProvider(dir, "alice", "bai")).toBe(false);
  });

  it("namespaces users: bob never sees alice's providers", () => {
    addUserCustomProvider(dir, "alice", input);
    expect(listUserCustomProviders(dir, "bob")).toEqual([]);
    expect(userCustomProviderUsers(dir)).toEqual(["alice"]);
  });

  it("suffixes same-name ids within one user", () => {
    addUserCustomProvider(dir, "alice", input);
    const second = addUserCustomProvider(dir, "alice", input);
    expect(second!.id).toBe("bai-2");
  });

  it("caps at the shared provider limit", () => {
    for (let i = 0; i < CUSTOM_PROVIDER_MAX; i += 1) {
      expect(addUserCustomProvider(dir, "alice", { ...input, name: `P${i}` })).not.toBeNull();
    }
    expect(addUserCustomProvider(dir, "alice", { ...input, name: "over" })).toBeNull();
  });

  it("persists 0600 and survives reload", () => {
    addUserCustomProvider(dir, "alice", input);
    const raw = JSON.parse(readFileSync(join(dir, "user-custom-providers.json"), "utf8"));
    expect(raw.alice[0].id).toBe("bai");
    expect(listUserCustomProviders(dir, "alice")).toHaveLength(1);
  });

  it("tolerates a corrupt file as empty rather than throwing", () => {
    addUserCustomProvider(dir, "alice", input);
    writeFileSync(join(dir, "user-custom-providers.json"), "{not json");
    expect(listUserCustomProviders(dir, "alice")).toEqual([]);
  });
});

describe("instance registration", () => {
  it("keys instances into the user-scoped namespace the turn guard reads", () => {
    addUserCustomProvider(dir, "alice", input);
    const configs = userCustomInstanceConfigs(dir, "alice", (vid) =>
      vid === "custom-bai" ? "sk-secret" : undefined,
    );
    expect(Object.keys(configs)).toEqual(["custom-baiApi:alice"]);
    const entry = configs["custom-baiApi:alice"]!;
    expect(entry).toMatchObject({ driver: "customOpenai", displayName: "Bai" });
    expect(entry.environment?.CUSTOM_PROVIDER_BAI_API_KEY).toBe("sk-secret");
    // SAFETY: the entry was just written from `input`, so the config keys the
    // provider input declares are present on the round-tripped registration.
    expect((entry.config as { url: string }).url).toBe("https://api.b.ai/v1");
    // SAFETY: same registration — the input's models block is carried through.
    expect((entry.config as { models: { default: string } }).models.default).toBe("glm-4.5");
  });

  it("registers without a key (picker shows it; turn-start reports needs-key)", () => {
    addUserCustomProvider(dir, "alice", input);
    const configs = userCustomInstanceConfigs(dir, "alice", () => undefined);
    expect(Object.keys(configs)).toEqual(["custom-baiApi:alice"]);
  });

  it("anthropic format maps to the anthropic driver", () => {
    addUserCustomProvider(dir, "alice", { ...input, format: "anthropic" });
    const configs = userCustomInstanceConfigs(dir, "alice", () => "k");
    expect(configs["custom-baiApi:alice"]!.driver).toBe("anthropic");
  });

  it("all-users union merges each user's instances", () => {
    addUserCustomProvider(dir, "alice", input);
    addUserCustomProvider(dir, "bob", { ...input, name: "Bob Gateway" });
    const all = allUserCustomInstanceConfigs(dir, ["alice", "bob", "ghost"], (uid, vid) =>
      vid === "custom-bai" && uid === "alice" ? "ka" : undefined,
    );
    expect(Object.keys(all).sort()).toEqual(["custom-baiApi:alice", "custom-bob-gatewayApi:bob"]);
    expect(all["custom-baiApi:alice"]?.environment?.CUSTOM_PROVIDER_BAI_API_KEY).toBe("ka");
  });
});
