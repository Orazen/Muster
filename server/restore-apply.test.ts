// The pending-restore apply — boot-time commit of a staged v2 restore.
//
// Fixtures are owned and throwaway: temp roots per case, a real messages.db
// built from the server/message-db.ts declaration, and the contract test —
// export from A, stage into fresh B, apply at "boot", and check that B now
// IS A's workspace with routines disabled and goals stopped. Nothing here
// touches a real installation.
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it, vi } from "vitest";

import { lastPreMigrationCapture } from "./snapshot-runner.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { buildPayloadV2, decryptBundleV2, encryptBundleV2, stageRestoreV2 } from "./workspace-bundle-v2.ts";
import {
  applyPendingRestore,
  PENDING_RESTORE_FORMAT,
  readLastReceipt,
  readPendingRestore,
  stagingPathFor,
  writePendingRestore,
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
