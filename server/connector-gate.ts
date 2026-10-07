// Harness-owned approval for the exact executable connector call. Only the
// two documented discovery meta-tools pass without a human decision.
import { z } from "zod";
import { newId } from "./contracts.ts";
import type { Store } from "./store.ts";
import type { JsonValue } from "./schema.ts";

export const CONNECTOR_MAX_ACTIONS = 12;
export const CONNECTOR_MAX_SUBTITLE = 300;
const actionSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/);
const actionsSchema = z.array(actionSchema).min(1).max(CONNECTOR_MAX_ACTIONS);
const argumentsSchema = z.record(z.string(), z.unknown());
const batchSchema = z.object({ tools: z.array(z.union([
  actionSchema,
  z.object({ tool_slug: actionSchema }).passthrough(),
])).min(1).max(CONNECTOR_MAX_ACTIONS) }).passthrough();

// A verb in a name is not evidence that its actual implementation is read-only.
// No executable action has a vetted read exemption in this slice.
export function classifyConnectorAction(_rawSlug: string): "read" | "write" { return "write"; }

/** Argument names only. Values never enter the approval card. */
export function redactArguments(args: JsonValue | undefined): string {
  const parsed = argumentsSchema.safeParse(args);
  if (!parsed.success) return "";
  const keys = Object.keys(parsed.data);
  const shown = keys.slice(0, 12).join(", ");
  return keys.length > 12 ? `${shown} (+${keys.length - 12} more keys)` : shown;
}

export type ConnectorWriteIntent = { actions: string[]; toolkits: string[]; argsSummary: string };
export type ConnectorGateIntent =
  | { kind: "pass" }
  | { kind: "refuse"; reason: string }
  | ({ kind: "write" } & ConnectorWriteIntent);

function toolkitsOf(slugs: string[]): string[] {
  return [...new Set(slugs.map(slug => slug.split("_")[0].toLowerCase()))];
}

export function connectorApprovalSubtitle(intent: ConnectorWriteIntent): string {
  const parts = [`connected apps (${intent.toolkits.join(", ")})`, intent.actions.join(", ")];
  if (intent.argsSummary) parts.push(`args: ${intent.argsSummary}`);
  return parts.join(" — ");
}

/** Validate every action without filtering, deduplicating or truncating it. */
export function connectorApprovalIntent(input: JsonValue | ConnectorWriteIntent): ConnectorWriteIntent | null {
  const parsed = z.object({
    actions: actionsSchema,
    toolkits: z.array(z.string()),
    argsSummary: z.string().max(240),
  }).strict().safeParse(input);
  if (!parsed.success) return null;
  const intent = { ...parsed.data, toolkits: toolkitsOf(parsed.data.actions) };
  if (connectorApprovalSubtitle(intent).length > CONNECTOR_MAX_SUBTITLE) return null;
  return intent;
}

export function connectorGateIntent(name: string, args: JsonValue | undefined): ConnectorGateIntent {
  if (name === "COMPOSIO_SEARCH_TOOLS" || name === "COMPOSIO_GET_TOOL_SCHEMAS") return { kind: "pass" };
  let actions: string[];
  if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const parsed = batchSchema.safeParse(args);
    if (!parsed.success) return { kind: "refuse", reason: "The complete connector action inventory is invalid or too large." };
    actions = parsed.data.tools.map(item => item instanceof Object ? item.tool_slug : item);
  } else {
    const parsed = actionSchema.safeParse(name);
    if (!parsed.success) return { kind: "refuse", reason: "The connector tool identity is invalid." };
    // arguments.action never substitutes for the tool which will execute.
    actions = [parsed.data];
  }
  const intent = connectorApprovalIntent({ actions, toolkits: toolkitsOf(actions), argsSummary: redactArguments(args) });
  return intent ? { kind: "write", ...intent } : { kind: "refuse", reason: "The complete connector action inventory cannot fit on one approval card." };
}

export interface ConnectorGateBus {
  store: Store;
  recordDecision?: (entry: { botId: string; action: string; decision: "approved" | "denied"; rule?: string; summary: string }) => void;
}
export const CONNECTOR_CARD_TOOL = "connector_call";
export const CONNECTOR_DENY_TIMEOUT_MS = 10 * 60_000;
export function connectorAllowKey(actions: string[]): string { return `connector_call:${JSON.stringify(actions)}`; }

export interface ConnectorConversation { botId: string; threadId: string; ownerId: string }
/** The caller supplies the current dispatch lease/account check, not a wire flag. */
export interface ConnectorApprovalAuthority extends ConnectorConversation {
  current: () => boolean;
  signal?: AbortSignal;
}
export interface ConnectorApprovalCard extends ConnectorWriteIntent, ConnectorConversation {
  requestId: string; allowKey: string; messageId: string; subtitle: string;
}
type Decision = "allow" | "deny";
interface PendingCard {
  card: ConnectorApprovalCard;
  resolve: (decision: Decision) => void;
  timer: ReturnType<typeof setTimeout>;
  bus: ConnectorGateBus;
  authority: ConnectorApprovalAuthority;
  onAbort: () => void;
}
const openCards = new Map<string, PendingCard>();

function currentConversation(bus: ConnectorGateBus, authority: ConnectorApprovalAuthority): boolean {
  try {
    if (!authority.ownerId || authority.signal?.aborted || !authority.current()) return false;
    const bot = bus.store.bot(authority.botId);
    if (!bot || (bot.ownerId && bot.ownerId !== authority.ownerId)) return false;
    if (bot.threadId === authority.threadId || bot.tasks?.some(task => task.threadId === authority.threadId)) return true;
    return bus.store.groups.some(group => group.threadId === authority.threadId && group.memberIds.includes(bot.id) &&
      (!group.ownerId || group.ownerId === authority.ownerId));
  } catch { return false; }
}

function settleBusCard(bus: ConnectorGateBus, card: ConnectorApprovalCard, answered: string, dismissed: boolean): void {
  const existing = bus.store.messagesFor(card.threadId).find(message => message.id === card.messageId);
  if (!existing?.card || existing.card.answered) return;
  bus.store.patchMessage(card.threadId, card.messageId, { card: { ...existing.card, answered, dismissed } });
}

function currentCardMatches(pending: PendingCard, answered?: "allow"): boolean {
  try {
    const message = pending.bus.store.messagesFor(pending.card.threadId).find(entry => entry.id === pending.card.messageId);
    const card = message?.card;
    return message?.kind === "options" && card?.requestId === pending.card.requestId && card.tool === CONNECTOR_CARD_TOOL &&
      card.title === "Approval needed" && card.subtitle === pending.card.subtitle && card.allowKey === undefined &&
      card.options.length === 2 && card.options[0] === "Allow" && card.options[1] === "Deny" &&
      card.answered === answered && !card.dismissed;
  } catch { return false; }
}

function settle(pending: PendingCard, decision: Decision, answered: string, dismissed: boolean, rule?: string): void {
  if (openCards.get(pending.card.requestId) !== pending) return;
  openCards.delete(pending.card.requestId);
  clearTimeout(pending.timer);
  pending.authority.signal?.removeEventListener("abort", pending.onAbort);
  // A failed store or ledger write must still unblock the caller as denied.
  let delivered = decision;
  try {
    settleBusCard(pending.bus, pending.card, answered, dismissed);
    if (decision === "allow" && (!currentConversation(pending.bus, pending.authority) || !currentCardMatches(pending, "allow"))) delivered = "deny";
    pending.bus.recordDecision?.({ botId: pending.card.botId, action: pending.card.actions.join(", "),
      decision: delivered === "allow" ? "approved" : "denied", rule, summary: pending.card.subtitle });
  } catch { delivered = "deny"; }
  if (delivered === "allow" && (!currentConversation(pending.bus, pending.authority) || !currentCardMatches(pending, "allow"))) delivered = "deny";
  if (delivered !== decision) {
    try {
      const existing = pending.bus.store.messagesFor(pending.card.threadId).find(message => message.id === pending.card.messageId);
      if (existing?.card) pending.bus.store.patchMessage(pending.card.threadId, pending.card.messageId,
        { card: { ...existing.card, answered: "deny", dismissed: true } });
    } catch { /* The held execution remains denied even if its display cannot be updated. */ }
  }
  pending.resolve(delivered);
}

export interface ConnectorCardRequest { card: ConnectorApprovalCard; decision: Promise<Decision> }
export function requestConnectorCard(
  bus: ConnectorGateBus,
  bot: { id: string; threadId: string },
  input: ConnectorWriteIntent,
  history?: { total: number; approved: number; denied: number; auto: number; lastDecision: "approved" | "denied" | "auto" | null; summary: string | null },
  authority?: ConnectorApprovalAuthority,
): ConnectorCardRequest {
  const intent = connectorApprovalIntent(input);
  if (!intent || !authority || authority.botId !== bot.id || authority.threadId !== bot.threadId || !currentConversation(bus, authority)) {
    throw new Error("Connector approval requires a complete inventory and current conversation authority.");
  }
  // Copy mutable caller values; every subsequent check uses this minted scope.
  const heldAuthority = { ...authority };
  const card: ConnectorApprovalCard = { ...intent, actions: [...intent.actions], toolkits: [...intent.toolkits],
    botId: bot.id, threadId: bot.threadId, ownerId: authority.ownerId, requestId: newId(),
    allowKey: connectorAllowKey(intent.actions), messageId: "", subtitle: connectorApprovalSubtitle(intent) };
  for (const pending of openCards.values()) {
    if (pending.bus.store === bus.store && pending.card.botId === card.botId && pending.card.ownerId === card.ownerId &&
      pending.card.threadId === card.threadId && pending.card.allowKey === card.allowKey) settle(pending, "deny", "superseded", true, "superseded");
  }
  if (!currentConversation(bus, heldAuthority)) throw new Error("Connector conversation is no longer current.");
  const note = bus.store.appendMessage(card.threadId, { role: "bot", kind: "options", card: {
    title: "Approval needed", subtitle: card.subtitle, options: ["Allow", "Deny"], requestId: card.requestId,
    tool: CONNECTOR_CARD_TOOL, history,
  } });
  card.messageId = note.id;
  let resolveDecision: (decision: Decision) => void = () => {};
  const decision = new Promise<Decision>(resolve => { resolveDecision = resolve; });
  const pending: PendingCard = { card, bus, authority: heldAuthority, resolve: resolveDecision,
    timer: setTimeout(() => settle(pending, "deny", "deny", true, "no answer within 10 minutes"), CONNECTOR_DENY_TIMEOUT_MS),
    onAbort: () => settle(pending, "deny", "deny", true, "connector request cancelled"),
  };
  pending.timer.unref?.();
  openCards.set(card.requestId, pending);
  heldAuthority.signal?.addEventListener("abort", pending.onAbort, { once: true });
  if (!currentConversation(bus, heldAuthority) || !currentCardMatches(pending)) settle(pending, "deny", "deny", true, "conversation authority changed");
  return { card: structuredClone(card), decision };
}

/** A request ID alone grants no authority to answer another conversation. */
export function resolveConnectorAction(bus: ConnectorGateBus, requestId: string, behavior: string | undefined, context?: ConnectorConversation): boolean {
  const pending = openCards.get(requestId);
  if (!pending || pending.bus.store !== bus.store || !context || pending.card.botId !== context.botId ||
      pending.card.threadId !== context.threadId || pending.card.ownerId !== context.ownerId) return false;
  const allow = behavior === "allow" && currentConversation(bus, pending.authority) && currentCardMatches(pending);
  settle(pending, allow ? "allow" : "deny", allow ? "allow" : "deny", !allow && behavior === "allow",
    !allow && behavior === "allow" ? "conversation authority changed" : undefined);
  return true;
}
export function cancelConnectorApprovalsFor(bus: ConnectorGateBus, botId: string): void {
  for (const pending of openCards.values()) {
    if (pending.bus.store === bus.store && pending.card.botId === botId) settle(pending, "deny", "deny", true, "the bot is being deleted");
  }
}
export function dismissStaleConnectorCards(bus: ConnectorGateBus): number {
  let dismissed = 0;
  const threads = new Set([...bus.store.bots.flatMap(bot => [bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)]),
    ...bus.store.groups.map(group => group.threadId)]);
  for (const threadId of threads) for (const message of bus.store.messagesFor(threadId)) {
    const card = message.card;
    if (!card?.requestId || card.answered || card.dismissed || card.tool !== CONNECTOR_CARD_TOOL || openCards.has(card.requestId)) continue;
    if (bus.store.patchMessage(threadId, message.id, { card: { ...card, answered: "deny", dismissed: true } })) dismissed++;
  }
  return dismissed;
}
