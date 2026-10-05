// Portable account projection only. The host supplies live session/membership
// and verified Google identity readers; encrypted metadata is never authority.
// No installation builder, route, Drive client, staging or restore writer.
import { createHash } from "node:crypto";
import { z } from "zod";

import { readAccountVisibleSource, type AccountVisibleSourceInput } from "./drive-visible-data-source.ts";
import { type VisibleFilesOutput } from "./drive-visible-producers.ts";
import { parseVisibleFiles, VISIBLE_FILE_NAMES, type ParseSuccess } from "./drive-visible.ts";
import type { FollowUpAccount } from "./follow-up-identity.ts";
import { BUNDLE_SCHEMA, encryptBundleV2, manifestDigest, normalizeRecoveryCode,
  type BundleFileEntry, type BundlePayloadV2, type EncryptBundleV2Options } from "./workspace-bundle-v2.ts";

export const ACCOUNT_BINDING_FILE = "account-binding.json";
export const MAX_ACCOUNT_PROJECTION_BYTES = 16 * 1024 * 1024;
export const MAX_ACCOUNT_BINDING_BYTES = 1024 * 1024;
export const MAX_ACCOUNT_BUNDLE_BYTES = 24 * 1024 * 1024;
export const ACCOUNT_TRANSCRIPT_METHOD = "unsupported:account-visible-projection";
/** A projection cannot recreate original runtime records from their lossy
 * visible representations. In particular group membership is not in them. */
export const ACCOUNT_PROJECTION_UNSUPPORTED = [
  "original-store-records-ownership-and-organization-partitions",
  "group-membership-and-runtime-transport",
  "active-transcript-branch-heads-and-engine-state",
  "provider-keys-credentials-and-resume-cursors",
  "attachments-and-full-installation-state",
  "runtime-apply",
] as const;

const id = z.string().min(1).max(200);
const recordId = id.regex(/^[\w-]+$/);
const ids = (schema: typeof id, localeOrder = false) => z.array(schema).max(32_768)
  .refine(values => new Set(values).size === values.length)
  .refine(values => values.every((value, index) => index === 0
    || (localeOrder ? values[index - 1]!.localeCompare(value) < 0 : values[index - 1]! < value)));
const accountSchema = z.object({ userId: id, workspaceId: id }).strict();
const liveAccountSchema = accountSchema.extend({ sessionId: id, isPrimary: z.boolean() }).strict();
const resolvedAccountSchema = z.object({
  account: liveAccountSchema,
  googleSub: z.string().min(1).max(1024),
}).strict();
const inventorySchema = z.object({
  botIds: ids(recordId), groupIds: ids(recordId), threadIds: ids(recordId), taskIds: ids(id, true),
}).strict();
const filesSchema = z.object({
  "soul.md": z.string(), "memory.json": z.string(), "sessions.json": z.string(),
  "tasks.json": z.string(), "settings.json": z.string(),
}).strict().refine(files => Object.values(files).reduce((total, text) => total + Buffer.byteLength(text), 0) <= MAX_ACCOUNT_PROJECTION_BYTES)
  .refine(files => Object.values(files).every(text => Buffer.from(text, "utf8").toString("utf8") === text));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({
  status: z.literal("ready"), scope: z.literal("account-owned"), account: accountSchema,
  inventory: inventorySchema, files: filesSchema, documents: z.unknown(),
  droppedSettings: z.array(z.string().max(200)).max(4096), digest,
}).strict();
type AccountProjectionInput = z.input<typeof sourceSchema>;
const encryptionKeySchema = z.object({
  custody: z.literal("user-held"), passphrase: z.string().min(8).max(4096),
  recovery: z.object({ codes: z.array(z.string().max(128).refine(code => normalizeRecoveryCode(code) !== null))
    .min(1).max(16).refine(codes => new Set(codes.map(normalizeRecoveryCode)).size === codes.length) }).optional(),
});
export const accountBindingSchema = z.object({
  version: z.literal(1), kind: z.literal("muster-account-visible"), scope: z.literal("account-owned"),
  account: accountSchema, googleSub: z.string().min(1).max(1024), inventory: inventorySchema,
  sourceDigest: digest,
  /** Content binding, not an authentication proof. Authorization comes only
   * from the host's live resolveAccount port, on every operation. */
  authorityDigest: digest,
}).strict();
export type AccountBundleBinding = z.infer<typeof accountBindingSchema>;
export type AccountInventory = AccountBundleBinding["inventory"];

/** Must be read from the authenticated host session/membership and verified
 * Google identity, never request fields or encrypted client metadata. */
export interface AuthenticatedVisibleAccount {
  readonly account: FollowUpAccount;
  readonly googleSub: string;
}
export type ResolveVisibleAccount = () => AuthenticatedVisibleAccount | null;
/** The host obtains this from user recovery input, never a deployment key.
 * Custody is an API contract; a JS tag cannot prove how the host got a key. */
export interface UserHeldAccountEncryption extends EncryptBundleV2Options {
  custody: "user-held";
}
export interface AccountProjection {
  account: { userId: string; workspaceId: string };
  inventory: AccountInventory;
  files: VisibleFilesOutput["files"];
  documents: ParseSuccess;
  digest: string;
}

export function accountBundleHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const expected = new Set(right);
  return new Set(left).size === left.length && left.length === right.length && left.every(value => expected.has(value));
}
/** The reader's exact byte/account/inventory digest, not a digest of a typed
 * ready flag. Keep its format aligned with readAccountVisibleSource. */
export function accountSourceDigest(account: AccountProjection["account"], inventory: AccountInventory,
  files: VisibleFilesOutput["files"]): string {
  const fileHashes = Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, body]) => ({ name, sha256: accountBundleHash(body) }));
  return accountBundleHash(JSON.stringify({ version: 1, account, inventory, fileHashes }));
}
export function accountAuthorityDigest(binding: Omit<AccountBundleBinding, "authorityDigest">): string {
  return accountBundleHash(JSON.stringify({ version: binding.version, kind: binding.kind, scope: binding.scope,
    account: binding.account, googleSub: binding.googleSub, inventory: binding.inventory, sourceDigest: binding.sourceDigest }));
}

/** Reparse all five real files, then reconcile their identities with the
 * captured inventory. Group IDs are provenance only: their original members
 * and ownership are not representable in the five-file format. */
export function inspectAccountProjection(value: AccountProjectionInput): AccountProjection | null {
  try {
    const source = sourceSchema.safeParse(value);
    if (!source.success) return null;
    const { account, inventory, files } = source.data;
    const documents = parseVisibleFiles(files);
    if (!documents.ok || JSON.stringify(documents) !== JSON.stringify(source.data.documents)
      || !sameIds(documents.soul.personas.map(persona => persona.botId), inventory.botIds)
      || !sameIds(documents.memory.bots.map(bot => bot.botId), inventory.botIds)
      || !sameIds(documents.sessions.threads.map(thread => thread.threadId), inventory.threadIds)
      || !sameIds(documents.tasks.tasks.map(task => task.id), inventory.taskIds)
      || accountSourceDigest(account, inventory, files) !== source.data.digest) return null;
    for (const thread of documents.sessions.threads) {
      const parents = new Map(thread.messages.map(message => [message.id, message.parentId]));
      if (parents.size !== thread.messages.length
        || thread.messages.some(message => message.parentId !== null && !parents.has(message.parentId))) return null;
      // Each node enters a path once, then becomes resolved. Iterative traversal
      // rejects self/multi-node cycles without recursion or repeated ancestor
      // scans; long valid histories cannot exhaust the JavaScript call stack.
      const resolved = new Set<string>();
      for (const id of parents.keys()) {
        const path = new Set<string>();
        let current: string | null = id;
        while (current !== null && !resolved.has(current)) {
          if (path.has(current)) return null;
          path.add(current);
          current = parents.get(current)!; // Every non-null parent was checked above.
        }
        for (const visited of path) resolved.add(visited);
      }
    }
    return { account, inventory, files, documents, digest: source.data.digest };
  } catch { return null; }
}

export function resolveAuthenticatedVisibleAccount(resolveAccount: ResolveVisibleAccount): AuthenticatedVisibleAccount | null {
  try {
    const parsed = resolvedAccountSchema.safeParse(resolveAccount());
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export function sameVisibleAuthority(left: AuthenticatedVisibleAccount, right: AuthenticatedVisibleAccount | null): boolean {
  return right !== null && left.googleSub === right.googleSub && sameAccount(left.account, right.account);
}
function sameAccount(left: FollowUpAccount, right: FollowUpAccount): boolean {
  return left.userId === right.userId && left.workspaceId === right.workspaceId && left.sessionId === right.sessionId
    && left.isPrimary === right.isPrimary;
}
function encryptionKeyValid(key: UserHeldAccountEncryption): boolean {
  return encryptionKeySchema.safeParse(key).success;
}
function fileEntry(path: string, text: string): BundleFileEntry {
  const bytes = Buffer.from(text, "utf8");
  return { path, size: bytes.byteLength, sha256: accountBundleHash(bytes), bodyB64: bytes.toString("base64") };
}

export type AccountBundleResult =
  | { status: "unavailable"; reason: "account-unavailable" | "account-changed" | "key-unavailable" | "source-unavailable" | "projection-invalid" | "bundle-unavailable" }
  | { status: "ready"; bytes: Buffer; binding: AccountBundleBinding; unsupported: typeof ACCOUNT_PROJECTION_UNSUPPORTED };

/** Reads actual account-owned source, validates its bytes again, then seals
 * exactly five visible files plus a strict encrypted binding manifest entry.
 * There is no buildPayloadV2, source write, staging or network operation. */
export function buildAccountVisibleBundle(input: {
  source: AccountVisibleSourceInput;
  resolveAccount: ResolveVisibleAccount;
  key: UserHeldAccountEncryption;
  appVersion: string;
}): AccountBundleResult {
  const authority = resolveAuthenticatedVisibleAccount(input.resolveAccount);
  if (!authority) return { status: "unavailable", reason: "account-unavailable" };
  const offeredAccount = liveAccountSchema.safeParse(input.source.account);
  if (!offeredAccount.success || !sameAccount(authority.account, offeredAccount.data)) return { status: "unavailable", reason: "account-changed" };
  if (!encryptionKeyValid(input.key)) return { status: "unavailable", reason: "key-unavailable" };
  const source = readAccountVisibleSource(input.source);
  if (source.status !== "ready") return { status: "unavailable", reason: "source-unavailable" };
  const projection = inspectAccountProjection(source);
  if (!projection) return { status: "unavailable", reason: "projection-invalid" };
  if (!sameVisibleAuthority(authority, resolveAuthenticatedVisibleAccount(input.resolveAccount))) {
    return { status: "unavailable", reason: "account-changed" };
  }
  const unsigned = { version: 1, kind: "muster-account-visible", scope: "account-owned",
    account: projection.account, googleSub: authority.googleSub, inventory: projection.inventory,
    sourceDigest: projection.digest } as const;
  const binding = accountBindingSchema.parse({ ...unsigned, authorityDigest: accountAuthorityDigest(unsigned) });
  const bindingText = JSON.stringify(binding);
  if (Buffer.byteLength(bindingText) > MAX_ACCOUNT_BINDING_BYTES) return { status: "unavailable", reason: "projection-invalid" };
  const files = [...Object.values(VISIBLE_FILE_NAMES).map(name => fileEntry(name, projection.files[name])), fileEntry(ACCOUNT_BINDING_FILE, bindingText)];
  const payload: BundlePayloadV2 = {
    schema: BUNDLE_SCHEMA, appVersion: input.appVersion,
    counts: { files: files.length, messages: 0, threads: 0, totalBytes: files.reduce((total, file) => total + file.size, 0) },
    files, skipped: [], skippedTruncated: false, manifestSha256: manifestDigest(files),
    transcripts: { method: ACCOUNT_TRANSCRIPT_METHOD, threads: [], counts: { threads: 0, messages: 0 } },
  };
  try {
    const bytes = encryptBundleV2(payload, input.key);
    if (bytes.byteLength > MAX_ACCOUNT_BUNDLE_BYTES) return { status: "unavailable", reason: "bundle-unavailable" };
    if (!sameVisibleAuthority(authority, resolveAuthenticatedVisibleAccount(input.resolveAccount))) {
      return { status: "unavailable", reason: "account-changed" };
    }
    return { status: "ready", bytes, binding, unsupported: ACCOUNT_PROJECTION_UNSUPPORTED };
  } catch { return { status: "unavailable", reason: "bundle-unavailable" }; }
}
