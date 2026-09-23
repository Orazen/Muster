// The retention ladder — pure decision logic over a remote snapshot list
// (DESIGN §11 Target: "retention ladder (recent/daily/weekly/monthly), and
// the invariant: never delete the last known-healthy recovery point").
//
// DESIGN names the buckets but no counts; counts arrive from the policy
// (snapshot-state.ts defaults 7/7/4/6) and are clamped here as defense so
// a hand-edited file cannot make the ladder unbounded or negative.
//
// Every keep is labelled in `bucketOf` so Settings/debug can answer "why
// is this still here?" without re-deriving the rules. Invariants, in the
// order they are applied:
//   1. a snapshot with no parseable time (neither createdTime nor the
//      timestamp in its own name) is never deleted — unclassifiable data
//      is not something a ladder may gamble on;
//   2. the healthy snapshot itself is never deleted;
//   3. nothing NEWER than the healthy one is deleted (an unverified gap
//      since the last round trip stays intact — if nightly verification
//      runs, the gap is one day; if it does not, the ladder freezes newer
//      material until the next verified point and keeps pruning older);
//   4. the newest snapshot overall is never deleted;
//   5. buckets: the newest `recent` snapshots, plus one newest per local
//      day / local week / local month for the newest `daily` / `weekly` /
//      `monthly` distinct buckets that actually contain snapshots.
import { RETENTION_DEFAULTS, RETENTION_MAX, type RetentionCounts } from "./snapshot-state.ts";

export interface RetentionSnapshot {
  id: string;
  name: string;
  createdTime?: string;
}

export interface RetentionPlanOptions {
  /** The newest known-healthy snapshot id, or null before the first verify. */
  healthySnapshotId: string | null;
  counts: RetentionCounts;
}

export interface RetentionPlan {
  deleteIds: string[];
  keepIds: string[];
  /** id → the keep reasons that saved it (empty ⇒ scheduled for deletion). */
  bucketOf: Map<string, string[]>;
}

const SNAPSHOT_NAME_RE = /^muster-workspace-v2-(\d+)-[0-9a-f]{8}\.enc$/;

/** createdTime (Drive's clock) first; the timestamp the uploader stamped
 * into the file name second. null ⇒ unclassifiable ⇒ always kept. */
export function snapshotCreatedMs(snapshot: RetentionSnapshot): number | null {
  const named = SNAPSHOT_NAME_RE.exec(snapshot.name);
  if (snapshot.createdTime !== undefined) {
    const parsed = Date.parse(snapshot.createdTime);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (named !== null) {
    const stamped = Number(named[1]);
    if (Number.isFinite(stamped) && stamped > 0) return stamped;
  }
  return null;
}

/** Local calendar day key — the ladder buckets in the operator's own
 * timezone, so "one per day" matches the day they lived. */
export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Week key via the Thursday-of-week rule in local time: one stable key
 * across a local Saturday→Sunday boundary, no ISO week-number math. */
function localWeekKey(ms: number): string {
  const date = new Date(ms);
  const weekday = (date.getDay() + 6) % 7; // Monday = 0
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - weekday + 3);
  return localDayKey(thursday.getTime());
}

function localMonthKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function clampCount(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(RETENTION_MAX, Math.max(0, Math.trunc(value)));
}

function clampedCounts(counts: RetentionCounts): RetentionCounts {
  return {
    recent: clampCount(counts.recent, RETENTION_DEFAULTS.recent),
    daily: clampCount(counts.daily, RETENTION_DEFAULTS.daily),
    weekly: clampCount(counts.weekly, RETENTION_DEFAULTS.weekly),
    monthly: clampCount(counts.monthly, RETENTION_DEFAULTS.monthly),
  };
}

export function planRetention(snapshots: readonly RetentionSnapshot[], options: RetentionPlanOptions): RetentionPlan {
  const counts = clampedCounts(options.counts);
  const bucketOf = new Map<string, string[]>();
  const keep = (id: string, reason: string): void => {
    const reasons = bucketOf.get(id);
    if (reasons === undefined) bucketOf.set(id, [reason]);
    else if (!reasons.includes(reason)) reasons.push(reason);
  };

  interface Classified {
    id: string;
    ms: number;
  }
  const classified: Classified[] = [];
  for (const snapshot of snapshots) {
    const ms = snapshotCreatedMs(snapshot);
    if (ms === null) {
      keep(snapshot.id, "unclassifiable");
      continue;
    }
    classified.push({ id: snapshot.id, ms });
  }

  // newest first; equal times fall back to input order (Drive returns
  // modifiedTime desc, so input order is already newest-first).
  classified.sort((a, b) => b.ms - a.ms);

  const byId = new Map(classified.map((entry) => [entry.id, entry] as const));

  // Invariant 2 + 3: the healthy point, and everything after it.
  if (options.healthySnapshotId !== null) {
    keep(options.healthySnapshotId, "healthy");
    const healthy = byId.get(options.healthySnapshotId);
    if (healthy !== undefined) {
      for (const entry of classified) {
        if (entry.ms > healthy.ms) keep(entry.id, "newer-than-healthy");
      }
    }
    // A healthy id missing from the list is a tombstone: the marker itself
    // is still reported as kept (nothing may delete an id we cannot see),
    // and the ladder continues over what the list actually contains.
  }

  // Invariant 4: the newest recovery point always survives.
  const newest = classified[0];
  if (newest !== undefined) keep(newest.id, "newest");

  // Bucket 1 — recent: the newest N raw snapshots.
  for (const entry of classified.slice(0, counts.recent)) keep(entry.id, "recent");

  // Buckets 2..4 — one newest snapshot per distinct local day/week/month,
  // over the newest `count` distinct buckets present in the list.
  const keepFirstPer = (keyOf: (ms: number) => string, count: number, label: string): void => {
    const ownerByKey = new Map<string, string>();
    for (const entry of classified) {
      const key = keyOf(entry.ms);
      if (!ownerByKey.has(key)) ownerByKey.set(key, entry.id); // first seen = newest
    }
    let taken = 0;
    for (const id of ownerByKey.values()) {
      if (taken >= count) break;
      keep(id, label);
      taken += 1;
    }
  };
  keepFirstPer(localDayKey, counts.daily, "daily");
  keepFirstPer(localWeekKey, counts.weekly, "weekly");
  keepFirstPer(localMonthKey, counts.monthly, "monthly");

  const deleteIds: string[] = [];
  const keepIds: string[] = [];
  for (const snapshot of snapshots) {
    if (bucketOf.has(snapshot.id)) keepIds.push(snapshot.id);
    else deleteIds.push(snapshot.id);
  }
  return { deleteIds, keepIds, bucketOf };
}
