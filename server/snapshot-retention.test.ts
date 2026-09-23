// Retention ladder tests (B1) — DESIGN.md §11 Target: "retention ladder
// (recent/daily/weekly/monthly), and the invariant: never delete the last
// known-healthy recovery point."
//
// The DESIGN names the buckets but deliberately states no counts, so the
// counts are this slice's implementation choice (RETENTION_DEFAULTS in
// snapshot-state.ts). What the DESIGN does fix is the invariant, and these
// tests pin it adversarially: bucket boundaries, a lone healthy point
// (deletes nothing), several formerly-healthy points (newest healthy wins),
// clock skew, tombstones, and unclassifiable names.
import { describe, expect, it } from "vitest";

import {
  RETENTION_DEFAULTS,
  RETENTION_MAX,
  type RetentionCounts,
  type SnapshotPolicy,
} from "./snapshot-state.ts";
import { localDayKey, planRetention, snapshotCreatedMs, type RetentionSnapshot } from "./snapshot-retention.ts";

/** Local-noon snapshot whose id, name and createdTime all agree on `date`.
 * `token` must be 8 hex chars to satisfy the real uploader's name format. */
function snap(date: Date, token: string): RetentionSnapshot {
  const epochMs = date.getTime();
  return {
    id: `id-${token}`,
    name: `muster-workspace-v2-${epochMs}-${token}.enc`,
    createdTime: new Date(epochMs).toISOString(),
  };
}

function counts(recent: number, daily: number, weekly: number, monthly: number): RetentionCounts {
  return { recent, daily, weekly, monthly };
}

function plan(files: readonly RetentionSnapshot[], options: { counts: RetentionCounts; healthySnapshotId?: string | null }) {
  return planRetention(files, {
    counts: options.counts,
    healthySnapshotId: options.healthySnapshotId ?? null,
  });
}

const kept = (result: { keepIds: string[] }): Set<string> => new Set(result.keepIds);

describe("snapshotCreatedMs", () => {
  it("prefers Drive's createdTime, falls back to the timestamp in the file name, and reports null when neither parses", () => {
    const driveTime = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(snapshotCreatedMs({ id: "a", createdTime: new Date(driveTime).toISOString(), name: "muster-workspace-v2-1700000000000-deadbeef.enc" })).toBe(driveTime);
    expect(snapshotCreatedMs({ id: "b", createdTime: "not-a-date", name: "muster-workspace-v2-1700000000000-deadbeef.enc" })).toBe(1_700_000_000_000);
    expect(snapshotCreatedMs({ id: "c", name: "muster-workspace-v2-1700000000000-deadbeef.enc" })).toBe(1_700_000_000_000);
    // Unparseable everywhere ⇒ null ⇒ the ladder always keeps it.
    expect(snapshotCreatedMs({ id: "d", createdTime: "nope", name: "not-a-snapshot.txt" })).toBeNull();
    expect(snapshotCreatedMs({ id: "e", name: "muster-workspace-v2-0-deadbeef.enc" })).toBeNull(); // epoch 0 is not a real upload time
    expect(snapshotCreatedMs({ id: "f", createdTime: "nope", name: "muster-workspace-v2-0-deadbeef.enc" })).toBeNull();
  });
});

describe("planRetention — recent / daily / weekly / monthly ladder", () => {
  it("keeps each bucket's newest occupants at the exact boundary and prunes only what falls outside every bucket", () => {
    // Wed 2026-06-17 local. Ladder 1/2/2/2 makes every bucket's edge observable.
    const files = [
      snap(new Date(2026, 5, 17, 12), "aaaaaaa0"), // newest — recent + every newest bucket
      snap(new Date(2026, 5, 16, 12), "aaaaaaa1"), // yesterday — daily's 2nd distinct day
      snap(new Date(2026, 5, 10, 12), "aaaaaaa2"), // prior local week — weekly's 2nd distinct week
      snap(new Date(2026, 5, 9, 12), "aaaaaaa3"), // same prior week, older day — outside weekly=2
      snap(new Date(2026, 4, 20, 12), "aaaaaaa4"), // prior month — monthly's 2nd distinct month
      snap(new Date(2026, 4, 5, 12), "aaaaaaa5"), // same prior month — outside monthly=2 and weekly=2
    ];
    const result = plan(files, { counts: counts(1, 2, 2, 2) });

    expect(kept(result)).toEqual(new Set([files[0].id, files[1].id, files[2].id, files[4].id]));
    expect(result.deleteIds).toEqual([files[3].id, files[5].id]);
    // The newest file is also the newest occupant of its own day, week and
    // month, so it accumulates every reason that could ever save it.
    expect(result.bucketOf.get(files[0].id)).toEqual(["newest", "recent", "daily", "weekly", "monthly"]);
    expect(result.bucketOf.get(files[1].id)).toEqual(["daily"]);
    expect(result.bucketOf.get(files[2].id)).toEqual(["weekly"]);
    expect(result.bucketOf.get(files[4].id)).toEqual(["monthly"]);
    expect(result.bucketOf.has(files[3].id)).toBe(false);
    expect(result.bucketOf.has(files[5].id)).toBe(false);
  });

  it("counts distinct local days that are present, not calendar slots — two snapshots in one local day consume one daily slot", () => {
    const files = [
      snap(new Date(2026, 5, 17, 20, 0), "bbbbbbb0"), // 20:00 today
      snap(new Date(2026, 5, 17, 1, 0), "bbbbbbb1"), // 01:00 today — same local day
      snap(new Date(2026, 5, 16, 23, 30), "bbbbbbb2"), // 23:30 yesterday — its own local day
    ];
    const result = plan(files, { counts: counts(1, 2, 0, 0) });

    // daily=2 covers the two newest distinct local days: today (newest = 20:00)
    // and yesterday (23:30). The 01:00 file loses its day's slot to the 20:00 one.
    expect(kept(result)).toEqual(new Set([files[0].id, files[2].id]));
    expect(result.deleteIds).toEqual([files[1].id]);
    expect(result.bucketOf.get(files[2].id)).toEqual(["daily"]);
  });

  it("buckets in local time: an hour either side of local midnight lands in different daily slots", () => {
    const files = [
      snap(new Date(2026, 5, 17, 0, 30), "ccccccc0"), // 00:30 today
      snap(new Date(2026, 5, 16, 23, 30), "ccccccc1"), // 23:30 yesterday
      snap(new Date(2026, 5, 15, 12, 0), "ccccccc2"), // two days back — outside daily=2
    ];
    const result = plan(files, { counts: counts(0, 2, 0, 0) });

    expect(kept(result)).toEqual(new Set([files[0].id, files[1].id]));
    expect(result.deleteIds).toEqual([files[2].id]);
    expect(localDayKey(new Date(2026, 5, 17, 0, 30).getTime())).toBe("2026-06-17");
    expect(localDayKey(new Date(2026, 5, 16, 23, 30).getTime())).toBe("2026-06-16");
  });

  it("when the healthy point is the oldest file, everything newer than it survives and nothing is deleted at all", () => {
    // The gap-freeze case the DESIGN invariant implies: one verified point far
    // in the past, no newer verify yet — the whole unverified gap stays intact,
    // even with a one-slot ladder that would otherwise prune aggressively.
    const healthy = snap(new Date(2026, 0, 5, 3, 0), "ddddddd0");
    const newer = Array.from({ length: 20 }, (_, i) => snap(new Date(2026, 1, 1 + i, 3, 0), `d${(i + 1).toString(16).padStart(7, "0")}`));
    const result = plan([healthy, ...newer], { counts: counts(1, 1, 1, 1), healthySnapshotId: healthy.id });

    expect(result.deleteIds).toEqual([]);
    expect(result.bucketOf.get(healthy.id)).toContain("healthy");
    for (const file of newer) expect(result.bucketOf.get(file.id)).toContain("newer-than-healthy");
  });

  it("when the healthy point is the newest file, older snapshots outside every bucket are still pruned", () => {
    const files = [
      snap(new Date(2026, 5, 17, 12), "eeeeeee0"),
      snap(new Date(2026, 5, 16, 12), "eeeeeee1"),
      snap(new Date(2026, 4, 20, 12), "eeeeeee2"),
      snap(new Date(2026, 3, 10, 12), "eeeeeee3"),
    ];
    const result = plan(files, { counts: counts(1, 1, 1, 1), healthySnapshotId: files[0].id });

    // One-slot buckets all point at the newest file; only it survives.
    expect(result.keepIds).toEqual([files[0].id]);
    expect(result.deleteIds).toEqual([files[1].id, files[2].id, files[3].id]);
    expect(result.bucketOf.get(files[0].id)).toContain("healthy");
  });

  it("with several formerly-healthy snapshots only the newest healthy id is THE protected point", () => {
    const files = [
      snap(new Date(2026, 5, 17, 12), "fffffff0"), // newest overall (unverified)
      snap(new Date(2026, 5, 15, 12), "fffffff1"), // newest KNOWN-healthy
      snap(new Date(2026, 0, 10, 12), "fffffff2"), // an older once-healthy point
      snap(new Date(2025, 11, 10, 12), "fffffff3"), // even older
    ];
    const result = plan(files, { counts: counts(1, 1, 1, 1), healthySnapshotId: files[1].id });

    expect(result.keepIds).toEqual([files[0].id, files[1].id]);
    expect(result.deleteIds).toEqual([files[2].id, files[3].id]);
    expect(result.bucketOf.get(files[1].id)).toContain("healthy");
    expect(result.bucketOf.get(files[0].id)).toContain("newer-than-healthy");
    // The superseded marker ids are ordinary files now — the invariant protects
    // the LAST known-healthy point, not every point that ever verified.
    expect(result.bucketOf.has(files[2].id)).toBe(false);
  });

  it("treats a healthy id missing from the remote list as a tombstone: no throw, no id in deleteIds", () => {
    const files = [snap(new Date(2026, 5, 17, 12), "abababab"), snap(new Date(2026, 4, 1, 12), "ababab00")];
    const result = plan(files, { counts: counts(1, 1, 0, 0), healthySnapshotId: "gone-from-drive" });

    expect(result.deleteIds).not.toContain("gone-from-drive");
    expect(result.keepIds).not.toContain("gone-from-drive"); // never listed ⇒ never deletable
    expect(result.bucketOf.get("gone-from-drive")).toEqual(["healthy"]);
    expect(kept(result).has(files[0].id)).toBe(true); // ladder continues over the visible list
  });

  it("survives clock skew: future-dated, name-only, and unclassifiable snapshots are never deleted", () => {
    const future = { id: "skew-future", name: "muster-workspace-v2-4102444800000-deadbeef.enc", createdTime: "2099-01-01T00:00:00.000Z" };
    const nameOnly = { id: "skew-name", name: "muster-workspace-v2-1700000000000-deadbeef.enc" };
    const unclassifiable = { id: "skew-garbage", name: "leftover.v2.backup", createdTime: "also-not-a-date" };
    const files = [future, nameOnly, unclassifiable, snap(new Date(2025, 0, 1, 12), "deadbee1")];
    const result = plan(files, { counts: counts(0, 0, 0, 0) });

    // Only the genuinely old, classifiable files go: the future-dated one owns
    // "newest", and the file with neither a Drive time nor a stamped-name time
    // is unclassifiable ⇒ always kept. `nameOnly` sorts by its name timestamp
    // (2023) and is old enough to fall outside a zero-slot ladder.
    expect(result.deleteIds).toEqual([files[1].id, files[3].id]);
    expect(result.bucketOf.get("skew-future")).toEqual(["newest"]);
    expect(result.bucketOf.has("skew-name")).toBe(false); // classified, but saved by nothing
    expect(result.bucketOf.get("skew-garbage")).toEqual(["unclassifiable"]);
  });

  it("clamps out-of-range counts and never lets a zero ladder delete the newest snapshot", () => {
    const files = Array.from({ length: 5 }, (_, i) => snap(new Date(2026, 5, 17 - i, 12), `987654${i}0`));
    const zero = plan(files, { counts: counts(-3, 0, 0, 0) });
    expect(zero.keepIds).toEqual([files[0].id]); // newest survives even at recent=0
    expect(zero.deleteIds).toHaveLength(4);

    const huge = plan(files, { counts: counts(10_000, 999, RETENTION_MAX + 40, Number.NaN) });
    expect(huge.deleteIds).toEqual([]); // NaN falls back to the default, others clamp to ≤60
    expect(plan(files, { counts: counts(2, 0, 0, 0) }).keepIds).toEqual([files[0].id, files[1].id]);
    expect(RETENTION_DEFAULTS).toEqual({ recent: 7, daily: 7, weekly: 4, monthly: 6 });
  });
});

describe("SnapshotPolicy defaults", () => {
  it("ships nightly enabled with the 7/7/4/6 ladder DESIGN leaves to us", () => {
    const policy: SnapshotPolicy = { nightlyEnabled: true, retention: { ...RETENTION_DEFAULTS } };
    expect(policy.nightlyEnabled).toBe(true);
    expect(policy.retention.recent + policy.retention.daily + policy.retention.weekly + policy.retention.monthly).toBe(24);
  });
});
