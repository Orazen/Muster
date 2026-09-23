// Automatic snapshot runner (B1, DESIGN §11 Target) — ONE gate, one path.
//
// The §11 gate, in order, exactly as the target words it: "automatic
// snapshots (nightly when a Drive connection + trusted passphrase store
// exist — the passphrase-store decision is the gate, flagged),
// pre-upgrade/pre-migration snapshots". So:
//
//   1. self-hosted → closed (the route wall keeps workspace backups
//      desktop-only; the runner refusing too means the scheduler cannot
//      arm its way around the wall);
//   2. Drive connection (installation refreshToken + OAuth client) → else
//      drive-not-connected;
//   3. passphrase store status → else store-unavailable (off darwin or
//      without /usr/bin/security the gate is closed, by design);
//   4. an actual readable passphrase of the bundle's own 8-char floor →
//      else no-passphrase.
//
// Every real attempt (success or failure) lands in the run log; a gate that
// is closed is silent for one-shot callers (manual, pre-migration) because
// THEY return the skip on the wire — except the scheduler, which passes
// recordGateSkip so a nightly that never fired is visible in Settings and
// counts against the per-local-day attempt budget instead of ticking
// invisibly forever.
//
// Health marking: the healthy marker moves only after upload → download →
// verifyBundleV2 all pass, so the deletion invariant ("never delete the
// last known-healthy recovery point") protects a point that actually round
// tripped. Prune runs after the mark, on every attempt type, and its
// failures are recorded without failing the verified upload.
//
// No passphrase value ever reaches a log line, an error message, or a
// response — and no security claim is made anywhere in this module.
import { readFileSync } from "node:fs";

import { DATA_DIR, loadConfig, type AppConfig } from "./config.ts";
import * as driveSync from "./drive-sync.ts";
import { createKeychainStore, KEYCHAIN_MIN_PASSPHRASE_LENGTH, type PassphraseStore } from "./keychain-store.ts";
import { planRetention } from "./snapshot-retention.ts";
import { markSnapshotHealth, readSnapshotState, recordSnapshotRun } from "./snapshot-state.ts";
import * as syncState from "./sync-state.ts";
import * as bundleV2 from "./workspace-bundle-v2.ts";

/** Mirrors auth.ts's SELF_HOSTED — CHANGE IN LOCKSTEP. Kept as a local
 * expression (not an import) so scheduler/runner tests never enter auth.ts's
 * import graph, the same reason auth.ts documents for its own locality. */
export const SELF_HOSTED_MIRROR =
  (process.env.OMB_HOST ?? "127.0.0.1") !== "127.0.0.1" || Boolean(process.env.OMB_PUBLIC_HOST);

export type GateReason = "self-hosted" | "drive-not-connected" | "store-unavailable" | "no-passphrase";

export interface SnapshotRunOptions {
  /** Test seam; production always uses DATA_DIR. */
  dataDir?: string;
  /** Test seam; production reads the package version (best effort). */
  appVersion?: string;
  /** Nightly passes true — see the header note on recording gate skips. */
  recordGateSkip?: boolean;
}

export interface SnapshotShipped {
  snapshotId: string;
  name: string;
  pruned: number;
  pruneFailed: number;
  pruneError?: string;
}

export type SnapshotRunResult =
  | ({ status: "ok" } & SnapshotShipped)
  | { status: "skipped"; reason: GateReason }
  | { status: "failed"; error: string };

/** The injectable store seam: routes and tests swap implementations without
 * the module graph reaching for the real Keychain. */
let passphraseStore: PassphraseStore = createKeychainStore();

export function overrideSnapshotPassphraseStore(store: PassphraseStore | null): void {
  passphraseStore = store ?? createKeychainStore();
}

export function snapshotPassphraseStore(): PassphraseStore {
  return passphraseStore;
}

/** The §11 Drive-connection half of the gate, exported so the Settings card
 * and the routes can report the SAME boolean the runner will enforce. */
export function installationDriveConnected(cfg: AppConfig = loadConfig()): boolean {
  return Boolean(cfg.driveSync?.refreshToken?.trim()) && driveSync.driveOAuthConfigured();
}

function gateReason(cfg: AppConfig): GateReason | null {
  if (SELF_HOSTED_MIRROR) return "self-hosted";
  if (!installationDriveConnected(cfg)) return "drive-not-connected";
  if (passphraseStore.status() !== "available") return "store-unavailable";
  return null;
}

/** Best effort, mirroring index.ts's appVersion(): a packaged layout without
 * a readable package.json reports "unknown" rather than failing a backup
 * over one cosmetic field. */
function readAppVersion(): string {
  try {
    // SAFETY: parsing this repo's own package.json; any surprise shape or IO
    // error falls through to "unknown". The field's contract is a semver
    // string per npm's own spec, so the domain type carries the check.
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return parsed.version && /^\d+\.\d+/.test(parsed.version) ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- thrown values arrive untyped; this classifier IS the boundary parse (same posture as config.ts's isValidSshAlias parser).
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function successDetail(shipped: SnapshotShipped): string {
  const prune = shipped.pruneError !== undefined
    ? `prune unavailable (${shipped.pruneError})`
    : `pruned ${shipped.pruned}${shipped.pruneFailed > 0 ? `, ${shipped.pruneFailed} delete(s) failed` : ""}`;
  return `round trip verified; ${prune}`;
}

/** Seal → connect → upload → download → verify → mark healthy → prune →
 * stamp the sync card. Throws are the caller's to classify; this function
 * never embeds the passphrase in what it throws. */
async function shipSnapshot(bytes: Buffer, passphrase: string): Promise<SnapshotShipped> {
  const cfg = loadConfig();
  const refreshToken = cfg.driveSync?.refreshToken;
  if (!refreshToken?.trim() || !driveSync.driveOAuthConfigured()) {
    // the connection was removed between the gate and the ship
    throw new Error("Google Drive is not connected");
  }
  const token = await driveSync.refreshDriveToken(refreshToken);
  const access = token.accessToken;
  const uploaded = await driveSync.uploadSnapshot(access, bytes.toString("utf8"));
  const downloaded = await driveSync.downloadSnapshot(access, uploaded.id);
  const verify = bundleV2.verifyBundleV2(Buffer.from(downloaded, "utf8"), { passphrase });
  if (verify.status !== "ok") {
    throw new Error(`the uploaded snapshot did not verify on round trip: ${verify.status}`);
  }
  // The marker moves only now — after the round trip actually opened.
  markSnapshotHealth({ snapshotId: uploaded.id, name: uploaded.name, verifiedAt: Date.now() });
  const prune = await pruneSnapshots(access);
  syncState.stampSync("local", "push", "google-drive");
  return { snapshotId: uploaded.id, name: uploaded.name, ...prune };
}

interface PruneOutcome {
  pruned: number;
  pruneFailed: number;
  pruneError?: string;
}

/** Retention on every attempt type. Never throws: a list failure or a
 * rejected delete is recorded in the run detail, because a prune problem
 * must not fail a snapshot that verified. */
async function pruneSnapshots(access: string): Promise<PruneOutcome> {
  try {
    const state = readSnapshotState();
    const listed = await driveSync.listSnapshots(access);
    const plan = planRetention(listed, {
      healthySnapshotId: state.health?.snapshotId ?? null,
      counts: state.policy.retention,
    });
    let pruned = 0;
    let pruneFailed = 0;
    for (const id of plan.deleteIds) {
      try {
        await driveSync.deleteSnapshot(access, id);
        pruned += 1;
      } catch {
        pruneFailed += 1;
      }
    }
    return { pruned, pruneFailed };
  } catch (error) {
    return { pruned: 0, pruneFailed: 0, pruneError: detailOf(error) };
  }
}

function skipResult(reason: string, gate: GateReason, record: boolean): SnapshotRunResult {
  if (record) {
    recordSnapshotRun({ at: Date.now(), reason, outcome: "skipped", detail: gate });
  }
  return { status: "skipped", reason: gate };
}

let inflight: Promise<SnapshotRunResult> | null = null;

/** One snapshot attempt. Single-flight: the nightly tick, a manual route
 * click, and a pre-migration capture's ship can overlap — the in-process
 * caller joins the attempt already running rather than racing two uploads
 * (Drive files are immutable, so overlap is safe; joining is just tidier). */
export function runSnapshot(reason: string, options: SnapshotRunOptions = {}): Promise<SnapshotRunResult> {
  if (inflight !== null) return inflight;
  inflight = execute(reason, options).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function execute(reason: string, options: SnapshotRunOptions): Promise<SnapshotRunResult> {
  const cfg = loadConfig();
  const gate = gateReason(cfg);
  if (gate !== null) return skipResult(reason, gate, options.recordGateSkip === true);
  const passphrase = await passphraseStore.get();
  if (passphrase === null || passphrase.length < KEYCHAIN_MIN_PASSPHRASE_LENGTH) {
    return skipResult(reason, "no-passphrase", options.recordGateSkip === true);
  }
  const dataDir = options.dataDir ?? DATA_DIR;
  const appVersion = options.appVersion ?? readAppVersion();
  try {
    const payload = bundleV2.buildPayloadV2({ dataDir, appVersion });
    const bytes = bundleV2.encryptBundleV2(payload, { passphrase });
    const shipped = await shipSnapshot(bytes, passphrase);
    recordSnapshotRun({
      at: Date.now(),
      reason,
      outcome: "success",
      detail: successDetail(shipped),
      uploadedId: shipped.snapshotId,
      pruned: shipped.pruned,
      pruneFailed: shipped.pruneFailed,
    });
    return { status: "ok", ...shipped };
  } catch (error) {
    const message = detailOf(error);
    recordSnapshotRun({ at: Date.now(), reason, outcome: "failed", detail: message });
    return { status: "failed", error: message };
  }
}

/** The scheduler's entry: same path as a manual run, but a closed gate is
 * RECORDED (visible in Settings, budgeted per local day) — see header. */
export function runNightlySnapshot(): Promise<SnapshotRunResult> {
  return runSnapshot("nightly", { recordGateSkip: true });
}

// ── Pre-migration / pre-upgrade capture ────────────────────────────────────
// Called from synchronous boot hooks (a legacy data-dir rename, a pending
// restore commit) that are ABOUT to replace data and cannot await anything
// first. So this captures in two phases: the SEAL (passphrase read, payload
// build, encrypt) runs synchronously — bytes of the pre-mutation state exist
// before the caller mutates — and the SHIP runs detached. A gate that is
// closed makes the capture a silent no-op observation (boot hooks must not
// grow state files or console noise on an installation that never opted in);
// a ship failure is always recorded, and never propagates to the caller:
// a failed pre-migration capture must NOT block the migration itself.

export interface PreMigrationCapture {
  at: number;
  reason: string;
  status: "skipped" | "sealing-failed" | "in-flight" | "ok" | "failed";
  detail: string;
  snapshotId?: string;
}

let lastCapture: PreMigrationCapture | null = null;

/** The observation seam for tests and diagnostics — the only way a boot-path
 * caller (which got a synchronous, deliberately un-awaited answer) can learn
 * how the detached ship ended. */
export function lastPreMigrationCapture(): PreMigrationCapture | null {
  return lastCapture;
}

function observe(capture: PreMigrationCapture): PreMigrationCapture {
  lastCapture = capture;
  return capture;
}

/** Seal now, ship detached. Never throws — the returned observation is the
 * synchronous truth at seal time; lastPreMigrationCapture() later reflects
 * the detached ship's outcome. */
export function capturePreMigrationSnapshot(dataDir: string, reason: string): PreMigrationCapture {
  const at = Date.now();
  try {
    const gate = gateReason(loadConfig());
    if (gate !== null) return observe({ at, reason, status: "skipped", detail: gate });
    const passphrase = passphraseStore.getSync();
    if (passphrase === null || passphrase.length < KEYCHAIN_MIN_PASSPHRASE_LENGTH) {
      return observe({ at, reason, status: "skipped", detail: "no-passphrase" });
    }
    let bytes: Buffer;
    try {
      const payload = bundleV2.buildPayloadV2({ dataDir, appVersion: readAppVersion() });
      bytes = bundleV2.encryptBundleV2(payload, { passphrase });
    } catch (error) {
      const detail = `pre-migration seal failed: ${detailOf(error)}`;
      recordSnapshotRun({ at: Date.now(), reason, outcome: "failed", detail });
      return observe({ at, reason, status: "sealing-failed", detail });
    }
    const observation = observe({ at, reason, status: "in-flight", detail: "sealed — shipping" });
    void shipSnapshot(bytes, passphrase)
      .then((shipped) => {
        recordSnapshotRun({
          at: Date.now(),
          reason,
          outcome: "success",
          detail: successDetail(shipped),
          uploadedId: shipped.snapshotId,
          pruned: shipped.pruned,
          pruneFailed: shipped.pruneFailed,
        });
        observe({ ...observation, status: "ok", detail: successDetail(shipped), snapshotId: shipped.snapshotId });
      })
      .catch((error) => {
        const detail = `pre-migration ship failed: ${detailOf(error)}`;
        recordSnapshotRun({ at: Date.now(), reason, outcome: "failed", detail });
        observe({ ...observation, status: "failed", detail });
      });
    return observation;
  } catch (error) {
    // belt: gateReason/loadConfig may throw on hostile env; boot must survive
    return observe({ at, reason, status: "sealing-failed", detail: detailOf(error) });
  }
}
