// Owner-scoped follow-up proposal policy — instinct plan slice I0.
//
// A proposal is not an authorized task. This module owns the whole
// lifecycle *policy* of one bounded follow-up suggestion and nothing else:
// it never dispatches, never admits a task, never calls a provider and
// never writes anything except proposal rows through the injected
// persistence port. Acceptance reserves a stable intent identity for a
// later admission path (I1); the reservation itself carries no runner
// acknowledgement and no task receipt.
//
// Pure by construction: no clock read (every entry point takes an injected
// `now`), no filesystem, no network, no database, no model call. The whole
// import surface is a hash, Temporal for civil-time arithmetic, zod for
// boundary parsing, and a type-only import of the existing Calendar day
// event.
//
// Snapshot adapter prerequisite. The current Calendar day result
// (server/calendar-day.ts) carries `calendarId` and `complete`, but no
// provider revision and no observation/authority envelope.
// `FollowUpObservation` models that envelope explicitly at this boundary.
// The version identity computed here is an **application snapshot digest
// over the full selected day** — it is not a provider ETag. Trusted code
// hashes provider content, including untrusted titles; those titles can change
// the version, never owner/grant authority. No model-supplied digest is trusted. I1 builds
// the envelope at the authenticated reader boundary from the real account,
// calendar, grant, requested date/time zone, completeness and server
// observed fetch time.
//
// Dedupe is scoped to authority + existing task ID + selected-day source
// version + proposal type. The full-day digest is conservative: an unrelated
// event changing requires another review; this is not per-event dedupe.
// A replayed read or a reworded suggestion cannot mint a second card,
// and a dismissed unchanged suggestion cannot be resurrected by midnight or
// a new polling window. Time-window notification eligibility is computed
// separately from that identity and is always deterministic.

import { createHash } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

import type { CalendarDayEvent } from './calendar-day.ts';

export const FOLLOW_UP_PROPOSAL_VERSION = 1;

/** Bounded input and excerpt limits. Raw source participates in the digest;
 * the stored title excerpt is visibly shortened, always marked untrusted. */
const MAX_IDENTIFIER = 200;
const MAX_TITLE = 120;
const MAX_WHY_NOW = 280;
const MAX_PROPOSED_OUTPUT = 280;
const MAX_LISTED_FACT = 120;
const MAX_LISTED_FACTS = 6;
const MAX_EVIDENCE_EVENT_IDS = 4;
const MAX_EVENT_SUMMARY = 160;
const MAX_SOURCE_SUMMARY = 4_096;
const MAX_REQUEST_BYTES = 256 * 1_024;
const MAX_EVENTS = 200;
const MIN_FRESHNESS_MS = 60_000;
const MAX_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SNOOZE_MS = 60_000;
const MAX_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

const nonBlankText = z.string().trim().min(1);
const nonBlank = (value: string): boolean => nonBlankText.safeParse(value).success;
const identifier = z.string().min(1).max(MAX_IDENTIFIER).refine(nonBlank, 'identifier required');
const shortText = z.string().min(1).max(MAX_TITLE).refine(nonBlank, 'text required');
const longText = (limit: number) => z.string().min(1).max(limit).refine(nonBlank, 'text required');
const listedFact = z.string().min(1).max(MAX_LISTED_FACT).refine(nonBlank, 'fact required');
const listedFacts = z.array(listedFact).max(MAX_LISTED_FACTS);
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const FOLLOW_UP_PROPOSAL_TYPES = ['meeting-preparation'] as const;
export type FollowUpProposalType = (typeof FOLLOW_UP_PROPOSAL_TYPES)[number];

/** Every way a source read can be less than a complete authorized read.
 * These stay distinct on purpose: an empty calendar, a disconnected
 * client, missing credentials, a revoked grant and a partial page are not
 * one state, and I0 never treats any of them as an empty calendar. */
export const FOLLOW_UP_SOURCE_COMPLETENESS = [
  'complete',
  'partial',
  'disconnected',
  'revoked',
  'failed',
  'stale',
] as const;
export type FollowUpSourceCompleteness = (typeof FOLLOW_UP_SOURCE_COMPLETENESS)[number];

/** Withdrawing or forgetting a source is a separate fact from how a read
 * completed, and an ordinary history restore never reverses it. */
export const FOLLOW_UP_SOURCE_STATUSES = ['active', 'withdrawn'] as const;
export type FollowUpSourceStatus = (typeof FOLLOW_UP_SOURCE_STATUSES)[number];

export const FOLLOW_UP_PROPOSAL_STATUSES = [
  'proposed',
  'accepted',
  'dismissed',
  'snoozed',
  'expired',
  'withdrawn',
] as const;
export type FollowUpProposalStatus = (typeof FOLLOW_UP_PROPOSAL_STATUSES)[number];

export type FollowUpExecutionCapability = 'available' | 'unsupported';

const proposalTypeSchema = z.enum(FOLLOW_UP_PROPOSAL_TYPES);
const completenessSchema = z.enum(FOLLOW_UP_SOURCE_COMPLETENESS);
const sourceStatusSchema = z.enum(FOLLOW_UP_SOURCE_STATUSES);
const proposalStatusSchema = z.enum(FOLLOW_UP_PROPOSAL_STATUSES);
const capabilitySchema = z.enum(['available', 'unsupported']);
const grantGenerationSchema = z.number().int().positive();
const timeZoneSchema = z.string().min(1).max(MAX_IDENTIFIER);

/** The events are exactly the reader's own day result rows, unchanged. */
const calendarEventSchema: z.ZodType<CalendarDayEvent> = z.object({
  id: z.string().min(1).max(MAX_IDENTIFIER),
  summary: z.string().min(1).max(MAX_SOURCE_SUMMARY),
  start: z.string().min(1).max(MAX_IDENTIFIER),
  end: z.string().min(1).max(MAX_IDENTIFIER),
  allDay: z.boolean(),
  busy: z.boolean(),
});

const observationEnvelopeSchema = z.object({
  providerAccountId: identifier,
  calendarId: identifier,
  requestedDate: civilDate,
  timeZone: timeZoneSchema,
  grantReference: identifier,
  grantGeneration: grantGenerationSchema,
  observedAt: instant,
  completeness: completenessSchema,
  status: sourceStatusSchema,
});

/** The observation envelope I1 must construct at the authenticated reader
 * boundary. Deliberately explicit: the Calendar day result alone cannot
 * express account authority, grant epoch, completeness or fetch time. */
export const followUpObservationSchema = observationEnvelopeSchema.extend({
  events: z.array(calendarEventSchema).max(MAX_EVENTS),
});
export type FollowUpObservation = z.infer<typeof followUpObservationSchema>;

const evidenceSchema = z.object({
  sourceKey: identifier,
  dedupeKey: identifier,
  /** Application snapshot digest of relevant normalized content. Not a
   * provider ETag: this source supplies no revision. */
  snapshotDigest: identifier,
  sourceCompleteness: completenessSchema,
  observedAt: instant,
  freshForMs: z.number().int().min(MIN_FRESHNESS_MS).max(MAX_FRESHNESS_MS),
  expiresAt: instant,
  excerpts: z.array(z.object({
    eventId: identifier,
    summary: z.string().min(1).max(MAX_EVENT_SUMMARY),
    start: z.string().min(1).max(MAX_IDENTIFIER),
    end: z.string().min(1).max(MAX_IDENTIFIER),
    /** Quoted provider text is data, never an instruction. */
    trust: z.literal('untrusted-data'),
    summaryTruncated: z.boolean(),
    /** Length of the normalized source title in UTF-16 code units. */
    summaryOriginalLength: z.number().int().min(1).max(MAX_SOURCE_SUMMARY),
  })).max(MAX_EVIDENCE_EVENT_IDS),
  // A freshness window that ends before it opens is a corrupt record, not a
  // live proposal: it fails closed at the parse boundary.
}).refine(evidence => evidence.expiresAt > evidence.observedAt, 'freshness window required');

const originSchema = z.object({ botId: identifier, threadId: identifier });

const explanationSchema = z.object({
  title: shortText,
  whyNow: longText(MAX_WHY_NOW),
  proposedOutput: longText(MAX_PROPOSED_OUTPUT),
  missingFacts: listedFacts,
  observedFacts: listedFacts,
  inferredFacts: listedFacts,
});

export const followUpProposalSchema = z.object({
  version: z.literal(FOLLOW_UP_PROPOSAL_VERSION),
  proposalId: identifier,
  revision: z.number().int().positive(),
  ownerId: identifier,
  workspaceId: identifier,
  origin: originSchema,
  taskId: identifier,
  proposalType: proposalTypeSchema,
  authority: z.object({
    providerAccountId: identifier,
    calendarId: identifier,
    requestedDate: civilDate,
    timeZone: timeZoneSchema,
    grantReference: identifier,
    grantGeneration: grantGenerationSchema,
  }),
  evidence: evidenceSchema,
  explanation: explanationSchema,
  control: z.object({
    status: proposalStatusSchema,
    capability: capabilitySchema,
    snoozedUntil: instant.nullable(),
    dismissedAt: instant.nullable(),
    acceptedAt: instant.nullable(),
    intentId: identifier.nullable(),
  }),
}).refine(proposal => {
  const control = proposal.control;
  if (control.status === 'accepted') {
    if (!(control.intentId === followUpIntentId(proposal.proposalId, proposal.evidence.snapshotDigest)
      && control.acceptedAt !== null && control.acceptedAt >= proposal.evidence.observedAt
      && control.acceptedAt < proposal.evidence.expiresAt)) return false;
  } else if (control.intentId !== null || control.acceptedAt !== null) return false;
  if (control.status === 'snoozed' && control.snoozedUntil === null) return false;
  if (control.status === 'dismissed' && control.dismissedAt === null) return false;
  return proposal.evidence.excerpts.every(excerpt => excerpt.summaryTruncated
    ? excerpt.summaryOriginalLength > MAX_EVENT_SUMMARY && excerpt.summary.endsWith('…')
    : excerpt.summaryOriginalLength === excerpt.summary.length);
}, 'proposal lifecycle and excerpt metadata must agree');
export type FollowUpProposal = z.infer<typeof followUpProposalSchema>;
export type FollowUpProposalExplanation = FollowUpProposal['explanation'];

export interface FollowUpAuthority {
  readonly ownerId: string;
  readonly workspaceId: string;
}

export interface FollowUpTaskReference {
  readonly taskId: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly origin: { readonly botId: string; readonly threadId: string };
  readonly status: 'active' | 'cancelled' | 'completed';
}

export interface FollowUpProposalLookup {
  readonly sourceKey?: string;
  readonly proposalType?: FollowUpProposalType;
}

/** Injected persistence port, scoped to proposal rows only. It never runs
 * jobs and it is never another task database. Rows cross this boundary as
 * serialized JSON so a corrupt or truncated record fails closed inside
 * this module instead of being trusted by a hand-rolled cast. */
export interface FollowUpProposalStore {
  listForAuthority(authority: FollowUpAuthority, lookup: FollowUpProposalLookup): readonly string[];
  load(authority: FollowUpAuthority, proposalId: string): string | null;
  compareAndSwap(
    authority: FollowUpAuthority,
    proposalId: string,
    expectedRevision: number,
    nextRow: string,
  ): FollowUpWriteOutcome;
  insert(authority: FollowUpAuthority, row: string): FollowUpWriteOutcome;
}

/** `lost-response` means the adapter cannot tell whether the write landed.
 * The module then reloads by the original id rather than writing twice. */
export type FollowUpWriteOutcome = 'committed' | 'rolled-back' | 'lost-response';

export const FOLLOW_UP_DENIAL_REASONS = [
  'invalid-clock',
  'missing-authority',
  'missing-task-identity',
  'task-not-owned',
  'task-cancelled',
  'task-not-active',
  'task-binding-changed',
  'missing-grant-identity',
  'invalid-request',
  'invalid-observation-time',
  'invalid-freshness',
  'expiry-before-observation',
  'invalid-time-zone',
  'payload-too-large',
  'evidence-not-found',
  'source-disconnected',
  'source-revoked',
  'source-partial',
  'source-failed',
  'source-stale',
  'source-withdrawn',
  'no-relevant-event',
  'persistence-rolled-back',
  'persistence-uncertain',
] as const;
export type FollowUpDenialReason = (typeof FOLLOW_UP_DENIAL_REASONS)[number];

/** Disconnected, revoked, partial, failed and stale each keep their own
 * reason. Collapsing them would report an outage as a quiet calendar. */
const COMPLETENESS_DENIAL = {
  complete: null,
  partial: 'source-partial',
  disconnected: 'source-disconnected',
  revoked: 'source-revoked',
  failed: 'source-failed',
  stale: 'source-stale',
} satisfies Readonly<Record<FollowUpSourceCompleteness, FollowUpDenialReason | null>>;

export const FOLLOW_UP_ACCEPTANCE_REJECTIONS = [
  'not-found',
  'task-not-found',
  'task-cancelled',
  'task-not-active',
  'task-binding-changed',
  'review-required',
  'invalid-clock',
  'revision-conflict',
  'revision-exhausted',
  'not-proposable',
  'expired',
  'source-unavailable',
  'source-withdrawn',
  'source-stale',
  'observation-in-future',
  'source-changed',
  'grant-revoked',
  'persistence-rolled-back',
  'persistence-uncertain',
] as const;
export type FollowUpAcceptanceRejection = (typeof FOLLOW_UP_ACCEPTANCE_REJECTIONS)[number];

export const FOLLOW_UP_CONTROL_REJECTIONS = [
  ...FOLLOW_UP_ACCEPTANCE_REJECTIONS,
  'invalid-snooze',
] as const;
export type FollowUpControlRejection = (typeof FOLLOW_UP_CONTROL_REJECTIONS)[number];

export const FOLLOW_UP_NOTIFICATION_BLOCKS = [
  'dismissed',
  'accepted',
  'expired',
  'withdrawn',
  'not-proposable',
  'snoozed',
  'stale-source',
  'quiet-hours',
  'polling-window-closed',
  'invalid-policy',
] as const;
export type FollowUpNotificationBlock = (typeof FOLLOW_UP_NOTIFICATION_BLOCKS)[number];

export type FollowUpNotificationDecision =
  | { readonly eligible: true; readonly reason: 'eligible' }
  | { readonly eligible: false; readonly reason: FollowUpNotificationBlock };

/** Owner quiet hours and the current polling window. Both are inputs, not
 * stored state: I0 owns no scheduler and no routine. */
export interface FollowUpNotificationPolicy {
  readonly timeZone: string;
  readonly quietHours: { readonly fromMinute: number; readonly toMinute: number } | null;
  readonly pollingWindow: {
    readonly id: string;
    readonly startedAt: number;
    readonly endsAt: number;
  };
}

/** The reserved identity and nothing more. `runnerAcknowledged` is always
 * false here and `taskReceipt` is always null: I0 admits nothing. */
export interface FollowUpIntentReservation {
  readonly intentId: string;
  readonly proposalId: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly destination: string;
  readonly reservedAt: number;
  readonly capability: FollowUpExecutionCapability;
  readonly runnerAcknowledged: false;
  readonly taskReceipt: null;
}

export interface FollowUpProposalView {
  readonly proposal: FollowUpProposal;
  readonly effectiveStatus: FollowUpProposalStatus;
  readonly notification: FollowUpNotificationDecision;
}

export type FollowUpProposalOutcome =
  | { readonly status: 'proposed'; readonly proposal: FollowUpProposal }
  | { readonly status: 'duplicate'; readonly proposal: FollowUpProposal }
  | { readonly status: 'refresh-required'; readonly proposal: FollowUpProposal }
  | { readonly status: 'denied'; readonly reason: FollowUpDenialReason };

export type FollowUpAcceptanceOutcome =
  | {
      readonly status: 'reserved' | 'replayed';
      readonly reservation: FollowUpIntentReservation;
      readonly proposal: FollowUpProposal;
    }
  | { readonly status: 'rejected'; readonly reason: FollowUpAcceptanceRejection };

export type FollowUpControlOutcome =
  | { readonly status: FollowUpProposalStatus; readonly proposal: FollowUpProposal }
  | { readonly status: 'rejected'; readonly reason: FollowUpControlRejection };

export interface FollowUpProposalRequest {
  readonly authority: FollowUpAuthority;
  readonly origin: { readonly botId: string; readonly threadId: string };
  readonly proposalType: FollowUpProposalType;
  readonly task: FollowUpTaskReference;
  readonly observation: FollowUpObservation;
  readonly evidenceEventIds: readonly string[];
  readonly explanation: FollowUpProposalExplanation;
  readonly freshForMs: number;
  readonly capability: FollowUpExecutionCapability;
  readonly now: number;
}

/** Every acceptance and refresh re-reads the source and re-states the grant
 * epoch. Nothing here trusts a client- or model-asserted freshness. */
export interface FollowUpSourceRevalidation {
  /** Current task loaded under authenticated authority, never a restored card or model claim. */
  readonly task: FollowUpTaskReference;
  readonly observation: FollowUpObservation;
  readonly grant: { readonly reference: string; readonly generation: number };
}

export interface FollowUpControlRequest {
  readonly authority: FollowUpAuthority;
  readonly proposalId: string;
  readonly expectedRevision: number;
  readonly now: number;
}

export interface FollowUpAcceptanceRequest extends FollowUpSourceRevalidation, FollowUpControlRequest {}

export interface FollowUpRefreshRequest extends FollowUpSourceRevalidation, FollowUpControlRequest {
  /** I1 constructs this from trusted task context and the current source. The digest
   * binds the new review copy; old explanatory facts cannot silently survive. */
  readonly review: { readonly snapshotDigest: string; readonly explanation: FollowUpProposalExplanation };
}

export interface FollowUpSnoozeRequest extends FollowUpControlRequest {
  readonly snoozeForMs: number;
}

export interface FollowUpNotificationQuery {
  readonly authority: FollowUpAuthority;
  readonly lookup: FollowUpProposalLookup;
  readonly policy: FollowUpNotificationPolicy;
  readonly now: number;
}

export interface FollowUpNotificationCandidate {
  readonly proposalId: string;
  readonly effectiveStatus: FollowUpProposalStatus;
  readonly decision: FollowUpNotificationDecision;
}

// ── identity ──────────────────────────────────────────────────────────────

function hash(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
}

/** Only the reader's own normalization: whitespace collapsed and trimmed,
 * with the reader's own empty-summary fallback. No rewriting beyond that. */
function normalizeSummary(summary: string): string {
  const collapsed = summary.replace(/\s+/gu, ' ').trim();
  return collapsed.length > 0 ? collapsed : 'Busy';
}

/** Keep the full normalized source in the digest, with a bounded display-only
 * excerpt. Do not split a UTF-16 surrogate pair before the visible ellipsis. */
function summaryExcerpt(raw: string) {
  const normalized = normalizeSummary(raw);
  const summaryTruncated = normalized.length > MAX_EVENT_SUMMARY;
  const summary = summaryTruncated
    ? normalized.slice(0, MAX_EVENT_SUMMARY - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…'
    : normalized;
  return { summary, summaryTruncated, summaryOriginalLength: normalized.length };
}

function evidenceExcerpts(source: FollowUpObservation, ids: readonly string[]): FollowUpProposal['evidence']['excerpts'] | null {
  const result: FollowUpProposal['evidence']['excerpts'] = [];
  for (const eventId of ids) {
    const match = source.events.find(event => event.id === eventId && event.busy);
    if (!match) return null;
    result.push({ eventId: match.id, start: match.start, end: match.end,
      trust: 'untrusted-data', ...summaryExcerpt(match.summary) });
  }
  return result;
}

/** Conservative selected-day snapshot digest, including all normalized events, sorted by
 * (start, end, id) so collection order cannot move it; deliberately blind to
 * `observedAt`, because a re-read of identical content is identical
 * content, and to any provider field this source does not supply. */
export function followUpSnapshotDigest(observation: FollowUpObservation): string {
  const events = observation.events
    .map(event => [
      event.id,
      normalizeSummary(event.summary),
      event.start,
      event.end,
      event.allDay ? '1' : '0',
      event.busy ? '1' : '0',
    ])
    .sort((left, right) => left[2].localeCompare(right[2]) || left[3].localeCompare(right[3])
      || left[0].localeCompare(right[0]));
  return hash([
    observation.providerAccountId,
    observation.calendarId,
    observation.grantReference,
    observation.requestedDate,
    observation.timeZone,
    String(observation.grantGeneration),
    observation.completeness,
    JSON.stringify(events),
  ]);
}

/** Source identity is provider/account/resource scoped, never a title match. */
export function followUpSourceKey(observation: FollowUpObservation): string {
  return hash([
    observation.providerAccountId,
    observation.calendarId,
    observation.grantReference,
    observation.requestedDate,
    String(observation.grantGeneration),
  ]);
}

/** Dedupe identity: authority + immutable task + source + selected-day version + type. */
export function followUpDedupeKey(input: {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly sourceKey: string;
  readonly snapshotDigest: string;
  readonly proposalType: FollowUpProposalType;
  readonly taskId: string;
}): string {
  return hash([
    input.ownerId,
    input.workspaceId,
    input.sourceKey,
    input.snapshotDigest,
    input.proposalType,
    input.taskId,
  ]);
}

/** Assigned once, at creation, from the dedupe identity and then retained for
 * the life of the card — including across a refresh, which rebinds the source
 * version without renaming the card the owner is already looking at. */
export function followUpProposalId(dedupeKey: string): string {
  return `fup_${dedupeKey}`;
}

/** Stable per (proposal, relevant source version): replaying an acceptance,
 * or two racing acceptances, cannot invent two identities, and a refreshed
 * source cannot reuse an identity reserved for the plan it replaced. */
export function followUpIntentId(proposalId: string, snapshotDigest: string): string {
  return `fui_${hash(['follow-up-intent', proposalId, snapshotDigest])}`;
}

// ── boundary parsing ──────────────────────────────────────────────────────

/** Bound aggregate input before a full stringify or schema traversal. Only
 * JSON-shaped data is accepted; nesting and every traversal step consume a
 * finite budget. Oversized strings are rejected before encoding copies. */
/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This raw JSON boundary must bound size, cycles and depth before schema traversal; the domain schema still validates every accepted input afterward. */
function boundedJsonInput(input: unknown): 'invalid-request' | 'payload-too-large' | null {
  let remaining = MAX_REQUEST_BYTES;
  const ancestors = new Set<object>();
  const walk = (value: unknown, depth: number): 'invalid-request' | 'payload-too-large' | null => {
    if (depth > 16) return 'invalid-request';
    if (--remaining < 0) return 'payload-too-large';
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) return null; // field schema names the clock error
      remaining -= String(value).length;
    } else if (typeof value === 'string') {
      if (value.length > remaining) return 'payload-too-large';
      remaining -= Buffer.byteLength(JSON.stringify(value), 'utf8');
    } else if (typeof value === 'object') {
      if (ancestors.has(value)) return 'invalid-request';
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
        && Object.getPrototypeOf(value) !== null) return 'invalid-request';
      ancestors.add(value);
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const keyResult = walk(key, depth + 1);
        if (keyResult !== null) return keyResult;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        // JSON has data properties only. Reject accessors without executing them.
        if (!descriptor || !('value' in descriptor)) return 'invalid-request';
        const child = walk(descriptor.value, depth + 1);
        if (child !== null) return child;
      }
      ancestors.delete(value);
    } else return 'invalid-request';
    return remaining < 0 ? 'payload-too-large' : null;
  };
  return walk(input, 0);
}
/* eslint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

function currentTaskRejection(current: FollowUpProposal, task: FollowUpTaskReference | undefined): FollowUpAcceptanceRejection | null {
  if (!task) return 'task-not-found';
  if (task.taskId !== current.taskId || task.ownerId !== current.ownerId
    || task.workspaceId !== current.workspaceId || !task.origin
    || task.origin.botId !== current.origin.botId || task.origin.threadId !== current.origin.threadId) {
    return 'task-binding-changed';
  }
  if (task.status === 'cancelled') return 'task-cancelled';
  if (task.status !== 'active') return 'task-not-active';
  return null;
}


function parseRow(row: string): FollowUpProposal | null {
  if (row.length > MAX_REQUEST_BYTES || Buffer.byteLength(row, 'utf8') > MAX_REQUEST_BYTES) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(row);
  } catch {
    return null;
  }
  if (boundedJsonInput(decoded) !== null) return null;
  const parsed = followUpProposalSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

function isClock(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function loadOwned(
  store: FollowUpProposalStore,
  authority: FollowUpAuthority,
  proposalId: string,
): FollowUpProposal | null {
  const row = store.load(authority, proposalId);
  if (row === null) return null;
  const parsed = parseRow(row);
  if (parsed === null) return null;
  // A store that ignores the authority filter must not become a disclosure.
  if (parsed.ownerId !== authority.ownerId || parsed.workspaceId !== authority.workspaceId) return null;
  return parsed;
}

function ownedRows(
  store: FollowUpProposalStore,
  authority: FollowUpAuthority,
  lookup: FollowUpProposalLookup,
): readonly FollowUpProposal[] {
  const rows: FollowUpProposal[] = [];
  for (const row of store.listForAuthority(authority, lookup)) {
    const parsed = parseRow(row);
    if (parsed === null) continue;
    if (parsed.ownerId !== authority.ownerId || parsed.workspaceId !== authority.workspaceId) continue;
    if (lookup.sourceKey !== undefined && parsed.evidence.sourceKey !== lookup.sourceKey) continue;
    if (lookup.proposalType !== undefined && parsed.proposalType !== lookup.proposalType) continue;
    rows.push(parsed);
  }
  return rows;
}

/** Expiry is derived on read, so no read path ever needs to write. */
export function followUpEffectiveStatus(
  proposal: FollowUpProposal,
  now: number,
): FollowUpProposalStatus {
  const stored = proposal.control.status;
  if (stored !== 'proposed' && stored !== 'snoozed') return stored;
  return now >= proposal.evidence.expiresAt ? 'expired' : stored;
}

function isSettled(proposal: FollowUpProposal, now: number): boolean {
  const effective = followUpEffectiveStatus(proposal, now);
  return effective === 'accepted' || effective === 'dismissed'
    || effective === 'expired' || effective === 'withdrawn';
}

// ── notification eligibility ──────────────────────────────────────────────

/** Wall-clock minute of day in the owner's zone, or null when the runtime
 * cannot resolve the zone at all. DST is handled by resolving the instant
 * first: a spring-forward gap simply has no local minute, and a fall-back
 * hour resolves to the same local minute on both passes. */
function localMinuteOfDay(now: number, timeZone: string): number | null {
  try {
    const local = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone);
    return local.hour * 60 + local.minute;
  } catch {
    return null;
  }
}

function withinQuietHours(minute: number, from: number, to: number): boolean {
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

export function followUpNotificationDecision(
  proposal: FollowUpProposal,
  policy: FollowUpNotificationPolicy,
  now: number,
): FollowUpNotificationDecision {
  const effective = followUpEffectiveStatus(proposal, now);
  if (effective === 'dismissed') return { eligible: false, reason: 'dismissed' };
  if (effective === 'accepted') return { eligible: false, reason: 'accepted' };
  if (effective === 'expired') return { eligible: false, reason: 'expired' };
  if (effective === 'withdrawn') return { eligible: false, reason: 'withdrawn' };
  if (effective !== 'proposed' && effective !== 'snoozed') {
    return { eligible: false, reason: 'not-proposable' };
  }
  if (!isClock(now) || now < proposal.evidence.observedAt || now >= proposal.evidence.expiresAt) {
    return { eligible: false, reason: 'stale-source' };
  }
  const snoozedUntil = proposal.control.snoozedUntil;
  if (effective === 'snoozed' && snoozedUntil !== null && now < snoozedUntil) {
    return { eligible: false, reason: 'snoozed' };
  }
  const window = policy.pollingWindow;
  if (!isClock(window.startedAt) || !isClock(window.endsAt)
    || window.endsAt <= window.startedAt || now < window.startedAt || now >= window.endsAt) {
    return { eligible: false, reason: 'polling-window-closed' };
  }
  const quiet = policy.quietHours;
  if (quiet !== null && (!Number.isInteger(quiet.fromMinute) || !Number.isInteger(quiet.toMinute)
    || quiet.fromMinute < 0 || quiet.fromMinute >= 1_440 || quiet.toMinute < 0 || quiet.toMinute >= 1_440)) {
    return { eligible: false, reason: 'invalid-policy' };
  }
  if (quiet === null) return { eligible: true, reason: 'eligible' };
  const minute = localMinuteOfDay(now, policy.timeZone);
  if (minute === null) return { eligible: false, reason: 'invalid-policy' };
  if (withinQuietHours(minute, quiet.fromMinute, quiet.toMinute)) {
    return { eligible: false, reason: 'quiet-hours' };
  }
  return { eligible: true, reason: 'eligible' };
}

export function listNotifyableFollowUps(
  store: FollowUpProposalStore,
  query: FollowUpNotificationQuery,
): readonly FollowUpNotificationCandidate[] {
  return ownedRows(store, query.authority, query.lookup).map(proposal => ({
    proposalId: proposal.proposalId,
    effectiveStatus: followUpEffectiveStatus(proposal, query.now),
    decision: followUpNotificationDecision(proposal, query.policy, query.now),
  }));
}

/** Read-only projection. Returns null for another owner, an unknown id or a
 * corrupt row, so a wrong-owner lookup discloses nothing at all. */
export function readFollowUp(
  store: FollowUpProposalStore,
  authority: FollowUpAuthority,
  proposalId: string,
  policy: FollowUpNotificationPolicy,
  now: number,
): FollowUpProposalView | null {
  const proposal = loadOwned(store, authority, proposalId);
  if (proposal === null) return null;
  return {
    proposal,
    effectiveStatus: followUpEffectiveStatus(proposal, now),
    notification: followUpNotificationDecision(proposal, policy, now),
  };
}

// ── proposal construction ─────────────────────────────────────────────────

interface PreparedEvidence {
  readonly source: FollowUpObservation;
  readonly sourceKey: string;
  readonly snapshotDigest: string;
  readonly expiresAt: number;
  readonly freshForMs: number;
  readonly excerpts: FollowUpProposal['evidence']['excerpts'];
}

/** Validates the envelope identity, then the payload size, then the source
 * condition, in that order, so a reason names the first real problem. */
function prepare(
  request: FollowUpProposalRequest,
): { readonly denied: FollowUpDenialReason } | { readonly denied: null; readonly prepared: PreparedEvidence } {
  if (!isClock(request.now)) return { denied: 'invalid-clock' };
  const payload = boundedJsonInput(request);
  if (payload !== null) return { denied: payload };
  if (!nonBlank(request.authority?.ownerId) || !nonBlank(request.authority?.workspaceId)) {
    return { denied: 'missing-authority' };
  }
  if (!request.task || !nonBlank(request.task.taskId)) return { denied: 'missing-task-identity' };
  if (request.task.ownerId !== request.authority.ownerId || request.task.workspaceId !== request.authority.workspaceId) {
    return { denied: 'task-not-owned' };
  }
  if (!request.task.origin || request.task.origin.botId !== request.origin?.botId
    || request.task.origin.threadId !== request.origin?.threadId) return { denied: 'task-binding-changed' };
  if (request.task.status === 'cancelled') return { denied: 'task-cancelled' };
  if (request.task.status !== 'active') return { denied: 'task-not-active' };
  const envelope = observationEnvelopeSchema.safeParse(request.observation);
  if (!envelope.success) return { denied: 'missing-grant-identity' };
  const source = envelope.data;
  const events = z.array(calendarEventSchema).max(MAX_EVENTS).safeParse(request.observation.events);
  const evidenceIds = z.array(identifier).max(MAX_EVIDENCE_EVENT_IDS).safeParse(request.evidenceEventIds);
  const identities = z.object({ ownerId: identifier, workspaceId: identifier }).safeParse(request.authority);
  const taskId = identifier.safeParse(request.task.taskId);
  const type = proposalTypeSchema.safeParse(request.proposalType);
  const capability = capabilitySchema.safeParse(request.capability);
  const explanation = explanationSchema.safeParse(request.explanation);
  const origin = originSchema.safeParse(request.origin);
  if (!events.success || !type.success || !capability.success || !explanation.success || !origin.success
    || !evidenceIds.success || !identities.success || !taskId.success) {
    const oversized = [events, type, capability, explanation, origin, evidenceIds, identities, taskId].some(parsed =>
      !parsed.success && parsed.error.issues.some(issue => issue.code === 'too_big'));
    return { denied: oversized ? 'payload-too-large' : 'invalid-request' };
  }
  if (source.observedAt > request.now) return { denied: 'invalid-observation-time' };
  if (!Number.isSafeInteger(request.freshForMs)
    || request.freshForMs < MIN_FRESHNESS_MS || request.freshForMs > MAX_FRESHNESS_MS) {
    return { denied: 'invalid-freshness' };
  }
  const expiresAt = source.observedAt + request.freshForMs;
  if (!isClock(expiresAt) || expiresAt <= source.observedAt) {
    return { denied: 'expiry-before-observation' };
  }
  if (request.now >= expiresAt) return { denied: 'source-stale' };
  if (/^[+-]/.test(source.timeZone)) return { denied: 'invalid-time-zone' };
  try {
    Temporal.PlainDate.from(source.requestedDate).toZonedDateTime(source.timeZone);
  } catch {
    return { denied: 'invalid-time-zone' };
  }
  const incomplete = COMPLETENESS_DENIAL[source.completeness];
  if (incomplete !== null) return { denied: incomplete };
  if (source.status === 'withdrawn') return { denied: 'source-withdrawn' };

  // Minimum necessary evidence: busy events only, named ones only, and only
  // the fields a reviewer needs. Transparent or declined time is never shown.
  const relevantEvents = events.data.filter(event => event.busy);
  if (relevantEvents.length === 0) return { denied: 'no-relevant-event' };
  if (evidenceIds.data.length === 0 || new Set(evidenceIds.data).size !== evidenceIds.data.length) {
    return { denied: 'evidence-not-found' };
  }
  const excerpts: FollowUpProposal['evidence']['excerpts'] = [];
  for (const eventId of evidenceIds.data) {
    const match = relevantEvents.find(event => event.id === eventId);
    if (match === undefined) return { denied: 'evidence-not-found' };
    excerpts.push({
      eventId: match.id,
      start: match.start,
      end: match.end,
      trust: 'untrusted-data',
      ...summaryExcerpt(match.summary),
    });
  }
  const observation = { ...source, events: events.data };
  return {
    denied: null,
    prepared: {
      source: observation,
      sourceKey: followUpSourceKey(observation),
      snapshotDigest: followUpSnapshotDigest(observation),
      expiresAt,
      freshForMs: request.freshForMs,
      excerpts,
    },
  };
}

function buildProposal(input: {
  readonly authority: FollowUpAuthority;
  readonly origin: { readonly botId: string; readonly threadId: string };
  readonly proposalType: FollowUpProposalType;
  readonly taskId: string;
  readonly prepared: PreparedEvidence;
  readonly explanation: FollowUpProposalExplanation;
  readonly capability: FollowUpExecutionCapability;
}): FollowUpProposal {
  const { prepared } = input;
  const { source } = prepared;
  const dedupeKey = followUpDedupeKey({
    ownerId: input.authority.ownerId,
    workspaceId: input.authority.workspaceId,
    sourceKey: prepared.sourceKey,
    snapshotDigest: prepared.snapshotDigest,
    proposalType: input.proposalType,
    taskId: input.taskId,
  });
  return followUpProposalSchema.parse({
    version: FOLLOW_UP_PROPOSAL_VERSION,
    proposalId: followUpProposalId(dedupeKey),
    revision: 1,
    ownerId: input.authority.ownerId,
    workspaceId: input.authority.workspaceId,
    origin: input.origin,
    taskId: input.taskId,
    proposalType: input.proposalType,
    authority: {
      providerAccountId: source.providerAccountId,
      calendarId: source.calendarId,
      requestedDate: source.requestedDate,
      timeZone: source.timeZone,
      grantReference: source.grantReference,
      grantGeneration: source.grantGeneration,
    },
    evidence: {
      sourceKey: prepared.sourceKey,
      dedupeKey,
      snapshotDigest: prepared.snapshotDigest,
      sourceCompleteness: source.completeness,
      observedAt: source.observedAt,
      freshForMs: prepared.freshForMs,
      expiresAt: prepared.expiresAt,
      excerpts: prepared.excerpts,
    },
    explanation: input.explanation,
    control: {
      status: 'proposed',
      capability: input.capability,
      snoozedUntil: null,
      dismissedAt: null,
      acceptedAt: null,
      intentId: null,
    },
  });
}

/** One explicit task plus one selected Calendar snapshot yields at most one
 * proposal. A replayed read returns the same record; a changed source
 * against the same open card asks for refresh instead of a second card. */
export function proposeFollowUp(
  store: FollowUpProposalStore,
  request: FollowUpProposalRequest,
): FollowUpProposalOutcome {
  const prepared = prepare(request);
  if (prepared.denied !== null) return { status: 'denied', reason: prepared.denied };
  const evidence = prepared.prepared;
  const proposal = buildProposal({
    authority: request.authority,
    origin: request.origin,
    proposalType: request.proposalType,
    taskId: request.task.taskId,
    prepared: evidence,
    explanation: request.explanation,
    capability: request.capability,
  });
  const existing = loadOwned(store, request.authority, proposal.proposalId);
  if (existing !== null) {
    if (currentTaskRejection(existing, request.task) !== null) return { status: 'denied', reason: 'task-binding-changed' };
    return { status: 'duplicate', proposal: existing };
  }
  const sourceRows = ownedRows(store, request.authority, {
    sourceKey: evidence.sourceKey,
    proposalType: request.proposalType,
  }).filter(row => row.taskId === request.task.taskId);
  // A refreshed card retains its original ID. Its latest dedupe key must also
  // be consulted after dismissal/acceptance/withdrawal, not only while open.
  const sameEvidence = sourceRows.find(row => row.evidence.dedupeKey === proposal.evidence.dedupeKey);
  if (sameEvidence !== undefined) {
    if (currentTaskRejection(sameEvidence, request.task) !== null) return { status: 'denied', reason: 'task-binding-changed' };
    return { status: 'duplicate', proposal: sameEvidence };
  }
  const competing = sourceRows.find(row => !isSettled(row, request.now) && row.proposalId !== proposal.proposalId);
  if (competing !== undefined) {
    if (currentTaskRejection(competing, request.task) !== null) return { status: 'denied', reason: 'task-binding-changed' };
    return { status: 'refresh-required', proposal: competing };
  }

  const written = store.insert(request.authority, JSON.stringify(proposal));
  if (written === 'lost-response') {
    // The adapter cannot say whether it landed: reload the original id
    // rather than inserting a second card.
    const reloaded = loadOwned(store, request.authority, proposal.proposalId);
    if (reloaded === null || reloaded.revision !== proposal.revision) {
      return { status: 'denied', reason: 'persistence-uncertain' };
    }
    return { status: 'proposed', proposal: reloaded };
  }
  if (written === 'rolled-back') return { status: 'denied', reason: 'persistence-rolled-back' };
  if (written !== 'committed') return { status: 'denied', reason: 'persistence-uncertain' };
  return { status: 'proposed', proposal };
}

// ── control transitions ───────────────────────────────────────────────────

type TransitionDecision =
  | { readonly kind: 'replay' }
  | { readonly kind: 'reject'; readonly reason: FollowUpControlRejection }
  | { readonly kind: 'apply'; readonly next: FollowUpProposal };

/** One shared compare-and-swap. Every control write goes through here, so
 * revision conflicts, rolled-back writes and lost responses behave the same
 * way everywhere and no path can quietly skip them. */
function transition(
  store: FollowUpProposalStore,
  request: FollowUpControlRequest,
  decide: (current: FollowUpProposal, now: number) => TransitionDecision,
): FollowUpControlOutcome {
  if (!isClock(request.now)) return { status: 'rejected', reason: 'invalid-clock' };
  const current = loadOwned(store, request.authority, request.proposalId);
  if (current === null) return { status: 'rejected', reason: 'not-found' };
  const decision = decide(current, request.now);
  if (decision.kind === 'replay') return { status: current.control.status, proposal: current };
  if (decision.kind === 'reject') return { status: 'rejected', reason: decision.reason };
  if (current.revision !== request.expectedRevision) {
    return { status: 'rejected', reason: 'revision-conflict' };
  }
  const revision = current.revision + 1;
  if (!Number.isSafeInteger(revision)) return { status: 'rejected', reason: 'revision-exhausted' };
  const written = store.compareAndSwap(
    request.authority,
    request.proposalId,
    current.revision,
    JSON.stringify({ ...decision.next, revision }),
  );
  if (written === 'committed') {
    return { status: decision.next.control.status, proposal: { ...decision.next, revision } };
  }
  // A swap that did not report success still has to be told apart from a
  // swap that never landed. One read of the original id settles it; this
  // path never writes a second time.
  const reloaded = loadOwned(store, request.authority, request.proposalId);
  if (reloaded === null) {
    return { status: 'rejected', reason: 'persistence-uncertain' };
  }
  const intended = followUpProposalSchema.parse({ ...decision.next, revision });
  if (reloaded.revision === current.revision && JSON.stringify(reloaded) === JSON.stringify(current)) {
    return { status: 'rejected', reason: written === 'rolled-back' ? 'persistence-rolled-back' : 'persistence-uncertain' };
  }
  if (reloaded.revision !== revision || JSON.stringify(reloaded) !== JSON.stringify(intended)) {
    return { status: 'rejected', reason: 'revision-conflict' };
  }
  if (reloaded.control.status === decision.next.control.status) {
    return { status: reloaded.control.status, proposal: reloaded };
  }
  return {
    status: 'rejected',
    reason: written === 'rolled-back' ? 'persistence-rolled-back' : 'persistence-uncertain',
  };
}

/** Dismissal is durable and total for its dedupe identity: no later polling
 * window, midnight or reworded card brings it back. */
export function dismissFollowUp(
  store: FollowUpProposalStore,
  request: FollowUpControlRequest,
): FollowUpControlOutcome {
  return transition(store, request, (current, now) => {
    if (current.control.status === 'dismissed') return { kind: 'replay' };
    if (current.control.status === 'accepted' || current.control.status === 'withdrawn') {
      return { kind: 'reject', reason: 'not-proposable' };
    }
    if (followUpEffectiveStatus(current, now) === 'expired') {
      return { kind: 'reject', reason: 'expired' };
    }
    return {
      kind: 'apply',
      next: {
        ...current,
        control: { ...current.control, status: 'dismissed', dismissedAt: now, snoozedUntil: null },
      },
    };
  });
}

export function snoozeFollowUp(
  store: FollowUpProposalStore,
  request: FollowUpSnoozeRequest,
): FollowUpControlOutcome {
  if (!Number.isSafeInteger(request.snoozeForMs)
    || request.snoozeForMs < MIN_SNOOZE_MS || request.snoozeForMs > MAX_SNOOZE_MS) {
    return { status: 'rejected', reason: 'invalid-snooze' };
  }
  return transition(store, request, (current, now) => {
    if (current.control.status !== 'proposed' && current.control.status !== 'snoozed') {
      return { kind: 'reject', reason: 'not-proposable' };
    }
    if (followUpEffectiveStatus(current, now) === 'expired') {
      return { kind: 'reject', reason: 'expired' };
    }
    const snoozedUntil = now + request.snoozeForMs;
    if (!isClock(snoozedUntil)) return { kind: 'reject', reason: 'invalid-snooze' };
    return {
      kind: 'apply',
      next: {
        ...current,
        control: { ...current.control, status: 'snoozed', snoozedUntil },
      },
    };
  });
}

/** Source withdrawal blocks everything still open for that source. An
 * ordinary history restore is not a withdrawal and never reverses one. */
export function withdrawFollowUps(
  store: FollowUpProposalStore,
  authority: FollowUpAuthority,
  lookup: FollowUpProposalLookup,
  now: number,
): readonly string[] {
  if (!isClock(now) || lookup.sourceKey === undefined) return [];
  const withdrawn: string[] = [];
  for (const row of ownedRows(store, authority, lookup)) {
    const outcome = transition(store, {
      authority, proposalId: row.proposalId, expectedRevision: row.revision, now,
    }, current => (current.control.status === 'accepted' || current.control.status === 'withdrawn'
      ? { kind: 'reject', reason: 'not-proposable' as const }
      : { kind: 'apply' as const, next: { ...current, control: { ...current.control, status: 'withdrawn' as const } } }));
    if (outcome.status === 'withdrawn') withdrawn.push(row.proposalId);
  }
  return withdrawn;
}

/** Refresh re-reads the authorized source for an open card. The card keeps
 * its proposal id and its originating bot and thread. Cited excerpts are
 * rebuilt from the newly reviewed source alongside its digest and window. A dismissed,
 * accepted, expired or withdrawn card is never refreshed, so a source change
 * cannot undo a dismissal. */
export function refreshFollowUp(
  store: FollowUpProposalStore,
  request: FollowUpRefreshRequest,
): FollowUpControlOutcome {
  return transition(store, request, (current, now) => {
    if (current.control.status !== 'proposed' && current.control.status !== 'snoozed') {
      return { kind: 'reject', reason: 'not-proposable' };
    }
    if (followUpEffectiveStatus(current, now) === 'expired') {
      return { kind: 'reject', reason: 'expired' };
    }
    const check = revalidate(current, request, true);
    if (check.rejected !== null) return { kind: 'reject', reason: check.rejected };
    const observation = check.observation;
    const expiresAt = observation.observedAt + current.evidence.freshForMs;
    if (!isClock(expiresAt) || expiresAt <= observation.observedAt) {
      return { kind: 'reject', reason: 'source-unavailable' };
    }
    const digest = followUpSnapshotDigest(observation);
    // Re-reading the same bytes is not a change and must not churn the row.
    if (digest === current.evidence.snapshotDigest) return { kind: 'replay' };
    const review = request.review && explanationSchema.safeParse(request.review.explanation);
    if (!review?.success || request.review.snapshotDigest !== digest) {
      return { kind: 'reject', reason: 'review-required' };
    }
    const sourceKey = followUpSourceKey(observation);
    const excerpts = evidenceExcerpts(observation, current.evidence.excerpts.map(excerpt => excerpt.eventId));
    if (excerpts === null) return { kind: 'reject', reason: 'source-changed' };
    if (sourceKey !== current.evidence.sourceKey) return { kind: 'reject', reason: 'source-changed' };
    return {
      kind: 'apply',
      next: {
        ...current,
        explanation: review.data,
        evidence: {
          ...current.evidence,
          sourceKey,
          excerpts,
          dedupeKey: followUpDedupeKey({
            ownerId: current.ownerId,
            workspaceId: current.workspaceId,
            sourceKey,
            snapshotDigest: digest,
            proposalType: current.proposalType,
            taskId: current.taskId,
          }),
          snapshotDigest: digest,
          sourceCompleteness: observation.completeness,
          observedAt: observation.observedAt,
          expiresAt,
        },
      },
    };
  });
}

type RevalidationCheck =
  | { readonly rejected: FollowUpAcceptanceRejection; readonly observation: null }
  | { readonly rejected: null; readonly observation: FollowUpObservation };

/** Grant epoch, account/calendar binding, completeness, withdrawal, clock
 * and freshness. Shared by refresh and accept so the two paths cannot drift
 * apart and neither can be relaxed without the other. */
function revalidate(
  current: FollowUpProposal,
  request: FollowUpSourceRevalidation & { readonly now: number },
  allowChangedSource = false,
): RevalidationCheck {
  const unavailable: RevalidationCheck = { rejected: 'source-unavailable', observation: null };
  if (boundedJsonInput(request) !== null) return unavailable;
  const taskCheck = currentTaskRejection(current, request.task);
  if (taskCheck !== null) return { rejected: taskCheck, observation: null };
  if (!isClock(request.now)) return { rejected: 'invalid-clock', observation: null };
  const envelope = observationEnvelopeSchema.safeParse(request.observation);
  if (!envelope.success) return unavailable;
  const events = z.array(calendarEventSchema).max(MAX_EVENTS).safeParse(request.observation.events);
  if (!events.success) return unavailable;
  const parsed = followUpObservationSchema.safeParse({ ...envelope.data, events: events.data });
  if (!parsed.success) return unavailable;
  const source = parsed.data;
  const incomplete = COMPLETENESS_DENIAL[source.completeness];
  if (incomplete !== null) return unavailable;
  if (source.status === 'withdrawn') return { rejected: 'source-withdrawn', observation: null };
  if (!request.grant || request.grant.reference !== current.authority.grantReference
    || request.grant.generation !== current.authority.grantGeneration
    || source.grantReference !== current.authority.grantReference
    || source.grantGeneration !== current.authority.grantGeneration
    || source.providerAccountId !== current.authority.providerAccountId
    || source.calendarId !== current.authority.calendarId) {
    return { rejected: 'grant-revoked', observation: null };
  }
  if (source.observedAt > request.now) {
    return { rejected: 'observation-in-future', observation: null };
  }
  if (source.observedAt < current.evidence.observedAt) {
    return { rejected: 'source-stale', observation: null };
  }
  if (request.now >= current.evidence.expiresAt) return { rejected: 'expired', observation: null };
  if (source.requestedDate !== current.authority.requestedDate || source.timeZone !== current.authority.timeZone) {
    return { rejected: 'source-changed', observation: null };
  }
  if (!allowChangedSource && followUpSnapshotDigest(source) !== current.evidence.snapshotDigest) {
    return { rejected: 'source-changed', observation: null };
  }
  return { rejected: null, observation: source };
}

function reservationFor(proposal: FollowUpProposal, now: number): FollowUpIntentReservation {
  return {
    intentId: proposal.control.intentId
      ?? followUpIntentId(proposal.proposalId, proposal.evidence.snapshotDigest),
    proposalId: proposal.proposalId,
    ownerId: proposal.ownerId,
    workspaceId: proposal.workspaceId,
    destination: proposal.origin.threadId,
    reservedAt: proposal.control.acceptedAt ?? now,
    capability: proposal.control.capability,
    runnerAcknowledged: false,
    taskReceipt: null,
  };
}

/** Acceptance is a compare-and-swap that reserves one stable intent
 * identity and nothing else. Two racing accepts converge on the same
 * intent; a replay re-reads the original id instead of reserving again.
 * No task, runner or provider is contacted from here. */
export function acceptFollowUp(
  store: FollowUpProposalStore,
  request: FollowUpAcceptanceRequest,
): FollowUpAcceptanceOutcome {
  if (!isClock(request.now)) return { status: 'rejected', reason: 'invalid-clock' };
  const current = loadOwned(store, request.authority, request.proposalId);
  if (current === null) return { status: 'rejected', reason: 'not-found' };
  if (current.control.status === 'accepted') {
    const replayCheck = revalidate(current, request);
    if (replayCheck.rejected !== null) return { status: 'rejected', reason: replayCheck.rejected };
    return { status: 'replayed', reservation: reservationFor(current, request.now), proposal: current };
  }
  if (current.control.status !== 'proposed' && current.control.status !== 'snoozed') {
    return { status: 'rejected', reason: 'not-proposable' };
  }
  if (followUpEffectiveStatus(current, request.now) === 'expired') {
    return { status: 'rejected', reason: 'expired' };
  }
  if (current.revision !== request.expectedRevision) {
    return { status: 'rejected', reason: 'revision-conflict' };
  }
  const check = revalidate(current, request);
  if (check.rejected !== null) return { status: 'rejected', reason: check.rejected };

  const intentId = followUpIntentId(current.proposalId, current.evidence.snapshotDigest);
  const accepted: FollowUpProposal = {
    ...current,
    control: { ...current.control, status: 'accepted', acceptedAt: request.now, intentId },
  };
  const revision = current.revision + 1;
  if (!Number.isSafeInteger(revision)) return { status: 'rejected', reason: 'revision-exhausted' };
  const written = store.compareAndSwap(
    request.authority,
    current.proposalId,
    current.revision,
    JSON.stringify({ ...accepted, revision }),
  );
  if (written === 'committed') {
    const committed = { ...accepted, revision };
    return { status: 'reserved', reservation: reservationFor(committed, request.now), proposal: committed };
  }
  // The swap did not report success. One read of the original id settles it
  // without reserving again: a committed write whose response was lost and a
  // lost race that the winner already accepted both converge here, on the
  // same intent identity. A definitively rolled-back write leaves the prior
  // record untouched and produces no acceptance signal at all.
  const reloaded = loadOwned(store, request.authority, current.proposalId);
  if (reloaded === null) return { status: 'rejected', reason: 'not-found' };
  if (reloaded.control.status === 'accepted' && reloaded.control.intentId === intentId) {
    return {
      status: written === 'lost-response' ? 'reserved' : 'replayed',
      reservation: reservationFor(reloaded, request.now),
      proposal: reloaded,
    };
  }
  if (reloaded.revision !== current.revision) return { status: 'rejected', reason: 'revision-conflict' };
  if (written === 'rolled-back') return { status: 'rejected', reason: 'persistence-rolled-back' };
  return { status: 'rejected', reason: 'persistence-uncertain' };
}
