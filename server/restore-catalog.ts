// The account-scoped restore catalog — "what portable records can THIS account
// restore", as one read-only document that moves no bytes.
//
// The product promise is encrypted Google Drive recovery, and a promise the
// user cannot inspect is a promise they have to take on faith. Before choosing
// a record to restore they need to know two things: which records exist, and
// what a restore will NOT bring back. The restore path could answer neither in
// a form anyone could read — the Drive listing route handed back raw transport
// metadata with no statement of whose records it was, and the credential/grant
// exclusion existed only as a `skipped` entry inside a sealed payload nobody
// can read before decrypting it.
//
// So this module builds the document, and it is deliberately pure: it takes a
// listing somebody already made and turns it into an account-scoped answer. It
// opens no file, opens no socket and asks for no passphrase. The one thing it
// will not do is answer for an account other than the one it was handed.
//
// SCOPE, stated because it is narrow on purpose. Only `google-account` records
// are catalogued, because those are the only portable records that are
// account-scoped: the installation Drive record, the Telegram record and a
// file on disk belong to the installation, not to a person, and listing them
// per-account would be a lie about their ownership. They are also the records
// the installation wall already gates, and this module is not a way around it.
//
// THE TWO-ACCOUNT PROPERTY, and what actually enforces it. Drive's
// `appDataFolder` is per Google account, so a listing made with account A's
// grant cannot return account B's records. That is Google's guarantee, not this
// module's, and a module that only re-sorted the rows would be untestable
// theatre. Two things here are Muster's own:
//   * `buildRestoreCatalog` REFUSES a listing that is not bound to the account
//     the document is for, instead of filtering it. A silent filter would make
//     a mis-bound listing look like a short list, and nobody would ever find
//     out; a refusal makes it a bug at the point it is written.
//   * every record carries `selectable: true` and the document carries
//     `accountId`, so a client renders a choice it can name the owner of, and
//     `selectableRecord` is the single predicate that turns an id into
//     permission to restore it.
// The end-to-end proof — two real accounts, one real server, a transport that
// keeps a separate app-data folder per Google account — is
// server/restore-records-two-accounts.test.ts. That is the layer that can
// actually fail; the binding check above is defence in depth, and saying so is
// more useful than a unit test pretending the check is the guarantee.

import { z } from "zod";

import {
  RESTORE_DISABLED_BOT_FIELDS,
  RESTORE_DROPPED_BOT_FIELDS,
  RESTORE_DROPPED_GROUP_FIELDS,
  RESTORE_DROPPED_TASK_FIELDS,
  RESTORE_EXCLUDED_ROOT_FILES,
} from "./workspace-bundle-v2.ts";

/** Bumped when the wire shape changes in a way a client must notice. */
export const RESTORE_CATALOG_VERSION = 1;

/** A Drive row as `listSnapshots` produces it. Structurally typed rather than
 * imported so this module stays pure and this file can be read on its own; the
 * transport's own zod schema has already validated the row before it gets here,
 * and the bounds below re-check what a selection actually depends on. */
export interface DriveSnapshotRow {
  id: string;
  name: string;
  createdTime: string;
  size?: string;
}

/** Bounded so a hostile or broken listing page cannot make the document
 * unbounded. Drive's own page size is 100; the catalog refuses to grow past
 * this and says so rather than silently truncating. */
export const RESTORE_CATALOG_MAX_RECORDS = 500;

/** The upper bound the transport's own `driveFileIdSchema` implies. A record id
 * longer than this could not have come from Drive, so a row carrying one is a
 * row the catalog refuses to pass through. */
const MAX_RECORD_ID_LENGTH = 1024;
const MAX_RECORD_NAME_LENGTH = 512;

export type RestoreRecordSource = "google-account";

export interface RestoreRecord {
  id: string;
  source: RestoreRecordSource;
  name: string;
  /** Epoch milliseconds, or null when Drive's `createdTime` was not a usable
   * date. Null rather than a guess: an unreadable timestamp rendered as "now"
   * would order a user's recovery choices wrongly. */
  createdAt: number | null;
  /** Bytes, or null when Drive reported no size. */
  sizeBytes: number | null;
  /** Always true. A record is either restorable or it is not in the list at
   * all, so the field is stated rather than left to be inferred from a missing
   * sibling — a client rendering a choice must not have to guess. */
  selectable: true;
}

/** Why the account's Drive records are what they are.
 *   connected             - the account holds a current grant and it was used
 *   not-connected          - the account holds no Drive grant, so it has no
 *                            Drive records. Not an error: a signed-in account
 *                            can still restore from a file.
 *   capability-unavailable - this install holds no Google credential pair, so
 *                            the connect flow cannot finish. Distinct from
 *                            not-connected because the fix is different.
 */
export type RestoreDriveState = "connected" | "not-connected" | "capability-unavailable";

/** What a restore never carries, named from the bundle module's own lists. The
 * credential and grant files are excluded by the subset scan, not by a special
 * case; these constants are exported from there so this document and the scan
 * that enforces the rule cannot drift. */
export interface RestoreExclusions {
  /** Data-directory entries that hold credentials or connection grants. */
  files: readonly string[];
  /** Bot-record fields dropped rather than restored (grants, owner ids,
   * machine pointers). */
  botFields: readonly string[];
  /** Capability switches written explicitly OFF, because their absence means
   * "allowed" — dropping `composio` would silently re-grant a connection. */
  disabledBotFields: readonly string[];
  taskFields: readonly string[];
  groupFields: readonly string[];
}

export const RESTORE_EXCLUSIONS: RestoreExclusions = Object.freeze({
  files: Object.freeze([...RESTORE_EXCLUDED_ROOT_FILES]),
  botFields: Object.freeze([...RESTORE_DROPPED_BOT_FIELDS]),
  disabledBotFields: Object.freeze([...RESTORE_DISABLED_BOT_FIELDS]),
  taskFields: Object.freeze([...RESTORE_DROPPED_TASK_FIELDS]),
  groupFields: Object.freeze([...RESTORE_DROPPED_GROUP_FIELDS]),
});

export interface RestoreCatalog {
  version: typeof RESTORE_CATALOG_VERSION;
  /** The account this document is about. Echoed on every document so a client
   * can refuse to render one that is not the signed-in account's, and so a user
   * reading it can be told whose records they are looking at. */
  accountId: string;
  drive: { state: RestoreDriveState; grantGeneration: number | null };
  /** Newest first, exactly the order the transport listed them in: Drive orders
   * by modified time, and re-sorting here would make the document disagree with
   * the order the restore route resolves "newest" in. */
  records: RestoreRecord[];
  /** True when the listing held more rows than the document carries. Reported
   * rather than implied, for the same reason `skippedTruncated` is. */
  truncated: boolean;
  excludes: RestoreExclusions;
}

export interface RestoreCatalogInput {
  /** The account the document is FOR. Never chosen by a client. */
  accountId: string;
  /** The account whose Drive grant produced `snapshots`. A listing bound to
   * anybody else is refused: see the module header on why that is a refusal
   * and not a filter. */
  listedForUserId: string;
  /** The account's current Drive grant, or null when it holds none. */
  grant: { generation: number } | null;
  /** Whether this install holds the Google credential pair the connect flow
   * needs. False makes `not-connected` mean "cannot connect yet" rather than
   * "has not connected". */
  connectConfigured: boolean;
  snapshots: readonly DriveSnapshotRow[];
  maxRecords?: number;
}

/** Raised when a listing is not bound to the account the document is for. A
 * distinct type so a caller can recognise this as its own bug rather than
 * reporting it as a Drive failure. */
export class RestoreCatalogBindingError extends Error {
  constructor(accountId: string, listedForUserId: string) {
    super(`restore catalog: listing was bound to ${listedForUserId}, not to ${accountId}`);
    this.name = "RestoreCatalogBindingError";
  }
}

function driveState(input: RestoreCatalogInput): RestoreDriveState {
  if (input.grant !== null) return "connected";
  return input.connectConfigured ? "not-connected" : "capability-unavailable";
}

/** The listing's own boundary. A row is parsed here, not narrowed at each use:
 * the transport already validated it once, but this module is reachable by a
 * future caller, and the bounds are what make the id a usable selection key. A
 * row longer than Drive's own id schema allows could not have come from Drive,
 * so it is not a record — it is noise with a shape. */
const driveRowSchema = z.object({
  id: z.string().max(MAX_RECORD_ID_LENGTH),
  name: z.string().min(1).max(MAX_RECORD_NAME_LENGTH).optional(),
  createdTime: z.string().min(1).max(64),
  size: z.string().max(24).optional(),
});

/** A row is a record only if the fields a selection is made from are present
 * and bounded. A row with no usable id cannot be selected at all, so the
 * document never offers a choice the restore route could not honour. */
function toRecord(row: DriveSnapshotRow): RestoreRecord | null {
  const parsed = driveRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const id = parsed.data.id.trim();
  if (id.length === 0) return null;
  const at = Date.parse(parsed.data.createdTime);
  const size = Number(parsed.data.size);
  return {
    id,
    source: "google-account",
    name: parsed.data.name ?? id,
    createdAt: Number.isFinite(at) ? at : null,
    sizeBytes: Number.isSafeInteger(size) && size >= 0 ? size : null,
    selectable: true,
  };
}

/** Build the document. Pure: no I/O, no network, no installation access. */
export function buildRestoreCatalog(input: RestoreCatalogInput): RestoreCatalog {
  if (!input.accountId || input.listedForUserId !== input.accountId) {
    throw new RestoreCatalogBindingError(input.accountId, input.listedForUserId);
  }
  const limit = Math.max(0, Math.trunc(input.maxRecords ?? RESTORE_CATALOG_MAX_RECORDS));
  const records: RestoreRecord[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const row of input.snapshots ?? []) {
    const record = toRecord(row);
    // A duplicated id is dropped rather than de-duplicated into two options:
    // one Drive file is one record, and rendering the same choice twice invites
    // a user to believe there are two backups.
    if (record === null || seen.has(record.id)) continue;
    if (records.length >= limit) { truncated = true; continue; }
    seen.add(record.id);
    records.push(record);
  }
  return {
    version: RESTORE_CATALOG_VERSION,
    accountId: input.accountId,
    drive: { state: driveState(input), grantGeneration: input.grant?.generation ?? null },
    records,
    truncated,
    excludes: RESTORE_EXCLUSIONS,
  };
}

/** The one predicate that turns a record id into permission to restore it.
 * Anything absent from this account's catalog is not selectable, so a client (or
 * a future route) has exactly one place to ask and no shape to ask it in that
 * happens to answer yes. */
export function selectableRecord(catalog: RestoreCatalog, id: string | null | undefined): RestoreRecord | null {
  // No narrowing guard needed and none wanted: an absent or unmatchable id
  // simply is not in `records`, which is the property being relied on. A guard
  // here would be a second place that could be wrong.
  return catalog.records.find((record) => record.id === id) ?? null;
}
