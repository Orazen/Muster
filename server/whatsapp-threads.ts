// Persistent customer-thread registry for the WhatsApp channel.
//
// server/whatsapp.ts mints a stable `customerThreadKey` per customer number;
// this module remembers which Muster task thread that customer's
// conversation lives in, durably, so a follow-up message continues the SAME
// thread (full chat context) instead of spawning a fresh task per message.
//
// Storage is one JSON file at DATA_DIR/whatsapp-threads.json, written via
// writeFileAtomic with mode 0600 (it maps customer phone numbers to thread
// ids, so it is treated as sensitive). The registry is loaded on first use
// and bounded at MAX_CUSTOMER_THREADS entries; when the bound is exceeded
// the entry with the oldest `lastAt` is evicted.
//
// The module stays pure: it never imports server/store.ts. Whether a
// remembered thread is still OPEN in the store is decided by the caller
// through the dependency-injected `findOpenThread` callback in
// resolveCustomerThread — see the wiring note at the bottom of this file.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { parseJson } from "./schema.ts";

/** Hard cap on remembered customer threads; oldest-`lastAt` eviction. */
export const MAX_CUSTOMER_THREADS = 2000;

/** File name (inside DATA_DIR) of the persisted registry. */
export const CUSTOMER_THREADS_FILE = "whatsapp-threads.json";

/** One customer's persistent conversation: the WhatsApp thread key, the
 * Muster task thread id the conversation lives in, and the bot it runs on. */
export interface CustomerThread {
  key: string;
  threadId: string;
  botId: string;
  lastAt: number;
}

export interface RegisterCustomerThreadInput {
  key: string;
  threadId: string;
  botId: string;
}

/** Dependency-injected liveness check: does the bot currently have an open
 * task thread for this customer key? Injected (instead of importing the
 * store) so this module stays pure and testable. */
export interface ResolveCustomerThreadOptions {
  findOpenThread?: (botId: string, key: string) => string | null;
}

export interface ResolvedCustomerThread {
  /** The thread to continue. "" when fresh is true — the caller creates the
   * task (store.createTask) and then calls registerCustomerThread with the
   * resulting threadId. */
  threadId: string;
  fresh: boolean;
}

const storedThreadSchema = z.object({
  key: z.string().min(1),
  threadId: z.string().min(1),
  botId: z.string().min(1),
  lastAt: z.number().finite().nonnegative(),
});

const storedRegistrySchema = z.object({
  version: z.literal(1),
  threads: z.array(storedThreadSchema),
});

interface StoredRegistry {
  version: 1;
  threads: CustomerThread[];
}

const filePath = (dataDir: string) => join(dataDir, CUSTOMER_THREADS_FILE);

// In-memory cache of the persisted registry, keyed by file path so tests can
// use throwaway data dirs. Loaded lazily on first access ("load-on-init").
const registries = new Map<string, Map<string, CustomerThread>>();

function loadRegistry(path: string): Map<string, CustomerThread> {
  const cached = registries.get(path);
  if (cached) return cached;
  const map = new Map<string, CustomerThread>();
  if (existsSync(path)) {
    try {
      const parsed = storedRegistrySchema.safeParse(
        // SAFETY: parseJson returns JSON-compatible values by contract; the
        // Zod storedRegistrySchema above is the actual validation step.
        parseJson(readFileSync(path, "utf8")),
      );
      if (parsed.success) {
        for (const thread of parsed.data.threads) map.set(thread.key, thread);
      }
      // A corrupt or unrecognized file starts empty rather than throwing —
      // the registry is a cache of convenience, not the source of truth.
    } catch {
      // Same posture for unreadable files: start empty.
    }
  }
  registries.set(path, map);
  return map;
}

function persist(path: string, map: Map<string, CustomerThread>): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/") || path.length), { recursive: true });
  const registry: StoredRegistry = {
    version: 1,
    threads: Array.from(map.values()),
  };
  writeFileAtomic(path, JSON.stringify(registry, null, 2), { mode: 0o600 });
}

function evictOldest(map: Map<string, CustomerThread>): void {
  if (map.size <= MAX_CUSTOMER_THREADS) return;
  const byOldest = Array.from(map.values()).sort((a, b) => a.lastAt - b.lastAt);
  while (map.size > MAX_CUSTOMER_THREADS) {
    const oldest = byOldest.shift();
    if (!oldest) break;
    map.delete(oldest.key);
  }
}

/** Upsert one customer's thread mapping and persist the registry. `now`
 * defaults to Date.now() and is injectable for tests and backfills. */
export function registerCustomerThread(
  dataDir: string,
  input: RegisterCustomerThreadInput,
  now?: number,
): CustomerThread {
  const path = filePath(dataDir);
  const map = loadRegistry(path);
  const thread: CustomerThread = {
    key: input.key,
    threadId: input.threadId,
    botId: input.botId,
    lastAt: now ?? Date.now(),
  };
  map.set(thread.key, thread);
  evictOldest(map);
  persist(path, map);
  return thread;
}

/** Look up a customer's remembered thread mapping (may be stale — the
 * thread may have been closed in the store since; use
 * resolveCustomerThread for the liveness-checked answer). */
export function findCustomerThread(dataDir: string, key: string): CustomerThread | null {
  return loadRegistry(filePath(dataDir)).get(key) ?? null;
}

/** Reverse lookup for reply routing: given a completed turn's threadId,
 * find the customer it belongs to (the equivalent of index.ts's
 * whatsappReplies map, but durable across restarts). */
export function mapCustomerReply(dataDir: string, threadId: string): CustomerThread | null {
  for (const thread of loadRegistry(filePath(dataDir)).values()) {
    if (thread.threadId === threadId) return thread;
  }
  return null;
}

/** Forget one customer's mapping (e.g. the task was closed or archived). */
export function closeCustomerThread(dataDir: string, key: string): void {
  const path = filePath(dataDir);
  const map = loadRegistry(path);
  if (!map.delete(key)) return;
  persist(path, map);
}

/** Placeholder for future read-receipt handling (WhatsApp `statuses`
 * webhooks): today it is a deliberate no-op so callers can wire the hook
 * now and fill in behavior later without touching route code again. */
export function markCustomerThreadSeen(dataDir: string, key: string, _now?: number): void {
  void dataDir;
  void key;
}

/** The one call the WhatsApp route makes per inbound message: reuse the
 * customer's existing open thread when one exists, otherwise report fresh
 * so the caller creates a task and registers it.
 *
 * Liveness: when `findOpenThread` is provided it is authoritative — a
 * remembered threadId that the callback no longer finds counts as closed,
 * and the callback's own answer (found by e.g. task title prefix
 * `WhatsApp: <key>`) is re-registered here so the durable cache self-heals.
 * Without the callback the remembered mapping is trusted as-is. A mapping
 * for a DIFFERENT bot is never reused: threads are per-bot context. */
export function resolveCustomerThread(
  dataDir: string,
  key: string,
  botId: string,
  opts: ResolveCustomerThreadOptions = {},
  now?: number,
): ResolvedCustomerThread {
  const remembered = findCustomerThread(dataDir, key);
  if (opts.findOpenThread) {
    const open = opts.findOpenThread(botId, key);
    if (open !== null && open !== "") {
      if (!remembered || remembered.threadId !== open || remembered.botId !== botId) {
        registerCustomerThread(dataDir, { key, threadId: open, botId }, now);
      }
      return { threadId: open, fresh: false };
    }
    return { threadId: "", fresh: true };
  }
  if (remembered && remembered.botId === botId) {
    return { threadId: remembered.threadId, fresh: false };
  }
  return { threadId: "", fresh: true };
}

// ── Wiring guidance for server/index.ts (NOT wired here — see the task) ──
//
// In the POST /api/whatsapp/webhook loop, replace
//   const task = store.createTask(target.id, `WhatsApp: ${message.from}`, false);
// with:
//   const threadKey = customerThreadKey(message.from);
//   const resolved = resolveCustomerThread(DATA_DIR, threadKey, target.id, {
//     findOpenThread: (botId, key) =>
//       store.tasks(botId).find((t) => t.title === `WhatsApp: ${key}`)?.threadId ?? null,
//   });
//   const task = resolved.fresh
//     ? store.createTask(target.id, `WhatsApp: ${threadKey}`, false)
//     : { threadId: resolved.threadId };
//   if (!task) continue;
//   registerCustomerThread(DATA_DIR, {
//     key: threadKey,
//     threadId: task.threadId,
//     botId: target.id,
//   });
//   whatsappReplies.set(task.threadId, { to: message.from, botId: target.id });
//   void startTurn(target.id, message.text, {
//     threadId: task.threadId, // SAME thread → full conversation context
//     ...
//   });
//
// On the reply side, when a turn completes, mapCustomerReply(DATA_DIR,
// event.threadId) can replace the whatsappReplies.get lookup so routing
// survives restarts. whatsappReplies.set/delete above can be dropped once
// that lands. When a task is closed/archived elsewhere, call
// closeCustomerThread to keep the registry in sync.

/** Test helper: drop the in-memory registry for a path so the next access
 * reloads from disk. Does not touch the backing file. Not used by
 * production code paths. */
export function resetCustomerThreadsForTest(dataDir: string): void {
  registries.delete(filePath(dataDir));
}
