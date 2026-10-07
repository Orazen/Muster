import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  cancelConnectorApprovalsFor,
  CONNECTOR_DENY_TIMEOUT_MS,
  connectorGateIntent,
  classifyConnectorAction,
  dismissStaleConnectorCards,
  redactArguments,
  requestConnectorCard as requestBoundCard,
  resolveConnectorAction as resolveBoundAction,
  type ConnectorGateBus,
  type ConnectorWriteIntent,
} from "./connector-gate.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("connector action classification (deny-by-default)", () => {
  it("requires approval for executable verbs without vetted read authority", () => {
    for (const slug of [
      "GMAIL_GET_EMAIL", "GMAIL_LIST_EMAILS", "SLACK_SEARCH_MESSAGES", "GOOGLEDRIVE_FETCH_FILE",
      "GITHUB_FIND_REPOSITORY", "MAIL_READ_MESSAGE", "CRM_RETRIEVE_CONTACT", "TMP_TOOLS_SEARCH",
    ]) {
      expect(classifyConnectorAction(slug), slug).toBe("write");
    }
    for (const slug of [
      "GMAIL_SEND_EMAIL", "SLACK_POST_MESSAGE", "GITHUB_CREATE_ISSUE", "GOOGLECALENDAR_DELETE_EVENT",
      "DRIVE_UPDATE_FILE", "CLICKUP_SET_STATUS", "CODE_EXECUTE_PYTHON", "CODE_EXECUTION_PYTHON",
      "SHEET_APPEND_ROW", "X_ACCEPT_REQUEST", "NOTION_ARCHIVE_PAGE", "BROWSER_NAVIGATE",
    ]) {
      expect(classifyConnectorAction(slug), slug).toBe("write");
    }
    // unknown/empty/no-verb → write
    expect(classifyConnectorAction("GMAIL_WIBBLE_EMAIL")).toBe("write");
    expect(classifyConnectorAction("")).toBe("write");
    expect(classifyConnectorAction("GMAIL")).toBe("write");
    // a read verb plus a write token is a write
    expect(classifyConnectorAction("GMAIL_GET_THEN_SEND")).toBe("write");
    expect(classifyConnectorAction("GMAIL_EXECUTE_FETCH")).toBe("write");
    // readOnlyHint-style trusting is impossible: the verb list decides
    expect(classifyConnectorAction("GMAIL_DOWNLOAD_ATTACHMENT")).toBe("write");
  });
});

describe("connector gate intent extraction", () => {
  it("passes the read-only meta tools", () => {
    expect(connectorGateIntent("COMPOSIO_SEARCH_TOOLS", {})).toEqual({ kind: "pass" });
    expect(connectorGateIntent("COMPOSIO_GET_TOOL_SCHEMAS", {})).toEqual({ kind: "pass" });
  });

  it("classifies every nested slug of a multi-execute batch; one write gates the whole batch", () => {
    const intent = connectorGateIntent("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [
        { tool_slug: "GMAIL_LIST_EMAILS" },
        { tool_slug: "SLACK_SEARCH_MESSAGES" },
        { tool_slug: "GMAIL_SEND_EMAIL" },
      ],
    });
    expect(intent).toMatchObject({ kind: "write" });
    if (intent.kind !== "write") return;
    expect(intent.actions).toEqual(["GMAIL_LIST_EMAILS", "SLACK_SEARCH_MESSAGES", "GMAIL_SEND_EMAIL"]);
    expect(intent.toolkits).toEqual(["gmail", "slack"]);
  });

  it("an executable batch with read-looking names still requires approval", () => {
    expect(connectorGateIntent("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: "GMAIL_LIST_EMAILS" }, "SLACK_SEARCH_MESSAGES"],
    })).toMatchObject({ kind: "write", actions: ["GMAIL_LIST_EMAILS", "SLACK_SEARCH_MESSAGES"] });
  });

  it("a batch with no usable slugs is refused (fail-closed)", () => {
    const intent = connectorGateIntent("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] });
    expect(intent.kind).toBe("refuse");
  });

  it("holds the actual direct tool identity independently of arguments.action", () => {
    expect(connectorGateIntent("GMAIL_LIST_EMAILS", {})).toMatchObject({ kind: "write", actions: ["GMAIL_LIST_EMAILS"] });
    const intent = connectorGateIntent("SOME_META_TOOL", { action: "GMAIL_SEND_EMAIL" });
    expect(intent).toMatchObject({ kind: "write", actions: ["SOME_META_TOOL"] });
  });

  it("redacts argument values — names only", () => {
    expect(redactArguments({ to: "victim@example.com", subject: "password" })).toBe("to, subject");
    expect(redactArguments([1, 2, 3])).toBe("");
    expect(redactArguments(null)).toBe("");
  });
});

describe("connector exact-frame regressions", () => {
  it("does not replace an executable tool identity with arguments.action", () => {
    expect(connectorGateIntent("GMAIL_SEND_EMAIL", { action: "GMAIL_LIST_EMAILS" })).toMatchObject({ kind: "write", actions: ["GMAIL_SEND_EMAIL"] });
  });
  it("does not pass names merely containing an exact search meta-tool", () => {
    expect(connectorGateIntent("EVIL_COMPOSIO_SEARCH_TOOLS_EXECUTE", {})).toMatchObject({ kind: "write" });
  });
  it("does not infer read authority from an unknown verb and a read noun", () => {
    expect(connectorGateIntent("GMAIL_WIBBLE_SEARCH", {})).toMatchObject({ kind: "write" });
  });
  it("refuses a whole batch containing an undecodable executable entry", () => {
    expect(connectorGateIntent("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: ["GMAIL_LIST_EMAILS", { unrecognized: "GMAIL_SEND_EMAIL" }] })).toMatchObject({ kind: "refuse" });
  });
  it("refuses an over-limit action inventory rather than approving its prefix", () => {
    expect(connectorGateIntent("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: Array.from({ length: 13 }, () => "GMAIL_SEND_EMAIL") })).toMatchObject({ kind: "refuse" });
  });
  it("refuses an inventory whose complete card text would be clipped", () => {
    expect(connectorGateIntent("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: Array.from({ length: 4 }, (_, n) => `TOOL${n}_${"ACTION".repeat(14)}`) })).toMatchObject({ kind: "refuse" });
  });
});

describe("connector approval card lifecycle", () => {
  let store: Store;
  let bus: ConnectorGateBus;
  let bot: BotRecord;
  let active: boolean;
  const scope = (threadId = bot.threadId) => ({ botId: bot.id, threadId, ownerId: "owner-A" });
  const authority = (threadId = bot.threadId) => ({ ...scope(threadId), current: () => active });
  function requestConnectorCard(bus: ConnectorGateBus, target: { id: string; threadId: string }, intent: ConnectorWriteIntent, history?: Parameters<typeof requestBoundCard>[3]) {
    return requestBoundCard(bus, target, intent, history, authority(target.threadId));
  }
  function resolveConnectorAction(bus: ConnectorGateBus, requestId: string, behavior: string) {
    return resolveBoundAction(bus, requestId, behavior, scope());
  }


  beforeEach(() => {
    store = new Store(selection);
    bot = store.patchBot(store.createBot().id, { name: "Connector Bot", ownerId: "owner-A" })!;
    bus = { store };
    active = true;
  });

  afterEach(() => {
    for (const entry of store.bots) cancelConnectorApprovalsFor(bus, entry.id);
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const openCard = () =>
    store.messagesFor(bot.threadId).find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);

  it("mints a card with toolkit, actions, redacted args — and NO always-allow key", async () => {
    const { card, decision } = requestConnectorCard(
      bus,
      bot,
      { actions: ["GMAIL_SEND_EMAIL"], toolkits: ["gmail"], argsSummary: "to, subject" },
    );
    const minted = openCard();
    expect(minted).toBeTruthy();
    expect(minted!.card!.tool).toBe("connector_call");
    expect(minted!.card!.subtitle).toContain("gmail");
    expect(minted!.card!.subtitle).toContain("GMAIL_SEND_EMAIL");
    expect(minted!.card!.subtitle).toContain("args: to, subject");
    // v1: the card never offers "always allow" (client renders that button
    // only when an allowKey is present)
    expect(minted!.card!.allowKey).toBeUndefined();

    resolveConnectorAction(bus, card.requestId, "allow");
    expect(await decision).toBe("allow");
    const settled = store.messagesFor(bot.threadId).find((m) => m.id === card.messageId);
    expect(settled?.card?.answered).toBe("allow");
    expect(settled?.card?.dismissed).toBe(false);
    expect(openCard()).toBeUndefined();
  });

  it("a deny resolves the hold and settles the card", async () => {
    const { card, decision } = requestConnectorCard(bus, bot, { actions: ["SLACK_POST_MESSAGE"], toolkits: ["slack"], argsSummary: "" });
    const minted = openCard()!;
    resolveConnectorAction(bus, minted.card!.requestId!, "deny");
    expect(await decision).toBe("deny");
    expect(store.messagesFor(bot.threadId).find((m) => m.id === card.messageId)?.card?.answered).toBe("deny");
  });

  it("times out denied after 10 minutes, dismissing the card", async () => {
    vi.useFakeTimers();
    const { decision } = requestConnectorCard(bus, bot, { actions: ["GMAIL_SEND_EMAIL"], toolkits: ["gmail"], argsSummary: "" });
    expect(openCard()).toBeTruthy();
    vi.advanceTimersByTime(CONNECTOR_DENY_TIMEOUT_MS);
    expect(await decision).toBe("deny");
    const settled = [...store.messagesFor(bot.threadId)].find((m) => m.kind === "options" && m.card?.answered === "deny" && m.card?.dismissed === true);
    expect(settled).toBeTruthy();
  });

  it("records the verdict to the decision ledger once", async () => {
    const recorded: Array<{ botId: string; action: string; decision: string }> = [];
    const ledger: ConnectorGateBus = { store, recordDecision: (entry) => recorded.push(entry) };
    const { card, decision } = requestConnectorCard(ledger, bot, { actions: ["GMAIL_SEND_EMAIL"], toolkits: ["gmail"], argsSummary: "" });
    resolveConnectorAction(ledger, card.requestId, "allow");
    await decision;
    expect(recorded).toEqual([
      { botId: bot.id, action: "GMAIL_SEND_EMAIL", decision: "approved", summary: expect.any(String) },
    ]);
  });

  it("a retry of the same call replaces the pending card instead of nesting", async () => {
    const first = requestConnectorCard(bus, bot, { actions: ["GMAIL_SEND_EMAIL"], toolkits: ["gmail"], argsSummary: "" });
    const firstCard = openCard()!;
    const retry = requestConnectorCard(bus, bot, { actions: ["GMAIL_SEND_EMAIL"], toolkits: ["gmail"], argsSummary: "" });
    // the superseded first hold resolves denied; the retry stays open and settles on its own answer
    expect(await first.decision).toBe("deny");
    expect(store.messagesFor(bot.threadId).find((m) => m.id === firstCard.id)?.card?.answered).toBe("superseded");
    expect(openCard()?.id).toBe(retry.card.messageId);
    resolveConnectorAction(bus, retry.card.requestId, "allow");
    expect(await retry.decision).toBe("allow");
  });

  it("cancel settles open cards of a deleted bot so its hold answers", async () => {
    const { decision } = requestConnectorCard(bus, bot, { actions: ["GMAIL_SEND_EMAIL"], toolkits: ["gmail"], argsSummary: "" });
    expect(openCard()).toBeTruthy();
    cancelConnectorApprovalsFor(bus, bot.id);
    expect(await decision).toBe("deny");
    expect(openCard()).toBeUndefined();
  });

  const writeIntent = () => ({ actions: ["GMAIL_SEND_EMAIL"], toolkits: ["gmail"], argsSummary: "" });
  it("does not consume a card through a different bot, thread, owner or Store", async () => {
    const held = requestConnectorCard(bus, bot, writeIntent());
    for (const other of [{ ...scope(), botId: "foreign" }, { ...scope(), threadId: "foreign" }, { ...scope(), ownerId: "foreign" }]) {
      expect(resolveBoundAction(bus, held.card.requestId, "allow", other)).toBe(false);
      expect(openCard()).toBeTruthy();
    }
    const otherStore = new Store(selection);
    expect(resolveBoundAction({ store: otherStore }, held.card.requestId, "allow", scope())).toBe(false);
    expect(resolveConnectorAction(bus, held.card.requestId, "allow")).toBe(true);
    expect(await held.decision).toBe("allow");
  });
  it("denies an answer after the dispatch lease changed", async () => {
    const held = requestConnectorCard(bus, bot, writeIntent());
    active = false;
    expect(resolveConnectorAction(bus, held.card.requestId, "allow")).toBe(true);
    expect(await held.decision).toBe("deny");
  });
  it("denies an answer after the resource owner changed", async () => {
    const held = requestConnectorCard(bus, bot, writeIntent());
    store.patchBot(bot.id, { ownerId: "owner-B" });
    resolveConnectorAction(bus, held.card.requestId, "allow");
    expect(await held.decision).toBe("deny");
  });
  it("abort immediately settles a held card and blocks a later Allow", async () => {
    const abort = new AbortController();
    const held = requestBoundCard(bus, bot, writeIntent(), undefined, { ...authority(), signal: abort.signal });
    abort.abort();
    expect(await held.decision).toBe("deny");
    expect(resolveConnectorAction(bus, held.card.requestId, "allow")).toBe(false);
    expect(openCard()).toBeUndefined();
  });
  it("mints and resolves in the actual task conversation", async () => {
    const task = store.createTask(bot.id, "Owned task", false)!;
    const target = { id: bot.id, threadId: task.threadId };
    const before = structuredClone(store.messagesFor(bot.threadId));
    const held = requestConnectorCard(bus, target, writeIntent());
    expect(store.messagesFor(task.threadId).find(m => m.id === held.card.messageId)).toBeTruthy();
    expect(store.messagesFor(bot.threadId)).toEqual(before);
    expect(resolveBoundAction(bus, held.card.requestId, "allow", scope())).toBe(false);
    expect(resolveBoundAction(bus, held.card.requestId, "allow", scope(task.threadId))).toBe(true);
    expect(await held.decision).toBe("allow");
  });
  it("mints in the room and denies if membership is removed before answer", async () => {
    const room = store.createGroup("Owned room", [bot.id], false, "owner-A");
    const held = requestConnectorCard(bus, { id: bot.id, threadId: room.threadId }, writeIntent());
    expect(store.messagesFor(room.threadId).find(m => m.id === held.card.messageId)).toBeTruthy();
    room.memberIds = [];
    resolveBoundAction(bus, held.card.requestId, "allow", scope(room.threadId));
    expect(await held.decision).toBe("deny");
  });
  it("checks authority after the append event barrier", async () => {
    const off = store.onChange(change => { if (change.type === "message") active = false; });
    const held = requestConnectorCard(bus, bot, writeIntent());
    off();
    expect(await held.decision).toBe("deny");
    expect(openCard()).toBeUndefined();
  });
  it("checks authority after the answer patch event barrier", async () => {
    const held = requestConnectorCard(bus, bot, writeIntent());
    const off = store.onChange(change => { if (change.type === "message.patch") active = false; });
    resolveConnectorAction(bus, held.card.requestId, "allow");
    off();
    expect(await held.decision).toBe("deny");
    expect(store.messagesFor(bot.threadId).find(m => m.id === held.card.messageId)?.card?.answered).toBe("deny");
  });
  it("refuses oversized inventory before appending any card", () => {
    const before = structuredClone(store.messagesFor(bot.threadId));
    expect(() => requestConnectorCard(bus, bot, { ...writeIntent(), actions: Array.from({ length: 13 }, () => "GMAIL_SEND_EMAIL") })).toThrow();
    expect(store.messagesFor(bot.threadId)).toEqual(before);
  });
  it("refuses Allow after its actual card was independently dismissed", async () => {
    const held = requestConnectorCard(bus, bot, writeIntent());
    const message = store.messagesFor(bot.threadId).find(m => m.id === held.card.messageId)!;
    store.patchMessage(bot.threadId, message.id, { card: { ...message.card!, answered: "deny", dismissed: true } });
    resolveConnectorAction(bus, held.card.requestId, "allow");
    expect(await held.decision).toBe("deny");
  });
  it("refuses Allow when the displayed consent inventory no longer matches", async () => {
    const held = requestConnectorCard(bus, bot, writeIntent());
    const message = store.messagesFor(bot.threadId).find(m => m.id === held.card.messageId)!;
    store.patchMessage(bot.threadId, message.id, { card: { ...message.card!, subtitle: "different action" } });
    resolveConnectorAction(bus, held.card.requestId, "allow");
    expect(await held.decision).toBe("deny");
  });
  it("refuses Allow after the answer event barrier changes its displayed consent", async () => {
    const held = requestConnectorCard(bus, bot, writeIntent());
    let changed = false;
    const off = store.onChange(change => {
      if (change.type !== "message.patch" || changed) return;
      changed = true;
      const message = store.messagesFor(bot.threadId).find(m => m.id === held.card.messageId)!;
      store.patchMessage(bot.threadId, message.id, { card: { ...message.card!, subtitle: "different action" } });
    });
    resolveConnectorAction(bus, held.card.requestId, "allow");
    off();
    expect(await held.decision).toBe("deny");
  });

  it("copies the full action inventory so caller mutation cannot change consent", async () => {
    const input = writeIntent();
    const held = requestConnectorCard(bus, bot, input);
    input.actions.push("SLACK_POST_MESSAGE");
    expect(held.card.actions).toEqual(["GMAIL_SEND_EMAIL"]);
    resolveConnectorAction(bus, held.card.requestId, "allow");
    expect(await held.decision).toBe("allow");
  });
  it("refuses missing, already aborted or foreign conversation authority", () => {
    const before = structuredClone(store.messagesFor(bot.threadId));
    const abort = new AbortController(); abort.abort();
    expect(() => requestBoundCard(bus, bot, writeIntent())).toThrow();
    expect(() => requestBoundCard(bus, bot, writeIntent(), undefined, { ...authority(), signal: abort.signal })).toThrow();
    expect(() => requestConnectorCard(bus, { id: bot.id, threadId: "foreign" }, writeIntent())).toThrow();
    expect(store.messagesFor(bot.threadId)).toEqual(before);
  });

  it("settles orphaned cards of a previous run at boot", () => {
    store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Approval needed",
        subtitle: "connected apps (gmail) — GMAIL_SEND_EMAIL",
        options: ["Allow", "Deny"],
        requestId: "old-run-request-id",
        tool: "connector_call",
      },
    });
    expect(dismissStaleConnectorCards(bus)).toBe(1);
    const settled = store.messagesFor(bot.threadId).find((m) => m.card?.requestId === "old-run-request-id");
    expect(settled?.card?.answered).toBe("deny");
    expect(settled?.card?.dismissed).toBe(true);
    // settled cards are never re-settled
    expect(dismissStaleConnectorCards(bus)).toBe(0);
  });
});
