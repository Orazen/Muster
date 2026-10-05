// Explicit immutable account-projection or rich account-recovery copies. No route activation,
// destructive migration, appData access, overwrite, or installation restore.
import type { VisibleAccessLease } from "./drive-visible-access.ts";
import { accountBundleHash, buildAccountVisibleBundle, resolveAuthenticatedVisibleAccount,
  sameVisibleAuthority, type AccountBundleResult, type ResolveVisibleAccount } from "./drive-visible-account-bundle.ts";
import { buildAccountRecoveryArchive, inspectAccountRecoveryArchive } from "./drive-visible-account-archive.ts";
import { inspectAccountVisibleRestore } from "./drive-visible-restore.ts";
import { findOrCreateBackupsFolder, findOrCreateVisibleFolder, type DriveFileRef,
  type VisibleDriveClient } from "./drive-visible.ts";

export interface VisibleBackupClient extends VisibleDriveClient {
  /** Resolve Google's root alias to the actual opaque metadata parent ID. */
  resolveRootId(): Promise<string>;
  createBinaryFile(name: string, parentId: string, bytes: Buffer): Promise<DriveFileRef>;
  getBinaryFile(id: string): Promise<{ body: Buffer; md5Checksum?: string }>;
}
export type VisibleBackupFailure = "account-unavailable" | "account-changed" | "bundle-unavailable"
  | "archive-unavailable" | "copy-too-large" | "ambiguous-folder" | "ambiguous-copy" | "invalid-copy" | "verification-failed" | "operation-failed";
export class VisibleBackupError extends Error {
  readonly code: VisibleBackupFailure;
  readonly createdFileId?: string;
  constructor(code: VisibleBackupFailure, createdFileId?: string) {
    super("Visible Drive backup was not verified.");
    this.code = code;
    this.createdFileId = createdFileId;
    this.name = "VisibleBackupError";
  }
}
export interface VerifiedVisibleBackup {
  status: "verified";
  scope: "account-owned";
  apply: "unsupported";
  visibleFolderId: string;
  backupFolderId: string;
  fileId: string;
  name: string;
  sha256: string;
  bytes: number;
  created: boolean;
  unsupported: Extract<AccountBundleResult, { status: "ready" }>["unsupported"];
}

export interface VerifiedAccountRecoveryBackup extends Omit<VerifiedVisibleBackup, "unsupported"> {
  format: "account-recovery-v1";
  excludes: Extract<ReturnType<typeof buildAccountRecoveryArchive>, { status: "ready" }>['excludes'];
}
// The actual Google media client accepts at most 24 MiB, even though the
// offline archive codec supports 48 MiB. Check before any folder operation.
export const MAX_VISIBLE_RECOVERY_COPY_BYTES = 24 * 1024 * 1024;
type CopyReceipt = Omit<VerifiedVisibleBackup, "unsupported">;
interface PreparedCopy<Details extends object> {
  bytes: Buffer; name: string; details: Details;
  verify(bytes: Buffer): boolean;
}
const binaryMime = "application/octet-stream";
const safeId = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value);
const escapeQuery = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** A user-requested projection is sealed by the real codec, copied under a
 * source/account-digest name and downloaded again. Existing copies are adopted
 * only after actual authenticated decryption/source validation; a conflict is
 * never overwritten. Newly created copies require exact ciphertext equality.
 * Remote creation is not transactional: a failed read-back preserves the
 * created copy and identifies it, rather than claiming rollback or success. */
export async function writeAccountVisibleBackup(input: {
  bundle: Parameters<typeof buildAccountVisibleBundle>[0];
  lease: VisibleAccessLease;
  client: VisibleBackupClient;
}): Promise<VerifiedVisibleBackup> {
  return writeImmutableAccountCopy({ ...input, resolveAccount: input.bundle.resolveAccount, prepare: () => {
    const ready = buildAccountVisibleBundle(input.bundle);
    if (ready.status !== "ready") throw new VisibleBackupError("bundle-unavailable");
    return { bytes: ready.bytes, name: `muster-account-visible-v1-${ready.binding.sourceDigest}.enc`,
      details: { unsupported: ready.unsupported }, verify: bytes => {
        const restored = inspectAccountVisibleRestore({ bytes,
          key: { custody: "user-held", passphrase: input.bundle.key.passphrase }, resolveAccount: input.bundle.resolveAccount });
        return restored.status === "ready" && restored.source.sourceDigest === ready.binding.sourceDigest
          && restored.source.authorityDigest === ready.binding.authorityDigest;
      } };
  } });
}

/** Rich archives use their distinct actual codec and digest. They never borrow
 * installation export or apply authority, and retain the same lease fences. */
export async function writeAccountRecoveryBackup(input: {
  archive: Parameters<typeof buildAccountRecoveryArchive>[0];
  lease: VisibleAccessLease;
  client: VisibleBackupClient;
}): Promise<VerifiedAccountRecoveryBackup> {
  return writeImmutableAccountCopy({ ...input, resolveAccount: input.archive.resolveAccount, prepare: () => {
    const ready = buildAccountRecoveryArchive(input.archive);
    if (ready.status !== "ready") throw new VisibleBackupError("archive-unavailable");
    if (!Buffer.isBuffer(ready.bytes) || ready.bytes.length > MAX_VISIBLE_RECOVERY_COPY_BYTES) throw new VisibleBackupError("copy-too-large");
    return { bytes: ready.bytes, name: `muster-account-recovery-v1-${ready.sourceDigest}.enc`,
      details: { format: "account-recovery-v1" as const, excludes: ready.excludes }, verify: bytes => {
        if (bytes.length > MAX_VISIBLE_RECOVERY_COPY_BYTES) return false;
        const restored = inspectAccountRecoveryArchive({ bytes,
          key: { custody: "user-held", passphrase: input.archive.key.passphrase }, resolveAccount: input.archive.resolveAccount });
        return restored.status === "ready" && restored.state.sourceDigest === ready.sourceDigest;
      } };
  } });
}

async function writeImmutableAccountCopy<Details extends object>(input: {
  resolveAccount: ResolveVisibleAccount;
  prepare(): PreparedCopy<Details>;
  lease: VisibleAccessLease;
  client: VisibleBackupClient;
}): Promise<CopyReceipt & Details> {
  let createdFileId: string | undefined;
  const fail = (code: VisibleBackupFailure): never => { throw new VisibleBackupError(code, createdFileId); };
  const authority = resolveAuthenticatedVisibleAccount(input.resolveAccount);
  if (!authority) throw new VisibleBackupError("account-unavailable");
  const current = () => {
    input.lease.assertCurrent();
    if (!sameVisibleAuthority(authority, resolveAuthenticatedVisibleAccount(input.resolveAccount))
      || authority.googleSub !== input.lease.googleSub) fail("account-changed");
  };
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    current();
    const result = await operation();
    current();
    return result;
  };
  try {
    current();
    const ready = input.prepare();
    current();
    const name = ready.name;
    const rootId = await call(() => input.client.resolveRootId());
    if (!safeId(rootId)) fail("invalid-copy");
    // Guard the individual list/create calls inside folder helpers as well as
    // the job. A whole-job check alone allows a second request after revocation.
    const guarded: VisibleDriveClient = {
      listFiles: async args => {
        const results = await call(() => input.client.listFiles(args));
        const folderName = args.q.includes("name = 'Muster'") ? "Muster" : "backups";
        const parent = /and '([^']+)' in parents/.exec(args.q)?.[1];
        if (!parent || results.some(file => !safeId(file.id) || file.name !== folderName
          || file.mimeType !== "application/vnd.google-apps.folder" || file.parents.length !== 1 || file.parents[0] !== parent)) fail("invalid-copy");
        return results;
      },
      createFolder: async (folderName, parent) => {
        const result = await call(() => input.client.createFolder(folderName, parent));
        if (!safeId(result.id) || result.name !== folderName || result.mimeType !== "application/vnd.google-apps.folder"
          || result.parents.length !== 1 || result.parents[0] !== parent) fail("invalid-copy");
        return result;
      },
      createFile: () => Promise.reject(new VisibleBackupError("operation-failed")),
      getFile: () => Promise.reject(new VisibleBackupError("operation-failed")),
      updateFile: () => Promise.reject(new VisibleBackupError("operation-failed")),
    };
    const visible = await findOrCreateVisibleFolder(guarded, rootId);
    if (visible.duplicates.length) fail("ambiguous-folder");
    if (!safeId(visible.id)) fail("invalid-copy");
    const destination = await findOrCreateBackupsFolder(guarded, visible.id);
    if (destination.duplicates.length) fail("ambiguous-folder");
    if (!safeId(destination.id)) fail("invalid-copy");
    const matches = await call(() => input.client.listFiles({
      q: `name = '${escapeQuery(name)}' and '${escapeQuery(destination.id)}' in parents and trashed = false`,
      fields: "files(id,name,parents,mimeType,md5Checksum)",
    }));
    if (matches.length > 1) fail("ambiguous-copy");
    const existing = matches[0];
    let file: DriveFileRef;
    if (existing) file = existing;
    else {
      file = await call(async () => {
        const created = await input.client.createBinaryFile(name, destination.id, Buffer.from(ready.bytes));
        if (safeId(created.id)) createdFileId = created.id;
        return created;
      });
    }
    if (!safeId(file.id) || file.name !== name || file.mimeType !== binaryMime
      || file.parents.length !== 1 || file.parents[0] !== destination.id) fail("invalid-copy");
    const downloaded = await call(() => input.client.getBinaryFile(file.id));
    if (!Buffer.isBuffer(downloaded.body)) fail("verification-failed");
    if (!existing && !downloaded.body.equals(ready.bytes)) fail("verification-failed");
    if (!ready.verify(downloaded.body)) fail("verification-failed");
    const sha256 = accountBundleHash(downloaded.body);
    current();
    return { status: "verified", scope: "account-owned", apply: "unsupported",
      visibleFolderId: visible.id, backupFolderId: destination.id, fileId: file.id,
      name, sha256, bytes: downloaded.body.byteLength, created: !existing, ...ready.details };
  } catch (error) {
    if (error instanceof VisibleBackupError) throw error;
    return fail("operation-failed");
  }
}
