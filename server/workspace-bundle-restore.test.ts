// v1 workspace-bundle restore: the two properties that make a restore safe
// on a machine it did not come from.
//
// 1. A bundle name is DATA, not an identifier. The decrypted payload is
//    attacker-shaped input to the extent that a human can hand someone a
//    bundle file, so every string that becomes a path segment — the
//    top-level memory key, the per-bot topic directory, the topic
//    filename — must be refused if it carries a separator, a parent
//    reference, a NUL, or is absurdly long. Only a `.md` check ran before
//    this file existed (bug report S4-3), and a key of
//    `../../../../Users/x/.ssh/authorized_keys.md` escaped the data dir.
//
// 2. A restored bot may not keep the exporting account's `ownerId`
//    (S4-4). The bundle is ciphertext to Drive, but once decrypted its bot
//    records arrive with an ownerId intact; unshifting that record
//    unchanged handed a restored bot to an account that is not on this
//    machine. The v2 restore already strips it — this pins v1 to the same
//    rule.
//
// Isolation: server/testing/setup.ts points HOME at a throwaway directory
// before config.ts loads, so DATA_DIR — and WORKSPACES_DIR, which
// workspaceDir() builds on — resolve inside it. No server, no network.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { Store } from "./store.ts";
import type { BundleWorkspace } from "./workspace-bundle.ts";

const { restoreBundle } = await import("./workspace-bundle.ts");
const { DATA_DIR } = await import("./config.ts");
const { WORKSPACES_DIR } = await import("./workspace.ts");

const selection = () => ({ instanceId: "restore-fixture", model: "fixture-model" });

/** A well-formed bundle the tests then break one field at a time — a
 *  baseline that is known to restore cleanly is what makes a refusal
 *  legible as a refusal rather than a broken fixture. */
const bundle = (overrides: Partial<BundleWorkspace> = {}): BundleWorkspace => ({
  bots: [{ id: "bot-a", name: "A" }],
  groups: [{ id: "grp-a" }],
  memory: { "notes.md": "top level" },
  topics: { "bot-a": { "topic.md": "a topic" } },
  exportedAt: Date.UTC(2026, 8, 27, 9, 0, 0),
  counts: { bots: 1, groups: 1, memoryFiles: 2 },
  ...overrides,
});

describe("v1 restore — bundle names never become path escapes", () => {
  beforeEach(() => {
    rmSync(join(DATA_DIR, "memory"), { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("writes the well-formed bundle, so the refusals below mean something", () => {
    const store = new Store(selection);
    const result = restoreBundle(store, DATA_DIR, bundle());
    expect(result.memoryFilesRestored).toBe(2);
    expect(readFileSync(join(DATA_DIR, "memory", "notes.md"), "utf8")).toBe("top level");
    expect(readFileSync(join(WORKSPACES_DIR, "bot-a", "memory", "topic.md"), "utf8")).toBe("a topic");
  });

  it("refuses a top-level memory key that walks out of the data dir", () => {
    const store = new Store(selection);
    const escape = join("..", "..", "..", "escaped.md");
    const result = restoreBundle(store, DATA_DIR, bundle({ memory: { [escape]: "owned" } }));
    expect(result.memoryFilesRestored).toBe(0);
    expect(existsSync(join(DATA_DIR, "..", "..", "..", "escaped.md"))).toBe(false);
  });

  it("refuses a topic directory id that is a parent reference", () => {
    const store = new Store(selection);
    const result = restoreBundle(store, DATA_DIR, bundle({ topics: { "..": { "topic.md": "owned" } } }));
    expect(result.memoryFilesRestored).toBe(0);
    expect(existsSync(join(WORKSPACES_DIR, "..", "memory", "topic.md"))).toBe(false);
  });

  it("refuses a topic filename carrying a separator", () => {
    const store = new Store(selection);
    const result = restoreBundle(store, DATA_DIR, bundle({ topics: { "bot-a": { "nested/topic.md": "owned" } } }));
    expect(result.memoryFilesRestored).toBe(0);
    expect(existsSync(join(WORKSPACES_DIR, "bot-a", "nested", "topic.md"))).toBe(false);
  });

  it("refuses a NUL byte and an over-long name the same way", () => {
    const store = new Store(selection);
    const result = restoreBundle(
      store,
      DATA_DIR,
      bundle({ memory: { ["nul\0.md"]: "owned", [`${"n".repeat(300)}.md`]: "owned" } }),
    );
    expect(result.memoryFilesRestored).toBe(0);
  });

  it("still honours the per-bot MEMORY.md branch, which had its own id check", () => {
    const store = new Store(selection);
    const result = restoreBundle(
      store,
      DATA_DIR,
      bundle({ memory: { "workspaces/bot-a/MEMORY.md": "agent memory", "workspaces/../evil/MEMORY.md": "owned" } }),
    );
    expect(result.memoryFilesRestored).toBe(1);
    expect(readFileSync(join(WORKSPACES_DIR, "bot-a", "MEMORY.md"), "utf8")).toBe("agent memory");
    expect(existsSync(join(WORKSPACES_DIR, "..", "evil", "MEMORY.md"))).toBe(false);
  });

  it("lets a local file win over the bundle", () => {
    const store = new Store(selection);
    const dir = join(DATA_DIR, "memory");
    restoreBundle(store, DATA_DIR, bundle());
    writeFileSync(join(dir, "notes.md"), "local edit", "utf8");
    const second = restoreBundle(store, DATA_DIR, bundle());
    expect(second.memoryFilesRestored).toBe(0);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("local edit");
  });
});

describe("v1 restore — ownership and capability fields do not survive", () => {
  it("drops ownerId from a restored bot, and does not mutate the caller's workspace", () => {
    const store = new Store(selection);
    const incoming = bundle({
      bots: [{ id: "bot-b", name: "B", ownerId: "account-somewhere-else", autoApprove: true }],
    });
    const result = restoreBundle(store, DATA_DIR, incoming);
    expect(result.botsRestored).toBe(1);
    const restored = store.bots.find((b) => b.id === "bot-b");
    expect(restored).toBeDefined();
    expect("ownerId" in (restored ?? {})).toBe(false);
    expect("autoApprove" in (restored ?? {})).toBe(false);
    // SAFETY: incoming is this test's own fixture literal — the assertion
    // pins that restoreBundle sanitised its COPY, not the caller's object.
    expect((incoming.bots as { ownerId?: string }[])[0]?.ownerId).toBe("account-somewhere-else");
  });

  it("drops ownerId from a restored group", () => {
    const store = new Store(selection);
    restoreBundle(store, DATA_DIR, bundle({ groups: [{ id: "grp-b", ownerId: "account-somewhere-else" }] }));
    const restored = store.groups.find((g) => g.id === "grp-b");
    expect(restored).toBeDefined();
    expect("ownerId" in (restored ?? {})).toBe(false);
  });

  it("still skips a bot id that already exists on this machine", () => {
    const store = new Store(selection);
    restoreBundle(store, DATA_DIR, bundle());
    const second = restoreBundle(store, DATA_DIR, bundle());
    expect(second.botsRestored).toBe(0);
    expect(second.skippedExisting).toBe(1);
    expect(store.bots.filter((b) => b.id === "bot-a")).toHaveLength(1);
  });
});
