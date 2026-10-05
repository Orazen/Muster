import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAccountVisibleBundle, accountAuthorityDigest, accountBundleHash, accountSourceDigest,
  ACCOUNT_BINDING_FILE, MAX_ACCOUNT_BUNDLE_BYTES, type AccountBundleBinding, type AuthenticatedVisibleAccount,
  type UserHeldAccountEncryption } from "./drive-visible-account-bundle.ts";
import { inspectAccountVisibleRestore } from "./drive-visible-restore.ts";
import type { AccountVisibleSourceInput } from "./drive-visible-data-source.ts";
import type { VisibleFilesOutput } from "./drive-visible-producers.ts";
import { decryptBundleV2, encryptBundleV2, generateRecoveryCodes, manifestDigest, type BundlePayloadV2 } from "./workspace-bundle-v2.ts";
import { parseVisibleFiles } from "./drive-visible.ts";
import type { BotRecord } from "./store.ts";

const sourceAccount = { userId: "old-local-user", sessionId: "old-session", workspaceId: "old-workspace", isPrimary: false };
const currentAccount = { userId: "fresh-local-user", sessionId: "fresh-session", workspaceId: "fresh-workspace", isPrimary: false };
const googleSub = "verified-same-google-subject";
const sourceAuthority: AuthenticatedVisibleAccount = { account: sourceAccount, googleSub };
const currentAuthority: AuthenticatedVisibleAccount = { account: currentAccount, googleSub };
const key: UserHeldAccountEncryption = { custody: "user-held", passphrase: "synthetic-user-owned-recovery-key",
  kdf: { name: "scrypt", N: 16_384, r: 8, p: 1, keyLen: 32, saltB64: "" } };
const bot: BotRecord = { id: "owned-bot", ownerId: sourceAccount.userId, threadId: "owned-thread", name: "Owned", title: "Owned task",
  description: "Stored persona", notifications: false, unread: false, color: "green", createdAt: 1,
  modelSelection: { instanceId: "offline", model: "test" }, tasks: [], resumeCursors: {} };

describe("inert account restore inspection", () => {
  let root: string;
  let bytes: Buffer;
  let payload: BundlePayloadV2;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "muster-account-restore-"));
    mkdirSync(join(root, "workspaces", bot.id), { recursive: true });
    writeFileSync(join(root, "workspaces", bot.id, "MEMORY.md"), "Owned source memory");
    const source: AccountVisibleSourceInput = { account: sourceAccount, dataDir: root,
      settingsSnapshot: { userId: sourceAccount.userId, workspaceId: sourceAccount.workspaceId, values: { theme: "light" } },
      store: { bots: [structuredClone(bot)], groups: [], snapshotThread: () => ({ status: "ready", source: "sqlite",
        messages: [{ id: "owned-message", role: "user", kind: "text", at: 5, text: "Original transcript", parentId: null }],
        activeLeafId: "owned-message" }) }, plans: { listPlans: () => [] } };
    const built = buildAccountVisibleBundle({ source, resolveAccount: () => sourceAuthority, key, appVersion: "1.15.0" });
    if (built.status !== "ready") throw new Error("Expected actual encrypted fixture");
    bytes = built.bytes;
    const opened = decryptBundleV2(bytes, { passphrase: key.passphrase });
    if (!opened.payload) throw new Error("Expected actual v2 decrypted fixture");
    payload = opened.payload;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function inspect(offered = bytes, resolveAccount = () => currentAuthority) {
    return inspectAccountVisibleRestore({ bytes: offered, key: { custody: "user-held", passphrase: key.passphrase }, resolveAccount });
  }
  function entryText(name: string): string { return Buffer.from(payload.files.find(file => file.path === name)!.bodyB64, "base64").toString("utf8"); }
  function replace(name: string, body: string): void {
    const file = payload.files.find(candidate => candidate.path === name)!;
    const buffer = Buffer.from(body, "utf8");
    Object.assign(file, { size: buffer.length, bodyB64: buffer.toString("base64"), sha256: accountBundleHash(buffer) });
  }
  function seal(): Buffer {
    payload.counts.files = payload.files.length;
    payload.counts.totalBytes = payload.files.reduce((total, file) => total + file.size, 0);
    payload.manifestSha256 = manifestDigest(payload.files);
    return encryptBundleV2(payload, key);
  }
  /** Simulate an edited bundle made by a holder of the passphrase: outer AEAD
   * and manifest still pass. The projection/binding checks must reject it. */
  function bindingEdit(edit: (binding: AccountBundleBinding) => void, rehash = false): void {
    const binding: AccountBundleBinding = JSON.parse(entryText(ACCOUNT_BINDING_FILE));
    edit(binding);
    if (rehash) {
      const files = { "soul.md": entryText("soul.md"), "memory.json": entryText("memory.json"), "sessions.json": entryText("sessions.json"),
        "tasks.json": entryText("tasks.json"), "settings.json": entryText("settings.json") } satisfies VisibleFilesOutput["files"];
      binding.sourceDigest = accountSourceDigest(binding.account, binding.inventory, files);
      binding.authorityDigest = accountAuthorityDigest(binding);
    }
    replace(ACCOUNT_BINDING_FILE, JSON.stringify(binding));
  }

  it("rebinds only to newly authenticated local account IDs with the same verified Google subject", () => {
    const result = inspect();
    if (result.status !== "ready") throw new Error("Expected inert fresh-local-account inspection");
    expect(result.account).toEqual(currentAccount);
    expect(result.projection).not.toHaveProperty("account");
    expect(result.source.account).toEqual({ userId: sourceAccount.userId, workspaceId: sourceAccount.workspaceId });
    expect(result.googleSub).toBe(googleSub);
    expect(result.apply).toBe("unsupported");
    expect(result.projection.documents.sessions.threads[0]?.messages[0]?.text).toBe("Original transcript");
    expect(parseVisibleFiles(result.projection.files)).toEqual(result.projection.documents);
    expect(result.unsupported).toContain("original-store-records-ownership-and-organization-partitions");
    expect(result.unsupported).toContain("group-membership-and-runtime-transport");
  });
  it("never turns encrypted local account metadata into target authorization", () => {
    const sourceClaimsCurrent = { ...sourceAuthority, account: sourceAccount };
    expect(inspect(bytes, () => ({ ...sourceClaimsCurrent, googleSub: "different-authenticated-subject" })))
      .toEqual({ status: "unavailable", reason: "subject-mismatch" });
  });
  it("requires the live host resolver and reports failures without data", () => {
    expect(inspectAccountVisibleRestore({ bytes, key, resolveAccount: () => null }))
      .toEqual({ status: "unavailable", reason: "account-unavailable" });
    expect(inspectAccountVisibleRestore({ bytes, key, resolveAccount: () => { throw new Error("private host detail"); } }))
      .toEqual({ status: "unavailable", reason: "account-unavailable" });
  });
  it("refuses a changed account/session after decrypting without exposing the projection", () => {
    const resolveAccount = vi.fn().mockReturnValueOnce(currentAuthority).mockReturnValue(null);
    expect(inspect(bytes, resolveAccount)).toEqual({ status: "unavailable", reason: "account-changed" });
  });
  it.each(["subject", "local-user", "workspace", "source-digest", "authority-digest"])
    ("rejects changed %s binding in a re-encrypted authenticated payload", field => {
      bindingEdit(binding => {
        if (field === "subject") binding.googleSub = "different-google-subject";
        if (field === "local-user") binding.account.userId = "another-provenance-account";
        if (field === "workspace") binding.account.workspaceId = "another-provenance-workspace";
        if (field === "source-digest") binding.sourceDigest = "0".repeat(64);
        if (field === "authority-digest") binding.authorityDigest = "0".repeat(64);
      });
      expect(inspect(seal()).status).toBe("unavailable");
    });
  it("does not mistake a self-consistent new encrypted subject for a current authenticated subject", () => {
    bindingEdit(binding => { binding.googleSub = "different-google-subject"; }, true);
    expect(inspect(seal())).toEqual({ status: "unavailable", reason: "subject-mismatch" });
  });
  it.each(["bot", "memory-bot", "thread", "task", "duplicate-thread", "extra-binding-field"])
    ("rejects %s inventory/binding mismatches despite recomputed digests and outer verification", mutation => {
      if (mutation === "memory-bot") {
        const memory = JSON.parse(entryText("memory.json")); memory.bots[0].botId = "another-bot";
        replace("memory.json", JSON.stringify(memory));
      }
      bindingEdit(binding => {
        if (mutation === "bot") binding.inventory.botIds = ["another-bot"];
        if (mutation === "thread") binding.inventory.threadIds = ["another-thread"];
        if (mutation === "task") binding.inventory.taskIds = ["extra-task"];
        if (mutation === "duplicate-thread") binding.inventory.threadIds.push(binding.inventory.threadIds[0]!);
        if (mutation === "extra-binding-field") Object.assign(binding, { userAuthority: "invented" });
      }, true);
      expect(inspect(seal()).status).toBe("unavailable");
    });
  it.each(["extra-file", "missing-file", "duplicate-file", "whole-install-transcript", "skipped", "truncated-skips"])
    ("refuses %s instead of presenting partial or full-state data as a ready projection", mutation => {
      if (mutation === "extra-file") payload.files.push({ path: "config.json", size: 2, bodyB64: "e30=", sha256: accountBundleHash("{}") });
      if (mutation === "missing-file") payload.files = payload.files.filter(file => file.path !== "settings.json");
      if (mutation === "duplicate-file") payload.files[0] = structuredClone(payload.files[1]!);
      if (mutation === "whole-install-transcript") payload.transcripts.method = "vacuum-into";
      if (mutation === "skipped") payload.skipped = [{ path: "config.json", reason: "outside-subset" }];
      if (mutation === "truncated-skips") payload.skippedTruncated = true;
      expect(inspect(seal())).toEqual({ status: "unavailable", reason: "bundle-invalid" });
    });
  it.each(["parser", "body", "manifest", "header", "ciphertext", "utf8"])("rejects %s corruption", mutation => {
    if (mutation === "parser") {
      replace("tasks.json", "{malformed-json"); bindingEdit(() => {}, true);
      expect(inspect(seal())).toEqual({ status: "unavailable", reason: "projection-invalid" }); return;
    }
    if (mutation === "utf8") {
      const invalid = Buffer.from([0xff]);
      Object.assign(payload.files.find(file => file.path === "soul.md")!, { size: 1, bodyB64: invalid.toString("base64"), sha256: accountBundleHash(invalid) });
      expect(inspect(seal())).toEqual({ status: "unavailable", reason: "bundle-invalid" }); return;
    }
    if (mutation === "body") payload.files[0]!.bodyB64 = Buffer.from("modified").toString("base64");
    if (mutation === "manifest") payload.manifestSha256 = "0".repeat(64);
    if (mutation === "body" || mutation === "manifest") {
      expect(inspect(encryptBundleV2(payload, key)).status).toBe("unavailable"); return;
    }
    const envelope = JSON.parse(bytes.toString("utf8"));
    if (mutation === "header") envelope.createdAt += 1;
    else envelope.ciphertextB64 = (envelope.ciphertextB64[0] === "A" ? "B" : "A") + envelope.ciphertextB64.slice(1);
    expect(inspect(Buffer.from(JSON.stringify(envelope)))).toEqual({ status: "unavailable", reason: "bundle-invalid" });
  });
  it("requires user-held custody and refuses missing, wrong and ambiguous keys", () => {
    expect(inspectAccountVisibleRestore({ bytes, key: { custody: "user-held" }, resolveAccount: () => currentAuthority }))
      .toEqual({ status: "unavailable", reason: "key-unavailable" });
    expect(inspectAccountVisibleRestore({ bytes, key: { custody: "user-held", passphrase: "incorrect-user-key" }, resolveAccount: () => currentAuthority }))
      .toEqual({ status: "unavailable", reason: "bundle-invalid" });
    expect(inspectAccountVisibleRestore({ bytes, key: { custody: "user-held", passphrase: key.passphrase, recoveryCode: "0000-0000-0000-0000" }, resolveAccount: () => currentAuthority }))
      .toEqual({ status: "unavailable", reason: "key-unavailable" });
    // SAFETY: The intentionally invalid synthetic custody tag exercises runtime refusal; it never becomes accepted recovery material.
    const badKey = { ...key, custody: "deployment-held" } as never;
    expect(inspectAccountVisibleRestore({ bytes, key: badKey, resolveAccount: () => currentAuthority }))
      .toEqual({ status: "unavailable", reason: "key-unavailable" });
  });
  it.each(["self-parent", "multi-node"])("rejects %s cycles through actual decryption with recomputed source/binding hashes", mutation => {
    const sessions = JSON.parse(entryText("sessions.json"));
    const first = sessions.threads[0].messages[0];
    first.parentId = mutation === "self-parent" ? first.id : "second-message";
    if (mutation === "multi-node") sessions.threads[0].messages.push({ ...first, id: "second-message", parentId: first.id });
    replace("sessions.json", JSON.stringify(sessions)); bindingEdit(() => {}, true);
    const encrypted = seal();
    expect(decryptBundleV2(encrypted, { passphrase: key.passphrase }).status).toBe("ok");
    expect(inspect(encrypted)).toEqual({ status: "unavailable", reason: "projection-invalid" });
  });
  it("inspects a long valid reverse-ordered history without recursive ancestor traversal", () => {
    const sessions = JSON.parse(entryText("sessions.json"));
    const messages = Array.from({ length: 20_000 }, (_, index) => ({
      id: `chain-${index}`, role: "user", kind: "text", at: index, text: "",
      parentId: index === 0 ? null : `chain-${index - 1}`,
    }));
    // The first visit must walk the complete chain, beyond normal call-stack
    // depth; later visits must reuse resolved nodes rather than rescan it.
    sessions.threads[0].messages = messages.reverse();
    replace("sessions.json", JSON.stringify(sessions)); bindingEdit(() => {}, true);
    const restored = inspect(seal());
    expect(restored.status).toBe("ready");
    if (restored.status !== "ready") throw new Error("Expected long valid projection");
    expect(restored.projection.documents.sessions.threads[0]?.messages).toHaveLength(20_000);
  });
  it("opens actual recovery slots and refuses wrong recovery codes without a passphrase fallback", () => {
    const codes = generateRecoveryCodes(2);
    const recoveryBytes = encryptBundleV2(payload, { ...key, recovery: { codes: [codes[0]!] } });
    expect(inspectAccountVisibleRestore({ bytes: recoveryBytes, key: { custody: "user-held", recoveryCode: codes[0] },
      resolveAccount: () => currentAuthority }).status).toBe("ready");
    expect(inspectAccountVisibleRestore({ bytes: recoveryBytes, key: { custody: "user-held", recoveryCode: codes[1] },
      resolveAccount: () => currentAuthority })).toEqual({ status: "unavailable", reason: "bundle-invalid" });
  });
  it("bounds input before parsing/decryption and leaves bundle/source directories unchanged", () => {
    expect(inspect(Buffer.alloc(MAX_ACCOUNT_BUNDLE_BYTES + 1))).toEqual({ status: "unavailable", reason: "bundle-invalid" });
    expect(inspect(Buffer.alloc(0))).toEqual({ status: "unavailable", reason: "bundle-invalid" });
    const original = Buffer.from(bytes);
    const path = join(root, "workspaces", bot.id, "MEMORY.md"); const memory = readFileSync(path);
    const names = readdirSync(root);
    expect(inspect().status).toBe("ready");
    expect(bytes).toEqual(original); expect(readFileSync(path)).toEqual(memory); expect(readdirSync(root)).toEqual(names);
  });
  it("refuses compressed oversized plaintext even when outer v2 crypto and manifest are correct", () => {
    replace("soul.md", "x".repeat(17 * 1024 * 1024 + 1));
    expect(inspect(seal())).toEqual({ status: "unavailable", reason: "bundle-invalid" });
  });
});
