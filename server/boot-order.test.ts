// The boot order, proven end to end.
//
// A staged restore must commit BEFORE the Store is constructed. Reversed, the
// Store reads the pre-restore fleet into memory, the live process overwrites
// what the swap wrote, and the receipt still says "committed" — a silent,
// total loss of the restore with a success message attached.
//
// This was a bare statement in server/index.ts under a comment, untestable
// because importing that module starts the server. `bootWithRestoreFirst` names
// the sequence so it can be executed here. Nothing is mocked: a real install is
// exported, sealed, decrypted, staged into a second real install, and booted
// through the helper — and the store factory reads the file off disk exactly
// as the real one does, so the assertion is about the restored world rather
// than about a mock's call order.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { bootWithRestoreFirst } from "./boot-order.ts";
import {
  PENDING_RESTORE_FORMAT,
  readPendingRestore,
  readLastReceipt,
  writePendingRestore,
} from "./restore-apply.ts";
import { buildPayloadV2, decryptBundleV2, encryptBundleV2, stageRestoreV2 } from "./workspace-bundle-v2.ts";

const PASSPHRASE = "correct-horse-battery";

/** A minimal but real install: one bot, so the roster is observable. */
function makeInstall(root: string, name: string, botId: string): string {
  const dataDir = join(root, name);
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  mkdirSync(join(dataDir, "workspaces", botId, "memory"), { recursive: true });
  writeFileSync(
    join(dataDir, "bots.json"),
    JSON.stringify([{ id: botId, threadId: `t-${botId}`, name, notifications: true, unread: false }], null, 2),
  );
  writeFileSync(join(dataDir, "groups.json"), "[]");
  writeFileSync(join(dataDir, "MEMORY.md"), "# MEMORY\n\nnotes\n");
  writeFileSync(join(dataDir, "memory", "topic.md"), "# Topic\n");
  writeFileSync(join(dataDir, "workspaces", botId, "MEMORY.md"), `# MEMORY\n\n${name} notes\n`);
  return dataDir;
}

function sealFrom(dataDir: string): Buffer {
  const payload = buildPayloadV2({ dataDir, appVersion: "1.21.0" });
  return encryptBundleV2(payload, { passphrase: PASSPHRASE });
}

/** The real stage result type rather than a hand-written copy, so a change to
 *  the stage contract breaks here instead of silently drifting. */
type StageResult = ReturnType<typeof stageRestoreV2>;

function stageInto(target: string, sealed: Buffer): StageResult {
  const opened = decryptBundleV2(sealed, { passphrase: PASSPHRASE });
  expect(opened.status).toBe("ok");
  if (opened.payload === undefined) throw new Error("expected a decrypted payload");
  const result = stageRestoreV2(opened.payload, { stagingDir: `${target}.restore-staging`, remapIds: false });
  expect(result.status, JSON.stringify(result.blocked)).toBe("staged");
  if (result.status !== "staged") throw new Error("a refused stage reached the caller");
  return result;
}

describe("boot order", () => {
  it("applies a staged restore before the store factory is reached", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-boot-order-"));
    try {
      const a = makeInstall(root, "source", "bot-source");
      const b = makeInstall(root, "target", "bot-target");

      const sealed = sealFrom(a);
      const staged = stageInto(b, sealed);
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

      // The real boot sequence, with a store factory that behaves like the
      // real one: it reads bots.json off disk, once, at construction.
      const { store: readAtConstruction, restored } = bootWithRestoreFirst(b, () =>
        // SAFETY: bots.json is written by makeInstall and by the restore commit
        // as a JSON array of bot records, and both writers are in this file's
        // control; the read happens once, inside the factory, exactly as the
        // real Store does at construction.
        JSON.parse(readFileSync(join(b, "bots.json"), "utf8")) as Array<{ id: string }>,
      );

      // The decisive assertion: the store saw the RESTORED roster, not the one
      // that was on disk before the swap. If the order were reversed this would
      // read ["bot-target"] and then be silently overwritten.
      expect(readAtConstruction.map((bot) => bot.id)).toEqual(["bot-source"]);
      expect(restored).toBe(true);
      expect(readPendingRestore(b), "the pending record survived a committed apply").toBeNull();
      expect(readLastReceipt(b)?.status).toBe("committed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still builds the store when there is nothing staged", () => {
    // The helper must not become a way to skip Store construction on a normal
    // boot — that would turn a restore fix into an empty-app bug.
    const root = mkdtempSync(join(tmpdir(), "omb-boot-order-clean-"));
    try {
      const b = makeInstall(root, "clean", "bot-only");
      let built = 0;
      const { store, restored } = bootWithRestoreFirst(b, () => {
        built += 1;
        // SAFETY: as above — makeInstall wrote this file, nothing else has.
        return JSON.parse(readFileSync(join(b, "bots.json"), "utf8")) as Array<{ id: string }>;
      });
      expect(built).toBe(1);
      expect(restored).toBe(false);
      expect(store.map((bot) => bot.id)).toEqual(["bot-only"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the restore even when the incoming bundle is smaller than the current one", () => {
    // A restore that would SHRINK the workspace is exactly the case a
    // "nothing to do, skip the store" optimisation would silently get wrong, so
    // the replace-not-merge behaviour is asserted from the boot's own view.
    const root = mkdtempSync(join(tmpdir(), "omb-boot-order-shrink-"));
    try {
      const a = makeInstall(root, "small", "bot-one");
      const b = makeInstall(root, "big", "bot-one");
      writeFileSync(
        join(b, "bots.json"),
        JSON.stringify(
          [
            { id: "bot-one", threadId: "t-bot-one", name: "big", notifications: true, unread: false },
            { id: "bot-two", threadId: "t-bot-two", name: "extra", notifications: true, unread: false },
          ],
          null,
          2,
        ),
      );
      const sealed = sealFrom(a);
      const staged = stageInto(b, sealed);
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

      const { store } = bootWithRestoreFirst(b, () =>
        // SAFETY: as above — written by makeInstall, then by the restore commit.
        JSON.parse(readFileSync(join(b, "bots.json"), "utf8")) as Array<{ id: string }>,
      );
      // bot-two is gone: the commit REPLACES the covered set, it does not merge.
      expect(store.map((bot) => bot.id)).toEqual(["bot-one"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


it("keeps the production live-account hook read-only and ahead of config/auth/storage imports",()=>{
  const source=readFileSync(join(process.cwd(),"server/index.ts"),"utf8");
  const live=source.indexOf('import "./drive-visible-startup-refusal.ts"'),whole=source.indexOf('import "./data-dir-exclusivity-boot.ts"');
  expect(live).toBeGreaterThanOrEqual(0);expect(whole).toBeGreaterThan(live);
  const early=readFileSync(join(process.cwd(),"server/drive-visible-startup-refusal.ts"),"utf8");
  expect(early).toContain("assertLiveRestoreStartupReady(DATA_DIR)");expect(early).not.toContain("recoverPendingLiveRestores(");
  const journal=readFileSync(join(process.cwd(),"server/drive-visible-live-journal.ts"),"utf8");
  expect(journal).not.toMatch(/from ["']\.\/(config|auth|store|task-engine|message-db)\.ts/);
});
