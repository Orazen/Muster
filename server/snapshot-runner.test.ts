// The snapshot runner (B1): the §11 gate in order, the verified round trip
// that moves the healthy marker, retention pruning through the transport,
// honest run-log recording, and the two-phase pre-migration capture.
//
// Environment: GOOGLE_* stubbed before a fresh module import (drive-sync
// reads the client at load), a throwaway DATA_DIR per test, one fetch router
// that answers oauth / upload / download / list / delete by URL — and a
// STORE INJECTION SEAM so no test ever touches the real Keychain.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { PassphraseStore } from "./keychain-store.ts";
import { planRetention, type RetentionSnapshot } from "./snapshot-retention.ts";
import { RETENTION_DEFAULTS } from "./snapshot-state.ts";

const PASSPHRASE = "correct-horse-battery-staple";

type RunnerModule = typeof import("./snapshot-runner.ts");
type StateModule = typeof import("./snapshot-state.ts");
type SyncStateModule = typeof import("./sync-state.ts");

/** Reset the registry, then load runner + its state siblings as ONE fresh
 * instance (the runner reads GOOGLE env and SELF_HOSTED at module load). */
async function loadFresh(): Promise<{ runner: RunnerModule; state: StateModule; syncState: SyncStateModule }> {
  vi.resetModules();
  const runner = await import("./snapshot-runner.ts");
  const state = await import("./snapshot-state.ts");
  const syncState = await import("./sync-state.ts");
  return { runner, state, syncState };
}

function fakeStore(overrides: Partial<PassphraseStore> = {}): PassphraseStore {
  const store: PassphraseStore = {
    status: () => "available",
    get: async () => PASSPHRASE,
    getSync: () => PASSPHRASE,
    has: async () => true,
    set: async () => true,
    clear: async () => true,
  };
  return { ...store, ...overrides };
}

function writeDriveConfig(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ driveSync: { refreshToken: "refresh-token-fixture" } }), { mode: 0o600 });
}

interface RemoteFile {
  id: string;
  name: string;
  createdTime: string;
}

interface RouterOptions {
  /** Older remote snapshots the ladder may prune. */
  old?: RetentionSnapshot[];
  /** The fresh upload, when the fixture should list it (real Drive does). */
  uploaded?: RemoteFile;
  uploadStatus?: number;
  deleteStatus?: (id: string) => number | undefined;
}

interface RouterTrace {
  deleted: string[];
  downloads: number;
  uploads: number;
}

function installRouter(options: RouterOptions = {}): RouterTrace {
  const trace: RouterTrace = { deleted: [], downloads: 0, uploads: 0 };
  let uploadedPayload: string | null = null;
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("https://oauth2.googleapis.com/")) {
      return Response.json({ access_token: "access-token-fixture", expires_in: 3600 });
    }
    if (method === "POST" && url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
      trace.uploads += 1;
      const body = String(init?.body ?? "");
      const marker = "Content-Type: application/octet-stream\r\n\r\n";
      const start = body.indexOf(marker);
      const end = body.lastIndexOf("\r\n--");
      if (start < 0 || end < start) throw new Error("fixture: payload part not found in the upload body");
      uploadedPayload = body.slice(start + marker.length, end);
      if (options.uploadStatus !== undefined && options.uploadStatus !== 200) {
        return new Response("upload rejected", { status: options.uploadStatus });
      }
      return Response.json({ id: "snap-new", name: "muster-workspace-v2-1730000000000-cafebabe.enc" });
    }
    if (method === "DELETE") {
      const id = decodeURIComponent(url.split("/files/")[1]?.split("?")[0] ?? "");
      trace.deleted.push(id);
      const status = options.deleteStatus?.(id);
      if (status !== undefined) return new Response("delete rejected", { status });
      return Response.json({ id });
    }
    if (url.includes("alt=media")) {
      trace.downloads += 1;
      if (uploadedPayload === null) throw new Error("fixture: download happened before any upload");
      return new Response(uploadedPayload);
    }
    if (url.includes("/drive/v3/files?")) {
      const files: RetentionSnapshot[] = [];
      if (options.uploaded !== undefined) files.push(options.uploaded);
      for (const entry of options.old ?? []) files.push(entry);
      return Response.json({ files });
    }
    throw new Error(`fixture: unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return trace;
}

/** Ten old snapshots, 40 days apart: every one lands in its own distinct
 * local day, week and month, so the 7/7/4/6 ladder deterministically keeps
 * the newest seven-by-day and prunes the rest. */
function oldSnapshots(): RetentionSnapshot[] {
  const now = Date.now();
  return Array.from({ length: 10 }, (_, i) => {
    const ms = now - (i + 1) * 40 * 86_400_000;
    return {
      id: `old-${i}`,
      name: `muster-workspace-v2-${ms}-${i.toString(16).padStart(8, "0")}.enc`,
      createdTime: new Date(ms).toISOString(),
    };
  });
}

const uploadedFile = (): RemoteFile => ({
  id: "snap-new",
  name: "muster-workspace-v2-1730000000000-cafebabe.enc",
  createdTime: new Date().toISOString(),
});

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "fixture-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture-client-secret");
  vi.stubEnv("OMB_HOST", "127.0.0.1");
  rmSync(DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("gate order (DESIGN §11)", () => {
  it("self-hosted closes the gate first — nothing is read, consulted, or written", async () => {
    vi.stubEnv("OMB_HOST", "0.0.0.0");
    const trace = installRouter();
    const { runner, state } = await loadFresh();
    runner.overrideSnapshotPassphraseStore(
      fakeStore({
        get: async () => {
          throw new Error("the store must not be consulted after the self-hosted gate");
        },
        getSync: () => {
          throw new Error("the store must not be consulted after the self-hosted gate");
        },
      }),
    );

    expect(await runner.runSnapshot("manual")).toEqual({ status: "skipped", reason: "self-hosted" });
    expect(trace.uploads).toBe(0);
    expect(state.readSnapshotState().history).toEqual([]);
  });

  it("no Drive connection closes the gate before the store is touched, silently for one-shot callers", async () => {
    const trace = installRouter();
    const { runner, state } = await loadFresh();
    const get = vi.fn(async () => PASSPHRASE);
    runner.overrideSnapshotPassphraseStore(fakeStore({ get, getSync: () => PASSPHRASE }));

    expect(await runner.runSnapshot("manual")).toEqual({ status: "skipped", reason: "drive-not-connected" });
    expect(get).not.toHaveBeenCalled();
    expect(trace.uploads).toBe(0);
    expect(state.readSnapshotState().history).toEqual([]);
  });

  it("an unavailable store (off darwin / missing helper) closes the gate after Drive", async () => {
    writeDriveConfig();
    const { runner, state } = await loadFresh();
    const get = vi.fn(async () => PASSPHRASE);
    runner.overrideSnapshotPassphraseStore(fakeStore({ status: () => "unavailable", get }));

    expect(await runner.runSnapshot("manual")).toEqual({ status: "skipped", reason: "store-unavailable" });
    expect(get).not.toHaveBeenCalled();
    expect(state.readSnapshotState().history).toEqual([]);
  });

  it("store available but empty → no-passphrase, still silent, still no upload", async () => {
    writeDriveConfig();
    const trace = installRouter();
    const { runner, state } = await loadFresh();
    runner.overrideSnapshotPassphraseStore(fakeStore({ get: async () => null, getSync: () => null }));

    expect(await runner.runSnapshot("manual")).toEqual({ status: "skipped", reason: "no-passphrase" });
    expect(trace.uploads).toBe(0);
    expect(state.readSnapshotState().history).toEqual([]);
  });

  it("the scheduler's nightly entry RECORDS its gate skip; a manual attempt on the same gate stays off disk", async () => {
    const { runner, state } = await loadFresh();
    runner.overrideSnapshotPassphraseStore(fakeStore());

    expect(await runner.runNightlySnapshot()).toEqual({ status: "skipped", reason: "drive-not-connected" });
    const afterNightly = state.readSnapshotState();
    expect(afterNightly.runs.lastOutcome).toBe("skipped");
    expect(afterNightly.runs.lastDetail).toBe("drive-not-connected");
    expect(afterNightly.runs.consecutiveFailures).toBe(1);
    expect(afterNightly.history).toHaveLength(1);
    expect(afterNightly.history[0]?.reason).toBe("nightly");

    expect(await runner.runSnapshot("manual")).toEqual({ status: "skipped", reason: "drive-not-connected" });
    expect(state.readSnapshotState().history).toHaveLength(1); // unchanged
  });
});

describe("verified round trip and retention", () => {
  it("uploads, downloads, verifies, marks health, prunes per the ladder, and stamps the sync card", async () => {
    writeDriveConfig();
    const old = oldSnapshots();
    const uploaded = uploadedFile();
    const trace = installRouter({ old, uploaded });
    const { runner, state, syncState } = await loadFresh();
    runner.overrideSnapshotPassphraseStore(fakeStore());

    const result = await runner.runSnapshot("manual");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.snapshotId).toBe("snap-new");
      expect(result.pruned).toBeGreaterThan(0);
      expect(result.pruneFailed).toBe(0);
    }
    expect(trace.uploads).toBe(1);
    expect(trace.downloads).toBe(1); // the round trip that "known-healthy" means

    const snapshotState = state.readSnapshotState();
    expect(snapshotState.health).toMatchObject({ snapshotId: "snap-new" });
    expect(snapshotState.runs.lastOutcome).toBe("success");
    expect(snapshotState.history[0]).toMatchObject({ outcome: "success", uploadedId: "snap-new" });
    expect(syncState.readSyncState("local").lastPush?.channel).toBe("google-drive");

    // The prune set is exactly the ladder's verdict over the listed files…
    const listed: RetentionSnapshot[] = [uploaded, ...old];
    const expected = planRetention(listed, { healthySnapshotId: "snap-new", counts: RETENTION_DEFAULTS });
    expect(trace.deleted).toEqual(expected.deleteIds);
    // …and the invariants hold at the transport level too.
    expect(trace.deleted).not.toContain("snap-new"); // never the healthy/newest point
    expect(trace.deleted).not.toContain(old[0]?.id); // recent-window files survive
  });

  it("a rejected delete is counted but never fails a snapshot that verified", async () => {
    writeDriveConfig();
    const old = oldSnapshots();
    const uploaded = uploadedFile();
    const trace = installRouter({ old, uploaded, deleteStatus: (id) => (id === "old-9" ? 500 : undefined) });
    const { runner, state } = await loadFresh();
    runner.overrideSnapshotPassphraseStore(fakeStore());

    const result = await runner.runSnapshot("manual");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.pruneFailed).toBe(1);
      expect(result.pruned).toBeGreaterThan(0);
    }
    expect(trace.deleted).toContain("old-9");
    expect(state.readSnapshotState().runs.lastOutcome).toBe("success");
    expect(state.readSnapshotState().health?.snapshotId).toBe("snap-new");
  });

  it("a 404 delete resolves as done — a retried prune converges", async () => {
    writeDriveConfig();
    const old = oldSnapshots();
    const uploaded = uploadedFile();
    const trace = installRouter({ old, uploaded, deleteStatus: () => 404 });
    const { runner } = await loadFresh();
    runner.overrideSnapshotPassphraseStore(fakeStore());

    const result = await runner.runSnapshot("manual");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.pruned).toBe(trace.deleted.length);
      expect(result.pruneFailed).toBe(0);
    }
    expect(trace.deleted.length).toBeGreaterThan(0);
  });

  it("an upload failure lands in the run log and never moves the health marker", async () => {
    writeDriveConfig();
    installRouter({ uploadStatus: 500 });
    const { runner, state } = await loadFresh();
    runner.overrideSnapshotPassphraseStore(fakeStore());

    const result = await runner.runSnapshot("manual");
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("HTTP 500");

    const snapshotState = state.readSnapshotState();
    expect(snapshotState.runs.lastOutcome).toBe("failed");
    expect(snapshotState.runs.lastError).toContain("HTTP 500");
    expect(snapshotState.runs.consecutiveFailures).toBe(1);
    expect(snapshotState.health).toBeNull(); // nothing round-tripped ⇒ nothing healthy
  });

  it("single-flight: overlapping callers join one attempt, not two uploads", async () => {
    writeDriveConfig();
    const trace = installRouter();
    const { runner } = await loadFresh();
    runner.overrideSnapshotPassphraseStore(fakeStore());

    const first = runner.runSnapshot("manual");
    const second = runner.runSnapshot("nightly");
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(trace.uploads).toBe(1);
  });
});

describe("pre-migration capture", () => {
  it("gate closed → a silent in-memory observation and nothing on disk (boot hooks must not write)", async () => {
    const trace = installRouter();
    const { runner, state } = await loadFresh();
    runner.overrideSnapshotPassphraseStore(fakeStore());

    const observation = runner.capturePreMigrationSnapshot(DATA_DIR, "pre-restore");
    expect(observation).toMatchObject({ status: "skipped", detail: "drive-not-connected", reason: "pre-restore" });
    expect(runner.lastPreMigrationCapture()).toEqual(observation);
    expect(state.readSnapshotState().history).toEqual([]);
    expect(trace.uploads).toBe(0);
  });

  it("gate open → seals synchronously (getSync), ships detached, and records the success", async () => {
    writeDriveConfig();
    const trace = installRouter();
    const { runner, state } = await loadFresh();
    const get = vi.fn(async () => PASSPHRASE);
    const getSync = vi.fn(() => PASSPHRASE);
    runner.overrideSnapshotPassphraseStore(fakeStore({ get, getSync }));

    const observation = runner.capturePreMigrationSnapshot(DATA_DIR, "pre-restore");
    expect(observation.status).toBe("in-flight"); // returned BEFORE the ship finished
    expect(getSync).toHaveBeenCalledTimes(1); // the synchronous boot seam
    expect(get).not.toHaveBeenCalled(); // async read is not the boot path

    await vi.waitFor(() => expect(runner.lastPreMigrationCapture()?.status).toBe("ok"));
    expect(runner.lastPreMigrationCapture()?.snapshotId).toBe("snap-new");
    const snapshotState = state.readSnapshotState();
    expect(snapshotState.history.some((entry) => entry.reason === "pre-restore" && entry.outcome === "success")).toBe(true);
    expect(snapshotState.health?.snapshotId).toBe("snap-new");
    expect(trace.uploads).toBe(1);
  });

  it("a failing ship is recorded as failed and never throws into the migration that triggered it", async () => {
    writeDriveConfig();
    installRouter({ uploadStatus: 500 });
    const { runner, state } = await loadFresh();
    runner.overrideSnapshotPassphraseStore(fakeStore());

    expect(() => runner.capturePreMigrationSnapshot(DATA_DIR, "pre-migration")).not.toThrow();
    await vi.waitFor(() => expect(runner.lastPreMigrationCapture()?.status).toBe("failed"));
    expect(runner.lastPreMigrationCapture()?.detail).toContain("HTTP 500");
    const snapshotState = state.readSnapshotState();
    expect(snapshotState.history.some((entry) => entry.reason === "pre-migration" && entry.outcome === "failed")).toBe(true);
  });
});

describe("store seam", () => {
  it("null restores the default store — status is observable without reading any stored value", async () => {
    const { runner } = await loadFresh();
    runner.overrideSnapshotPassphraseStore(fakeStore());
    runner.overrideSnapshotPassphraseStore(null);
    const restored = runner.snapshotPassphraseStore();
    expect(["available", "unavailable"]).toContain(restored.status());
    // deliberately no get()/getSync() here: those would read a real Keychain
  });
});
