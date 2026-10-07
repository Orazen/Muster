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
  requestConnectorCard,
  resolveConnectorAction,
  type ConnectorGateBus,
} from "./connector-gate.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("connector action classification (deny-by-default)", () => {
  it("reads only allowlisted verbs; everything else is a write", () => {
    for (const slug of [
      "GMAIL_GET_EMAIL", "GMAIL_LIST_EMAILS", "SLACK_SEARCH_MESSAGES", "GOOGLEDRIVE_FETCH_FILE",
      "GITHUB_FIND_REPOSITORY", "MAIL_READ_MESSAGE", "CRM_RETRIEVE_CONTACT", "TMP_TOOLS_SEARCH",
    ]) {
      expect(classifyConnectorAction(slug), slug).toBe("read");
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

  it("an all-read batch passes", () => {
    expect(connectorGateIntent("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: "GMAIL_LIST_EMAILS" }, "SLACK_SEARCH_MESSAGES"],
    })).toEqual({ kind: "read" });
  });

  it("a batch with no usable slugs is a write (fail-closed)", () => {
    const intent = connectorGateIntent("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] });
    expect(intent.kind).toBe("write");
  });

  it("treats other tool names as their own action; an action argument wins", () => {
    expect(connectorGateIntent("GMAIL_LIST_EMAILS", {})).toEqual({ kind: "read" });
    const intent = connectorGateIntent("SOME_META_TOOL", { action: "GMAIL_SEND_EMAIL" });
    expect(intent).toMatchObject({ kind: "write", actions: ["GMAIL_SEND_EMAIL"] });
  });

  it("redacts argument values — names only", () => {
    expect(redactArguments({ to: "victim@example.com", subject: "password" })).toBe("to, subject");
    expect(redactArguments([1, 2, 3])).toBe("");
    expect(redactArguments(null)).toBe("");
  });
});

describe("connector approval card lifecycle", () => {
  let store: Store;
  let bus: ConnectorGateBus;
  let bot: BotRecord;

  beforeEach(() => {
    store = new Store(selection);
    bot = store.patchBot(store.createBot().id, { name: "Connector Bot" })!;
    bus = { store };
  });

  afterEach(() => {
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
