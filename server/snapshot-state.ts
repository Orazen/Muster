// Snapshot automation state — one small 0600 json under
// DATA_DIR/snapshot-state/ (the sync-state.ts pattern, snapshot-scoped):
// the policy the Settings card edits, the last known-healthy recovery
// point, and the run log every attempt lands in.
//
// DESIGN §11 Target names the retention buckets (recent/daily/weekly/
// monthly) and the invariant — never delete the last known-healthy
// recovery point — but deliberately states NO counts. The defaults below
// (7/7/4/6, ≤24 remote files at steady state) are this slice's choice and
// are shown verbatim in Settings so the operator sees what is in effect.
//
// Writers: policy changes throw (the route reports them); run/health
// bookkeeping follows the sync-state rule — it must never fail the backup
// it describes — except markSnapshotHealth, whose failure the runner
// reports honestly as a failed run (an unrecorded "healthy" marker would
// silently weaken the deletion invariant).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export const RETENTION_MAX = 60;
export const RETENTION_DEFAULTS: RetentionCounts = { recent: 7, daily: 7, weekly: 4, monthly: 6 };
const HISTORY_LIMIT = 20;

export interface RetentionCounts {
  recent: number;
  daily: number;
  weekly: number;
  monthly: number;
}

export interface SnapshotPolicy {
  nightlyEnabled: boolean;
  retention: RetentionCounts;
}

/** The last snapshot a verify round trip actually opened — the "known
 * healthy" point the deletion invariant protects. */
export interface SnapshotHealth {
  snapshotId: string;
  name: string;
  verifiedAt: number;
}

export type SnapshotRunOutcome = "success" | "failed" | "skipped";

export interface SnapshotHistoryEntry {
  at: number;
  reason: string;
  outcome: SnapshotRunOutcome;
  detail: string;
  uploadedId?: string;
  pruned?: number;
  pruneFailed?: number;
}

export interface SnapshotRuns {
  lastAttemptAt: number | null;
  lastAttemptReason: string | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastOutcome: SnapshotRunOutcome | null;
  lastDetail: string | null;
  consecutiveFailures: number;
}

export interface SnapshotState {
  version: 1;
  policy: SnapshotPolicy;
  health: SnapshotHealth | null;
  runs: SnapshotRuns;
  history: SnapshotHistoryEntry[];
}

const retentionCountsSchema = z.object({
  recent: z.number().int().min(0).max(RETENTION_MAX),
  daily: z.number().int().min(0).max(RETENTION_MAX),
  weekly: z.number().int().min(0).max(RETENTION_MAX),
  monthly: z.number().int().min(0).max(RETENTION_MAX),
});

const policySchema = z.object({
  nightlyEnabled: z.boolean(),
  retention: retentionCountsSchema,
});

const healthSchema = z.object({
  snapshotId: z.string().min(1),
  name: z.string().min(1),
  verifiedAt: z.number().int().nonnegative(),
});

const outcomeSchema = z.enum(["success", "failed", "skipped"]);

const historyEntrySchema = z.object({
  at: z.number().int().nonnegative(),
  reason: z.string().min(1),
  outcome: outcomeSchema,
  detail: z.string(),
  uploadedId: z.string().min(1).optional(),
  pruned: z.number().int().nonnegative().optional(),
  pruneFailed: z.number().int().nonnegative().optional(),
});

const runsSchema = z.object({
  lastAttemptAt: z.number().int().nonnegative().nullable(),
  lastAttemptReason: z.string().nullable(),
  lastSuccessAt: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
  lastOutcome: outcomeSchema.nullable(),
  lastDetail: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
});

// Section-level .catch: one hand-edited or corrupt section degrades to its
// default instead of discarding the health marker and the run log with it.
const stateSchema = z.object({
  version: z.literal(1),
  policy: policySchema.catch({ nightlyEnabled: true, retention: RETENTION_DEFAULTS }),
  health: healthSchema.nullable().catch(null),
  runs: runsSchema.catch({
    lastAttemptAt: null,
    lastAttemptReason: null,
    lastSuccessAt: null,
    lastError: null,
    lastOutcome: null,
    lastDetail: null,
    consecutiveFailures: 0,
  }),
  history: z.array(historyEntrySchema).catch([]),
});

const DIR = join(DATA_DIR, "snapshot-state");
const FILE = join(DIR, "automation.json");

export function defaultSnapshotState(): SnapshotState {
  return {
    version: 1,
    // Nightly defaults ON: the gate (Drive + stored passphrase) is what
    // holds automatic snapshots back, exactly as DESIGN §11 frames it.
    policy: { nightlyEnabled: true, retention: { ...RETENTION_DEFAULTS } },
    health: null,
    runs: {
      lastAttemptAt: null,
      lastAttemptReason: null,
      lastSuccessAt: null,
      lastError: null,
      lastOutcome: null,
      lastDetail: null,
      consecutiveFailures: 0,
    },
    history: [],
  };
}

export function readSnapshotState(): SnapshotState {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(FILE, "utf8")));
    if (parsed.success) return parsed.data;
    return defaultSnapshotState();
  } catch {
    // first run or unreadable file — the defaults ARE the state
    return defaultSnapshotState();
  }
}

function writeState(state: SnapshotState): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(FILE, JSON.stringify(state), { mode: 0o600 });
}

/** Policy writes surface failures to the route — a silently-dropped
 * toggle would lie to the operator. */
export function writeSnapshotPolicy(policy: SnapshotPolicy): void {
  const checked = policySchema.parse(policy);
  const state = readSnapshotState();
  writeState({ ...state, policy: checked });
}

/** Record the healthy marker. Throws on purpose: the runner reports a
 * failed write as a failed run rather than pruning without proof. */
export function markSnapshotHealth(health: SnapshotHealth): void {
  const checked = healthSchema.parse(health);
  const state = readSnapshotState();
  writeState({ ...state, health: checked });
}

/** Append one attempt to the run log and advance the derived runs view.
 * Swallows write failures — bookkeeping must never fail the backup it
 * describes (sync-state.ts convention). */
export function recordSnapshotRun(entry: SnapshotHistoryEntry): void {
  try {
    const checked = historyEntrySchema.parse(entry);
    const state = readSnapshotState();
    const runs: SnapshotRuns = {
      lastAttemptAt: checked.at,
      lastAttemptReason: checked.reason,
      lastSuccessAt: checked.outcome === "success" ? checked.at : state.runs.lastSuccessAt,
      lastError: checked.outcome === "failed" ? checked.detail : null,
      lastOutcome: checked.outcome,
      lastDetail: checked.detail,
      // "failures" counts non-success attempts (skips included): the number
      // Settings shows after a gate stayed closed all night.
      consecutiveFailures: checked.outcome === "success" ? 0 : state.runs.consecutiveFailures + 1,
    };
    writeState({ ...state, runs, history: [...state.history, checked].slice(-HISTORY_LIMIT) });
  } catch {
    // never throws into the run it describes
  }
}
