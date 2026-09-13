import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("sync state bookkeeping", () => {
  async function withDataDirectory<T>(run: () => Promise<T>): Promise<T> {
    const dataDirectory = mkdtempSync(join(tmpdir(), "omb-sync-state-"));
    const previousDataDirectory = process.env.OMB_DATA_DIR;
    process.env.OMB_DATA_DIR = dataDirectory;
    try {
      return await run();
    } finally {
      if (previousDataDirectory === undefined) delete process.env.OMB_DATA_DIR;
      else process.env.OMB_DATA_DIR = previousDataDirectory;
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it("initializes unread sync state as empty", async () => {
    await withDataDirectory(async () => {
      const { readSyncState } = await import("./sync-state.ts");
      const state = readSyncState("local");
      expect(state).toEqual({ lastPush: null, lastPull: null });
    });
  });

  it("persists separate push and pull stamps", async () => {
    await withDataDirectory(async () => {
      const { readSyncState, stampSync } = await import("./sync-state.ts");
      stampSync("local", "push", "google-drive");
      const afterPush = readSyncState("local");
      expect(afterPush.lastPush).not.toBeNull();
      expect(afterPush.lastPush?.channel).toBe("google-drive");
      expect(afterPush.lastPull).toBeNull();
      stampSync("local", "pull", "telegram");
      const afterPull = readSyncState("local");
      expect(afterPull.lastPush).toEqual(afterPush.lastPush);
      expect(afterPull.lastPull).toEqual(expect.objectContaining({ channel: "telegram" }));
    });
  });
});
