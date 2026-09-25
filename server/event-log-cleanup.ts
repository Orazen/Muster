// Event-log cleanup — the bounded retention OMB ships and Muster's settings
// used to admit missing. One .ndjson per thread lives in EVENTS_DIR (written
// by the harness bus on every runtime event); threads that were archived
// stop growing but their logs sat forever, and a chatty bot's log grew
// unbounded. Both controls are OFF by default: deletion only ever touches
// event-log FILES of ARCHIVED threads past the threshold, and trimming keeps
// the newest tail — never the transcript, never the message database.
// `sync-*.ndjson` files in the same directory belong to the sync engine's
// journal and are excluded by prefix: this sweep must not eat them.
import { readdirSync, statSync, unlinkSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

/** Event-log files only: `<threadId>.ndjson`, never the sync journal. */
export function listEventLogFiles(eventsDir: string): string[] {
  try {
    return readdirSync(eventsDir)
      .filter((name) => name.endsWith(".ndjson") && !name.startsWith("sync-"))
      .map((name) => join(eventsDir, name));
  } catch {
    // A missing or unreadable events dir has nothing to clean.
    return [];
  }
}

export interface PruneResult {
  deleted: number;
  trimmed: number;
}

/** Delete event logs of archived threads whose last write is older than
 * `days`. mtime is the honest "closed N days ago" signal: the bus appends on
 * every runtime event, so a still-active thread's log is always fresh. */
export function deleteStaleArchivedLogs(input: {
  eventsDir: string;
  archivedThreadIds: ReadonlySet<string>;
  days: number;
  now?: number;
}): PruneResult {
  const { eventsDir, archivedThreadIds, days } = input;
  const now = input.now ?? Date.now();
  if (!Number.isFinite(days) || days < 1 || archivedThreadIds.size === 0) return { deleted: 0, trimmed: 0 };
  let deleted = 0;
  for (const path of listEventLogFiles(eventsDir)) {
    const threadId = path.slice(eventsDir.length + 1).replace(/\.ndjson$/, "");
    if (!archivedThreadIds.has(threadId)) continue;
    try {
      const age = now - statSync(path).mtimeMs;
      if (age > days * DAY_MS) {
        unlinkSync(path);
        deleted++;
      }
    } catch {
      // Raced with a delete or a permission blip — the next sweep retries.
    }
  }
  return { deleted, trimmed: 0 };
}

/** Keep each log at or below `mib` MiB by retaining the NEWEST tail, cut at
 * a newline boundary so the first remaining line is whole. All callers use
 * synchronous fs (the harness bus appends synchronously), so a read-modify-
 * write here cannot interleave with a concurrent append in-process. */
export function trimEventLog(path: string, mib: number): boolean {
  if (!Number.isFinite(mib) || mib < 1) return false;
  const cap = mib * MIB;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size <= cap) return false;
  try {
    // Read the last `cap` bytes, then drop the partial first line.
    const fd = openSync(path, "r");
    const start = Math.max(0, size - cap);
    const length = size - start;
    const buf = Buffer.alloc(length);
    try {
      readSync(fd, buf, 0, length, start);
    } finally {
      closeSync(fd);
    }
    const newline = buf.indexOf(0x0a);
    const kept = newline >= 0 && newline < length - 1 ? buf.subarray(newline + 1) : buf;
    writeFileSync(path, kept);
    return true;
  } catch {
    return false;
  }
}

export function trimAllEventLogs(eventsDir: string, mib: number): number {
  let trimmed = 0;
  for (const path of listEventLogFiles(eventsDir)) {
    if (trimEventLog(path, mib)) trimmed++;
  }
  return trimmed;
}
