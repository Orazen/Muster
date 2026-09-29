import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { parseWebhookRunAuthority, type RoutineRunOn, type WebhookRunAuthority } from "./routines.ts";
import { parseJson, schemaIssue, type JsonValue } from "./schema.ts";

export interface WebhookTrigger {
  id: string;
  endpointId: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastReceivedAt?: number;
  lastRunId?: string;
  deliveryCount: number;
  /** New UI-created hooks capture one authenticated request before they can run. */
  verificationPending?: boolean;
  verifiedAt?: number;
  verificationSample?: WebhookVerificationSample;
  /** Optional event-name allowlist. Empty means every event type. */
  eventTypes?: string[];
  /** Owning account (absent = legacy unowned row, operator-visible only).
   * Also carried on webhook SSE frames so scoped clients can fold only
   * their own hooks. */
  owner?: string;
}

export interface WebhookTriggerInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  verificationPending?: boolean;
  eventTypes?: string[];
}

type CleanWebhookInput = Omit<
  WebhookTrigger,
  | "id"
  | "endpointId"
  | "createdAt"
  | "updatedAt"
  | "lastReceivedAt"
  | "lastRunId"
  | "deliveryCount"
  | "verifiedAt"
  | "verificationSample"
>;

export interface WebhookVerificationSample {
  receivedAt: number;
  eventName?: string;
  contentType?: string;
  preview: string;
}

export type WebhookAttemptOutcome = "accepted" | "captured" | "duplicate" | "ignored" | "rejected";

export interface WebhookAttempt {
  id: string;
  webhookId: string;
  receivedAt: number;
  outcome: WebhookAttemptOutcome;
  statusCode: number;
  eventName?: string;
  preview?: string;
  deliveryId?: string;
  runId?: string;
  reason?: string;
  /** Owning account of the webhook this attempt belongs to (absent =
   * legacy row). Carried so scoped SSE clients can filter foreign frames. */
  owner?: string;
}

interface StoredWebhookTrigger extends WebhookTrigger {
  secretHash: string;
}

interface DeliveryReceipt {
  key: string;
  runId: string;
  at: number;
}

interface WebhookFile {
  version: 1;
  webhooks: StoredWebhookTrigger[];
  deliveries: DeliveryReceipt[];
  attempts?: WebhookAttempt[];
}

interface CreatedWebhook {
  webhook: WebhookTrigger;
  secret: string;
}

export interface WebhookEvent {
  payload: JsonValue;
  contentType?: string;
  eventName?: string;
  userAgent?: string;
  deliveryId?: string;
}

export interface WebhookReceiveResult {
  runId?: string;
  deliveryId: string;
  duplicate: boolean;
  captured?: boolean;
  ignored?: boolean;
}

export interface WebhookManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (event: WebhookManagerEvent) => void;
  botState: (botId: string) => "ready" | "busy" | "missing";
  /** Actual deployment operator; missing identity denies account access to legacy rows. */
  operatorUserId?: () => string | null;
  /** Deployment authority for execution. Hosted wiring resolves legacy rows
   * to its actual operator; standalone desktop callers retain local access. */
  executionViewer?: (owner: string | undefined) => WebhookViewer | null;
  /** Does `viewer`'s account own this bot? Gates bot (re)assignment so a
   * webhook can never be pointed at — or re-pointed to — another account's
   * AGENT. Desktop passes a constant true. */
  botOwned: (viewer: WebhookViewer, botId: string) => boolean;
  enqueue: (input: {
    webhookId: string;
    webhookName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
    webhookAuthority: WebhookRunAuthority;
  }) => { id: string };
  cancelQueued?: (webhookId: string, message: string) => void;
  pendingRuns?: (webhookId: string) => number;
}

export type WebhookManagerEvent =
  | { kind: "webhook"; webhook: WebhookTrigger }
  | { kind: "webhook.deleted"; webhookId: string; owner?: string }
  | { kind: "webhook.attempt"; attempt: WebhookAttempt };

const MAX_DELIVERIES = 2_000;
const MAX_ATTEMPTS = 2_000;
const MAX_EVENT_CHARS = 48_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;
const MAX_PENDING_RUNS = 3;

const runOnSchema = z.enum(["agent", "cloud", "opensandbox"]);
const eventTypesSchema = z.array(z.string()).max(20).optional();
/** Desktop keeps its existing implicit local authority. Hosted account access
 * uses the authenticated account plus the deployment's actual operator ID. */
export type WebhookViewer = { kind: "all" } | { kind: "account"; owner: string };

/** Shared by management, live events and replay. "local" is a historical
 * storage marker from1.23.0, never an account credential or a public audience. */
export function webhookOwnerVisible(viewer: WebhookViewer, owner: string | undefined, operatorUserId: string | null): boolean {
  if (viewer.kind === "all") return true;
  if (owner === undefined || owner === "local") return operatorUserId !== null && viewer.owner === operatorUserId;
  return owner === viewer.owner;
}
const triggerInputSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  botId: z.string(),
  runOn: runOnSchema.optional(),
  enabled: z.boolean().optional(),
  verificationPending: z.boolean().optional(),
  eventTypes: eventTypesSchema,
});
const triggerPatchSchema = triggerInputSchema.partial();
const verificationSampleSchema = z.object({
  receivedAt: z.number().finite().nonnegative(),
  eventName: z.string().optional(),
  contentType: z.string().optional(),
  preview: z.string(),
});
const storedWebhookSchema = z.object({
  id: z.string().min(1),
  endpointId: z.string().min(1),
  name: z.string(),
  prompt: z.string(),
  botId: z.string().min(1),
  runOn: runOnSchema,
  enabled: z.boolean(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  lastReceivedAt: z.number().finite().nonnegative().optional(),
  lastRunId: z.string().optional(),
  deliveryCount: z.number().int().nonnegative(),
  verificationPending: z.boolean().optional(),
  verifiedAt: z.number().finite().nonnegative().optional(),
  verificationSample: verificationSampleSchema.optional(),
  eventTypes: eventTypesSchema,
  secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Owning account (W0 owner space: session id hosted, "local" desktop).
   * Absent on rows written before ownership existed; such rows are visible
   * to the operator (primary account) only, exactly like the unowned-record
   * rule the route gate already applies to bots and groups. */
  owner: z.string().min(1).optional(),
});
const deliveryReceiptSchema = z.object({
  key: z.string().min(1),
  runId: z.string().min(1),
  at: z.number().finite().nonnegative(),
});
const webhookAttemptSchema = z.object({
  id: z.string().min(1),
  webhookId: z.string().min(1),
  receivedAt: z.number().finite().nonnegative(),
  outcome: z.enum(["accepted", "captured", "duplicate", "ignored", "rejected"]),
  statusCode: z.number().int().min(100).max(599),
  eventName: z.string().optional(),
  preview: z.string().optional(),
  deliveryId: z.string().optional(),
  runId: z.string().optional(),
  reason: z.string().optional(),
});
const webhookFileSchema = z.object({
  version: z.literal(1),
  webhooks: z.array(storedWebhookSchema),
  deliveries: z.array(deliveryReceiptSchema),
  attempts: z.array(webhookAttemptSchema).optional(),
});
const taskPayloadSchema = z.object({ task: z.string().optional(), message: z.string().optional() });
const statusErrorSchema = z.object({ status: z.number().int().optional() });

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function invalidInput(error: z.ZodError): never {
  fail(400, schemaIssue(error, "Invalid webhook settings"));
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(secret: string, expectedHex: string): boolean {
  if (!secret) return false;
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function newEndpointId(): string {
  return `wh_${randomBytes(12).toString("base64url")}`;
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function cleanInput(input: WebhookTriggerInput): CleanWebhookInput {
  const name = input.name.trim().slice(0, 80);
  const prompt = input.prompt.trim().slice(0, 20_000);
  const botId = input.botId.trim();
  const runOn = input.runOn ?? "agent";
  if (!name) fail(400, "Give the webhook a name");
  if (!botId) fail(400, "Choose a AGENT");
  if (runOn !== "agent" && runOn !== "cloud" && runOn !== "opensandbox") fail(400, "Choose where this webhook runs");
  const eventTypes = Array.from(new Set(
    (input.eventTypes ?? [])
      .map((value) => value.trim().slice(0, 200))
      .filter(Boolean),
  )).slice(0, 20);
  const enabled = input.enabled !== false;
  const clean: CleanWebhookInput = {
    name,
    prompt,
    botId,
    runOn,
    enabled,
    verificationPending: enabled ? false : input.verificationPending === true,
  };
  if (eventTypes.length) clean.eventTypes = eventTypes;
  return clean;
}

function parseTriggerInput(value: JsonValue): WebhookTriggerInput {
  const parsed = triggerInputSchema.safeParse(value);
  if (!parsed.success) invalidInput(parsed.error);
  return parsed.data;
}

function parseTriggerPatch(value: JsonValue): Partial<WebhookTriggerInput> {
  const parsed = triggerPatchSchema.safeParse(value);
  if (!parsed.success) invalidInput(parsed.error);
  return parsed.data;
}

function publicTrigger(trigger: StoredWebhookTrigger): WebhookTrigger {
  const { secretHash: _secretHash, ...safe } = trigger;
  return { ...safe };
}

function serializePayload(payload: JsonValue): string {
  let text: string;
  const plainText = z.string().safeParse(payload);
  if (plainText.success) text = plainText.data;
  else {
    try {
      text = JSON.stringify(payload, null, 2) ?? String(payload);
    } catch {
      text = String(payload);
    }
  }
  if (text.length <= MAX_EVENT_CHARS) return text;
  return `${text.slice(0, MAX_EVENT_CHARS)}\n\n[Payload truncated by Muster]`;
}

function previewPayload(payload: JsonValue): string {
  return serializePayload(payload).replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function taskFromPayload(payload: JsonValue): string {
  const parsed = taskPayloadSchema.safeParse(payload);
  if (!parsed.success) return "";
  const task = parsed.data.task ?? parsed.data.message ?? "";
  return task.trim().slice(0, 20_000);
}

function eventPrompt(trigger: StoredWebhookTrigger, event: WebhookEvent, receivedAt: number, deliveryId: string): string {
  const metadata = [
    `Received: ${new Date(receivedAt).toISOString()}`,
    `Delivery ID: ${deliveryId}`,
    event.eventName && `Event: ${event.eventName.slice(0, 200)}`,
    event.contentType && `Content-Type: ${event.contentType.slice(0, 200)}`,
    event.userAgent && `Sender: ${event.userAgent.slice(0, 300)}`,
  ].filter(Boolean);
  const configured = trigger.prompt.trim();
  const requestedTask = configured ? "" : taskFromPayload(event.payload);
  const instructionBlock = configured
    ? ["[USER-CONFIGURED WEBHOOK INSTRUCTIONS]", configured, "[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]"]
    : requestedTask
      ? ["[AUTHENTICATED WEBHOOK TASK]", requestedTask, "[/AUTHENTICATED WEBHOOK TASK]"]
      : [
          "[DEFAULT WEBHOOK INSTRUCTIONS]",
          "Review the incoming event and summarize what happened. Do not take external actions unless the event clearly requires them and existing permissions allow them.",
          "[/DEFAULT WEBHOOK INSTRUCTIONS]",
        ];
  return [
    ...instructionBlock,
    "",
    "[UNTRUSTED WEBHOOK EVENT DATA]",
    ...metadata,
    "",
    serializePayload(event.payload),
    "[/UNTRUSTED WEBHOOK EVENT DATA]",
  ].join("\n");
}

export class WebhookManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: WebhookManagerOptions;
  private webhooks: StoredWebhookTrigger[] = [];
  private deliveries: DeliveryReceipt[] = [];
  private attempts: WebhookAttempt[] = [];
  private rate = new Map<string, number[]>();

  constructor(options: WebhookManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "webhooks.json");
    this.now = options.now ?? Date.now;
    try {
      const parsed = webhookFileSchema.safeParse(parseJson(readFileSync(this.file, "utf8")));
      if (!parsed.success) throw parsed.error;
      this.webhooks = parsed.data.webhooks;
      this.deliveries = parsed.data.deliveries.slice(-MAX_DELIVERIES);
      this.attempts = (parsed.data.attempts ?? []).slice(-MAX_ATTEMPTS);
    } catch {
      this.webhooks = [];
      this.deliveries = [];
      this.attempts = [];
    }
  }

  /** Owner-scoped list: an account sees only its own hooks (unowned legacy
   * rows are the operator's); the desktop viewer sees everything. */
  list(viewer: WebhookViewer): WebhookTrigger[] {
    return this.webhooks
      .filter((trigger) => webhookOwnerVisible(viewer, trigger.owner, this.options.operatorUserId?.() ?? null))
      .map(publicTrigger);
  }

  /** Delivery/attempt history, scoped exactly like list(): an account must
   * not learn that another account's webhook received an event, let alone
   * its payload preview or run id. */
  listAttempts(viewer: WebhookViewer): WebhookAttempt[] {
    const mine = new Set(
      this.webhooks.filter((trigger) => webhookOwnerVisible(viewer, trigger.owner, this.options.operatorUserId?.() ?? null)).map((trigger) => trigger.id),
    );
    return this.attempts.filter((attempt) => mine.has(attempt.webhookId)).map((attempt) => ({ ...attempt }));
  }

  /** Resolve a row for `viewer` or null: foreign and unknown ids are the
   * same null, so a scoped caller can answer a blank 404 either way. */
  private findFor(viewer: WebhookViewer, id: string): StoredWebhookTrigger | undefined {
    const trigger = this.webhooks.find((candidate) => candidate.id === id);
    return trigger && webhookOwnerVisible(viewer, trigger.owner, this.options.operatorUserId?.() ?? null) ? trigger : undefined;
  }

  /** Refuse pointing a webhook at a bot outside the viewer's account — on
   * create and on every reassignment (the patch path). The bot may exist;
   * that is exactly why this check exists. */
  private requireBotOwned(viewer: WebhookViewer, botId: string): void {
    if (this.options.botState(botId) === "missing") fail(400, "That AGENT no longer exists");
    if (!this.options.botOwned(viewer, botId)) fail(403, "Choose one of your own AGENTs for this webhook");
  }

  private executionViewer(trigger: StoredWebhookTrigger): WebhookViewer | null {
    if (this.options.executionViewer) return this.options.executionViewer(trigger.owner);
    return trigger.owner && trigger.owner !== "local" ? { kind: "account", owner: trigger.owner } : { kind: "all" };
  }

  private executionAuthority(trigger: StoredWebhookTrigger): WebhookRunAuthority | null {
    const viewer = this.executionViewer(trigger);
    if (!viewer || !this.options.botOwned(viewer, trigger.botId)) return null;
    return parseWebhookRunAuthority(viewer.kind === "all" ? { kind: "desktop" } : viewer);
  }

  /** Called again after queueing: an edited hook cannot redirect stored work,
   * and a transferred bot cannot inherit another account's pending command. */
  canRunQueued(run: { webhookId?: string; botId: string; webhookAuthority?: unknown }): boolean {
    const captured = parseWebhookRunAuthority(run.webhookAuthority);
    const trigger = this.webhooks.find((row) => row.id === run.webhookId);
    if (!captured || !trigger?.enabled || trigger.botId !== run.botId || this.options.botState(run.botId) === "missing") return false;
    const current = this.executionAuthority(trigger);
    return current?.kind === captured.kind && (current.kind === "desktop" || (captured.kind === "account" && current.owner === captured.owner));
  }

  /** The authenticated merge caller has proved both named accounts. A paused
   * candidate is persisted before memory/events change. Retrying is a no-op;
   * capabilities and historical receipts keep their existing identities. */
  transferOwner(source: string, target: string): number {
    if (!source || !target || source === "local" || target === "local" || source === target) fail(400, "Choose two valid accounts to merge");
    const moved = this.webhooks.filter((row) => row.owner === source);
    if (!moved.length) return 0;
    for (const row of moved) this.options.cancelQueued?.(row.id, "The webhook's account was merged; review it before sending new work");
    const candidate = this.webhooks.map((row) => row.owner === source
      ? { ...row, owner: target, enabled: false, verificationPending: false, updatedAt: this.now() }
      : row);
    this.save(candidate);
    this.webhooks = candidate;
    for (const row of moved) {
      this.options.emit?.({ kind: "webhook.deleted", webhookId: row.id, owner: source });
      this.emit(this.webhooks.find((current) => current.id === row.id)!);
    }
    return moved.length;
  }

  create(viewer: WebhookViewer, input: JsonValue): CreatedWebhook {
    const clean = cleanInput(parseTriggerInput(input));
    this.requireBotOwned(viewer, clean.botId);
    const now = this.now();
    const secret = newSecret();
    const trigger: StoredWebhookTrigger = {
      id: randomUUID(),
      endpointId: newEndpointId(),
      ...clean,
      secretHash: hashSecret(secret),
      createdAt: now,
      updatedAt: now,
      deliveryCount: 0,
      owner: viewer.kind === "account" ? viewer.owner : undefined,
    };
    this.webhooks.unshift(trigger);
    this.save();
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  update(viewer: WebhookViewer, id: string, value: JsonValue): WebhookTrigger | null {
    const trigger = this.findFor(viewer, id);
    if (!trigger) return null;
    const patch = parseTriggerPatch(value);
    const clean = cleanInput({
      name: patch.name ?? trigger.name,
      prompt: patch.prompt ?? trigger.prompt,
      botId: patch.botId ?? trigger.botId,
      runOn: patch.runOn ?? trigger.runOn,
      enabled: patch.enabled ?? trigger.enabled,
      verificationPending: patch.verificationPending ?? trigger.verificationPending,
      eventTypes: patch.eventTypes ?? trigger.eventTypes,
    });
    // Reassignment is the interesting case: the target bot must belong to
    // the same account as the webhook, not merely exist.
    this.requireBotOwned(viewer, clean.botId);
    Object.assign(trigger, clean, { updatedAt: this.now() });
    if (!clean.eventTypes?.length) delete trigger.eventTypes;
    if (patch.enabled === false) {
      this.options.cancelQueued?.(trigger.id, "The webhook was paused before this delivery started");
    }
    // The queued callback also enforces this after restart; do not silently
    // redirect an already accepted payload to a different bot.
    if (patch.botId !== undefined) this.options.cancelQueued?.(trigger.id, "The webhook's assigned bot changed before this delivery started");
    this.save();
    this.emit(trigger);
    return publicTrigger(trigger);
  }

  remove(viewer: WebhookViewer, id: string): boolean {
    const trigger = this.findFor(viewer, id);
    if (!trigger) return false;
    const at = this.webhooks.indexOf(trigger);
    this.webhooks.splice(at, 1);
    this.deliveries = this.deliveries.filter((delivery) => !delivery.key.startsWith(`${trigger.endpointId}:`));
    this.attempts = this.attempts.filter((attempt) => attempt.webhookId !== trigger.id);
    this.rate.delete(trigger.endpointId);
    this.options.cancelQueued?.(trigger.id, "The webhook was deleted before this delivery started");
    this.save();
    this.options.emit?.({ kind: "webhook.deleted", webhookId: id, owner: trigger.owner });
    return true;
  }

  rotateSecret(viewer: WebhookViewer, id: string): { webhook: WebhookTrigger; secret: string } | null {
    const trigger = this.findFor(viewer, id);
    if (!trigger) return null;
    const secret = newSecret();
    trigger.secretHash = hashSecret(secret);
    trigger.updatedAt = this.now();
    this.save();
    this.emit(trigger);
    return { webhook: publicTrigger(trigger), secret };
  }

  disableForBot(botId: string): void {
    let changed = false;
    for (const trigger of this.webhooks) {
      if (trigger.botId !== botId || !trigger.enabled) continue;
      trigger.enabled = false;
      trigger.updatedAt = this.now();
      this.options.cancelQueued?.(trigger.id, "The assigned AGENT was deleted");
      this.emit(trigger);
      changed = true;
    }
    if (changed) this.save();
  }

  authorize(endpointId: string, secret: string): boolean {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    return Boolean(trigger && secretMatches(secret, trigger.secretHash));
  }

  receive(endpointId: string, secret: string, event: WebhookEvent): WebhookReceiveResult {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger || !secretMatches(secret, trigger.secretHash)) fail(401, "Invalid webhook URL or secret");
    if (trigger.verificationPending && !trigger.enabled) {
      if (this.options.botState(trigger.botId) === "missing") fail(410, "The assigned AGENT no longer exists");
      if (!this.executionAuthority(trigger)) fail(403, "The webhook no longer has permission to use its assigned bot");
      return this.captureVerification(trigger, event);
    }
    try {
      return this.dispatch(trigger, event);
    } catch (error) {
      const parsedError = statusErrorSchema.safeParse(error);
      const status = parsedError.success ? parsedError.data.status ?? 500 : 500;
      this.recordRejectedForTrigger(trigger, status, error instanceof Error ? error.message : String(error), event);
      throw error;
    }
  }

  test(viewer: WebhookViewer, id: string, payload: JsonValue = { event: "muster.test", message: "Test webhook delivery" }): WebhookReceiveResult | null {
    const trigger = this.findFor(viewer, id);
    if (!trigger) return null;
    const eventName = trigger.eventTypes?.[0] ?? "muster.test";
    return this.dispatch(trigger, {
      payload,
      contentType: "application/json",
      eventName,
      userAgent: "Muster webhook tester",
      deliveryId: `test-${randomUUID()}`,
    });
  }

  recordRejected(endpointId: string, statusCode: number, reason: string, event: Partial<WebhookEvent> = {}): WebhookAttempt | null {
    const trigger = this.webhooks.find((candidate) => candidate.endpointId === endpointId);
    if (!trigger) return null;
    return this.recordRejectedForTrigger(trigger, statusCode, reason, event);
  }

  private dispatch(trigger: StoredWebhookTrigger, event: WebhookEvent): WebhookReceiveResult {
    if (!trigger.enabled) fail(409, "This webhook is paused");
    if (this.options.botState(trigger.botId) === "missing") fail(410, "The assigned AGENT no longer exists");
    const webhookAuthority = this.executionAuthority(trigger);
    if (!webhookAuthority) fail(403, "The webhook no longer has permission to use its assigned bot");

    const allowed = trigger.eventTypes ?? [];
    if (allowed.length > 0 && (!event.eventName || !allowed.includes(event.eventName))) {
      const deliveryId = String(event.deliveryId ?? "").trim().slice(0, 200) || randomUUID();
      this.appendAttempt(trigger, event, {
        outcome: "ignored",
        statusCode: 202,
        deliveryId,
        reason: event.eventName ? `Event type “${event.eventName}” is not enabled` : "Event type is missing",
      });
      this.save();
      return { deliveryId, duplicate: false, ignored: true };
    }

    const now = this.now();
    const requestedDeliveryId = String(event.deliveryId ?? "").trim().slice(0, 200);
    if (requestedDeliveryId) {
      const key = `${trigger.endpointId}:${requestedDeliveryId}`;
      const duplicate = this.deliveries.find((delivery) => delivery.key === key);
      if (duplicate) {
        this.appendAttempt(trigger, event, {
          outcome: "duplicate",
          statusCode: 202,
          deliveryId: requestedDeliveryId,
          runId: duplicate.runId,
          reason: "Duplicate delivery ignored",
        });
        this.save();
        return { runId: duplicate.runId, deliveryId: requestedDeliveryId, duplicate: true };
      }
    }

    // A sender retrying an already-accepted delivery must remain idempotent
    // even while this webhook's queue is full. Only new work consumes a slot.
    if ((this.options.pendingRuns?.(trigger.id) ?? 0) >= MAX_PENDING_RUNS) {
      fail(429, "This webhook already has too many unfinished tasks");
    }

    const recent = (this.rate.get(trigger.endpointId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) fail(429, "Webhook rate limit exceeded");
    recent.push(now);
    this.rate.set(trigger.endpointId, recent);

    const deliveryId = requestedDeliveryId || randomUUID();
    const run = this.options.enqueue({
      webhookId: trigger.id,
      webhookName: trigger.name,
      prompt: eventPrompt(trigger, event, now, deliveryId),
      botId: trigger.botId,
      runOn: trigger.runOn,
      deliveryId,
      receivedAt: now,
      webhookAuthority,
    });
    this.deliveries.push({ key: `${trigger.endpointId}:${deliveryId}`, runId: run.id, at: now });
    if (this.deliveries.length > MAX_DELIVERIES) {
      this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
    }
    trigger.lastReceivedAt = now;
    trigger.lastRunId = run.id;
    trigger.deliveryCount += 1;
    trigger.updatedAt = now;
    this.appendAttempt(trigger, event, {
      outcome: "accepted",
      statusCode: 202,
      deliveryId,
      runId: run.id,
    });
    this.save();
    this.emit(trigger);
    return { runId: run.id, deliveryId, duplicate: false };
  }

  private captureVerification(trigger: StoredWebhookTrigger, event: WebhookEvent): WebhookReceiveResult {
    const receivedAt = this.now();
    const deliveryId = String(event.deliveryId ?? "").trim().slice(0, 200) || randomUUID();
    trigger.verificationPending = false;
    trigger.verifiedAt = receivedAt;
    trigger.lastReceivedAt = receivedAt;
    trigger.updatedAt = receivedAt;
    const sample: WebhookVerificationSample = {
      receivedAt,
      preview: previewPayload(event.payload),
    };
    if (event.eventName) sample.eventName = event.eventName.slice(0, 200);
    if (event.contentType) sample.contentType = event.contentType.slice(0, 200);
    trigger.verificationSample = sample;
    this.appendAttempt(trigger, event, {
      outcome: "captured",
      statusCode: 202,
      deliveryId,
      reason: "Test event captured; enable the webhook to start AGENT tasks",
    });
    this.save();
    this.emit(trigger);
    return { deliveryId, duplicate: false, captured: true };
  }

  private recordRejectedForTrigger(trigger: StoredWebhookTrigger, statusCode: number, reason: string, event: Partial<WebhookEvent>): WebhookAttempt {
    const attempt = this.appendAttempt(trigger, event, {
      outcome: "rejected",
      statusCode,
      reason: reason.slice(0, 500),
      deliveryId: event.deliveryId,
    });
    this.save();
    return attempt;
  }

  private appendAttempt(
    trigger: StoredWebhookTrigger,
    event: Partial<WebhookEvent>,
    details: Pick<WebhookAttempt, "outcome" | "statusCode"> & Partial<Pick<WebhookAttempt, "deliveryId" | "runId" | "reason">>,
  ): WebhookAttempt {
    const attempt: WebhookAttempt = {
      id: randomUUID(),
      webhookId: trigger.id,
      receivedAt: this.now(),
      outcome: details.outcome,
      statusCode: details.statusCode,
    };
    if (event.eventName) attempt.eventName = event.eventName.slice(0, 200);
    if (event.payload !== undefined) attempt.preview = previewPayload(event.payload);
    if (details.deliveryId) attempt.deliveryId = details.deliveryId.slice(0, 200);
    if (details.runId) attempt.runId = details.runId;
    if (details.reason) attempt.reason = details.reason;
    this.attempts.push(attempt);
    if (this.attempts.length > MAX_ATTEMPTS) this.attempts.splice(0, this.attempts.length - MAX_ATTEMPTS);
    this.emitAttempt(trigger, attempt);
    return attempt;
  }

  private emit(trigger: StoredWebhookTrigger): void {
    this.options.emit?.({ kind: "webhook", webhook: publicTrigger(trigger) });
  }

  /** Attempts are emitted with their webhook's owner so a scoped SSE client
   * can drop another account's delivery activity without learning it. */
  private emitAttempt(trigger: StoredWebhookTrigger, attempt: WebhookAttempt): void {
    this.options.emit?.({ kind: "webhook.attempt", attempt: { ...attempt, owner: trigger.owner } });
  }

  private save(webhooks = this.webhooks): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: 1, webhooks, deliveries: this.deliveries, attempts: this.attempts } satisfies WebhookFile, null, 2),
      { mode: 0o600 },
    );
  }
}
