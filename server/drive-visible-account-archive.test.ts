import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAccountRecoveryArchive, inspectAccountRecoveryArchive, ACCOUNT_RECOVERY_FILE, MAX_ACCOUNT_RECOVERY_ARCHIVE_BYTES } from "./drive-visible-account-archive.ts";
import { recoveryCanonicalJson, recoveryStateDigest, type AccountRecoverySourceInput } from "./drive-visible-account-state.ts";
import { type UserHeldAccountEncryption, accountBundleHash, buildAccountVisibleBundle } from "./drive-visible-account-bundle.ts";
import { decryptBundleV2, encryptBundleV2, manifestDigest, verifyBundleV2, generateRecoveryCodes, type BundlePayloadV2 } from "./workspace-bundle-v2.ts";
import { type BotRecord, type Message } from "./store.ts";
const account = { userId: "old-user", workspaceId: "old-org", sessionId: "old-session", isPrimary: false };
const authority = { account, googleSub: "verified-google-sub" };
const fresh = { account: { userId: "new-user", workspaceId: "new-org", sessionId: "new-session", isPrimary: false }, googleSub: authority.googleSub };
const key: UserHeldAccountEncryption = { custody: "user-held", passphrase: "synthetic-user-recovery-passphrase", kdf: { name: "scrypt", N: 16384, r: 8, p: 1, keyLen: 32, saltB64: "" } };
const bot: BotRecord = { id: "own", ownerId: account.userId, threadId: "own-thread", name: "Own", title: "Title", description: "Persona", color: "green",
  notifications: false, unread: false, createdAt: 1, tasks: [{ threadId: "own-thread", title: "Task", createdAt: 1, resumeCursors: {} }],
  modelSelection: { instanceId: "excluded-old-instance", model: "test" }, resumeCursors: { token: "EXCLUDED-RESUME" } };
let directory: string; let source: AccountRecoverySourceInput;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "muster-account-archive-"));
  mkdirSync(join(directory, "workspaces", "own"), { recursive: true }); writeFileSync(join(directory, "workspaces", "own", "MEMORY.md"), "Original memory");
  const rows: Message[] = [{ id: "root", role: "user", kind: "text", at: 1, parentId: null, text: "Original conversation" },
    { id: "selected-old", role: "bot", kind: "screen", at: 2, parentId: "root", png: "AA==", mime: "image/png", text: "Rich selected branch" },
    { id: "newer-fork", role: "bot", kind: "activity", at: 3, parentId: "root", tool: { name: "Historical tool", ok: true } }];
  source = { account, dataDir: directory, settingsSnapshot: { userId: account.userId, workspaceId: account.workspaceId, values: { theme: "dark" } },
    store: { bots: [structuredClone(bot)], groups: [], snapshotThread: () => ({ status: "ready", source: "sqlite", messages: structuredClone(rows), activeLeafId: "selected-old" }) },
    plans: { listPlans: () => [], transitionsFor: () => [] } };
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const build = (overrides: Partial<Parameters<typeof buildAccountRecoveryArchive>[0]> = {}) => buildAccountRecoveryArchive({ source, resolveAccount: () => authority, key, appVersion: "1.15.0", ...overrides });
const ready = () => { const result = build(); if (result.status !== "ready") throw new Error(JSON.stringify(result)); return result; };
function payloadOf(bytes: Buffer) { const opened = decryptBundleV2(bytes, { passphrase: key.passphrase }); if (!opened.payload) throw new Error("No payload"); return opened.payload; }
function replaceBody(payload: BundlePayloadV2, name: string, text: string) {
  const file = payload.files.find(file => file.path === name)!; const body = Buffer.from(text);
  Object.assign(file, { bodyB64: body.toString("base64"), size: body.length, sha256: accountBundleHash(body) });
}
function reseal(payload: BundlePayloadV2) {
  payload.counts.files = payload.files.length; payload.counts.totalBytes = payload.files.reduce((total, file) => total + file.size, 0);
  payload.manifestSha256 = manifestDigest(payload.files); return encryptBundleV2(payload, key);
}
const inspect = (bytes: Buffer, overrides: Partial<Parameters<typeof inspectAccountRecoveryArchive>[0]> = {}) =>
  inspectAccountRecoveryArchive({ bytes, key: { custody: "user-held", passphrase: key.passphrase }, resolveAccount: () => fresh, ...overrides });

describe("actual v2 complete-account recovery archive", () => {
  it("uses real authenticated encryption and verification with rich rows and original selected head", () => {
    const result = ready(); const opened = payloadOf(result.bytes);
    const verified = verifyBundleV2(result.bytes, { passphrase: key.passphrase }); expect(verified.status).toBe("ok"); expect(verified.checks.every(check => check.ok)).toBe(true);
    expect(opened.files.map(file => file.path).sort()).toEqual([ACCOUNT_RECOVERY_FILE, "memory.json", "sessions.json", "settings.json", "soul.md", "tasks.json"].sort());
    expect(opened.transcripts).toMatchObject({ method: "account-recovery-snapshot-v1", counts: { messages: 3, threads: 1 }, threads: [{ activeLeafId: "selected-old" }] });
    const resultState = inspect(result.bytes);
    if (resultState.status !== "ready") throw new Error(JSON.stringify(resultState));
    expect(resultState.state.threads[0]!.messages).toMatchObject([{ id: "root" }, { id: "selected-old", png: "AA==" }, { id: "newer-fork", tool: { ok: true } }]);
    expect(resultState).toMatchObject({ apply: "unsupported", account: fresh.account, googleSub: fresh.googleSub });
    expect(resultState.state.source.userId).toBe(account.userId);
    expect(result.bytes.toString()).not.toContain("Original conversation"); expect(result.bytes.toString()).not.toContain(authority.googleSub);
    expect(JSON.stringify(opened)).not.toContain("EXCLUDED-RESUME");
  });
  it("uses the actual user recovery code without any original installation secret", () => {
    const codes = generateRecoveryCodes(1); const result = build({ key: { ...key, recovery: { codes } } });
    if (result.status !== "ready") throw new Error("No archive");
    expect(inspect(result.bytes, { key: { custody: "user-held", recoveryCode: codes[0] } }).status).toBe("ready");
    expect(inspect(result.bytes, { key: { custody: "user-held", passphrase: "wrong-user-secret" } }).status).toBe("unavailable");
  });
  it("rejects tamper, truncation, oversized input and malformed user keys", () => {
    const result = ready(); const envelope = JSON.parse(result.bytes.toString()); envelope.createdAt++;
    expect(inspect(Buffer.from(JSON.stringify(envelope))).status).toBe("unavailable"); expect(inspect(result.bytes.subarray(0, 100)).status).toBe("unavailable");
    expect(inspect(Buffer.alloc(MAX_ACCOUNT_RECOVERY_ARCHIVE_BYTES + 1)).status).toBe("unavailable");
    expect(inspect(result.bytes, { key: JSON.parse("{}") })).toEqual({ status: "unavailable", reason: "key-unavailable" });
    expect(inspect(result.bytes, { key: { custody: "user-held", passphrase: "short" } }).status).toBe("unavailable");
  });
  it("requires real current Google-subject authority and detects revocation after decrypt", () => {
    const result = ready();
    expect(inspect(result.bytes, { resolveAccount: () => ({ ...fresh, googleSub: "other-verified-sub" }) }).status).toBe("unavailable");
    expect(inspect(result.bytes, { resolveAccount: () => null })).toEqual({ status: "unavailable", reason: "account-unavailable" });
    expect(inspect(result.bytes, { resolveAccount: vi.fn().mockReturnValueOnce(fresh).mockReturnValue(null) })).toEqual({ status: "unavailable", reason: "account-changed" });
  });
  it.each(["extra", "missing", "duplicate", "method", "skipped", "projection", "transcript-text", "transcript-head", "counts", "state-inventory", "state-digest", "state-credential", "state-driver", "state-cycle"])
    ("rejects coherently re-encrypted %s discrepancies", mutation => {
      const original = ready(); const payload = payloadOf(original.bytes);
      if (mutation === "extra") payload.files.push({ ...payload.files[0]!, path: "extra.json" });
      if (mutation === "missing") payload.files.pop();
      if (mutation === "duplicate") payload.files[0]!.path = payload.files[1]!.path;
      if (mutation === "method") payload.transcripts.method = "vacuum-into";
      if (mutation === "skipped") payload.skipped.push({ path: "bots.json", reason: "unsupported" });
      if (mutation === "projection") replaceBody(payload, "settings.json", '{"kind":"settings","schemaVersion":1,"settings":{"theme":"changed"}}');
      if (mutation === "transcript-text") payload.transcripts.threads[0]!.messages[0]!.text = "Changed";
      if (mutation === "transcript-head") payload.transcripts.threads[0]!.activeLeafId = "newer-fork";
      if (mutation === "counts") payload.counts.messages++;
      if (mutation.startsWith("state-")) {
        const state = JSON.parse(Buffer.from(payload.files.find(file => file.path === ACCOUNT_RECOVERY_FILE)!.bodyB64, "base64").toString());
        if (mutation === "state-inventory") state.inventory.groupIds.push("unknown");
        if (mutation === "state-digest") state.sourceDigest = "0".repeat(64);
        if (mutation === "state-credential") state.threads[0].messages[0].tool = { client_secret: "SYNTHETIC-SECRET" };
        if (mutation === "state-cycle") state.threads[0].messages[0].parentId = "selected-old";
        if (mutation === "state-driver") {
          state.threads[0].messages[0].card = { title: "Historical", subtitle: "Display", options: ["Yes"], driver: { env: { TOKEN: "SYNTHETIC-PRIVATE" }, proxy: { url: "http://synthetic.invalid" } } };
          payload.transcripts.threads[0]!.messages[0]!.json = recoveryCanonicalJson(state.threads[0].messages[0]);
        }
        if (mutation !== "state-digest") state.sourceDigest = recoveryStateDigest(state);
        replaceBody(payload, ACCOUNT_RECOVERY_FILE, JSON.stringify(state));
      }
      const changed = reseal(payload);
      if (mutation === "state-driver") expect(verifyBundleV2(changed, { passphrase: key.passphrase }).status).toBe("ok");
      expect(inspect(changed).status).toBe("unavailable");
    });
  it("distinguishes older lossy projection from this complete safe-record format", () => {
    const projection = buildAccountVisibleBundle({ source, resolveAccount: () => authority, key, appVersion: "1.15.0" });
    if (projection.status !== "ready") throw new Error("No projection"); expect(inspect(projection.bytes).status).toBe("unavailable");
  });
  it("fails closed on missing source/preferences and deployment-held material", () => {
    expect(build({ source: { ...source, settingsSnapshot: null } }).status).toBe("unavailable");
    expect(build({ key: JSON.parse(JSON.stringify({ ...key, custody: "deployment-held" })) })).toEqual({ status: "unavailable", reason: "key-unavailable" });
    expect(build({ resolveAccount: () => ({ ...authority, account: fresh.account }) }).status).toBe("unavailable");
    expect(build({ appVersion: "" }).status).toBe("unavailable");
  });
  it("does not write source, create staging, alter snapshots or call a remote client", () => {
    const memory = join(directory, "workspaces", "own", "MEMORY.md"); const body = readFileSync(memory), before = statSync(memory), names = readdirSync(directory);
    const records = JSON.stringify(source.store.bots); const archive = ready(); expect(inspect(archive.bytes).status).toBe("ready");
    expect(JSON.stringify(source.store.bots)).toBe(records); expect(readFileSync(memory)).toEqual(body); expect(statSync(memory).ino).toBe(before.ino);
    expect(statSync(memory).mtimeMs).toBe(before.mtimeMs); expect(readdirSync(directory)).toEqual(names);
  });
});
