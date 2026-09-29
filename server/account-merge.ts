// Account merge — one human, several sign-in identities, one dataset.
//
// Why. Cloud sign-in fragments naturally: the same person ends up with a
// Google identity per email (work, old signup, typo account), each holding
// its own vault keys and bots. Rather than asking support to shuffle rows,
// any signed-in account can mint a short-lived merge token; the OTHER
// account spends it and its data migrates into the token's account.
// What. Token registry here; the actual migration (vault keys, bot
// ownership, auth-row deletion) lives in index.ts where the store and
// registry handles already exist.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const mergeTransfersSchema = z.object({
  version: z.literal(1),
  transfers: z.array(z.object({ source: z.string().min(1), target: z.string().min(1) }).strict()),
}).strict();

/** Bind before moving data: a partly completed merge must never be retried
 * toward a third account. This is a durable intent, not a transaction claim. */
export function bindAccountMergeTarget(file: string, source: string, target: string): void {
  if (!source || !target || source === target) throw new Error("Choose two valid accounts to merge");
  let transfers: Array<{ source: string; target: string }> = [];
  try {
    transfers = mergeTransfersSchema.parse(JSON.parse(readFileSync(file, "utf8"))).transfers;
  } catch (error) {
    const missing = z.object({ code: z.literal("ENOENT") }).safeParse(error);
    if (!missing.success) throw new Error("Merge recovery data needs repair before accounts can be merged", { cause: error });
  }
  const previous = transfers.filter((entry) => entry.source === source);
  if (previous.some((entry) => entry.target !== target)) {
    throw Object.assign(new Error("This account already started merging into another account. Create a fresh merge code from that original destination to continue."), { status: 409 });
  }
  if (previous.length) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ version: 1, transfers: [...transfers, { source, target }] }), { mode: 0o600 });
}

interface PendingMerge {
  targetUserId: string;
  expiresAt: number;
}

const TTL_MS = 15 * 60_000;
const pending = new Map<string, PendingMerge>();

function sweep(now = Date.now()): void {
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
}

/** Mint a single-use merge token whose target is the CURRENT account. */
export function startAccountMerge(targetUserId: string): string {
  sweep();
  const token = randomBytes(24).toString("base64url");
  pending.set(token, { targetUserId, expiresAt: Date.now() + TTL_MS });
  return token;
}

export interface MergeIntent {
  targetUserId: string;
}

export function mergeHasActiveWork(
  bots: ReadonlyArray<{ id: string; busy?: boolean }>,
  webhookBotIds: ReadonlyArray<string>,
  runs: ReadonlyArray<{ botId: string; status: string }>,
): boolean {
  const affected = new Set([...bots.map((bot) => bot.id), ...webhookBotIds]);
  return bots.some((bot) => bot.busy === true) || runs.some((run) => affected.has(run.botId) && (run.status === "running" || run.status === "waiting"));
}

/** Inspect without consuming: operator/busy checks must not burn approval. */
export function readAccountMergeToken(token: string, sourceUserId: string): MergeIntent | null {
  sweep();
  const entry = pending.get(token);
  if (!entry || entry.expiresAt <= Date.now() || entry.targetUserId === sourceUserId) return null;
  return { targetUserId: entry.targetUserId };
}

/** Spend a token on behalf of the SOURCE account. Returns the merge target,
 * or null when the token is unknown/expired. Single-use by construction —
 * a valid spend removes the token before the caller mutates anything. */
export function spendAccountMergeToken(token: string, sourceUserId: string): MergeIntent | null {
  const intent = readAccountMergeToken(token, sourceUserId);
  if (!intent) return null;
  pending.delete(token);
  return intent;
}
