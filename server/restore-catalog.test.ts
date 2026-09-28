// The restore catalog — the account-scoped answer to "what portable records can
// I restore, and what will a restore not bring back".
//
// The two-account exclusion is NOT proved here. It is proved over real HTTP by
// server/restore-records-two-accounts.test.ts, because the only thing that can
// fail is a listing made with the wrong account's grant, and that needs two
// accounts and a transport with per-account app-data folders. What is proved
// here is the module half: that it answers for exactly the account it was
// handed, that it refuses a listing bound to anybody else, that it drops rows
// it could not honour as a selection, and — the drift case — that the exclusion
// it publishes is the exclusion the bundle scan actually enforces.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RESTORE_CATALOG_MAX_RECORDS,
  RESTORE_CATALOG_VERSION,
  RESTORE_EXCLUSIONS,
  RestoreCatalogBindingError,
  buildRestoreCatalog,
  selectableRecord,
  type DriveSnapshotRow,
  type RestoreCatalog,
} from "./restore-catalog.ts";
import {
  RESTORE_DISABLED_BOT_FIELDS,
  RESTORE_DROPPED_BOT_FIELDS,
  RESTORE_DROPPED_GROUP_FIELDS,
  RESTORE_DROPPED_TASK_FIELDS,
  SUBSET_ROOT_FILES,
  buildPayloadV2,
} from "./workspace-bundle-v2.ts";

const ADA = "user-ada";
const ZOE = "user-zoe";

const row = (id: string, patch: Partial<DriveSnapshotRow> = {}): DriveSnapshotRow => ({
  id,
  name: `muster-workspace-v2-170000000-${id}.enc`,
  createdTime: "2026-09-20T10:00:00.000Z",
  size: "4096",
  ...patch,
});

/** A listing made with this account's grant, and therefore this account's
 *  records. The builder is told which account the listing was bound to, so a
 *  mis-bound listing is a refusal rather than a filter. */
const catalogFor = (accountId: string, snapshots: DriveSnapshotRow[], patch: Partial<Parameters<typeof buildRestoreCatalog>[0]> = {}): RestoreCatalog =>
  buildRestoreCatalog({
    accountId,
    listedForUserId: accountId,
    grant: { generation: 7 },
    connectConfigured: true,
    snapshots,
    ...patch,
  });

describe("the restore catalog answers for one account", () => {
  it("names the account it is about, and offers only what that account listed", () => {
    const catalog = catalogFor(ADA, [row("snap-1"), row("snap-2")]);
    expect(catalog.version).toBe(RESTORE_CATALOG_VERSION);
    expect(catalog.accountId).toBe(ADA);
    expect(catalog.drive).toEqual({ state: "connected", grantGeneration: 7 });
    expect(catalog.records.map((record) => record.id)).toEqual(["snap-1", "snap-2"]);
    expect(catalog.truncated).toBe(false);
  });

  it("keeps the transport's newest-first order instead of re-sorting it", () => {
    // The restore route resolves "newest" by Drive's modifiedTime order, so a
    // catalog that re-sorted would offer a different default than the one the
    // restore would actually take.
    const catalog = catalogFor(ADA, [
      row("newest", { createdTime: "2026-09-28T12:00:00.000Z" }),
      row("middle", { createdTime: "2026-09-21T12:00:00.000Z" }),
      row("oldest", { createdTime: "2026-09-14T12:00:00.000Z" }),
    ]);
    expect(catalog.records.map((record) => record.id)).toEqual(["newest", "middle", "oldest"]);
    expect(catalog.records[0]?.createdAt).toBe(Date.parse("2026-09-28T12:00:00.000Z"));
  });

  it("refuses a listing that was not bound to the account the document is for", () => {
    // The load-bearing check. Filtering instead would make a listing made with
    // another account's grant look like a short list, and nobody would ever find
    // out; refusing makes it a bug at the point it is written.
    expect(() => buildRestoreCatalog({
      accountId: ZOE,
      listedForUserId: ADA,
      grant: { generation: 1 },
      connectConfigured: true,
      snapshots: [row("snap-1")],
    })).toThrow(RestoreCatalogBindingError);
  });

  it("refuses to build a document with no account at all", () => {
    expect(() => buildRestoreCatalog({
      accountId: "",
      listedForUserId: "",
      grant: null,
      connectConfigured: false,
      snapshots: [],
    })).toThrow(RestoreCatalogBindingError);
  });

  it("says an account with no Drive grant has no Drive records, without inventing one", () => {
    // Two distinct empties, because the fixes differ: connect first, versus this
    // install has no Google credential pair so connecting cannot finish.
    const notConnected = catalogFor(ADA, [], { grant: null, connectConfigured: true });
    expect(notConnected.drive).toEqual({ state: "not-connected", grantGeneration: null });
    expect(notConnected.records).toEqual([]);

    const unavailable = catalogFor(ADA, [], { grant: null, connectConfigured: false });
    expect(unavailable.drive).toEqual({ state: "capability-unavailable", grantGeneration: null });
    expect(unavailable.records).toEqual([]);
  });
});

describe("the catalog only offers choices the restore could honour", () => {
  it("drops a row with no usable id rather than offering an unselectable option", () => {
    const catalog = catalogFor(ADA, [row(""), row("   "), row("snap-1")]);
    expect(catalog.records.map((record) => record.id)).toEqual(["snap-1"]);
  });

  it("drops an id longer than Drive could have issued", () => {
    const catalog = catalogFor(ADA, [row("x".repeat(2000)), row("snap-1")]);
    expect(catalog.records.map((record) => record.id)).toEqual(["snap-1"]);
  });

  it("collapses a repeated id, because one Drive file is one record", () => {
    const catalog = catalogFor(ADA, [row("snap-1"), row("snap-1"), row("snap-2")]);
    expect(catalog.records.map((record) => record.id)).toEqual(["snap-1", "snap-2"]);
  });

  it("reads an unreadable timestamp as unknown rather than as now", () => {
    // A null rendered as "just now" would put a user's recovery choice in the
    // wrong order, which is worse than not knowing.
    const catalog = catalogFor(ADA, [row("snap-1", { createdTime: "not-a-date" }), row("snap-2", { size: "huge" })]);
    expect(catalog.records[0]?.createdAt).toBeNull();
    expect(catalog.records[1]?.sizeBytes).toBeNull();
    expect(catalog.records[0]?.sizeBytes).toBe(4096);
  });

  it("is bounded, and says when it dropped the tail", () => {
    const many = Array.from({ length: RESTORE_CATALOG_MAX_RECORDS + 25 }, (_unused, index) => row(`snap-${index}`));
    const catalog = catalogFor(ADA, many);
    expect(catalog.records).toHaveLength(RESTORE_CATALOG_MAX_RECORDS);
    expect(catalog.truncated).toBe(true);
  });

  it("marks every listed record selectable, and nothing else is selectable", () => {
    const catalog = catalogFor(ADA, [row("snap-1")]);
    expect(catalog.records.every((record) => record.selectable === true)).toBe(true);
    expect(selectableRecord(catalog, "snap-1")?.id).toBe("snap-1");
    expect(selectableRecord(catalog, "snap-somebody-elses")).toBeNull();
    expect(selectableRecord(catalog, null)).toBeNull();
    expect(selectableRecord(catalog, "")).toBeNull();
  });
});

describe("the catalog reports the credential and grant exclusion", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "omb-restore-catalog-"));
    // A data directory holding exactly the three entries the exclusion names,
    // with recognisable contents, so the scan below can be checked against it.
    writeFileSync(join(dataDir, "auth.db"), "canary-auth-db");
    writeFileSync(join(dataDir, "auth.secret"), "canary-auth-secret");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ telegramSync: { botToken: "canary-bot-token" } }));
    writeFileSync(join(dataDir, "bots.json"), "[]");
  });
  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("names the credential and grant files, taken from the bundle module's own list", () => {
    // Not a hand-copied list. A second copy of these names is a second thing to
    // forget to update, and this one is a promise made to a user.
    expect(RESTORE_EXCLUSIONS.files).toEqual(["auth.db", "auth.secret", "config.json"]);
    expect(RESTORE_EXCLUSIONS.botFields).toEqual([...RESTORE_DROPPED_BOT_FIELDS]);
    expect(RESTORE_EXCLUSIONS.disabledBotFields).toEqual([...RESTORE_DISABLED_BOT_FIELDS]);
    expect(RESTORE_EXCLUSIONS.taskFields).toEqual([...RESTORE_DROPPED_TASK_FIELDS]);
    expect(RESTORE_EXCLUSIONS.groupFields).toEqual([...RESTORE_DROPPED_GROUP_FIELDS]);
  });

  it("agrees with the scan: the named files are skipped, and none is in the subset", () => {
    // The drift guard. RESTORE_EXCLUDED_ROOT_FILES is only a truthful report
    // while those names are outside SUBSET_ROOT_FILES; moving one in would put
    // a credential or a grant into a portable record, and this case is what
    // makes that a red test instead of a silent change.
    for (const file of RESTORE_EXCLUSIONS.files) {
      expect(SUBSET_ROOT_FILES.has(file), `${file} is inside the portable subset`).toBe(false);
    }
    const payload = buildPayloadV2({ dataDir, appVersion: "1.12.3" });
    const skipped = new Map(payload.skipped.map((entry) => [entry.path, entry.reason]));
    for (const file of RESTORE_EXCLUSIONS.files) {
      expect(skipped.get(file), `${file} was not skipped by the scan`).toBe("outside-subset");
    }
    // And the canaries are nowhere in the payload the scan produced.
    const serialised = JSON.stringify(payload);
    for (const canary of ["canary-auth-db", "canary-auth-secret", "canary-bot-token"]) {
      expect(serialised).not.toContain(canary);
    }
  });

  it("carries no passphrase, token or ciphertext into the document", () => {
    // The catalog is rendered BEFORE a user types a passphrase, so a field that
    // held one would be a field that leaked on a screen. The declared key set is
    // asserted exactly, so a new field cannot be added without someone deciding
    // it belongs there.
    const catalog = catalogFor(ADA, [row("snap-1")]);
    expect(Object.keys(catalog).sort()).toEqual(["accountId", "drive", "excludes", "records", "truncated", "version"]);
    expect(Object.keys(catalog.records[0]!).sort()).toEqual(["createdAt", "id", "name", "selectable", "sizeBytes", "source"]);
    expect(Object.keys(catalog.drive).sort()).toEqual(["grantGeneration", "state"]);
    const serialised = JSON.stringify(catalog);
    for (const forbidden of ["passphrase", "ciphertext", "accessToken", "refreshToken", "payload"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});
