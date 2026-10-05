// Explicit immutable account-projection copies only. No route activation,
// destructive migration, appData access, overwrite, or installation restore.
import type { VisibleAccessLease } from "./drive-visible-access.ts";
import { accountBundleHash, buildAccountVisibleBundle, resolveAuthenticatedVisibleAccount,
  sameVisibleAuthority, type AccountBundleResult } from "./drive-visible-account-bundle.ts";
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
  | "ambiguous-folder" | "ambiguous-copy" | "invalid-copy" | "verification-failed" | "operation-failed";
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
  let createdFileId: string | undefined;
  const fail = (code: VisibleBackupFailure): never => { throw new VisibleBackupError(code, createdFileId); };
  const authority = resolveAuthenticatedVisibleAccount(input.bundle.resolveAccount);
  if (!authority) throw new VisibleBackupError("account-unavailable");
  const current = () => {
    input.lease.assertCurrent();
    if (!sameVisibleAuthority(authority, resolveAuthenticatedVisibleAccount(input.bundle.resolveAccount))
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
    const bundle = buildAccountVisibleBundle(input.bundle);
    if (bundle.status !== "ready") throw new VisibleBackupError("bundle-unavailable");
    current();
    const ready = bundle;
    const name = `muster-account-visible-v1-${ready.binding.sourceDigest}.enc`;
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
    const restored = inspectAccountVisibleRestore({ bytes: downloaded.body,
      key: { custody: "user-held", passphrase: input.bundle.key.passphrase }, resolveAccount: input.bundle.resolveAccount });
    if (restored.status !== "ready" || restored.source.sourceDigest !== ready.binding.sourceDigest
      || restored.source.authorityDigest !== ready.binding.authorityDigest) fail("verification-failed");
    const sha256 = accountBundleHash(downloaded.body);
    current();
    return { status: "verified", scope: "account-owned", apply: "unsupported",
      visibleFolderId: visible.id, backupFolderId: destination.id, fileId: file.id,
      name, sha256, bytes: downloaded.body.byteLength, created: !existing, unsupported: ready.unsupported };
  } catch (error) {
    if (error instanceof VisibleBackupError) throw error;
    return fail("operation-failed");
  }
}
