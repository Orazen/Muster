import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAccountVisibleBundle, inspectAccountProjection, accountSourceDigest, ACCOUNT_BINDING_FILE,
  ACCOUNT_PROJECTION_UNSUPPORTED, MAX_ACCOUNT_PROJECTION_BYTES, type AuthenticatedVisibleAccount,
  type UserHeldAccountEncryption } from "./drive-visible-account-bundle.ts";
import { readAccountVisibleSource, type AccountVisibleSourceInput } from "./drive-visible-data-source.ts";
import { parseVisibleFiles } from "./drive-visible.ts";
import { decryptBundleV2, generateRecoveryCodes, verifyBundleV2 } from "./workspace-bundle-v2.ts";
import { Store, type BotRecord } from "./store.ts";
import { TaskPlanEngine } from "./task-engine.ts";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";

const account = { userId: "local-old", sessionId: "session-old", workspaceId: "workspace-old", isPrimary: false };
const authority: AuthenticatedVisibleAccount = { account, googleSub: "verified-google-subject" };
const key: UserHeldAccountEncryption = { custody: "user-held", passphrase: "user-owned-recovery-passphrase",
  kdf: { name: "scrypt", N: 16_384, r: 8, p: 1, keyLen: 32, saltB64: "" } };
const ownBot: BotRecord = { id: "own", ownerId: account.userId, threadId: "own-thread", name: "Own", title: "Own title",
  description: "Own persona", notifications: false, unread: false, color: "green", createdAt: 1,
  modelSelection: { instanceId: "offline", model: "test" }, tasks: [], resumeCursors: { secret: "MUST-NOT-BACKUP" } };

describe("portable account backup", () => {
  let root: string;
  let source: AccountVisibleSourceInput;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "muster-account-bundle-"));
    mkdirSync(join(root, "workspaces", "own"), { recursive: true });
    writeFileSync(join(root, "workspaces", "own", "MEMORY.md"), "Actual account memory");
    source = { account, dataDir: root,
      settingsSnapshot: { userId: account.userId, workspaceId: account.workspaceId, values: { theme: "dark" } },
      store: { bots: [structuredClone(ownBot)], groups: [], snapshotThread: vi.fn(() => ({
        status: "ready" as const, source: "sqlite" as const,
        messages: [{ id: "message-one", role: "user" as const, kind: "text" as const, at: 1, text: "Actual transcript row", parentId: null }],
        activeLeafId: "message-one",
      })) }, plans: { listPlans: () => [] } };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const build = (source: AccountVisibleSourceInput, overrides: Partial<Parameters<typeof buildAccountVisibleBundle>[0]> = {}) =>
    buildAccountVisibleBundle({ source, resolveAccount: () => authority, key, appVersion: "1.15.0", ...overrides });

  it("seals actual five-file bytes and binding using v2 authenticated crypto and manifest verification", () => {
    const captured = readAccountVisibleSource(source);
    expect(captured.status).toBe("ready");
    const result = build(source);
    if (result.status !== "ready" || captured.status !== "ready") throw new Error("Expected actual source bundle");
    const verified = verifyBundleV2(result.bytes, { passphrase: key.passphrase });
    expect(verified.status).toBe("ok"); expect(verified.checks.length).toBeGreaterThan(0);
    expect(verified.checks.every(check => check.ok)).toBe(true);
    const opened = decryptBundleV2(result.bytes, { passphrase: key.passphrase });
    expect(opened.status).toBe("ok");
    expect(opened.payload?.files.map(file => file.path).sort()).toEqual([...Object.keys(captured.files), ACCOUNT_BINDING_FILE].sort());
    for (const [name, body] of Object.entries(captured.files)) {
      const entry = opened.payload?.files.find(file => file.path === name);
      expect(Buffer.from(entry!.bodyB64, "base64").toString("utf8")).toBe(body);
    }
    expect(result.binding).toMatchObject({ account: captured.account, googleSub: authority.googleSub,
      sourceDigest: captured.digest, inventory: captured.inventory });
    expect(result.unsupported).toEqual(ACCOUNT_PROJECTION_UNSUPPORTED);
    expect(opened.payload?.transcripts).toMatchObject({ method: "unsupported:account-visible-projection", threads: [] });
    expect(result.bytes.toString()).not.toContain("Actual transcript row");
    expect(result.bytes.toString()).not.toContain(authority.googleSub);
    expect(result.bytes.toString()).not.toContain(key.passphrase);
    expect(JSON.stringify(opened.payload)).not.toContain("MUST-NOT-BACKUP");
  });

  it("opens the same bytes using the actual user-held recovery code without an installation secret", () => {
    const codes = generateRecoveryCodes(1);
    const result = build(source, { key: { ...key, recovery: { codes } } });
    if (result.status !== "ready") throw new Error("Expected recovery bundle");
    expect(decryptBundleV2(result.bytes, { recoveryCode: codes[0] }).status).toBe("ok");
    expect(decryptBundleV2(result.bytes, { passphrase: "wrong user key" }).status).toBe("bad-key");
  });

  it.each([null, { ...authority, googleSub: "" }, { ...authority, account: { ...account, sessionId: "" } }])
    ("refuses unavailable or malformed live authority %j before reading", current => {
      expect(build(source, { resolveAccount: () => current })).toEqual({ status: "unavailable", reason: "account-unavailable" });
      expect(source.store.snapshotThread).not.toHaveBeenCalled();
    });
  it("refuses another resolved account before reading its offered source", () => {
    expect(build(source, { resolveAccount: () => ({ ...authority, account: { ...account, userId: "other" } }) }))
      .toEqual({ status: "unavailable", reason: "account-changed" });
    expect(source.store.snapshotThread).not.toHaveBeenCalled();
  });
  it("compares account identity fields independently of object property order", () => {
    expect(build(source, { resolveAccount: () => ({ googleSub: authority.googleSub,
      account: { isPrimary: false, workspaceId: account.workspaceId, sessionId: account.sessionId, userId: account.userId } }) }).status).toBe("ready");
  });
  it.each([
    { ...key, custody: "deployment-held" }, { ...key, passphrase: "short" },
    { ...key, recovery: { codes: ["not-a-code"] } }, { ...key, recovery: { codes: [] } },
  ])("requires bounded user-held recovery material %j", offered => {
    // SAFETY: Deliberately malformed synthetic custody is injected to verify runtime refusal, not treated as a valid key.
    const badKey = offered as UserHeldAccountEncryption;
    expect(build(source, { key: badKey })).toEqual({ status: "unavailable", reason: "key-unavailable" });
    expect(source.store.snapshotThread).not.toHaveBeenCalled();
  });
  it("refuses revocation during capture without emitting encrypted bytes", () => {
    const resolveAccount = vi.fn().mockReturnValueOnce(authority).mockReturnValue(null);
    expect(build(source, { resolveAccount })).toEqual({ status: "unavailable", reason: "account-changed" });
  });
  it("refuses a newer session after encryption without returning old-account bytes", () => {
    const resolveAccount = vi.fn().mockReturnValueOnce(authority).mockReturnValueOnce(authority)
      .mockReturnValue({ ...authority, account: { ...account, sessionId: "new-session" } });
    expect(build(source, { resolveAccount })).toEqual({ status: "unavailable", reason: "account-changed" });
  });
  it("requires captured settings and the actual readable source", () => {
    expect(build({ ...source, settingsSnapshot: null })).toEqual({ status: "unavailable", reason: "source-unavailable" });
  });
  it("treats a malformed app version as unavailable and never echoes recovery material", () => {
    expect(build(source, { appVersion: "" })).toEqual({ status: "unavailable", reason: "bundle-unavailable" });
  });

  it("revalidates typed-ready bytes rather than trusting stale parsed documents or digest", () => {
    const captured = readAccountVisibleSource(source);
    if (captured.status !== "ready") throw new Error("Expected source");
    const files = { ...captured.files, "memory.json": "not-json" };
    expect(inspectAccountProjection({ ...captured, files, digest: accountSourceDigest(captured.account, captured.inventory, files) })).toBeNull();
    expect(inspectAccountProjection({ ...captured, documents: { ok: true } })).toBeNull();
    expect(inspectAccountProjection({ ...captured, digest: "0".repeat(64) })).toBeNull();
  });
  it.each(["extra", "missing", "inventory", "duplicate-inventory", "duplicate-message", "parent-missing", "bound", "utf8"])
    ("rejects %s projection discrepancies even when source digest is recomputed", mutation => {
      const captured = readAccountVisibleSource(source);
      if (captured.status !== "ready") throw new Error("Expected source");
      const changed = structuredClone(captured);
      if (mutation === "extra") Object.assign(changed.files, { "extra.json": "private" });
      if (mutation === "missing") Reflect.deleteProperty(changed.files, "settings.json");
      if (mutation === "inventory") changed.inventory.botIds = ["different"];
      if (mutation === "duplicate-inventory") changed.inventory.threadIds.push("own-thread");
      if (mutation === "bound") changed.files["soul.md"] = "x".repeat(MAX_ACCOUNT_PROJECTION_BYTES + 1);
      if (mutation === "utf8") changed.files["soul.md"] += "\ud800";
      if (mutation === "duplicate-message" || mutation === "parent-missing") {
        const sessions = JSON.parse(changed.files["sessions.json"]);
        if (mutation === "duplicate-message") sessions.threads[0].messages.push(sessions.threads[0].messages[0]);
        else sessions.threads[0].messages[0].parentId = "not-in-history";
        changed.files["sessions.json"] = JSON.stringify(sessions);
        const parsed = parseVisibleFiles(changed.files);
        if (parsed.ok) changed.documents = parsed;
      }
      changed.digest = accountSourceDigest(changed.account, changed.inventory, changed.files);
      expect(inspectAccountProjection(changed)).toBeNull();
    });
  it("refuses non-serializable offered documents rather than trusting a typed-ready object", () => {
    const captured = readAccountVisibleSource(source);
    if (captured.status !== "ready") throw new Error("Expected source");
    interface CircularDocument { self?: CircularDocument }
    const circular: CircularDocument = {}; circular.self = circular;
    expect(inspectAccountProjection({ ...captured, documents: circular })).toBeNull();
  });
  it("handles source inventory ordering used by the actual reader", () => {
    source.store.bots.push({ ...structuredClone(ownBot), id: "Z-bot", threadId: "Z-thread" });
    source.store.bots.push({ ...structuredClone(ownBot), id: "a-bot", threadId: "a-thread" });
    expect(build(source).status).toBe("ready");
  });
});

describe("portable account backup from durable real source", () => {
  it("captures persisted own rows after restart with unchanged source bytes and no foreign payload", () => {
    closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true });
    const initial = new Store(() => ({ instanceId: "offline", model: "test" }));
    const own = initial.createBot({ ownerId: account.userId, name: "Own" }, { seedMessages: false });
    const foreign = initial.createBot({ ownerId: "another-local-account", name: "Foreign" }, { seedMessages: false });
    initial.appendMessage(own.threadId, { role: "user", kind: "text", text: "Persisted actual owned row" });
    initial.appendMessage(foreign.threadId, { role: "user", kind: "text", text: "PRIVATE-FOREIGN-ROW" });
    closeMessageDb();
    const store = new Store(() => ({ instanceId: "offline", model: "test" }));
    const plans = new TaskPlanEngine({ file: join(DATA_DIR, "task-plans.json") });
    const names = readdirSync(DATA_DIR).sort();
    const before = names.map(name => ({ name, body: readFileSync(join(DATA_DIR, name)), stat: statSync(join(DATA_DIR, name)) }));
    const result = buildAccountVisibleBundle({ source: { account, store, plans, dataDir: DATA_DIR,
      settingsSnapshot: { userId: account.userId, workspaceId: account.workspaceId, values: {} } },
      resolveAccount: () => authority, key, appVersion: "1.15.0" });
    if (result.status !== "ready") throw new Error("Expected actual durable bundle");
    const opened = decryptBundleV2(result.bytes, { passphrase: key.passphrase });
    if (!opened.payload) throw new Error("Expected actual opened payload");
    const sessions = opened.payload.files.find(file => file.path === "sessions.json")!;
    expect(Buffer.from(sessions.bodyB64, "base64").toString()).toContain("Persisted actual owned row");
    expect(JSON.stringify(opened.payload)).not.toContain("PRIVATE-FOREIGN-ROW");
    expect(readdirSync(DATA_DIR).sort()).toEqual(names);
    for (const original of before) {
      expect(readFileSync(join(DATA_DIR, original.name))).toEqual(original.body);
      expect(statSync(join(DATA_DIR, original.name)).ino).toBe(original.stat.ino);
      expect(statSync(join(DATA_DIR, original.name)).mtimeMs).toBe(original.stat.mtimeMs);
    }
  });
});
