// The pending-restore apply — boot-time commit of a staged v2 restore.
//
// Fixtures are owned and throwaway: temp roots per case, a real messages.db
// built from the server/message-db.ts declaration, and the contract test —
// export from A, stage into fresh B, apply at "boot", and check that B now
// IS A's workspace with routines disabled and goals stopped. Nothing here
// touches a real installation.
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { bootWithRestoreFirst } from "./boot-order.ts";
import { lastPreMigrationCapture } from "./snapshot-runner.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { buildPayloadV2, commitRestoreV2, decryptBundleV2, encryptBundleV2, stageRestoreV2, stagingManifestConsumed, type RestoreEvent } from "./workspace-bundle-v2.ts";
import {
  applyPendingRestore,
  backupsRootFor,
  PENDING_RESTORE_FORMAT,
  readLastReceipt,
  readPendingRestore,
  stagingPathFor,
  writePendingRestore,
  type PendingRestore,
} from "./restore-apply.ts";

const PASSPHRASE = "correct horse battery staple";
const APP_VERSION = "1.12.1";

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "muster-restore-apply-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of roots) await removeTempDir(root);
});

function writeTranscript(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id))");
    db.exec("CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id)");
    db.exec("CREATE TABLE IF NOT EXISTS thread_state (thread_id TEXT PRIMARY KEY, active_leaf_id TEXT)");
    db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("thread-bot-1", "m1", 1_760_000_000_001, "user", "text", "hello from A", JSON.stringify({ id: "m1", text: "hello from A" }));
    db.prepare("INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?)").run("thread-bot-1", "m1");
  } finally {
    db.close();
  }
}

/** Installation A — the source of the backup. */
function makeInstallA(root: string): string {
  const dataDir = join(root, "install-a");
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([
    { id: "bot-1", threadId: "thread-bot-1", name: "Orchard", title: "Gardener" },
  ]));
  writeFileSync(join(dataDir, "groups.json"), JSON.stringify([]));
  writeFileSync(join(dataDir, "routines.json"), JSON.stringify({
    routines: [{ id: "r-1", name: "morning digest", botId: "bot-1", enabled: true, nextRunAt: 999, schedule: { type: "daily", at: "08:00" }, prompt: "digest", createdAt: 1, updatedAt: 1 }],
  }));
  writeFileSync(join(dataDir, "goals.json"), JSON.stringify({
    version: 1, goals: [{ id: "g-1", botId: "bot-1", text: "ship it", status: "active", rounds: 1, maxRounds: 5 }],
  }));
  writeFileSync(join(dataDir, "decisions.json"), JSON.stringify({ entries: [] }));
  writeFileSync(join(dataDir, "social.json"), JSON.stringify({ profiles: [], requests: [], friendships: [] }));
  writeFileSync(join(dataDir, "MEMORY.md"), "# MEMORY\n\n## Facts\n- from install A\n");
  writeFileSync(join(dataDir, "memory", "topic.md"), "# Topic\nrestored verbatim\n");
  writeTranscript(join(dataDir, "messages.db"));
  return dataDir;
}

/** Installation B — fresh, with its own local data the restore must replace. */
function makeInstallB(root: string): string {
  const dataDir = join(root, "install-b");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([
    { id: "bot-local", threadId: "thread-local", name: "Local", title: "was here first" },
  ]));
  writeFileSync(join(dataDir, "groups.json"), JSON.stringify([]));
  writeFileSync(join(dataDir, "routines.json"), JSON.stringify({ routines: [] }));
  writeFileSync(join(dataDir, "goals.json"), JSON.stringify({ version: 1, goals: [] }));
  return dataDir;
}

function exportFromA(dataDirA: string): Buffer {
  const payload = buildPayloadV2({ dataDir: dataDirA, appVersion: APP_VERSION });
  return encryptBundleV2(payload, { passphrase: PASSPHRASE });
}

function stageInto(dataDirB: string, bytes: Buffer) {
  const decrypt = decryptBundleV2(bytes, { passphrase: PASSPHRASE });
  expect(decrypt.status).toBe("ok");
  const staged = stageRestoreV2(decrypt.payload!, { stagingDir: stagingPathFor(dataDirB), remapIds: false });
  expect(staged.status).toBe("staged");
  return staged;
}

describe("pending restore apply", () => {
  it("exports from A and restores into B at boot — ids kept, routines off, goals stopped", () => {
    const root = makeRoot();
    const a = makeInstallA(root);
    const b = makeInstallB(root);
    const bytes = exportFromA(a);

    const staged = stageInto(b, bytes);
    const pending: Parameters<typeof writePendingRestore>[1] = {
      version: 1,
      format: PENDING_RESTORE_FORMAT,
      stagingDir: staged.stagingDir,
      createdAt: Date.now(),
      source: "file",
      reconsentRequired: staged.reconsentRequired,
    };
    if (staged.counts !== undefined) pending.counts = staged.counts;
    writePendingRestore(b, pending);
    expect(readPendingRestore(b)).not.toBeNull();

    const applied = applyPendingRestore(b);
    expect(applied.status).toBe("committed");
    expect(applied.deWeaponized).toContain("routines");
    expect(applied.deWeaponized).toContain("goals");

    // B's bots are REPLACED by A's — ids kept so routines/goals references hold
    const bots = JSON.parse(readFileSync(join(b, "bots.json"), "utf8"));
    expect(bots.map((x: { id: string }) => x.id)).toEqual(["bot-1"]);
    expect(bots[0].title).toBe("Gardener");

    const routines = JSON.parse(readFileSync(join(b, "routines.json"), "utf8"));
    expect(routines.routines[0].enabled).toBe(false);
    expect(routines.routines[0].nextRunAt).toBeNull();
    expect(routines.routines[0].name).toBe("morning digest");

    const goals = JSON.parse(readFileSync(join(b, "goals.json"), "utf8"));
    expect(goals.goals[0].status).toBe("stopped");

    expect(readFileSync(join(b, "MEMORY.md"), "utf8")).toContain("from install A");
    expect(readFileSync(join(b, "memory", "topic.md"), "utf8")).toContain("restored verbatim");

    // the transcript came back too
    const db = new DatabaseSync(join(b, "messages.db"), { readOnly: true });
    try {
      // SAFETY: the row is selected by the fixture's own literal id and the
      // messages table declares text TEXT; undefined is the no-row shape.
      const row = db.prepare("SELECT text FROM messages WHERE id = 'm1'").get() as { text: string } | undefined;
      expect(row?.text).toBe("hello from A");
    } finally {
      db.close();
    }

    // bookkeeping: pending cleared, receipt written, staging consumed,
    // and B's previous bots.json rides in the safety copy
    expect(readPendingRestore(b)).toBeNull();
    const receipt = readLastReceipt(b);
    expect(receipt?.status).toBe("committed");
    expect(receipt?.source).toBe("file");
    expect(existsSync(stagingPathFor(b))).toBe(false);
    if (!receipt?.backupDir) throw new Error("committed restore must name its safety copy");
    expect(existsSync(join(receipt.backupDir, "bots.json"))).toBe(true);
    const preserved = JSON.parse(readFileSync(join(receipt.backupDir, "bots.json"), "utf8"));
    expect(preserved[0].name).toBe("Local");
  });

  it("a second staged restore is refused while one is pending", () => {
    const root = makeRoot();
    const a = makeInstallA(root);
    const b = makeInstallB(root);
    const bytes = exportFromA(a);
    const staged = stageInto(b, bytes);
    const pending = {
      version: 1 as const,
      format: PENDING_RESTORE_FORMAT,
      stagingDir: staged.stagingDir,
      createdAt: Date.now(),
      source: "file",
      reconsentRequired: [],
    };
    writePendingRestore(b, pending);
    expect(() => writePendingRestore(b, pending)).toThrow(/already waiting/);
  });

  it("a pending file pointing at a non-conventional staging path is refused", () => {
    const root = makeRoot();
    const b = makeInstallB(root);
    expect(() =>
      writePendingRestore(b, {
        version: 1,
        format: PENDING_RESTORE_FORMAT,
        stagingDir: join(root, "somewhere-else"),
        createdAt: Date.now(),
        source: "file",
        reconsentRequired: [],
      }),
    ).toThrow(/conventional/);
  });

  it("refuses a hand-edited pending marker that redirects to another valid staging tree", () => {
    const root = makeRoot();
    const a = makeInstallA(root);
    const b = makeInstallB(root);
    const decrypted = decryptBundleV2(exportFromA(a), { passphrase: PASSPHRASE });
    expect(decrypted.status).toBe("ok");
    const alternateStagingDir = join(root, "alternate-staging");
    const alternate = stageRestoreV2(decrypted.payload!, { stagingDir: alternateStagingDir, remapIds: false });
    expect(alternate.status).toBe("staged");
    writePendingRestore(b, {
      version: 1,
      format: PENDING_RESTORE_FORMAT,
      stagingDir: stagingPathFor(b),
      createdAt: Date.now(),
      source: "file",
      reconsentRequired: [],
    });

    const pendingPath = join(b, "pending-restore.json");
    // SAFETY: writePendingRestore created this marker with the accepted pending schema immediately above.
    const editedMarker = JSON.parse(readFileSync(pendingPath, "utf8")) as PendingRestore;
    editedMarker.stagingDir = alternate.stagingDir;
    writeFileSync(pendingPath, JSON.stringify(editedMarker, null, 2));
    const originalBots = readFileSync(join(b, "bots.json"));

    const applied = applyPendingRestore(b);

    expect(applied.status).toBe("refused");
    expect(applied.error).toMatch(/conventional sibling staging path/u);
    expect(readLastReceipt(b)).toMatchObject({ status: "refused", error: applied.error });
    expect(readFileSync(join(b, "bots.json"))).toEqual(originalBots);
    expect(stagingManifestConsumed(alternate.stagingDir)).toBe(false);
    expect(readPendingRestore(b)?.stagingDir).toBe(alternate.stagingDir);
  });

  it("apply with nothing pending is a no-op; a corrupt pending file is ignored", () => {
    const root = makeRoot();
    const b = makeInstallB(root);
    expect(applyPendingRestore(b).status).toBe("nothing-pending");
    writeFileSync(join(b, "pending-restore.json"), "{oops");
    expect(applyPendingRestore(b).status).toBe("nothing-pending");
  });

  it("a wrong passphrase never reaches staging — decrypt refuses", () => {
    const root = makeRoot();
    const a = makeInstallA(root);
    const bytes = exportFromA(a);
    const decrypt = decryptBundleV2(bytes, { passphrase: "wrong horse battery staple" });
    expect(decrypt.status).toBe("bad-key");
    expect(decrypt.payload).toBeUndefined();
  });

  it("de-weaponize leaves already-off routines untouched and is crash-safe via rename", () => {
    const root = makeRoot();
    const a = makeInstallA(root);
    // A's routine is already disabled — the restored copy must not gain an
    // edit stamp, and apply must still commit cleanly.
    const doc = JSON.parse(readFileSync(join(a, "routines.json"), "utf8"));
    doc.routines[0].enabled = false;
    doc.routines[0].nextRunAt = null;
    writeFileSync(join(a, "routines.json"), JSON.stringify(doc));
    const b = makeInstallB(root);
    const staged = stageInto(b, exportFromA(a));
    writePendingRestore(b, {
      version: 1,
      format: PENDING_RESTORE_FORMAT,
      stagingDir: staged.stagingDir,
      createdAt: Date.now(),
      source: "google-drive",
      reconsentRequired: [],
    });
    const applied = applyPendingRestore(b);
    expect(applied.status).toBe("committed");
    expect(applied.deWeaponized).toEqual(["goals"]);
    const restored = JSON.parse(readFileSync(join(b, "routines.json"), "utf8"));
    expect(restored.routines[0].enabled).toBe(false);
  });

  it("stays out of the snapshot capture under the test harness guard", () => {
    const root = makeRoot();
    const a = makeInstallA(root);
    const b = makeInstallB(root);
    const staged = stageInto(b, exportFromA(a));
    writePendingRestore(b, {
      version: 1,
      format: PENDING_RESTORE_FORMAT,
      stagingDir: staged.stagingDir,
      createdAt: Date.now(),
      source: "file",
      reconsentRequired: [],
    });
    expect(applyPendingRestore(b).status).toBe("committed");
    // vitest sets VITEST, so the pre-restore hook must not have fired
    expect(lastPreMigrationCapture()).toBeNull();
  });

  it("fires the pre-restore capture outside the harness — a closed gate is observed as skipped", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    try {
      const root = makeRoot();
      const a = makeInstallA(root);
      const b = makeInstallB(root);
      const staged = stageInto(b, exportFromA(a));
      writePendingRestore(b, {
        version: 1,
        format: PENDING_RESTORE_FORMAT,
        stagingDir: staged.stagingDir,
        createdAt: Date.now(),
        source: "file",
        reconsentRequired: [],
      });
      const applied = applyPendingRestore(b);
      expect(applied.status).toBe("committed");
      const capture = lastPreMigrationCapture();
      expect(capture).not.toBeNull();
      // no config.json in the throwaway DATA_DIR → the Drive half of the
      // §11 gate closes FIRST, so the store's getSync is never reached
      expect(capture).toMatchObject({ reason: "pre-restore", status: "skipped", detail: "drive-not-connected" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/** A commit that throws part-way leaves the live tree rolled back but keeps its
 * safety copy; these two pin that a transient failure no longer wedges a
 * staged restore, and that a disarm that could not be written is never filed
 * under "committed". */
describe("pending restore apply — transient failures", () => {
  function pendingFor(b: string, stagedStagingDir: string): void {
    writePendingRestore(b, {
      version: 1,
      format: PENDING_RESTORE_FORMAT,
      stagingDir: stagedStagingDir,
      createdAt: Date.now(),
      source: "file",
      reconsentRequired: [],
    });
  }

  it("a rolled-back commit does not wedge the pending restore on the next boot", () => {
    const root = makeRoot();
    const a = makeInstallA(root);
    const b = makeInstallB(root);
    const staged = stageInto(b, exportFromA(a));
    pendingFor(b, staged.stagingDir);
    const createdAt = readPendingRestore(b)!.createdAt;
    const backupsRoot = join(b, `${".restore-backups"}`);
    const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");

    // BOOT 1: the commit writes every staged file, then fails on the final
    // "consume" step because the staging tree is no longer writable — the
    // stand-in for an ENOSPC/EIO part-way through. It rolls back and leaves
    // its safety copy behind.
    chmodSync(staged.stagingDir, 0o500);
    const first = applyPendingRestore(b);
    chmodSync(staged.stagingDir, 0o700);
    expect(first.status).toBe("rolled-back");
    expect(existsSync(join(backupsRoot, stamp))).toBe(true);
    expect(readPendingRestore(b)).not.toBeNull();
    // the live tree is the pre-restore one again
    const bots = JSON.parse(readFileSync(join(b, "bots.json"), "utf8"));
    expect(bots[0].name).toBe("Local");

    // BOOT 2 must reach the commit instead of refusing the leftover directory.
    const second = applyPendingRestore(b);
    expect(second.status).toBe("committed");
    // the safety copy is preserved, not overwritten or dropped
    expect(existsSync(join(backupsRoot, stamp))).toBe(true);
    if (!second.commit?.backupDir) throw new Error("committed restore must name its safety copy");
    expect(second.commit.backupDir).not.toBe(join(backupsRoot, stamp));
    expect(existsSync(join(second.commit.backupDir, "bots.json"))).toBe(true);
    expect(readLastReceipt(b)?.status).toBe("committed");
    expect(readPendingRestore(b)).toBeNull();
    // and the restore really is A's workspace
    const restored = JSON.parse(readFileSync(join(b, "bots.json"), "utf8"));
    expect(restored[0].name).toBe("Orchard");
  });

  it("chooses a retry name when the timestamp safety-copy path is occupied", () => {
    // The "already exists" guard itself is not weakened: this pins that the
    // retry leaves the preexisting copy alone and commits under a free name.
    const root = makeRoot();
    const a = makeInstallA(root);
    const b = makeInstallB(root);
    const staged = stageInto(b, exportFromA(a));
    pendingFor(b, staged.stagingDir);
    const stamp = new Date(readPendingRestore(b)!.createdAt).toISOString().replace(/[:.]/g, "-");
    mkdirSync(join(b, ".restore-backups", stamp), { recursive: true });
    const applied = applyPendingRestore(b);
    expect(applied.status).toBe("committed");
    expect(applied.commit?.backupDir).toBe(join(b, ".restore-backups", `${stamp}-retry-1`));
  });

  it("refuses direct recovery through a safety-copy name not bound to the pending timestamp", () => {
    const root = makeRoot();
    const a = makeInstallA(root);
    const b = makeInstallB(root);
    const staged = stageInto(b, exportFromA(a));
    const createdAt = Date.now();
    // SAFETY: stageInto just created this manifest through stageRestoreV2, which validated and wrote its files list.
    const manifest = JSON.parse(readFileSync(join(staged.stagingDir, ".muster-restore-staging.json"), "utf8")) as { files: { path: string }[] };
    const inventory: Record<string, { size: number; sha256: string } | null> = {};
    const before: Record<string, string | null> = {};
    for (const entry of manifest.files) {
      const live = join(b, ...entry.path.split("/"));
      if (existsSync(live)) {
        const body = readFileSync(live);
        inventory[entry.path] = { size: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") };
        before[entry.path] = createHash("sha256").update(body).digest("hex");
      } else {
        inventory[entry.path] = null;
        before[entry.path] = null;
      }
    }
    const unboundBackupDir = join(backupsRootFor(b), "not-the-pending-timestamp");

    const result = commitRestoreV2({
      stagingDir: staged.stagingDir,
      dataDir: b,
      backupDir: unboundBackupDir,
      priorBackupDir: unboundBackupDir,
      priorBackupCreatedAt: createdAt,
      priorBackupInventory: inventory,
      confirm: true,
    });

    expect(result.status).toBe("refused");
    expect(result.blocked[0]?.detail).toMatch(/pending marker timestamp\/retry path/u);
    const incompleteAttempts: Array<Partial<Pick<Parameters<typeof commitRestoreV2>[0], "priorBackupDir" | "priorBackupCreatedAt" | "priorBackupInventory">>> = [
      { priorBackupDir: unboundBackupDir },
      { priorBackupCreatedAt: createdAt },
      { priorBackupInventory: inventory },
      { priorBackupDir: unboundBackupDir, priorBackupCreatedAt: createdAt },
      { priorBackupDir: unboundBackupDir, priorBackupInventory: inventory },
      { priorBackupCreatedAt: createdAt, priorBackupInventory: inventory },
    ];
    for (const incomplete of incompleteAttempts) {
      const incompleteResult = commitRestoreV2({
        stagingDir: staged.stagingDir,
        dataDir: b,
        backupDir: unboundBackupDir,
        confirm: true,
        ...incomplete,
      });
      expect(incompleteResult.status).toBe("refused");
      expect(incompleteResult.blocked[0]?.detail).toMatch(/prior backup attempt marker is incomplete/u);
    }
    for (const [path, expectedHash] of Object.entries(before)) {
      const live = join(b, ...path.split("/"));
      expect(existsSync(live) ? createHash("sha256").update(readFileSync(live)).digest("hex") : null).toBe(expectedHash);
    }
  });

  it("treats a dangling symlink backup name as occupied and preserves it", () => {
    const root = makeRoot();
    const a = makeInstallA(root);
    const b = makeInstallB(root);
    const staged = stageInto(b, exportFromA(a));
    pendingFor(b, staged.stagingDir);
    const stamp = new Date(readPendingRestore(b)!.createdAt).toISOString().replace(/[:.]/g, "-");
    const backupRoot = backupsRootFor(b);
    const occupiedPath = join(backupRoot, stamp);
    const missingTarget = join(root, "missing-backup-target");
    mkdirSync(backupRoot, { recursive: true });
    symlinkSync(missingTarget, occupiedPath);
    const originalLink = readlinkSync(occupiedPath);
    expect(existsSync(occupiedPath)).toBe(false);
    expect(lstatSync(occupiedPath).isSymbolicLink()).toBe(true);

    const applied = applyPendingRestore(b);
    const selected = join(backupRoot, `${stamp}-retry-1`);
    expect(applied.status).toBe("committed");
    expect(applied.commit?.backupDir).toBe(selected);
    expect(readLastReceipt(b)?.backupDir).toBe(selected);
    expect(existsSync(join(selected, "bots.json"))).toBe(true);
    expect(lstatSync(occupiedPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(occupiedPath)).toBe(originalLink);
  });

  it("downgrades the receipt when de-weaponization cannot write, instead of claiming a clean commit", () => {
    const root = makeRoot();
    const a = makeInstallA(root);
    const b = makeInstallB(root);
    const staged = stageInto(b, exportFromA(a));
    pendingFor(b, staged.stagingDir);
    // A directory where rewriteIfChanged's temp file belongs: the disarm
    // cannot land, and the restored routine is still armed. This is the one
    // outcome the module header forbids, so it must not be reported as
    // "committed" with the failure nowhere.
    mkdirSync(join(b, "routines.json.tmp"), { recursive: true });

    const applied = applyPendingRestore(b);
    expect(applied.status).toBe("failed");
    expect(applied.error).toMatch(/routines/);
    expect(applied.error).toMatch(/may still be enabled/);
    // the goals disarm did land and is still reported as such
    expect(applied.deWeaponized).toEqual(["goals"]);
    expect(JSON.parse(readFileSync(join(b, "goals.json"), "utf8")).goals[0].status).toBe("stopped");
    // the routine really is still armed — which is why this is not "committed"
    expect(JSON.parse(readFileSync(join(b, "routines.json"), "utf8")).routines[0].enabled).toBe(true);
    const receipt = readLastReceipt(b);
    expect(receipt?.status).toBe("failed");
    expect(receipt?.error).toMatch(/routines/);
    // the safety copy of a landed commit stays named, and the pending file
    // stays so a later boot can re-apply and re-try the disarm
    expect(receipt?.backupDir).toBeDefined();
    const markerBackupDir = readPendingRestore(b)?.backupAttempt?.backupDir;
    expect(markerBackupDir).toBe(receipt?.backupDir);
    expect(stagingManifestConsumed(staged.stagingDir)).toBe(true);
    expect(readPendingRestore(b)).not.toBeNull();
    expect(existsSync(stagingPathFor(b))).toBe(true);

    // clear the obstruction: the next boot commits cleanly
    rmSync(join(b, "routines.json.tmp"), { recursive: true, force: true });
    rmSync(join(b, "last-restore.json"), { force: true });
    const second = applyPendingRestore(b);
    expect(second.status).toBe("committed");
    expect(second.deWeaponized).toEqual(["routines"]);
    expect(JSON.parse(readFileSync(join(b, "routines.json"), "utf8")).routines[0].enabled).toBe(false);
    expect(readLastReceipt(b)?.status).toBe("committed");
    expect(readLastReceipt(b)?.backupDir).toBe(markerBackupDir);
    expect(readPendingRestore(b)).toBeNull();
  });

  it("recovers a legacy consumed-stage marker from its matching failed receipt after disarm retries", () => {
    const root = makeRoot();
    const a = makeInstallA(root);
    const b = makeInstallB(root);
    const staged = stageInto(b, exportFromA(a));
    pendingFor(b, staged.stagingDir);
    const pending = readPendingRestore(b);
    if (pending === null) throw new Error("the synthetic pending marker must be readable");
    const stamp = new Date(pending.createdAt).toISOString().replace(/[:.]/g, "-");
    const originalInventory = Object.fromEntries(["bots.json", "groups.json", "routines.json", "goals.json"].map((path) => [
      path,
      sha256(readFileSync(join(b, path))),
    ]));
    const obstruction = join(b, "routines.json.tmp");
    mkdirSync(obstruction, { recursive: true });

    const firstBoot = applyPendingRestore(b);
    expect(firstBoot.status).toBe("failed");
    expect(firstBoot.commit?.status).toBe("committed");
    const failedReceipt = readLastReceipt(b);
    expect(failedReceipt).toMatchObject({ status: "failed", createdAt: pending.createdAt });
    const backupDir = failedReceipt?.backupDir;
    if (backupDir === undefined) throw new Error("the landed restore must record its original safety copy");
    expect(backupDir).toBe(join(backupsRootFor(b), stamp));
    const backupInfo = lstatSync(backupDir);
    expect(backupInfo.isDirectory()).toBe(true);
    expect(backupInfo.isSymbolicLink()).toBe(false);
    expect(stagingManifestConsumed(staged.stagingDir)).toBe(true);

    // Remove only the newer attempt metadata to model an accepted v1 marker;
    // keep the real failed receipt and consumed manifest from the first boot.
    const legacyMarker = readPendingRestore(b);
    if (legacyMarker === null) throw new Error("the failed disarm must keep its pending marker");
    expect(legacyMarker.version).toBe(1);
    delete legacyMarker.backupAttempt;
    writeFileSync(join(b, "pending-restore.json"), JSON.stringify(legacyMarker, null, 2));
    expect(readPendingRestore(b)?.backupAttempt).toBeUndefined();
    expect(readLastReceipt(b)?.status).toBe("failed");
    rmSync(obstruction, { recursive: true, force: true });

    const reboot = bootWithRestoreFirst(b, () => {
      const routines = JSON.parse(readFileSync(join(b, "routines.json"), "utf8"));
      const goals = JSON.parse(readFileSync(join(b, "goals.json"), "utf8"));
      return {
        routineEnabledStates: routines.routines.map((routine: { enabled: boolean }) => routine.enabled),
        goalStatuses: goals.goals.map((goal: { status: string }) => goal.status),
        pending: readPendingRestore(b),
      };
    });

    expect(reboot.restored).toBe(true);
    expect(reboot.store.routineEnabledStates).toEqual([false]);
    expect(reboot.store.goalStatuses).toEqual(["stopped"]);
    expect(reboot.store.pending).toBeNull();
    const committedReceipt = readLastReceipt(b);
    expect(committedReceipt?.status).toBe("committed");
    expect(committedReceipt?.createdAt).toBe(pending.createdAt);
    expect(committedReceipt?.backupDir).toBe(backupDir);
    expect(lstatSync(backupDir).isDirectory()).toBe(true);
    expect(lstatSync(backupDir).isSymbolicLink()).toBe(false);
    for (const [path, expectedHash] of Object.entries(originalInventory)) {
      expect(sha256(readFileSync(join(backupDir, path)))).toBe(expectedHash);
    }
    expect(readPendingRestore(b)).toBeNull();
    expect(existsSync(stagingPathFor(b))).toBe(false);
  });
});

type OwnedChildExit = { code: number | null; signal: string | null };

type CrashChildInput =
  | { dataDir: string; pendingPath: string; crashWriteNumber: number }
  | { dataDir: string; coveredPaths: string[]; originalHashes: Record<string, string | null>; expectedHashes: Record<string, string> };

interface TreeSnapshotFile {
  path: string;
  sha256: string;
}

interface TreeSnapshot {
  exists: boolean;
  directories: string[];
  files: TreeSnapshotFile[];
}

interface SingleFileSnapshot {
  exists: boolean;
  sha256?: string;
}

interface ProcessSnapshot {
  data: TreeSnapshot;
  backups: TreeSnapshot;
  firstBackup?: TreeSnapshot;
  preoccupiedBackups: Record<string, TreeSnapshot>;
  receiptBackup?: TreeSnapshot | null;
  pending: SingleFileSnapshot;
  receipt: SingleFileSnapshot;
  staging: TreeSnapshot;
  stagingManifest: SingleFileSnapshot;
}

interface ChildProcessEvidence {
  pid?: number;
  command: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exit: OwnedChildExit | null;
}

interface CrashCleanupEvidence {
  killedPids: number[];
  unresolvedPids: number[];
  fixtureRootRemoved?: boolean;
  fixtureRootRemovalError?: string;
}

interface CrashFixtureEvidence {
  installA: string;
  installB: string;
  stagingDir: string;
  firstBackupDir: string;
  preoccupiedBackupDirs: string[];
  coveredPaths: string[];
  originalCoveredHashes: Record<string, string | null>;
  originalBackupInventory: Record<string, { size: number; sha256: string }>;
  stagedContentHashes: Record<string, string>;
  expectedRestoredHashes: Record<string, string>;
}

interface CrashChecks {
  configuredWriteHookReachedAfterEverySafetyMove: boolean;
  crashOutageStateMatchesConfiguredBoundary: boolean;
  firstWriteCompletedBeforeSecondWriteCrash: boolean;
  crashExit: OwnedChildExit | null;
  firstSafetyCopyPreservesOriginalB: boolean;
  selectedAttemptRecordedBeforeFirstMove: boolean;
  pendingMarkerPersistsAcrossCrash: boolean;
  stagingManifestPreservedUnconsumedDuringOutage: boolean;
  recoveryChildExit: OwnedChildExit | null;
  storeFactorySawCompleteRestoredData: boolean;
  storeFactorySawOriginalData: boolean;
  storeFactorySawSafeTree: boolean;
  recoveredCoveredHashesMatchRestoredA: boolean;
  recoveryReportedCommitted: boolean;
  pendingMarkerClearedAfterRecovery: boolean;
  receiptNamesExistingSafetyCopy: boolean;
  receiptReusesFirstSafetyCopy: boolean;
  receiptSafetyCopyPreservesOriginalB: boolean;
  firstSafetyCopyUnchangedByRecovery: boolean;
  unrelatedPreoccupiedCopyUnchanged: boolean;
  receiptBackupDir: string | null;
  expectedFirstBackupDir: string;
  preoccupiedBackupDirs: string[];
  recoveredHashes: Record<string, string | null>;
  expectedRestoredHashes: Record<string, string>;
  receipt: ReturnType<typeof readLastReceipt>;
}

interface ProcessCrashEvidence {
  fixtureRoot: string;
  childProcesses: { crash?: ChildProcessEvidence; recovery?: ChildProcessEvidence };
  snapshots: { before?: ProcessSnapshot; afterCrash?: ProcessSnapshot; afterRecovery?: ProcessSnapshot };
  fixture?: CrashFixtureEvidence;
  childScripts?: {
    crash: { path: string; sha256: string; source: string };
    recovery: { path: string; sha256: string; source: string };
  };
  crashBoundary?: {
    requestedWriteCallback: number;
    observedWriteCallback: number | null;
    callbackEvent: RestoreEvent | null;
    completedPriorWritePaths: string[];
    outageLiveHashes: Record<string, string | null>;
    outageInterpretation: string;
  };
  checks?: CrashChecks;
  cleanup?: CrashCleanupEvidence;
  finalChildExits?: { crash: OwnedChildExit | null; recovery: OwnedChildExit | null };
}

const restoreEventSchema = z.object({
  step: z.enum(["validate", "staging-dir", "file", "transcript", "manifest", "move", "write", "consume"]),
  path: z.string().optional(),
});

const childOutputRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attempt-marker"), pid: z.number(), markerText: z.string(), markerSha256: z.string() }),
  z.object({
    kind: z.literal("crash-point"),
    pid: z.number(),
    event: restoreEventSchema,
    movedPaths: z.array(z.string()),
    writeNumber: z.number(),
    priorWritePaths: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("store-factory"),
    matchesExpected: z.boolean(),
    matchesOriginal: z.boolean(),
    matchesSafeTree: z.boolean(),
    actualHashes: z.record(z.string(), z.string().nullable()),
  }),
  z.object({
    kind: z.literal("boot-return"),
    restored: z.boolean(),
    storeSawCompleteRestore: z.boolean(),
    storeSawOriginalData: z.boolean(),
    storeSawSafeTree: z.boolean(),
    receipt: z.object({ status: z.string().optional(), backupDir: z.string().optional() }).nullable(),
    pending: z.unknown(),
  }),
]);

type ChildOutputRecord = z.infer<typeof childOutputRecordSchema>;

type RestoreFixtureJsonValue = string | number | boolean | null | RestoreFixtureJsonValue[] | { [key: string]: RestoreFixtureJsonValue };

interface RoutineFixtureRecord {
  enabled: boolean;
  nextRunAt: string | number | null;
  [key: string]: RestoreFixtureJsonValue;
}

interface GoalFixtureRecord {
  status: string;
  [key: string]: RestoreFixtureJsonValue;
}

interface OwnedChild {
  child: ChildProcess;
  command: string[];
  cwd: string;
  closed: Promise<OwnedChildExit>;
  output: () => { stdout: string; stderr: string };
}

function startOwnedChild(scriptPath: string, argument: CrashChildInput, cwd: string): OwnedChild {
  const command = [process.execPath, "--experimental-strip-types", scriptPath, JSON.stringify(argument)];
  const [executable, ...args] = command;
  const child = spawn(executable, args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: tmpdir(),
      NODE_ENV: "test",
      VITEST: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (part: string) => { stdout += part; });
  child.stderr?.on("data", (part: string) => { stderr += part; });
  child.on("error", (error) => { stderr += `${error.stack ?? error.message}\n`; });
  const closed = new Promise<OwnedChildExit>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, command, cwd, closed, output: () => ({ stdout, stderr }) };
}

async function awaitOwnedChild(record: OwnedChild, timeoutMs: number): Promise<OwnedChildExit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`owned child exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([record.closed, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotTree(path: string, excludedTopLevel?: string): TreeSnapshot {
  if (!existsSync(path)) return { exists: false, directories: [], files: [] };
  const directories: string[] = [];
  const files: TreeSnapshotFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (directory === path && entry.name === excludedTopLevel) continue;
      const fullPath = join(directory, entry.name);
      const relativePath = relative(path, fullPath).split(sep).join("/");
      if (entry.isDirectory()) {
        directories.push(relativePath);
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push({ path: relativePath, sha256: sha256(readFileSync(fullPath)) });
      } else if (entry.isSymbolicLink()) {
        files.push({ path: relativePath, sha256: "<symlink>" });
      }
    }
  };
  visit(path);
  directories.sort();
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { exists: true, directories, files };
}

function snapshotSingleFile(path: string): SingleFileSnapshot {
  if (!existsSync(path)) return { exists: false };
  return { exists: true, sha256: sha256(readFileSync(path)) };
}

function hashesForPaths(files: { path: string; sha256: string }[], paths: string[]): Record<string, string | null> {
  const hashes = new Map(files.map((file) => [file.path, file.sha256]));
  return Object.fromEntries(paths.map((path) => [path, hashes.get(path) ?? null]));
}

function parseJsonLines(text: string): ChildOutputRecord[] {
  const records: ChildOutputRecord[] = [];
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    try {
      const parsed = childOutputRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
    } catch {
      // Non-JSON diagnostics remain in the raw child stdout receipt.
    }
  }
  return records;
}

describe("pending restore apply — process death and restart", () => {
  it.each([
    { scenario: "without a timestamp collision", preoccupiedCount: 0, crashWriteNumber: 1 },
    { scenario: "with the timestamp path preoccupied", preoccupiedCount: 1, crashWriteNumber: 1 },
    { scenario: "at the retry-64 boundary", preoccupiedCount: 64, crashWriteNumber: 1 },
    { scenario: "after the first staged write and before the second", preoccupiedCount: 0, crashWriteNumber: 2 },
  ])("records a real SIGKILL after the safety moves and checks restart before store construction ($scenario)", async ({ scenario, preoccupiedCount, crashWriteNumber }) => {
    const root = makeRoot();
    const evidenceDir = process.env.MUSTER_RESTORE_CRASH_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), "muster-restore-crash-evidence-"));
    if (process.env.MUSTER_RESTORE_CRASH_EVIDENCE_DIR === undefined) chmodSync(evidenceDir, 0o700);
    const evidenceName = scenario.replace(/[^a-z0-9]+/giu, "-").toLowerCase();
    const evidencePath = join(evidenceDir, `process-crash-${evidenceName}.json`);
    const ownedChildren = new Set<OwnedChild>();
    const evidence: ProcessCrashEvidence = { fixtureRoot: root, childProcesses: {}, snapshots: {} };
    let checks: CrashChecks | undefined;
    let crashChild: OwnedChild | undefined;
    let recoveryChild: OwnedChild | undefined;
    let crashExit: OwnedChildExit | null = null;
    let recoveryExit: OwnedChildExit | null = null;

    try {
      const a = makeInstallA(root);
      const b = makeInstallB(root);
      const bundleBytes = exportFromA(a);
      const decrypted = decryptBundleV2(bundleBytes, { passphrase: PASSPHRASE });
      if (decrypted.status !== "ok" || decrypted.payload === undefined) {
        throw new Error(`synthetic A bundle failed to decrypt: ${decrypted.status}`);
      }
      const payload = decrypted.payload;
      const coveredPaths = [
        ...payload.files.map((file) => file.path),
        ...(payload.transcripts.threads.length > 0 ? ["messages.db"] : []),
      ].sort();
      if (coveredPaths.length === 0) throw new Error("synthetic A bundle has no covered files");

      // B starts with a distinct synthetic byte string at every covered path.
      for (const path of coveredPaths) {
        const target = join(b, ...path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        if (path === "messages.db") {
          const db = new DatabaseSync(target);
          try {
            db.exec("CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id))");
            db.exec("CREATE INDEX messages_thread ON messages(thread_id)");
            db.exec("CREATE TABLE thread_state (thread_id TEXT PRIMARY KEY, active_leaf_id TEXT)");
            db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
              .run("thread-b-only", "b-only-message", 1_760_000_000_002, "user", "text", "synthetic install B only", JSON.stringify({ id: "b-only-message", text: "synthetic install B only" }));
            db.prepare("INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?)").run("thread-b-only", "b-only-message");
          } finally {
            db.close();
          }
        } else {
          writeFileSync(target, `SYNTHETIC INSTALL B ONLY: ${path}\n`);
        }
      }
      const staged = stageInto(b, bundleBytes);
      const stagedManifestPath = join(staged.stagingDir, ".muster-restore-staging.json");

      // The staged files are the exact commit inputs (including the rebuilt
      // transcript DB and restore-time record sanitization), then apply turns
      // routines off and goals stopped before the store factory runs.
      const expectedRestoredHashes: Record<string, string> = {};
      const stagedContentHashes: Record<string, string> = {};
      for (const path of coveredPaths) {
        let body = readFileSync(join(staged.stagingDir, ...path.split("/")));
        stagedContentHashes[path] = sha256(body);
        if (path === "routines.json") {
          // SAFETY: this body was just read from the routines.json produced by the staged fixture bundle.
          const document = JSON.parse(body.toString("utf8")) as { routines: RoutineFixtureRecord[] };
          let changed = false;
          for (const routine of document.routines) {
            if (routine.enabled !== false) { routine.enabled = false; changed = true; }
            if (routine.nextRunAt !== null) { routine.nextRunAt = null; changed = true; }
          }
          if (changed) body = Buffer.from(JSON.stringify(document, null, 2));
        } else if (path === "goals.json") {
          // SAFETY: this body was just read from the goals.json produced by the staged fixture bundle.
          const document = JSON.parse(body.toString("utf8")) as { goals: GoalFixtureRecord[] };
          let changed = false;
          for (const goal of document.goals) {
            if (goal.status === "active") { goal.status = "stopped"; changed = true; }
          }
          if (changed) body = Buffer.from(JSON.stringify({ goals: document.goals }, null, 2));
        }
        expectedRestoredHashes[path] = sha256(body);
      }
      const createdAt = Date.now();
      const pending: Parameters<typeof writePendingRestore>[1] = {
        version: 1,
        format: PENDING_RESTORE_FORMAT,
        stagingDir: staged.stagingDir,
        createdAt,
        source: "file",
        reconsentRequired: staged.reconsentRequired,
      };
      if (staged.counts !== undefined) pending.counts = staged.counts;
      writePendingRestore(b, pending);

      const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
      const preoccupiedBackupDirs = Array.from({ length: preoccupiedCount }, (_, index) =>
        join(backupsRootFor(b), index === 0 ? stamp : `${stamp}-retry-${index}`),
      );
      for (const [index, directory] of preoccupiedBackupDirs.entries()) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `unrelated-preserved-copy-${index}.txt`), `unrelated synthetic marker ${index}\n`);
      }
      const preoccupiedBefore = Object.fromEntries(preoccupiedBackupDirs.map((directory) => [directory, snapshotTree(directory)]));
      const firstBackupDir = join(backupsRootFor(b), preoccupiedCount === 0 ? stamp : `${stamp}-retry-${preoccupiedCount}`);
      const originalBackupInventory = Object.fromEntries(coveredPaths.map((path) => {
        const body = readFileSync(join(b, ...path.split("/")));
        return [path, { size: body.byteLength, sha256: sha256(body) }];
      }));
      expect(readPendingRestore(b)?.version).toBe(1);
      expect(readPendingRestore(b)?.backupAttempt).toBeUndefined();
      const crashScriptPath = join(root, "owned-crash-child.mjs");
      const recoveryScriptPath = join(root, "owned-boot-recovery-child.mjs");
      const crashScript = `
import { createHash } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { applyPendingRestore } from ${JSON.stringify(new URL("./restore-apply.ts", import.meta.url).href)};
const input = JSON.parse(process.argv[2]);
const movedPaths = [];
const writeCallbackPaths = [];
let markerCaptured = false;
applyPendingRestore(input.dataDir, {
  onCommit(event) {
    if (event.step === "move") {
      movedPaths.push(event.path);
      if (!markerCaptured) {
        markerCaptured = true;
        const markerText = readFileSync(input.pendingPath, "utf8");
        writeSync(1, JSON.stringify({ kind: "attempt-marker", pid: process.pid, markerText, markerSha256: createHash("sha256").update(markerText).digest("hex") }) + "\\n");
      }
    }
    if (event.step === "write") {
      const writeNumber = writeCallbackPaths.length + 1;
      if (writeNumber === input.crashWriteNumber) {
        writeSync(1, JSON.stringify({ kind: "crash-point", pid: process.pid, event, movedPaths, writeNumber, priorWritePaths: writeCallbackPaths }) + "\\n");
        process.kill(process.pid, "SIGKILL");
      }
      writeCallbackPaths.push(event.path);
    }
  },
});
writeSync(2, "applyPendingRestore returned without the first-write SIGKILL\\n");
process.exitCode = 91;
`;
      const recoveryScript = `
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { bootWithRestoreFirst } from ${JSON.stringify(new URL("./boot-order.ts", import.meta.url).href)};
import { readLastReceipt, readPendingRestore } from ${JSON.stringify(new URL("./restore-apply.ts", import.meta.url).href)};
const input = JSON.parse(process.argv[2]);
const result = bootWithRestoreFirst(input.dataDir, () => {
  const actualHashes = {};
  for (const path of input.coveredPaths) {
    const fullPath = input.dataDir + "/" + path;
    actualHashes[path] = existsSync(fullPath)
      ? createHash("sha256").update(readFileSync(fullPath)).digest("hex")
      : null;
  }
  const matchesExpected = input.coveredPaths.every((path) => actualHashes[path] === input.expectedHashes[path]);
  const matchesOriginal = input.coveredPaths.every((path) => actualHashes[path] === input.originalHashes[path]);
  const matchesSafeTree = matchesExpected || matchesOriginal;
  writeSync(1, JSON.stringify({ kind: "store-factory", matchesExpected, matchesOriginal, matchesSafeTree, actualHashes }) + "\\n");
  return { matchesExpected, matchesOriginal, matchesSafeTree };
});
writeSync(1, JSON.stringify({
  kind: "boot-return",
  restored: result.restored,
  storeSawCompleteRestore: result.store.matchesExpected,
  storeSawOriginalData: result.store.matchesOriginal,
  storeSawSafeTree: result.store.matchesSafeTree,
  receipt: readLastReceipt(input.dataDir),
  pending: readPendingRestore(input.dataDir),
}) + "\\n");
`;
      writeFileSync(crashScriptPath, crashScript, { mode: 0o600 });
      writeFileSync(recoveryScriptPath, recoveryScript, { mode: 0o600 });

      const before = {
        data: snapshotTree(b, ".restore-backups"),
        backups: snapshotTree(backupsRootFor(b)),
        preoccupiedBackups: preoccupiedBefore,
        pending: snapshotSingleFile(join(b, "pending-restore.json")),
        receipt: snapshotSingleFile(join(b, "last-restore.json")),
        staging: snapshotTree(stagingPathFor(b)),
        stagingManifest: snapshotSingleFile(stagedManifestPath),
      };
      const originalCoveredHashes = hashesForPaths(before.data.files, coveredPaths);
      evidence.fixture = {
        installA: a,
        installB: b,
        stagingDir: staged.stagingDir,
        firstBackupDir,
        preoccupiedBackupDirs,
        coveredPaths,
        originalCoveredHashes,
        originalBackupInventory,
        stagedContentHashes,
        expectedRestoredHashes,
      };
      evidence.snapshots = { before };
      evidence.childScripts = {
        crash: { path: crashScriptPath, sha256: sha256(crashScript), source: crashScript },
        recovery: { path: recoveryScriptPath, sha256: sha256(recoveryScript), source: recoveryScript },
      };

      crashChild = startOwnedChild(crashScriptPath, {
        dataDir: b,
        pendingPath: join(b, "pending-restore.json"),
        crashWriteNumber,
      }, root);
      ownedChildren.add(crashChild);
      crashExit = await awaitOwnedChild(crashChild, 15_000);
      ownedChildren.delete(crashChild);
      const crashOutput = crashChild.output();
      const crashRecords = parseJsonLines(crashOutput.stdout);
      const crashPoint = crashRecords.find((record) => record.kind === "crash-point");
      const attemptMarkerRecord = crashRecords.find((record) => record.kind === "attempt-marker");
      const markerText = attemptMarkerRecord?.kind === "attempt-marker" ? attemptMarkerRecord.markerText : "";
      // SAFETY: markerText came from the pending file written by persistBackupAttempt and is checked against the on-disk marker hash below.
      const markerAtFirstMove = markerText.length > 0 ? JSON.parse(markerText) as ReturnType<typeof readPendingRestore> : null;
      const afterCrash = {
        data: snapshotTree(b, ".restore-backups"),
        backups: snapshotTree(backupsRootFor(b)),
        firstBackup: snapshotTree(firstBackupDir),
        preoccupiedBackups: Object.fromEntries(preoccupiedBackupDirs.map((directory) => [directory, snapshotTree(directory)])),
        pending: snapshotSingleFile(join(b, "pending-restore.json")),
        receipt: snapshotSingleFile(join(b, "last-restore.json")),
        staging: snapshotTree(stagingPathFor(b)),
        stagingManifest: snapshotSingleFile(stagedManifestPath),
      };
      const priorWritePaths = crashPoint?.kind === "crash-point" ? crashPoint.priorWritePaths : [];
      const crashLiveHashes = hashesForPaths(afterCrash.data.files, coveredPaths);
      const crashOutageStateMatchesBoundary = crashWriteNumber === 1
        ? coveredPaths.every((path) => crashLiveHashes[path] === null)
        : crashWriteNumber === 2
          && priorWritePaths.length === 1
          && coveredPaths.every((path) => path === priorWritePaths[0]
            ? crashLiveHashes[path] === stagedContentHashes[path]
            : crashLiveHashes[path] === null);
      evidence.snapshots = { before, afterCrash };
      evidence.crashBoundary = {
        requestedWriteCallback: crashWriteNumber,
        observedWriteCallback: crashPoint?.writeNumber ?? null,
        callbackEvent: crashPoint?.event ?? null,
        completedPriorWritePaths: priorWritePaths,
        outageLiveHashes: crashLiveHashes,
        outageInterpretation: "immediate post-SIGKILL outage snapshot only; absent live paths are not classified as permanent loss",
      };
      evidence.childProcesses = {
        crash: { pid: crashChild.child.pid, command: crashChild.command, cwd: crashChild.cwd, stdout: crashOutput.stdout, stderr: crashOutput.stderr, exit: crashExit },
      };

      // The service is down between the SIGKILL and this reboot. Covered live
      // entries being absent here is temporary outage state, not permanent
      // loss: the first safety copy must still hold B, and the pending marker
      // plus unconsumed staged manifest must remain available for recovery.
      const outageBackupHashes = hashesForPaths(afterCrash.firstBackup.files, coveredPaths);
      expect(crashExit).toEqual({ code: null, signal: "SIGKILL" });
      expect(JSON.stringify(outageBackupHashes)).toBe(JSON.stringify(originalCoveredHashes));
      expect(attemptMarkerRecord?.pid).toBe(crashChild.child.pid);
      expect(markerAtFirstMove?.backupAttempt?.backupDir).toBe(firstBackupDir);
      expect(coveredPaths.every((path) => JSON.stringify(markerAtFirstMove?.backupAttempt?.inventory[path]) === JSON.stringify(originalBackupInventory[path]))).toBe(true);
      expect(attemptMarkerRecord?.markerSha256).toBe(afterCrash.pending.sha256);
      expect(afterCrash.pending.exists).toBe(true);
      expect(afterCrash.staging.exists).toBe(true);
      expect(afterCrash.stagingManifest).toEqual(before.stagingManifest);
      expect(afterCrash.stagingManifest.exists).toBe(true);
      expect(stagingManifestConsumed(staged.stagingDir)).toBe(false);
      expect(crashOutageStateMatchesBoundary).toBe(true);

      // Always exercise real next-boot recovery, even if the crash snapshot
      // shows that covered live files are temporarily absent from the live B tree.
      recoveryChild = startOwnedChild(recoveryScriptPath, {
        dataDir: b,
        coveredPaths,
        originalHashes: originalCoveredHashes,
        expectedHashes: expectedRestoredHashes,
      }, root);
      ownedChildren.add(recoveryChild);
      recoveryExit = await awaitOwnedChild(recoveryChild, 15_000);
      ownedChildren.delete(recoveryChild);
      const recoveryOutput = recoveryChild.output();
      const recoveryRecords = parseJsonLines(recoveryOutput.stdout);
      const storeFactoryRecord = recoveryRecords.find((record) => record.kind === "store-factory");
      const bootReturnRecord = recoveryRecords.find((record) => record.kind === "boot-return");

      const receipt = readLastReceipt(b);
      const receiptBackupDir = receipt?.backupDir ?? null;
      const receiptBackup = receiptBackupDir === null ? null : snapshotTree(receiptBackupDir);
      const afterRecovery = {
        data: snapshotTree(b, ".restore-backups"),
        backups: snapshotTree(backupsRootFor(b)),
        firstBackup: snapshotTree(firstBackupDir),
        preoccupiedBackups: Object.fromEntries(preoccupiedBackupDirs.map((directory) => [directory, snapshotTree(directory)])),
        receiptBackup,
        pending: snapshotSingleFile(join(b, "pending-restore.json")),
        receipt: snapshotSingleFile(join(b, "last-restore.json")),
        staging: snapshotTree(stagingPathFor(b)),
        stagingManifest: snapshotSingleFile(stagedManifestPath),
      };
      evidence.snapshots = { before, afterCrash, afterRecovery };
      evidence.childProcesses = {
        crash: { pid: crashChild.child.pid, command: crashChild.command, cwd: crashChild.cwd, stdout: crashOutput.stdout, stderr: crashOutput.stderr, exit: crashExit },
        recovery: { pid: recoveryChild.child.pid, command: recoveryChild.command, cwd: recoveryChild.cwd, stdout: recoveryOutput.stdout, stderr: recoveryOutput.stderr, exit: recoveryExit },
      };

      const firstBackupHashes = hashesForPaths(afterCrash.firstBackup.files, coveredPaths);
      const receiptBackupHashes = hashesForPaths(receiptBackup?.files ?? [], coveredPaths);
      const recoveredHashes = hashesForPaths(afterRecovery.data.files, coveredPaths);
      checks = {
        configuredWriteHookReachedAfterEverySafetyMove:
          crashPoint !== undefined
          && crashChild !== undefined
          && crashPoint.pid === crashChild.child.pid
          && crashPoint.event !== undefined
          && crashPoint.event.step === "write"
          && crashPoint.writeNumber === crashWriteNumber
          && JSON.stringify([...crashPoint.movedPaths].sort()) === JSON.stringify(coveredPaths),
        crashOutageStateMatchesConfiguredBoundary: crashOutageStateMatchesBoundary,
        firstWriteCompletedBeforeSecondWriteCrash:
          crashWriteNumber !== 2
          || (priorWritePaths.length === 1
            && crashPoint?.event !== undefined
            && crashPoint.event.path !== priorWritePaths[0]
            && crashLiveHashes[priorWritePaths[0]] === stagedContentHashes[priorWritePaths[0]]),
        crashExit: crashExit === null ? null : { code: crashExit.code, signal: crashExit.signal },
        firstSafetyCopyPreservesOriginalB: JSON.stringify(firstBackupHashes) === JSON.stringify(originalCoveredHashes),
        selectedAttemptRecordedBeforeFirstMove:
          attemptMarkerRecord?.pid === crashChild.child.pid
          && markerAtFirstMove?.backupAttempt?.backupDir === firstBackupDir
          && coveredPaths.every((path) => JSON.stringify(markerAtFirstMove?.backupAttempt?.inventory[path]) === JSON.stringify(originalBackupInventory[path])),
        pendingMarkerPersistsAcrossCrash:
          afterCrash.pending.exists
          && attemptMarkerRecord?.markerSha256 === afterCrash.pending.sha256,
        stagingManifestPreservedUnconsumedDuringOutage:
          before.stagingManifest.exists
          && afterCrash.stagingManifest.exists
          && before.stagingManifest.sha256 === afterCrash.stagingManifest.sha256
          && stagingManifestConsumed(staged.stagingDir) === false,
        recoveryChildExit: recoveryExit === null ? null : { code: recoveryExit.code, signal: recoveryExit.signal },
        storeFactorySawCompleteRestoredData:
          storeFactoryRecord?.matchesExpected === true
          && bootReturnRecord?.storeSawCompleteRestore === true,
        storeFactorySawOriginalData: storeFactoryRecord?.matchesOriginal === true,
        storeFactorySawSafeTree: storeFactoryRecord?.matchesSafeTree === true
          && bootReturnRecord?.storeSawSafeTree === true,
        recoveredCoveredHashesMatchRestoredA:
          JSON.stringify(recoveredHashes) === JSON.stringify(expectedRestoredHashes),
        recoveryReportedCommitted:
          bootReturnRecord?.restored === true
          && bootReturnRecord.receipt?.status === "committed",
        pendingMarkerClearedAfterRecovery: !afterRecovery.pending.exists,
        receiptNamesExistingSafetyCopy: receiptBackupDir !== null && receiptBackup?.exists === true,
        receiptReusesFirstSafetyCopy: receiptBackupDir === firstBackupDir,
        receiptSafetyCopyPreservesOriginalB:
          JSON.stringify(receiptBackupHashes) === JSON.stringify(originalCoveredHashes),
        firstSafetyCopyUnchangedByRecovery:
          JSON.stringify(afterRecovery.firstBackup) === JSON.stringify(afterCrash.firstBackup),
        unrelatedPreoccupiedCopyUnchanged:
          JSON.stringify(afterCrash.preoccupiedBackups) === JSON.stringify(preoccupiedBefore)
          && JSON.stringify(afterRecovery.preoccupiedBackups) === JSON.stringify(preoccupiedBefore),
        receiptBackupDir,
        expectedFirstBackupDir: firstBackupDir,
        preoccupiedBackupDirs,
        recoveredHashes,
        expectedRestoredHashes,
        receipt,
      };
    } finally {
      const cleanup: CrashCleanupEvidence = { killedPids: [], unresolvedPids: [] };
      for (const record of ownedChildren) {
        const pid = record.child.pid;
        if (pid !== undefined && record.child.exitCode === null && record.child.signalCode === null) {
          try {
            record.child.kill("SIGKILL");
            cleanup.killedPids.push(pid);
          } catch {
            // The owned child may have exited between the status check and kill.
          }
        }
        try {
          await awaitOwnedChild(record, 5_000);
          ownedChildren.delete(record);
        } catch {
          if (pid !== undefined) cleanup.unresolvedPids.push(pid);
        }
      }
      evidence.cleanup = cleanup;
      if (crashChild !== undefined && crashExit === null) {
        try { crashExit = await awaitOwnedChild(crashChild, 100); } catch { /* recorded as unresolved above */ }
      }
      if (recoveryChild !== undefined && recoveryExit === null) {
        try { recoveryExit = await awaitOwnedChild(recoveryChild, 100); } catch { /* recorded as unresolved above */ }
      }
      evidence.finalChildExits = { crash: crashExit, recovery: recoveryExit };
      try {
        await removeTempDir(root);
        cleanup.fixtureRootRemoved = !existsSync(root);
        if (cleanup.fixtureRootRemoved) {
          const rootIndex = roots.indexOf(root);
          if (rootIndex !== -1) roots.splice(rootIndex, 1);
        }
      } catch (error) {
        cleanup.fixtureRootRemoved = false;
        cleanup.fixtureRootRemovalError = error instanceof Error ? error.message : String(error);
      }
      evidence.checks = checks;
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      chmodSync(evidencePath, 0o600);
      console.info(`[process-crash raw receipt] ${evidencePath}`);
    }

    if (crashWriteNumber === 2) {
      expect(checks).toMatchObject({
        configuredWriteHookReachedAfterEverySafetyMove: true,
        crashOutageStateMatchesConfiguredBoundary: true,
        firstWriteCompletedBeforeSecondWriteCrash: true,
        crashExit: { code: null, signal: "SIGKILL" },
        firstSafetyCopyPreservesOriginalB: true,
        selectedAttemptRecordedBeforeFirstMove: true,
        pendingMarkerPersistsAcrossCrash: true,
        stagingManifestPreservedUnconsumedDuringOutage: true,
        recoveryChildExit: { code: 0, signal: null },
        storeFactorySawCompleteRestoredData: true,
        storeFactorySawOriginalData: false,
        storeFactorySawSafeTree: true,
        recoveredCoveredHashesMatchRestoredA: true,
        recoveryReportedCommitted: true,
        pendingMarkerClearedAfterRecovery: true,
        receiptNamesExistingSafetyCopy: true,
        receiptReusesFirstSafetyCopy: true,
        receiptSafetyCopyPreservesOriginalB: true,
        firstSafetyCopyUnchangedByRecovery: true,
        unrelatedPreoccupiedCopyUnchanged: true,
      });
      expect(checks?.receipt).toMatchObject({ status: "committed", backupDir: checks?.expectedFirstBackupDir });
    } else {
      expect(checks).toEqual({
        configuredWriteHookReachedAfterEverySafetyMove: true,
        crashOutageStateMatchesConfiguredBoundary: true,
        firstWriteCompletedBeforeSecondWriteCrash: true,
        crashExit: { code: null, signal: "SIGKILL" },
        firstSafetyCopyPreservesOriginalB: true,
      selectedAttemptRecordedBeforeFirstMove: true,
      pendingMarkerPersistsAcrossCrash: true,
      stagingManifestPreservedUnconsumedDuringOutage: true,
        recoveryChildExit: { code: 0, signal: null },
        storeFactorySawCompleteRestoredData: true,
        storeFactorySawOriginalData: false,
        storeFactorySawSafeTree: true,
        recoveredCoveredHashesMatchRestoredA: true,
      recoveryReportedCommitted: true,
      pendingMarkerClearedAfterRecovery: true,
      receiptNamesExistingSafetyCopy: true,
      receiptReusesFirstSafetyCopy: true,
      receiptSafetyCopyPreservesOriginalB: true,
      firstSafetyCopyUnchangedByRecovery: true,
      unrelatedPreoccupiedCopyUnchanged: true,
      receiptBackupDir: expect.any(String),
      expectedFirstBackupDir: expect.any(String),
      preoccupiedBackupDirs: Array.from({ length: preoccupiedCount }, () => expect.any(String)),
      recoveredHashes: expect.any(Object),
      expectedRestoredHashes: expect.any(Object),
        receipt: expect.objectContaining({ status: "committed" }),
      });
    }
  });
});
