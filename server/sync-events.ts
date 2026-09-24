// P5a (docs/plans/local-first-architecture-plan-2026-09-23.md, §8 "P5 —
// Event protocol + device identity + revocation", R5/R12) — the typed event
// RECEIPT stream and the stable install identity it is written against.
//
// The plan's rule is the whole design: "one system, two views, no second
// queue". The journal already owns transport; these events are the
// audit-grade VIEW of it. Every event therefore originates at a point the
// journal already passes through — a row actually enqueued, or an object
// actually applied — and carries no payload of its own:
//
//   { v, type, objectId, objectType, rev, deviceId, at }
//
// There is no message text, no file path, no checksum of content, no
// provider name, no token, no error string: an event says WHAT changed and
// WHICH device said so, and the object itself is the data (fetch it from
// the encrypted sync object, not from this log). That is what makes the
// receipt stream safe to keep in a plain append-only file next to the
// workspace, and it is pinned by a test that feeds a message body and
// secret-looking values through a real write and greps the file for them.
//
// Identity: `syncInstallId` is this install's device_id — a random uuid
// persisted next to the data at mode 0600, never derived from hardware
// (the plan's S0 no-fingerprinting rule), regenerated rather than trusted
// if the file is unreadable. It is the same id the sync objects already
// carry (S2b), so the receipt stream and the object stream cannot disagree
// about who produced a rev. It lives HERE now because P5 makes it the
// device identity, and sync-memory re-exports it so its callers and tests
// are untouched.
//
// Retention is bounded and boring on purpose: one file per UTC day named
// `sync-YYYY-MM-DD.ndjson` inside the events directory (the `sync-` prefix
// keeps these clearly separate from the unrelated thread runtime evidence
// that already lives there), at most EVENT_MAX_FILES and EVENT_MAX_BYTES,
// oldest pruned first, never touching a file this module did not write.
// Full "compaction against snapshot generations" needs the generation
// counter P6 introduces; until then the caps are the honest bound and are
// documented as such rather than pretending to be generational.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import { DATA_DIR } from "./config.ts";

export const SYNC_EVENT_VERSION = 1;
/** 30 daily files and 8 MB: an audit trail that a year of quiet use cannot
 * grow without bound. Generational compaction arrives with P6. */
export const EVENT_MAX_FILES = 30;
export const EVENT_MAX_BYTES = 8 * 1024 * 1024;

const printable = (value: string): boolean =>
  [...value].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 && code !== 127;
  });

const eventTypeSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[a-z][\w-]{0,31}\.(created|updated|deleted|applied)$/u);

/** The receipt itself. Every field is an identifier, a counter, or a
 * clock — deliberately nothing that could carry content. */
export const syncEventSchema = z
  .object({
    v: z.literal(SYNC_EVENT_VERSION),
    type: eventTypeSchema,
    objectId: z.string().min(1).max(256).refine(printable),
    objectType: z.string().min(1).max(32).regex(/^[a-z][\w-]{0,31}$/u),
    rev: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    deviceId: z.string().min(1).max(128).regex(/^[0-9a-f-]{1,128}$/iu),
    at: z.number().int().nonnegative(),
  })
  .strict();
export type SyncEvent = z.infer<typeof syncEventSchema>;

/** The type vocabulary, derived rather than closed: a future object type
 * must not be able to break the stream by being unknown here. */
export function syncEventType(
  objectType: string,
  rev: number,
  options: { tombstone?: boolean; applied?: boolean } = {},
): string {
  if (options.applied === true) return `${objectType}.applied`;
  if (options.tombstone === true) return `${objectType}.deleted`;
  return rev <= 1 ? `${objectType}.created` : `${objectType}.updated`;
}

export interface RecordSyncEventInput {
  objectId: string;
  objectType: string;
  rev: number;
  at: number;
  tombstone?: boolean;
  applied?: boolean;
  deviceId?: string;
  dataDir?: string;
}

// --- install identity (this install's device_id) --------------------------

const installIdValid = (value: string): boolean => /^[0-9a-f-]{1,128}$/iu.test(value);
const installIds = new Map<string, string>();

/** This install's stable device_id: a random uuid persisted next to the
 * data, never derived from hardware, regenerated rather than trusted if
 * the file is unreadable or does not look like one. */
export function syncInstallId(dataDir: string = DATA_DIR): string {
  const cached = installIds.get(dataDir);
  if (cached !== undefined) return cached;
  const file = join(dataDir, "sync-install-id");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (installIdValid(existing)) {
      installIds.set(dataDir, existing);
      return existing;
    }
  }
  const id = randomUUID();
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
  } catch {
    // A data directory that cannot be written still gets a usable id for
    // this process; the next boot regenerates one rather than failing boot.
  }
  installIds.set(dataDir, id);
  return id;
}

// --- the append-only receipt stream ---------------------------------------

/** Where the receipts live. The `sync-` prefix keeps them apart from the
 * unrelated thread runtime evidence in the same directory. */
const eventsDir = (dataDir: string): string => join(dataDir, "events");
const dayFile = (dataDir: string, at: number): string =>
  join(eventsDir(dataDir), `sync-${new Date(at).toISOString().slice(0, 10)}.ndjson`);

const eventFiles = (dataDir: string): string[] => {
  try {
    return readdirSync(eventsDir(dataDir))
      .filter((name) => /^sync-\d{4}-\d{2}-\d{2}\.ndjson$/u.test(name))
      .sort()
      .map((name) => join(eventsDir(dataDir), name));
  } catch {
    return [];
  }
};

/** Bounded retention: drop the oldest receipts until both the file count
 * and the byte budget hold. Only files this module writes are considered. */
export function pruneSyncEvents(dataDir: string = DATA_DIR): void {
  const files = eventFiles(dataDir);
  let total = 0;
  const sizes = new Map<string, number>();
  for (const file of files) {
    try {
      const size = statSync(file).size;
      sizes.set(file, size);
      total += size;
    } catch {
      sizes.set(file, 0);
    }
  }
  let index = 0;
  while (files.length - index > EVENT_MAX_FILES || (total > EVENT_MAX_BYTES && index < files.length - 1)) {
    const file = files[index];
    if (file === undefined) break;
    try {
      rmSync(file, { force: true });
      total -= sizes.get(file) ?? 0;
    } catch {
      // A receipt we cannot delete is a disk problem, not a sync problem.
    }
    index += 1;
  }
}

/** Append one receipt line. Best effort by contract: a failed receipt must
 * never fail the write, push or apply it describes. */
function appendEventLine(event: SyncEvent, dataDir: string): void {
  try {
    const dir = eventsDir(dataDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(dayFile(dataDir, event.at), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch {
    // see above: bookkeeping must not fail the work it describes
  }
}

export type SyncEventSink = (event: SyncEvent) => void;

let sink: SyncEventSink = (event) => appendEventLine(event, DATA_DIR);

/** Boot wiring may redirect receipts; tests point this at a capture. null
 * turns the stream off entirely, which is a decision, not a silence. */
export function setSyncEventSink(next: SyncEventSink | null): void {
  sink = next ?? (() => {});
}

export function currentSyncEventSink(): SyncEventSink {
  return sink;
}

/** Record one typed receipt. The one call every view funnels through. */
export function recordSyncEvent(input: RecordSyncEventInput): void {
  try {
    const event = syncEventSchema.parse({
      v: SYNC_EVENT_VERSION,
      type: syncEventType(input.objectType, input.rev, input),
      objectId: input.objectId,
      objectType: input.objectType,
      rev: input.rev,
      deviceId: input.deviceId ?? syncInstallId(input.dataDir),
      at: input.at,
    });
    sink(event);
    pruneSyncEvents(input.dataDir ?? DATA_DIR);
  } catch {
    // A malformed receipt is dropped, never partially written, and never
    // allowed to become the caller's problem.
  }
}

export interface ReadSyncEventsOptions {
  dataDir?: string;
  /** Newest last. Defaults to the most recent EVENT_MAX_FILES window. */
  limit?: number;
  sinceAt?: number;
}

/** Read receipts back, oldest first, across the retained day files. A
 * corrupt line is skipped rather than failing the whole read — the stream
 * is append-only evidence, and one damaged line must not blind the rest. */
export function readSyncEvents(options: ReadSyncEventsOptions = {}): SyncEvent[] {
  const dataDir = options.dataDir ?? DATA_DIR;
  const limit = options.limit ?? 500;
  const sinceAt = options.sinceAt ?? 0;
  const events: SyncEvent[] = [];
  for (const file of eventFiles(dataDir)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue; // a damaged line must not blind the rest of the stream
      }
      const parsed = syncEventSchema.safeParse(raw);
      if (!parsed.success) continue;
      if (parsed.data.at < sinceAt) continue;
      events.push(parsed.data);
    }
  }
  return events.slice(Math.max(0, events.length - limit));
}
