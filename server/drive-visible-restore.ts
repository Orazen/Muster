// Decrypt/inspect only. The result is an inert projection; none of the bundle
// metadata grants authority or writes records into a fresh installation.
import { TextDecoder } from "node:util";
import { z } from "zod";

import { parseVisibleFiles, VISIBLE_FILE_NAMES } from "./drive-visible.ts";
import { decryptBundleV2, normalizeRecoveryCode, type DecryptBundleV2Options } from "./workspace-bundle-v2.ts";
import { ACCOUNT_BINDING_FILE, ACCOUNT_PROJECTION_UNSUPPORTED, ACCOUNT_TRANSCRIPT_METHOD,
  MAX_ACCOUNT_BINDING_BYTES, MAX_ACCOUNT_BUNDLE_BYTES, MAX_ACCOUNT_PROJECTION_BYTES,
  accountAuthorityDigest, accountBindingSchema, accountSourceDigest, inspectAccountProjection,
  resolveAuthenticatedVisibleAccount, sameVisibleAuthority,
  type AccountBundleBinding, type AccountProjection, type AuthenticatedVisibleAccount, type ResolveVisibleAccount } from "./drive-visible-account-bundle.ts";
import type { VisibleFilesOutput } from "./drive-visible-producers.ts";

export interface UserHeldAccountDecryption extends DecryptBundleV2Options { custody: "user-held" }
export type AccountRestoreInspection =
  | { status: "unavailable"; reason: "account-unavailable" | "account-changed" | "key-unavailable" | "bundle-invalid" | "subject-mismatch" | "projection-invalid" }
  | { status: "ready"; scope: "account-owned"; apply: "unsupported";
      /** Only the host's current authenticated local account is the target. */
      account: AuthenticatedVisibleAccount["account"]; googleSub: string;
      /** Original local IDs are provenance, never the restored owner. */
      source: AccountBundleBinding; projection: Pick<AccountProjection, "inventory" | "files" | "documents">;
      unsupported: typeof ACCOUNT_PROJECTION_UNSUPPORTED };

const decryptionKeySchema = z.object({ custody: z.literal("user-held"), passphrase: z.string().min(8).max(4096).optional(),
  recoveryCode: z.string().max(128).refine(code => normalizeRecoveryCode(code) !== null).optional(),
}).refine(key => (key.passphrase === undefined) !== (key.recoveryCode === undefined));

/** Uses actual v2 authenticated decryption/manifest verification and the real
 * visible parser. An exact six-entry inventory is required; generic whole
 * installation bundles and partial visible folders are not silently restored.
 * The v2 codec supplies its existing inflated-payload bound; this adapter
 * additionally bounds input bytes, binding bytes and the visible projection. */
export function inspectAccountVisibleRestore(input: {
  bytes: Buffer;
  key: UserHeldAccountDecryption;
  resolveAccount: ResolveVisibleAccount;
}): AccountRestoreInspection {
  const authority = resolveAuthenticatedVisibleAccount(input.resolveAccount);
  if (!authority) return { status: "unavailable", reason: "account-unavailable" };
  if (!decryptionKeySchema.safeParse(input.key).success) return { status: "unavailable", reason: "key-unavailable" };
  if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_ACCOUNT_BUNDLE_BYTES) {
    return { status: "unavailable", reason: "bundle-invalid" };
  }
  const opened = decryptBundleV2(input.bytes, input.key);
  if (opened.status !== "ok" || !opened.payload) return { status: "unavailable", reason: "bundle-invalid" };
  const payload = opened.payload;
  const names = new Set<string>([...Object.values(VISIBLE_FILE_NAMES), ACCOUNT_BINDING_FILE]);
  if (payload.files.length !== names.size || payload.files.some(file => !names.delete(file.path)) || names.size !== 0
    || payload.skipped.length !== 0 || payload.skippedTruncated
    || payload.transcripts.method !== ACCOUNT_TRANSCRIPT_METHOD || payload.transcripts.threads.length !== 0
    || payload.transcripts.counts.threads !== 0 || payload.transcripts.counts.messages !== 0
    || payload.counts.threads !== 0 || payload.counts.messages !== 0
    || payload.counts.totalBytes > MAX_ACCOUNT_PROJECTION_BYTES + MAX_ACCOUNT_BINDING_BYTES) {
    return { status: "unavailable", reason: "bundle-invalid" };
  }
  try {
    const text = (name: string): string => {
      const entry = payload.files.find(file => file.path === name)!;
      const limit = name === ACCOUNT_BINDING_FILE ? MAX_ACCOUNT_BINDING_BYTES : MAX_ACCOUNT_PROJECTION_BYTES;
      if (entry.size > limit) throw new Error("Bound exceeded");
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(entry.bodyB64, "base64"));
    };
    const parsedBinding = accountBindingSchema.safeParse(JSON.parse(text(ACCOUNT_BINDING_FILE)));
    if (!parsedBinding.success) return { status: "unavailable", reason: "bundle-invalid" };
    const binding = parsedBinding.data;
    if (accountAuthorityDigest(binding) !== binding.authorityDigest) return { status: "unavailable", reason: "bundle-invalid" };
    if (binding.googleSub !== authority.googleSub) return { status: "unavailable", reason: "subject-mismatch" };
    const files = { "soul.md": text("soul.md"), "memory.json": text("memory.json"), "sessions.json": text("sessions.json"),
      "tasks.json": text("tasks.json"), "settings.json": text("settings.json") } satisfies VisibleFilesOutput["files"];
    const documents = parseVisibleFiles(files);
    if (!documents.ok) return { status: "unavailable", reason: "projection-invalid" };
    const projection = inspectAccountProjection({ status: "ready", scope: binding.scope, account: binding.account,
      inventory: binding.inventory, files, documents, droppedSettings: [], digest: binding.sourceDigest });
    if (!projection || accountSourceDigest(binding.account, binding.inventory, files) !== binding.sourceDigest) {
      return { status: "unavailable", reason: "projection-invalid" };
    }
    if (!sameVisibleAuthority(authority, resolveAuthenticatedVisibleAccount(input.resolveAccount))) {
      return { status: "unavailable", reason: "account-changed" };
    }
    return { status: "ready", scope: "account-owned", apply: "unsupported", account: authority.account,
      googleSub: authority.googleSub, source: binding,
      projection: { inventory: projection.inventory, files: projection.files, documents: projection.documents },
      unsupported: ACCOUNT_PROJECTION_UNSUPPORTED };
  } catch { return { status: "unavailable", reason: "bundle-invalid" }; }
}
