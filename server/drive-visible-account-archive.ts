// Complete safe account archive preparation. No Drive IO, routes, staging,
// installation secret or restore writer. Old portable projections remain valid
// in their own reader; they are deliberately not called full account archives.
import { z } from "zod";
import { accountBundleHash, resolveAuthenticatedVisibleAccount, sameVisibleAuthority,
  type ResolveVisibleAccount, type UserHeldAccountEncryption } from "./drive-visible-account-bundle.ts";
import { VISIBLE_FILE_NAMES } from "./drive-visible.ts";
import { BUNDLE_SCHEMA, encryptBundleV2, decryptBundleV2, manifestDigest, normalizeRecoveryCode,
  type BundleFileEntry, type BundlePayloadV2 } from "./workspace-bundle-v2.ts";
import type { UserHeldAccountDecryption } from "./drive-visible-restore.ts";
import { ACCOUNT_RECOVERY_EXCLUDES, MAX_RECOVERY_STATE_BYTES, captureAccountRecoveryState,
  inspectAccountRecoveryState, recoveryCanonicalJson, type AccountRecoveryState,
  type AccountRecoverySourceInput } from "./drive-visible-account-state.ts";

export const ACCOUNT_RECOVERY_FILE = "account-recovery.json";
export const ACCOUNT_RECOVERY_TRANSCRIPTS = "account-recovery-snapshot-v1";
export const MAX_ACCOUNT_RECOVERY_ARCHIVE_BYTES = 48 * 1024 * 1024;
const keySchema = z.object({ custody: z.literal("user-held"), passphrase: z.string().min(8).max(4096),
  recovery: z.object({ codes: z.array(z.string().max(128).refine(code => normalizeRecoveryCode(code) !== null))
    .min(1).max(16).refine(codes => new Set(codes.map(normalizeRecoveryCode)).size === codes.length) }).optional() });
function entry(path: string, body: string): BundleFileEntry {
  const bytes = Buffer.from(body, "utf8");
  return { path, size: bytes.byteLength, sha256: accountBundleHash(bytes), bodyB64: bytes.toString("base64") };
}
function transcripts(state: AccountRecoveryState): BundlePayloadV2["transcripts"] {
  return { method: ACCOUNT_RECOVERY_TRANSCRIPTS, threads: state.threads.map(thread => ({
    threadId: thread.threadId, activeLeafId: thread.activeLeafId,
    messages: thread.messages.map((message, seq) => ({ seq, id: message.id, at: message.at, role: message.role,
      kind: message.kind, text: message.text ?? null, json: recoveryCanonicalJson(message) })),
  })), counts: { threads: state.threads.length, messages: state.threads.reduce((total, thread) => total + thread.messages.length, 0) } };
}
export type AccountArchiveUnavailable = { status: "unavailable"; reason:
  "account-unavailable" | "account-changed" | "key-unavailable" | "source-unavailable" | "archive-invalid" | "archive-unavailable" };

export function buildAccountRecoveryArchive(input: {
  source: AccountRecoverySourceInput; resolveAccount: ResolveVisibleAccount;
  key: UserHeldAccountEncryption; appVersion: string;
}): AccountArchiveUnavailable | { status: "ready"; bytes: Buffer; sourceDigest: string; excludes: typeof ACCOUNT_RECOVERY_EXCLUDES } {
  const authority = resolveAuthenticatedVisibleAccount(input.resolveAccount);
  if (!authority) return { status: "unavailable", reason: "account-unavailable" };
  if (!keySchema.safeParse(input.key).success) return { status: "unavailable", reason: "key-unavailable" };
  const captured = captureAccountRecoveryState(input);
  if (captured.status !== "ready") return { status: "unavailable", reason: captured.reason === "account-changed" ? "account-changed" : "source-unavailable" };
  if (!sameVisibleAuthority(authority, resolveAuthenticatedVisibleAccount(input.resolveAccount))) return { status: "unavailable", reason: "account-changed" };
  try {
    const state = captured.state;
    const files = [...Object.values(VISIBLE_FILE_NAMES).map(name => entry(name, state.files[name])), entry(ACCOUNT_RECOVERY_FILE, recoveryCanonicalJson(state))];
    const transcript = transcripts(state);
    const payload: BundlePayloadV2 = { schema: BUNDLE_SCHEMA, appVersion: input.appVersion,
      counts: { files: files.length, messages: transcript.counts.messages, threads: transcript.counts.threads,
        totalBytes: files.reduce((total, file) => total + file.size, 0) }, files, skipped: [], skippedTruncated: false,
      manifestSha256: manifestDigest(files), transcripts: transcript };
    const bytes = encryptBundleV2(payload, input.key);
    if (bytes.byteLength > MAX_ACCOUNT_RECOVERY_ARCHIVE_BYTES) return { status: "unavailable", reason: "archive-unavailable" };
    if (!sameVisibleAuthority(authority, resolveAuthenticatedVisibleAccount(input.resolveAccount))) return { status: "unavailable", reason: "account-changed" };
    return { status: "ready", bytes, sourceDigest: state.sourceDigest, excludes: ACCOUNT_RECOVERY_EXCLUDES };
  } catch { return { status: "unavailable", reason: "archive-unavailable" }; }
}

/** The real codec verifies AEAD, file bodies, manifest, counts and links. This
 * stricter account format then reconciles both copies of every transcript and
 * the five real parser outputs. A recomputed digest is not authorization. */
export function inspectAccountRecoveryArchive(input: {
  bytes: Buffer; key: UserHeldAccountDecryption; resolveAccount: ResolveVisibleAccount;
}): AccountArchiveUnavailable | { status: "ready"; state: AccountRecoveryState;
  account: NonNullable<ReturnType<typeof resolveAuthenticatedVisibleAccount>>["account"];
  googleSub: string; apply: "unsupported"; excludes: typeof ACCOUNT_RECOVERY_EXCLUDES } {
  const authority = resolveAuthenticatedVisibleAccount(input.resolveAccount);
  if (!authority) return { status: "unavailable", reason: "account-unavailable" };
  try {
    if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength > MAX_ACCOUNT_RECOVERY_ARCHIVE_BYTES) return { status: "unavailable", reason: "archive-invalid" };
    const keyValid = z.object({ custody: z.literal("user-held"), passphrase: z.string().min(8).max(4096).optional(),
      recoveryCode: z.string().max(128).refine(code => normalizeRecoveryCode(code) !== null).optional() }).strict()
      .refine(key => Boolean(key.passphrase) !== Boolean(key.recoveryCode)).safeParse(input.key);
    if (!keyValid.success) return { status: "unavailable", reason: "key-unavailable" };
    const opened = decryptBundleV2(input.bytes, keyValid.data);
    if (opened.status !== "ok" || !opened.payload) return { status: "unavailable", reason: "archive-invalid" };
    const payload = opened.payload;
    const expected = [...Object.values(VISIBLE_FILE_NAMES), ACCOUNT_RECOVERY_FILE].sort();
    if (payload.skipped.length || payload.skippedTruncated || payload.files.length !== expected.length
      || payload.files.map(file => file.path).sort().some((path, index) => path !== expected[index])
      || payload.transcripts.method !== ACCOUNT_RECOVERY_TRANSCRIPTS) return { status: "unavailable", reason: "archive-invalid" };
    const body = (name: string) => {
      const file = payload.files.find(file => file.path === name)!;
      const bytes = Buffer.from(file.bodyB64, "base64");
      if (bytes.byteLength !== file.size || accountBundleHash(bytes) !== file.sha256) throw new Error("Invalid body");
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Invalid encoding");
      return text;
    };
    const stateText = body(ACCOUNT_RECOVERY_FILE);
    if (Buffer.byteLength(stateText) > MAX_RECOVERY_STATE_BYTES) return { status: "unavailable", reason: "archive-invalid" };
    const state = inspectAccountRecoveryState(JSON.parse(stateText));
    if (!state || state.source.googleSub !== authority.googleSub
      || Object.values(VISIBLE_FILE_NAMES).some(name => body(name) !== state.files[name])
      || payload.counts.messages !== transcripts(state).counts.messages || payload.counts.threads !== transcripts(state).counts.threads
      || recoveryCanonicalJson(payload.transcripts) !== recoveryCanonicalJson(transcripts(state))) return { status: "unavailable", reason: "archive-invalid" };
    if (!sameVisibleAuthority(authority, resolveAuthenticatedVisibleAccount(input.resolveAccount))) return { status: "unavailable", reason: "account-changed" };
    return { status: "ready", state, account: authority.account, googleSub: authority.googleSub,
      apply: "unsupported", excludes: ACCOUNT_RECOVERY_EXCLUDES };
  } catch { return { status: "unavailable", reason: "archive-invalid" }; }
}
