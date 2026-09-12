// Per-account last-backup bookkeeping: one small 0600 json under DATA_DIR so
// the sync card can say "Last backed up to Drive · 5m ago" instead of leaving
// the user guessing whether the thing they clicked actually landed.
// Written only after a transport confirms success; failures change nothing.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export interface SyncStamp {
  at: number;
  channel: "google-drive" | "telegram";
}

export interface SyncState {
  lastPush: SyncStamp | null;
  lastPull: SyncStamp | null;
}

const DIR = join(DATA_DIR, "sync-state");
const fileFor = (userId: string) => join(DIR, `${userId}.json`);

export function readSyncState(userId: string): SyncState {
  try {
    const parsed = JSON.parse(readFileSync(fileFor(userId), "utf8"));
    return {
      lastPush: parsed.lastPush ?? null,
      lastPull: parsed.lastPull ?? null,
    };
  } catch {
    return { lastPush: null, lastPull: null };
  }
}

export function stampSync(userId: string, kind: "push" | "pull", channel: SyncStamp["channel"]): void {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const state = readSyncState(userId);
    state[kind === "push" ? "lastPush" : "lastPull"] = { at: Date.now(), channel };
    writeFileAtomic(fileFor(userId), JSON.stringify(state), { mode: 0o600 });
  } catch {
    // bookkeeping must never fail the backup it describes
  }
}
