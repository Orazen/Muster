// Connected-app (Composio) approval gate — the write-side card for tool calls
// the engines run auto-approved (audit S3; CONNECTOR-APPROVAL-GATE/v1).
//
// Engines reach Composio through connector-proxy.ts. Its tools are Tool
// Router meta-tools: the concrete action (send an email, post a message) is
// an argument — for COMPOSIO_MULTI_EXECUTE_TOOL it is one slug per entry of
// arguments.tools[].tool_slug. claude pre-allows the whole `mcp__composio`
// server and codex runs connector calls with default approvals, so without
// a gate here a write action would never meet a human.
//
// The gate is deny-by-default and deliberately simple:
//   · meta "pass" tools (search/schemas), connection management (handled by
//     the bridge itself) and calls whose every slug reads as a READ pass
//     through with no card;
//   · any other call is write — one write in a batch gates the whole batch;
//     the card lists every action in it;
//   · never trust tool annotations (readOnlyHint and friends are upstream
//     data) — the allowlist below is the only read evidence;
//   · the bridge holds the original call and asks the harness route
//     /api/internal/connectors/approve, which mints an approval card on the
//     same options-card flow peer-approval.ts uses and holds its own
//     response open until the human answers or the timeout denies;
//   · a declined or timed-out call answers the engine with an isError and
//     must not be retried;
//   · a retry of the same call (same allowKey in the same conversation)
//     replaces its pending card instead of nesting a new one;
//   · there is deliberately NO "always allow" for connector writes in v1.

import { newId } from "./contracts.ts";
import type { Store } from "./store.ts";

// Wire decoders for the stdio/HTTP-boundary data: this module also runs
// inside the spawned connector-proxy bundle, where JSON.parse output is the
// only known source. Discriminated exactly here and nowhere else.
type JsonPrimitive = string | number | boolean | null;
type JsonRecord = { [key: string]: JsonValue };
type JsonValue = JsonPrimitive | JsonRecord | JsonValue[];

const isText = (value: JsonValue): value is string => String(value) === value;
/** A parsed JSON object (constructor Object): the only record shape. */
const isJsonRecord = (value: JsonValue): value is JsonRecord =>
  value instanceof Object && value.constructor === Object;

/** The read verbs. Exact tokens, evaluated case-insensitively against the
 * slug's tokens (the first token is the toolkit and is ignored). */
const READ_VERBS = new Set([
  "get", "list", "search", "fetch", "find", "read", "retrieve",
]);

/** Exact write tokens (mixed slugs — a read verb plus any of these — stay
 * writes). Prefix stems cover inflections ("execution" runs code like
 * "execute" does; "deleted" deletes like "delete"). Stems are chosen so no
 * common noun collides ("settings" must keep `get` a read). */
const WRITE_TOKENS = new Set([
  "send", "post", "create", "delete", "destroy", "update", "upsert", "edit",
  "reply", "forward", "move", "copy", "label", "tag", "star", "like", "react",
  "mark", "upload", "attach", "share", "modify", "remove", "add", "set",
  "toggle", "subscribe", "unsubscribe", "join", "leave", "archive", "mute",
  "unmute", "pin", "unpin", "resolve", "close", "reopen", "merge", "checkout",
  "commit", "push", "trigger", "run", "exec", "execute", "stop", "restart",
  "lock", "unlock", "accept", "decline", "restore", "manage", "grant",
  "revoke", "ban", "unban", "follow", "unfollow", "block", "unblock",
  "invite", "kick", "schedule", "reschedule", "approve", "reject", "withdraw",
  "publish", "unpublish", "rename", "transfer", "launch", "deploy", "sync",
]);

/** Inflections and other spellings that must not slip past the exact set
 * (each is a root that only appears in mutating verbs). */
const WRITE_STEMS: RegExp[] = [
  /^delet/, /^remov/, /^cancel/, /^deactiv/, /^terminat/, /^shutdown/,
  /^flush/, /^purge/, /^wipe/, /^truncat/, /^kill/, /^execut/, /^updat/,
  /^_CREAT/, /^_SET/,
];

/** Whether an action slug reads data. Unknown verbs are writes: the
 * fail-default only ever asks for one more tap. */
export function classifyConnectorAction(rawSlug: string): "read" | "write" {
  const tokens = String(rawSlug ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length <= 1) return "write"; // no verb token at all
  const body = tokens.slice(1); // tokens[0] is the toolkit
  const isWrite = body.some((token) =>
    WRITE_TOKENS.has(token) || WRITE_STEMS.some((stem) => stem.test(token)),
  );
  if (isWrite) return "write";
  return body.some((token) => READ_VERBS.has(token)) ? "read" : "write";
}

/** Keys of an arguments object — the card shows argument NAMES, never
 * values, so nothing sensitive rides onto a card. */
export function redactArguments(args: JsonValue): string {
  if (isJsonRecord(args)) {
    const keys = Object.keys(args).slice(0, 12);
    return keys.length ? keys.join(", ") : "";
  }
  return "";
}

/** A resolved gate verdict for one tools/call frame. */
export type ConnectorGateIntent =
  | { kind: "pass" }
  | { kind: "read" }
  | {
      kind: "write";
      /** every action in the call, in wire order — the card lists all of them */
      actions: string[];
      toolkits: string[];
      argsSummary: string;
    };

const PASS_TOOLS = /COMPOSIO_SEARCH_TOOLS|COMPOSIO_GET_TOOL_SCHEMAS$/i;

function toolkitsOf(slugs: string[]): string[] {
  return [...new Set(slugs.map((slug) => slug.toLowerCase().split(/[^a-z0-9]+/)[0]).filter(Boolean))];
}

/** The tools[] entries of a COMPOSIO_MULTI_EXECUTE_TOOL call: a bare slug
 * or a {tool_slug} object — decoded here; nothing else carries a slug. */
function batchSlugs(items: JsonValue[]): string[] {
  return [...new Set(
    items.flatMap((item): string[] => {
      if (isText(item)) return item.trim() ? [item.trim()] : [];
      if (isJsonRecord(item) && isText(item.tool_slug) && item.tool_slug.trim()) {
        return [item.tool_slug.trim()];
      }
      return [];
    }),
  )];
}

/** Read the gate verdict out of a connector tools/call frame. Connection
 * meta-tools never reach this (the bridge answers them itself) — pass/read
 * relays, writes hold. */
export function connectorGateIntent(name: string, args: JsonValue): ConnectorGateIntent {
  if (PASS_TOOLS.test(name)) return { kind: "pass" };
  if (/COMPOSIO_MULTI_EXECUTE_TOOL$/i.test(name)) {
    const wrapper = isJsonRecord(args) ? args : {};
    // SAFETY: Array.isArray splits an absent tools array from real entries;
    // item decoding itself happens in batchSlugs.
    const items = Array.isArray(wrapper.tools) ? wrapper.tools : [];
    if (!items.length) {
      return { kind: "write", actions: [], toolkits: [], argsSummary: redactArguments(args) };
    }
    const slugs = batchSlugs(items);
    if (!slugs.length) {
      return { kind: "write", actions: [], toolkits: [], argsSummary: redactArguments(args) };
    }
    // EVERY slug is classified; one write gates the whole batch
    if (slugs.every((slug) => classifyConnectorAction(slug) === "read")) {
      return { kind: "read" };
    }
    return {
      kind: "write",
      actions: slugs,
      toolkits: toolkitsOf(slugs),
      argsSummary: redactArguments(args),
    };
  }
  // anything else that reaches this bridge names its own action: create/read
  // style direct tools (GMAIL_GET_EMAIL) or a slug argument
  const detail = isJsonRecord(args) ? args : {};
  const slug = isText(detail.action) && detail.action.trim() ? detail.action.trim() : name;
  if (classifyConnectorAction(slug) === "read") return { kind: "read" };
  return {
    kind: "write",
    actions: [slug],
    toolkits: toolkitsOf([slug]),
    argsSummary: redactArguments(args),
  };
}

/** What a connector gate needs: the store to push/settle cards, and an
 * optional decision-ledger hook called exactly once per settled verdict. */
export interface ConnectorGateBus {
  store: Store;
  recordDecision?: (entry: { botId: string; action: string; decision: "approved" | "denied"; rule?: string; summary: string }) => void;
}

/** Card marker + the narrow "always allow"-style key (v1: writes are never
 * pre-covered by it — the key is the card's identity for card replacement). */
export const CONNECTOR_CARD_TOOL = "connector_call";

export function connectorAllowKey(actions: string[]): string {
  return `connector_call:${actions.map((action) => action.toUpperCase()).join("+")}`;
}

export interface ConnectorApprovalCard {
  requestId: string;
  allowKey: string;
  actions: string[];
  toolkits: string[];
  argsSummary: string;
  botId: string;
  threadId: string;
  messageId: string;
  subtitle: string;
}

/** One settled card answer's delivery — the requesting hold resolves to a
 * decision on the human's answer, a timeout, supersession or plant-down. */
type Decision = "allow" | "deny";

interface PendingCard {
  card: ConnectorApprovalCard;
  resolve: (decision: Decision) => void;
  timer: ReturnType<typeof setTimeout>;
  bus: ConnectorGateBus;
}

/** requestId → open gate card. Memory only: a restart settles every
 * orphaned card at boot (peer-approval precedent) — the composer must never
 * be bricked by a card nothing can answer. */
const openCards = new Map<string, PendingCard>();

export const CONNECTOR_DENY_TIMEOUT_MS = 10 * 60_000;

function settleBusCard(bus: ConnectorGateBus, card: ConnectorApprovalCard, answered: string, dismissed: boolean): void {
  const existing = bus.store
    .messagesFor(card.threadId)
    .find((m) => m.id === card.messageId);
  if (!existing?.card || existing.card.answered) return;
  bus.store.patchMessage(card.threadId, card.messageId, {
    card: { ...existing.card, answered, dismissed },
  });
}

/** A minted card plus the hold a human's answer (or the timeout) resolves. */
export interface ConnectorCardRequest {
  card: ConnectorApprovalCard;
  decision: Promise<"allow" | "deny">;
}

/** Mint the approval card (via store append) and register the hold. A card
 * exists before its pending entry, so any answer can always settle it.
 * `history` is certify-lite evidence embedded by the caller when available. */
export function requestConnectorCard(
  bus: ConnectorGateBus,
  bot: { id: string; threadId: string },
  intent: { actions: string[]; toolkits: string[]; argsSummary: string },
  history?: {
    total: number;
    approved: number;
    denied: number;
    auto: number;
    lastDecision: "approved" | "denied" | "auto" | null;
    summary: string | null;
  },
): ConnectorCardRequest {
  const allowKey = connectorAllowKey(intent.actions);
  // a retry of the same call replaces the pending card instead of nesting:
  // supersede every still-open same-key card in this conversation first
  for (const [oldId, pending] of openCards) {
    if (pending.card.allowKey !== allowKey || pending.card.threadId !== bot.threadId) continue;
    openCards.delete(oldId);
    clearTimeout(pending.timer);
    settleBusCard(bus, pending.card, "superseded", true);
    pending.resolve("deny");
  }
  const requestId = newId();
  const subtitleParts = [
    intent.toolkits.length ? `connected apps (${intent.toolkits.join(", ")})` : "connected apps",
    intent.actions.join(", "),
  ];
  if (intent.argsSummary) subtitleParts.push(`args: ${intent.argsSummary}`);
  const subtitle = subtitleParts.join(" — ").slice(0, 300);
  const note = bus.store.appendMessage(bot.threadId, {
    role: "bot",
    kind: "options",
    card: {
      title: "Approval needed",
      subtitle,
      // v1: no "Always allow" for connector writes — the card carries NO
      // allowKey, so the client never offers one (its button exists only
      // when an allowKey is present); the narrow key lives in the hold map
      // below, where it scopes card replacement on a retry.
      options: ["Allow", "Deny"],
      requestId,
      tool: CONNECTOR_CARD_TOOL,
      history,
    },
  });
  const card: ConnectorApprovalCard = {
    requestId,
    allowKey,
    actions: intent.actions,
    toolkits: intent.toolkits,
    argsSummary: intent.argsSummary,
    botId: bot.id,
    threadId: bot.threadId,
    messageId: note.id,
    subtitle,
  };
  const decision = new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      // timed out = denied (fail-closed), answered with the declined text;
      // the timeout IS a decision and the ledger must say so
      const pending = openCards.get(card.requestId);
      if (!pending) return;
      openCards.delete(card.requestId);
      settleBusCard(bus, card, "deny", true);
      pending.bus.recordDecision?.({
        botId: card.botId,
        action: card.actions.join(", "),
        decision: "denied",
        rule: "no answer within 10 minutes",
        summary: card.subtitle,
      });
      resolve("deny");
    }, CONNECTOR_DENY_TIMEOUT_MS);
    timer.unref?.(); // a waiting card must never hold the process open
    openCards.set(card.requestId, { card, resolve, timer, bus });
  });
  return { card, decision };
}

/** Called by the respond endpoints BEFORE forwarding to the provider
 * adapter. Returns true if the requestId belonged to an open connector card
 * (and settles it); false when the caller should keep going. */
export function resolveConnectorAction(
  bus: ConnectorGateBus,
  requestId: string,
  behavior: string | undefined,
): boolean {
  const pending = openCards.get(requestId);
  if (!pending) return false;
  openCards.delete(requestId);
  clearTimeout(pending.timer);
  const allow = behavior === "allow";
  settleBusCard(bus, pending.card, allow ? "allow" : "deny", false);
  pending.bus.recordDecision?.({
    botId: pending.card.botId,
    action: pending.card.actions.join(", "),
    decision: allow ? "approved" : "denied",
    summary: pending.card.subtitle,
  });
  pending.resolve(allow ? "allow" : "deny");
  return true;
}

/** Settle-and-deny every open card of a bot that no longer exists (or is
 * being deleted) so its held route answers instead of timing out. */
export function cancelConnectorApprovalsFor(bus: ConnectorGateBus, botId: string): void {
  // deleting the current entry mid-iteration is safe for Maps (visited-once)
  for (const [requestId, pending] of openCards) {
    if (pending.card.botId !== botId) continue;
    openCards.delete(requestId);
    clearTimeout(pending.timer);
    settleBusCard(bus, pending.card, "deny", true);
    pending.bus.recordDecision?.({
      botId: pending.card.botId,
      action: pending.card.actions.join(", "),
      decision: "denied",
      rule: "the bot is being deleted",
      summary: pending.card.subtitle,
    });
    pending.resolve("deny");
  }
}

/** Cards left on disk by a previous run can never be answered — their
 * in-memory hold died with the process. Settle them at boot so a crashed run
 * doesn't leave a thread scored "unanswered" forever. */
export function dismissStaleConnectorCards(bus: ConnectorGateBus): number {
  let dismissed = 0;
  for (const bot of bus.store.bots) {
    const threadIds = new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
    for (const threadId of threadIds) {
      for (const message of bus.store.messagesFor(threadId)) {
        const card = message.card;
        if (!card?.requestId || card.answered || card.dismissed) continue;
        if (card.tool !== CONNECTOR_CARD_TOOL) continue;
        if (openCards.has(card.requestId)) continue;
        const patched = bus.store.patchMessage(threadId, message.id, {
          card: { ...card, answered: "deny", dismissed: true },
        });
        if (patched) dismissed += 1;
      }
    }
  }
  return dismissed;
}
