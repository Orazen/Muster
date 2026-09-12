// Async peer handoff (delegate_bot).
//
// A bot that finishes one task can hand the NEXT task to a peer without
// blocking its own turn — the source bot's turn.completed fires after it
// settles, and the queued delegation runs then. The peer gets a fresh
// depth-1 turn (depth cap still blocks A→B→C chains, see index.ts).
//
// Visiblity rides on the same comms-visibility helpers ask_bot uses
// (channel mirror + 1:1 chips) so a delegated exchange looks like an
// exchanged one. The optional approval gate (A2) is checked at drain
// time, never at queue time, because the user might have just turned
// approvePeerComms on between queueing and draining.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import { parseJson } from "./schema.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

export interface DelegationItem {
  toBotId: string;
  message: string;
  reason?: string;
  /** The source bot's comms depth (0 for a user-initiated turn). The
   * delegated-to bot runs at `depth + 1`, which equals MAX_COMMS_DEPTH
   * (= 1) for a user turn — so the peer has no agents integration, and
   * recursive delegation is structurally impossible. */
  depth: number;
}

export interface PeerProvenance {
  ownerId: string;
  fromBotId: string;
  sourceThreadId: string;
  /** Durable task identity is TaskRecord.threadId; this is its wire alias. */
  taskId: string;
  depth: number;
  operation: "delegate_bot";
}

interface PendingDelegationItem extends DelegationItem {
  provenance: PeerProvenance;
  /** Stable acknowledgement key for crash-safe removal from the queue. */
  id: string;
}

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many" | "invalid_provenance" | "persistence_failed";

/** Per source-thread queue. Persisted to delegations.json on every change
 * and reloaded at boot: a handoff queued right before a restart runs after
 * it. (Provider PERMISSIONS still die with the process — nobody can answer
 * for an unattended bot — but queued work is not a permission; the target
 * and approvePeerComms are re-checked at drain time as always.) */
const pendingDelegations = new Map<string, PendingDelegationItem[]>();
const drainingThreads = new Set<string>();
const canceledItems = new Set<string>();
const discardGenerations = new Map<string, number>();
const DELEGATIONS_FILE = join(DATA_DIR, "delegations.json");

type OwnerResolver = (record: { ownerId?: string }) => string;
const localOwner: OwnerResolver = () => "local";
type RunTarget = (
  toBotId: string,
  message: string,
  commsDepth: number,
  sourceThreadId: string,
  channel: GroupRecord | undefined,
  validate: () => boolean,
) => void | Promise<void>;

const nonblank = z.string().refine((value) => value.trim().length > 0);
const depthSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const provenanceSchema = z.object({
  ownerId: nonblank,
  fromBotId: nonblank,
  sourceThreadId: nonblank,
  taskId: nonblank,
  depth: depthSchema,
  operation: z.literal("delegate_bot"),
}).strict();
// Only user-initiated depth-zero turns may accept an async peer handoff.
const MAX_DELEGATION_SOURCE_DEPTH = 0;
const pendingSchema = z.object({
  id: nonblank,
  toBotId: nonblank,
  message: z.string(),
  reason: z.string().optional(),
  depth: depthSchema.max(MAX_DELEGATION_SOURCE_DEPTH),
  provenance: provenanceSchema,
}).refine((item) => item.depth === item.provenance.depth);
const queueSchema = z.record(z.string(), z.unknown());

/** Commit a complete next queue before publishing any in-memory change. */
function replacePending(threadId: string, items: PendingDelegationItem[]): void {
  const next = new Map(pendingDelegations);
  if (items.length) next.set(threadId, items);
  else next.delete(threadId);
  writeFileAtomic(DELEGATIONS_FILE, JSON.stringify(Object.fromEntries(next), null, 2), { mode: 0o600 });
  pendingDelegations.clear();
  for (const [id, list] of next) pendingDelegations.set(id, list);
}

/** Legacy rows without provenance are refused, not upgraded into authority. */
export function _loadPending(): void {
  pendingDelegations.clear();
  try {
    const result = queueSchema.safeParse(parseJson(readFileSync(DELEGATIONS_FILE, "utf8")));
    if (!result.success) return;
    const ids = new Set<string>();
    for (const [threadId, list] of Object.entries(result.data)) {
      if (!Array.isArray(list)) continue;
      const items: PendingDelegationItem[] = [];
      for (const raw of list) {
        const decoded = pendingSchema.safeParse(raw);
        if (!decoded.success || decoded.data.provenance.sourceThreadId !== threadId || ids.has(decoded.data.id)) continue;
        ids.add(decoded.data.id);
        items.push(decoded.data);
      }
      if (items.length) pendingDelegations.set(threadId, items);
    }
  } catch {
    /* fresh install, corrupt or unreadable — no accepted queue loaded */
  }
}

function sourceFor(bus: CommsBus, provenance: PeerProvenance, ownerOf: OwnerResolver): BotRecord | undefined {
  const sender = bus.store.bot(provenance.fromBotId);
  if (!sender || ownerOf(sender) !== provenance.ownerId) return undefined;
  const task = bus.store.taskByThread(sender.id, provenance.sourceThreadId);
  return task?.threadId === provenance.taskId ? sender : undefined;
}

function participantsFor(bus: CommsBus, item: PendingDelegationItem, ownerOf: OwnerResolver) {
  const source = sourceFor(bus, item.provenance, ownerOf);
  const target = bus.store.bot(item.toBotId);
  if (!source || !target || target.hidden || source.id === target.id || ownerOf(target) !== item.provenance.ownerId) return undefined;
  return { source, target };
}

/** Source threads with something queued — what a boot drain iterates. */
export function pendingThreads(): string[] {
  return [...pendingDelegations.keys()];
}

/** How many handoffs one turn may queue. Small on purpose: this is the only
 * thing standing between a confused bot and a fan-out of real turns. */
const MAX_QUEUED_PER_THREAD = 4;

/** Validate and enqueue a delegation. Pushes a "Delegated to @B: reason"
 * chip to the source thread so the user can see what was queued. */
export function queueDelegation(
  bus: CommsBus,
  from: BotRecord,
  item: DelegationItem,
  maxDepth: number,
  provenance: PeerProvenance,
  ownerOf: OwnerResolver = localOwner,
): QueueResult {
  const parsed = provenanceSchema.safeParse(provenance);
  if (!parsed.success || parsed.data.fromBotId !== from.id || parsed.data.depth !== item.depth
    || !sourceFor(bus, parsed.data, ownerOf)) return "invalid_provenance";
  if (item.toBotId === from.id) return "self";
  if (item.depth >= maxDepth || item.depth > MAX_DELEGATION_SOURCE_DEPTH) return "too_deep";
  const target = bus.store.bot(item.toBotId);
  if (!target) return "no_target";
  if (target.hidden || ownerOf(target) !== parsed.data.ownerId) return "invalid_provenance";
  const sourceThreadId = parsed.data.sourceThreadId;
  const list = pendingDelegations.get(sourceThreadId) ?? [];
  if (list.length >= MAX_QUEUED_PER_THREAD) return "too_many";
  const queued: PendingDelegationItem = {
    id: newId(), toBotId: item.toBotId, message: item.message, depth: item.depth, provenance: parsed.data,
  };
  if (item.reason !== undefined) queued.reason = item.reason;
  try {
    replacePending(sourceThreadId, [...list, queued]);
  } catch (error) {
    console.error("delegations: could not persist queue", error);
    return "persistence_failed";
  }
  const label = `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`;
  try {
    bus.store.appendMessage(sourceThreadId, {
      role: "bot", kind: "activity", tool: { name: label },
    }, { bestEffort: true });
  } catch (error) {
    // The queue is already accepted durably. An acknowledgement display
    // failure must not turn that acceptance into an ambiguous HTTP failure.
    console.error("delegations: accepted handoff acknowledgement failed", error);
  }
  return "ok";
}

/** Drain queued delegations for a source thread (called on its
 * turn.completed). Each item is processed independently: a deny, a busy
 * target, or an error in one does not stop the rest. The actual start
 * of the target turn is delegated to `runTarget` so delegations.ts
 * stays free of harness-level concerns (commsDepth is the only thing
 * the caller needs). */
export function drainDelegations(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  threadId: string,
  runTarget: RunTarget,
  ownerOf: OwnerResolver = localOwner,
): void {
  if (drainingThreads.has(threadId)) return;
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const snapshot = [...list];
  drainingThreads.add(threadId);
  let persistenceFailed = false;
  void (async () => {
    for (const item of snapshot) {
      try {
        await processOne(bus, approvalBus, threadId, item, runTarget, ownerOf);
      } catch (error) {
        // A failed durable dequeue must never dispatch or immediately retry.
        if (error instanceof QueuePersistenceError) persistenceFailed = true;
        reportFailure(bus, item, ownerOf, error instanceof Error ? error.message : String(error));
      }
      if (persistenceFailed) break;
      try {
        acknowledgeDelegation(threadId, item.id);
      } catch (error) {
        persistenceFailed = true;
        reportFailure(bus, item, ownerOf, error instanceof Error ? error.message : String(error));
        break;
      }
    }
  })().finally(() => {
    drainingThreads.delete(threadId);
    // Only later arrivals drain automatically; a failed queue write remains
    // pending for an explicit later drain or restart, without a retry loop.
    if (!persistenceFailed && pendingDelegations.get(threadId)?.length) {
      drainDelegations(bus, approvalBus, threadId, runTarget, ownerOf);
    }
  });
}

class QueuePersistenceError extends Error {}

function reportFailure(bus: CommsBus, item: PendingDelegationItem, ownerOf: OwnerResolver, why: string): void {
  console.error("delegations: handoff failed", why);
  if (!sourceFor(bus, item.provenance, ownerOf)) return;
  try {
    bus.store.appendMessage(item.provenance.sourceThreadId, {
      role: "bot", kind: "activity",
      tool: { name: `error: delegation failed — ${why.slice(0, 120)}`, ok: false },
    });
  } catch (reportError) {
    console.error("delegation failed and could not be reported", reportError);
  }
}

/** Remove one terminal handoff; unchanged/missing IDs need no write. */
function acknowledgeDelegation(threadId: string, itemId: string): void {
  const current = pendingDelegations.get(threadId);
  if (!current?.some((item) => item.id === itemId)) return;
  try {
    replacePending(threadId, current.filter((item) => item.id !== itemId));
    canceledItems.delete(itemId);
  } catch (error) {
    throw new QueuePersistenceError("Could not durably remove queued delegation", { cause: error });
  }
}

/** Drop a thread's queued handoffs without running them, telling the user
 * they were dropped. Used when the queueing turn failed or was interrupted. */
export function discardDelegations(bus: CommsBus, threadId: string): boolean {
  // Retire in-process authority even if disk is unavailable, including a
  // handoff already dequeued but still waiting for target setup. This is
  // not a durable stop receipt: failed removal may be reloaded on restart.
  discardGenerations.set(threadId, (discardGenerations.get(threadId) ?? 0) + 1);
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return true;
  for (const item of list) canceledItems.add(item.id);
  try {
    replacePending(threadId, []);
    for (const item of list) canceledItems.delete(item.id);
  } catch (error) {
    console.error("delegations: could not persist discard", error);
    return false;
  }
  const from = bus.store.botByThread(threadId);
  if (!from) return true;
  try {
    bus.store.appendMessage(threadId, {
      role: "bot", kind: "activity",
      tool: { name: `${list.length} queued delegation${list.length > 1 ? "s" : ""} dropped — the turn did not finish`, ok: false },
    }, { bestEffort: true });
  } catch (error) {
    console.error("delegations: discarded handoff acknowledgement failed", error);
  }
  return true;
}

async function processOne(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  sourceThreadId: string,
  item: PendingDelegationItem,
  runTarget: RunTarget,
  ownerOf: OwnerResolver,
): Promise<void> {
  const generation = discardGenerations.get(sourceThreadId) ?? 0;
  const stillAccepted = () => !canceledItems.has(item.id)
    && generation === (discardGenerations.get(sourceThreadId) ?? 0);
  if (!stillAccepted()) return;
  const valid = pendingSchema.safeParse(item);
  if (!valid.success || item.provenance.sourceThreadId !== sourceThreadId) return;
  if (!pendingDelegations.get(sourceThreadId)?.some((queued) => queued.id === item.id)) return;
  const sender = sourceFor(bus, item.provenance, ownerOf);
  if (!sender) return;
  const target = bus.store.bot(item.toBotId);
  if (!target) {
    bus.store.appendMessage(sourceThreadId, {
      role: "bot", kind: "activity",
      tool: { name: "error: delegation failed — no such bot", ok: false },
    });
    return;
  }
  if (!participantsFor(bus, item, ownerOf)) return;
  const reportBusy = (bot: BotRecord) => bus.store.appendMessage(sourceThreadId, {
    role: "bot", kind: "activity",
    tool: { name: `Delegation to @${bot.name} canceled — @${bot.name} is busy`, ok: false },
  });
  if (target.busy) {
    reportBusy(target);
    return;
  }
  let approved = false;
  if (sender.approvePeerComms) {
    const verdict = await requestPeerApproval(approvalBus, sender, target, item.message, "delegate_bot", sourceThreadId);
    // No names, busy state or dispatch from snapshots that crossed approval.
    const current = participantsFor(bus, item, ownerOf);
    if (!stillAccepted() || !current || !pendingDelegations.get(sourceThreadId)?.some((queued) => queued.id === item.id)) return;
    if (verdict !== "allow") {
      bus.store.appendMessage(sourceThreadId, {
        role: "bot", kind: "activity",
        tool: { name: `Delegation to @${current.target.name} denied by user`, ok: false },
      });
      return;
    }
    approved = true;
  }
  const current = participantsFor(bus, item, ownerOf);
  if (!stillAccepted() || !current || !pendingDelegations.get(sourceThreadId)?.some((queued) => queued.id === item.id)) return;
  if (current.target.busy) {
    reportBusy(current.target);
    return;
  }
  // Persist removal before any mirrored exchange or target setup. This is
  // at-most-once dispatch, not a promise of completion across process loss.
  acknowledgeDelegation(sourceThreadId, item.id);
  const channel = getOrCreateChannel(bus.store, current.source, current.target);
  const validate = () => {
    const participants = participantsFor(bus, item, ownerOf);
    if (!stillAccepted() || !participants || (participants.source.approvePeerComms && !approved)) return false;
    const room = bus.store.group(channel.id);
    return !!room && room.threadId === channel.threadId && ownerOf(room) === item.provenance.ownerId
      && room.memberIds.includes(item.provenance.fromBotId) && room.memberIds.includes(item.toBotId)
      && room.memberIds.every((id) => {
        const member = bus.store.bot(id);
        return !!member && (!member.hidden || id === item.provenance.fromBotId)
          && ownerOf(member) === item.provenance.ownerId;
      });
  };
  if (!validate()) return;
  mirrorExchange(bus, current.source, current.target, item.message, channel, sourceThreadId);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  const prefixed = `[Delegated by @${current.source.name}, another bot in this Muster workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  await runTarget(item.toBotId, prefixed, item.depth + 1, sourceThreadId, channel, validate);
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}

/** Test helper: forget the in-memory queue (a simulated restart). */
export function _resetPending(): void {
  pendingDelegations.clear();
  drainingThreads.clear();
  canceledItems.clear();
  discardGenerations.clear();
}
