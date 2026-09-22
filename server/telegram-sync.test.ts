import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  discoverChat, downloadBundle, parseChatUpdates, pollChatUpdates, pushBundle, resolveLatestFileId, sendChatText,
  telegramConnectionMatches, telegramFileIdAfterConnect, telegramRestoreConnectionMatches, verifyBot,
} from "./telegram-sync.ts";
import type { TelegramFileBinding } from "./telegram-sync.ts";

// Random, offline BotFather-shaped fixture; every request is mocked.
const TOKEN = `1234567890:${randomBytes(24).toString("base64url")}`;

interface UpdateFixture {
  update_id?: number;
  message?: {
    chat: { id: number; title?: string; username?: string; first_name?: string };
    document?: { file_id: string; file_name?: string };
  };
}

type MethodResultFixture =
  | { username?: string }
  | UpdateFixture[]
  | { document: { file_id: string } }
  | { file_path: string };

interface ResponseFixture {
  ok: boolean;
  description?: string;
  error_code?: number;
  result?: MethodResultFixture;
}

function jsonResponse(body: ResponseFixture, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("telegram-sync", () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset().mockRejectedValue(new Error("Unexpected Telegram fixture request"));
    global.fetch = fetchMock;
  });
  afterEach(() => { global.fetch = originalFetch; });

  it("rejects a token that could smuggle another host before any request", async () => {
    for (const bad of ["https://evil.example/bot123", "123:short", `abc${TOKEN}`]) {
      await expect(verifyBot(bad)).rejects.toThrow(/BotFather/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the getMe result while validating the shared envelope", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { username: "fixture_bot" } }));
    await expect(verifyBot(TOKEN)).resolves.toBe("fixture_bot");
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it("discovers the latest chat and confirms the update queue", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        ok: true, result: [
          { update_id: 7, message: { chat: { id: 99, first_name: "Older" } } },
          { update_id: 8, message: { chat: { id: 42, first_name: "Fixture" } } },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: [] }));
    await expect(discoverChat(TOKEN)).resolves.toEqual({ chatId: 42, label: "Fixture" });
    expect(fetchMock.mock.calls[1][0]).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=9`);
  });

  it("keeps discovery successful when the best-effort acknowledgement fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        ok: true, result: [{ update_id: 8, message: { chat: { id: 42, title: "Fixture" } } }],
      }))
      .mockRejectedValueOnce(new Error("fixture acknowledgement unavailable"));
    await expect(discoverChat(TOKEN)).resolves.toEqual({ chatId: 42, label: "Fixture" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a valid empty update list from unreadable provider data", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: [] }));
    await expect(discoverChat(TOKEN)).rejects.toThrow(/\/start/);
  });

  it("uploads the exact bundle document and retains the returned file ID", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { document: { file_id: "FILE" } } }));
    const payload = "muster-workspace-bundle:1:salt:iv:tag:cipher";
    await expect(pushBundle(TOKEN, 42, payload)).resolves.toBe("FILE");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendDocument`);
    expect(init?.method).toBe("POST");
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error("Expected upload FormData");
    expect(form.get("chat_id")).toBe("42");
    const document = form.get("document");
    if (!(document instanceof File)) throw new Error("Expected upload file");
    expect(document.name).toBe("muster-workspace.enc");
    await expect(document.text()).resolves.toBe(payload);
  });

  it("uses the connected chat's newest document despite a newer other-chat document", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true, result: [
        { update_id: 1, message: { chat: { id: 42 }, document: { file_id: "OLD" } } },
        { update_id: 2, message: { chat: { id: 42 }, document: { file_id: "RIGHT" } } },
        { update_id: 3, message: { chat: { id: 99 }, document: { file_id: "OTHER" } } },
      ],
    }));
    await expect(resolveLatestFileId(TOKEN, 42)).resolves.toBe("RIGHT");
  });

  it("never falls back to another chat when the connected chat has no document", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true, result: [
        { update_id: 1, message: { chat: { id: 42 } } },
        { update_id: 2, message: { chat: { id: 99 }, document: { file_id: "OTHER" } } },
      ],
    }));
    await expect(resolveLatestFileId(TOKEN, 42)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains the existing explicit null-chat recent-document discovery mode", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true, result: [
        { update_id: 1, message: { chat: { id: 42 }, document: { file_id: "OLDER" } } },
        { update_id: 2, message: { chat: { id: 99 }, document: { file_id: "NEWEST" } } },
      ],
    }));
    await expect(resolveLatestFileId(TOKEN, null)).resolves.toBe("NEWEST");
  });

  it("resolves getFile metadata then downloads the payload from the fixed host", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "documents/file_9.enc" } }))
      .mockResolvedValueOnce(new Response("fixture encrypted bundle", { status: 200 }));
    await expect(downloadBundle(TOKEN, "FILE")).resolves.toBe("fixture encrypted bundle");
    const [metaUrl, metaInit] = fetchMock.mock.calls[0];
    expect(metaUrl).toBe(`https://api.telegram.org/bot${TOKEN}/getFile`);
    const body = z.object({ file_id: z.string() }).parse(JSON.parse(z.string().parse(metaInit?.body)));
    expect(body.file_id).toBe("FILE");
    expect(fetchMock.mock.calls[1][0]).toBe(`https://api.telegram.org/file/bot${TOKEN}/documents/file_9.enc`);
  });

  it("rejects a file path that escapes the download tree before downloading", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "documents/../../etc/passwd" } }));
    await expect(downloadBundle(TOKEN, "FILE")).rejects.toThrow(/unexpected file path/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects binary download HTTP failure after valid metadata", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "documents/file.enc" } }))
      .mockResolvedValueOnce(new Response("fixture unavailable", { status: 503 }));
    await expect(downloadBundle(TOKEN, "FILE")).rejects.toThrow("Telegram download failed: HTTP 503");
  });

  const methods = [
    { name: "getMe", call: () => verifyBot(TOKEN), result: { username: "fixture" } },
    { name: "getUpdates", call: () => resolveLatestFileId(TOKEN, 42), result: [] },
    { name: "sendDocument", call: () => pushBundle(TOKEN, 42, "fixture"), result: { document: { file_id: "FILE" } } },
    { name: "getFile", call: () => downloadBundle(TOKEN, "FILE"), result: { file_path: "documents/file.enc" } },
  ] satisfies Array<{ name: string; call: () => Promise<string | null>; result: MethodResultFixture }>;

  it.each(methods)("$name rejects HTTP failure even when the envelope says ok", async ({ call, result }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true, description: "fixture service unavailable", result,
    }, 503));
    await expect(call()).rejects.toThrow("HTTP 503 — fixture service unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(methods)("$name preserves provider errors even with HTTP 200", async ({ call }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: false, error_code: 429, description: "retry after 30",
    }));
    await expect(call()).rejects.toThrow(
      "HTTP 200 (Telegram code 429) (Telegram rate limit — wait a minute and try again) — retry after 30",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(methods)("$name rejects a successful envelope missing its result", async ({ call }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(call()).rejects.toThrow(/unreadable/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["{broken", "null", "[]", '{"ok":"true","result":{}}'])(
    "rejects malformed JSON/envelope %s",
    async (raw) => {
      fetchMock.mockResolvedValueOnce(new Response(raw, { status: 200 }));
      await expect(verifyBot(TOKEN)).rejects.toThrow(/unreadable/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { name: "getMe", call: () => verifyBot(TOKEN), raw: '{"ok":true,"result":{"username":123}}' },
    { name: "getUpdates", call: () => resolveLatestFileId(TOKEN, 42), raw: '{"ok":true,"result":[{"message":{"chat":{"id":"42"}}}]}' },
    { name: "sendDocument", call: () => pushBundle(TOKEN, 42, "fixture"), raw: '{"ok":true,"result":{"document":{"file_id":42}}}' },
    { name: "getFile", call: () => downloadBundle(TOKEN, "FILE"), raw: '{"ok":true,"result":{"file_path":123}}' },
  ])("$name rejects malformed method data without returning empty success", async ({ call, raw }) => {
    fetchMock.mockResolvedValueOnce(new Response(raw, { status: 200 }));
    await expect(call()).rejects.toThrow(/unreadable/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains the HTTP rate-limit hint when the provider response is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("service overloaded", { status: 429 }));
    await expect(verifyBot(TOKEN)).rejects.toThrow("HTTP 429 (Telegram rate limit — wait a minute and try again)");
  });

  const connectionChanges: Array<{
    name: string;
    next: TelegramFileBinding | undefined;
    mayCache: boolean;
  }> = [
    { name: "unchanged bot and chat without a previous file", next: { botToken: TOKEN, chatId: 42 }, mayCache: true },
    { name: "changed bot", next: { botToken: `9876543210:${randomBytes(24).toString("base64url")}`, chatId: 42 }, mayCache: false },
    { name: "changed chat", next: { botToken: TOKEN, chatId: 99 }, mayCache: false },
    { name: "missing binding", next: undefined, mayCache: false },
    { name: "disconnected binding", next: { botToken: "", chatId: 0, lastFileId: "" }, mayCache: false },
  ];

  it.each(connectionChanges)("checks $name when an upload finishes after the connection changes", async ({ next, mayCache }) => {
    let completeUpload: (response: Response) => void = () => { throw new Error("Upload fixture not initialized"); };
    const pendingResponse = new Promise<Response>((resolve) => { completeUpload = resolve; });
    fetchMock.mockReturnValueOnce(pendingResponse);
    let binding: TelegramFileBinding | undefined = { botToken: TOKEN, chatId: 42 };
    const capturedToken = binding.botToken ?? "";
    const capturedChat = binding.chatId ?? 0;
    const upload = pushBundle(capturedToken, capturedChat, "fixture encrypted bundle");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    binding = next;
    completeUpload(jsonResponse({ ok: true, result: { document: { file_id: "LATE_FILE" } } }));
    const uploadedFileId = await upload;
    // The route uses this post-await predicate immediately before saving.
    expect(uploadedFileId).toBe("LATE_FILE");
    expect(telegramConnectionMatches(binding, capturedToken, capturedChat)).toBe(mayCache);
  });

  const restoreChanges: Array<{
    name: string;
    capturedChat: number | null;
    next: TelegramFileBinding | undefined;
    mayRestore: boolean;
  }> = [
    { name: "unchanged connected chat", capturedChat: 42, next: { botToken: TOKEN, chatId: 42 }, mayRestore: true },
    { name: "unchanged null-chat discovery", capturedChat: null, next: { botToken: TOKEN }, mayRestore: true },
    { name: "changed bot", capturedChat: 42, next: { botToken: `9876543210:${randomBytes(24).toString("base64url")}`, chatId: 42 }, mayRestore: false },
    { name: "changed chat", capturedChat: 42, next: { botToken: TOKEN, chatId: 99 }, mayRestore: false },
    { name: "new binding during null-chat discovery", capturedChat: null, next: { botToken: TOKEN, chatId: 42 }, mayRestore: false },
    { name: "removed chat binding", capturedChat: 42, next: { botToken: TOKEN }, mayRestore: false },
    { name: "missing connection", capturedChat: 42, next: undefined, mayRestore: false },
    { name: "disconnected connection", capturedChat: null, next: { botToken: "", chatId: 0 }, mayRestore: false },
  ];

  it.each(restoreChanges)("guards the restore callback after a delayed download: $name", async ({ capturedChat, next, mayRestore }) => {
    let completeDownload: (response: Response) => void = () => { throw new Error("Download fixture not initialized"); };
    const pendingResponse = new Promise<Response>((resolve) => { completeDownload = resolve; });
    let markDownloadStarted: () => void = () => { throw new Error("Download signal not initialized"); };
    const downloadStarted = new Promise<void>((resolve) => { markDownloadStarted = resolve; });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "documents/file.enc" } }))
      .mockImplementationOnce(() => { markDownloadStarted(); return pendingResponse; });
    let binding: TelegramFileBinding | undefined = { botToken: TOKEN, chatId: capturedChat ?? undefined };
    const restoreEffect = vi.fn<(payload: string) => void>();
    // Consumer fixture exercises the guard at the restore boundary; it does
    // not invoke the workspace restore implementation or mutate user data.
    const guardedDownload = downloadBundle(TOKEN, "FILE").then((payload) => {
      if (telegramRestoreConnectionMatches(binding, TOKEN, capturedChat)) restoreEffect(payload);
    });
    await downloadStarted;
    expect(restoreEffect).not.toHaveBeenCalled();
    binding = next;
    completeDownload(new Response("fixture encrypted bundle", { status: 200 }));
    await guardedDownload;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(restoreEffect).toHaveBeenCalledTimes(mayRestore ? 1 : 0);
    if (mayRestore) expect(restoreEffect).toHaveBeenCalledWith("fixture encrypted bundle");
  });
});

describe("telegramConnectionMatches", () => {
  it("accepts a complete group-chat binding without a cached file", () => {
    expect(telegramConnectionMatches({ botToken: TOKEN, chatId: -10042 }, TOKEN, -10042)).toBe(true);
  });

  it.each([
    { botToken: "", chatId: 42 },
    { botToken: "invalid-token", chatId: 42 },
    { botToken: TOKEN, chatId: 0 },
    { botToken: TOKEN, chatId: 42.5 },
    { botToken: TOKEN, chatId: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects an invalid binding even if its values match: %j", (binding) => {
    expect(telegramConnectionMatches(binding, binding.botToken, binding.chatId)).toBe(false);
  });
});

describe("telegramRestoreConnectionMatches", () => {
  it.each([0, 42.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid matching chat ID %s", (chatId) => {
    expect(telegramRestoreConnectionMatches({ botToken: TOKEN, chatId }, TOKEN, chatId)).toBe(false);
  });

  it("does not treat a zero chat ID as null-chat discovery", () => {
    expect(telegramRestoreConnectionMatches({ botToken: TOKEN, chatId: 0 }, TOKEN, null)).toBe(false);
  });

  it("rejects matching invalid tokens even with no chat binding", () => {
    expect(telegramRestoreConnectionMatches({ botToken: "invalid" }, "invalid", null)).toBe(false);
  });
});

describe("telegramFileIdAfterConnect", () => {
  const current = { botToken: TOKEN, chatId: 42, lastFileId: "PERSISTED_FILE" };

  it("preserves same-bot same-chat cached files beyond recent update discovery", () => {
    expect(telegramFileIdAfterConnect(current, TOKEN, 42)).toBe("PERSISTED_FILE");
  });

  it("clears a cached file when the bot token changes", () => {
    const otherToken = `9876543210:${randomBytes(24).toString("base64url")}`;
    expect(telegramFileIdAfterConnect(current, otherToken, 42)).toBe("");
  });

  it("clears a cached file when the connected chat changes", () => {
    expect(telegramFileIdAfterConnect(current, TOKEN, 99)).toBe("");
  });

  it.each([
    undefined, {}, { lastFileId: "ORPHAN" }, { botToken: TOKEN, lastFileId: "ORPHAN" },
    { chatId: 42, lastFileId: "ORPHAN" },
  ])("does not preserve cached files without a complete prior binding: %j", (binding) => {
    expect(telegramFileIdAfterConnect(binding, TOKEN, 42)).toBe("");
  });
});

describe("chat channel primitives", () => {
  const originalFetch = global.fetch;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset().mockRejectedValue(new Error("Unexpected Telegram fixture request"));
    global.fetch = fetchMock;
  });
  afterEach(() => { global.fetch = originalFetch; });

  it("parses text updates with sender + chat id, dropping empty and non-text updates", () => {
    const updates = parseChatUpdates({
      ok: true,
      result: [
        { update_id: 10, message: { chat: { id: 700, username: "tr", first_name: "Tharun" }, text: "  hi  " } },
        { update_id: 11, message: { chat: { id: 700 }, text: "   " } },
        { update_id: 12, message: { chat: { id: 700 }, document: { file_id: "f" } } },
        { update_id: 13 },
      ],
    });
    expect(updates).toEqual([
      { chatId: 700, from: "tr", text: "hi", updateId: 10 },
    ]);
  });

  it("prefers chat title over username over first name as the sender label", () => {
    const updates = parseChatUpdates({
      ok: true,
      result: [{ update_id: 1, message: { chat: { id: 5, title: "Ops", username: "tr", first_name: "T" }, text: "x" } }],
    });
    expect(updates[0].from).toBe("Ops");
  });

  it("yields nothing for malformed provider payloads", () => {
    expect(parseChatUpdates(null)).toEqual([]);
    expect(parseChatUpdates({ ok: false })).toEqual([]);
    expect(parseChatUpdates({ ok: true, result: "nope" })).toEqual([]);
  });

  it("sends a message through the Bot API and returns the message id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 9 } }));
    await expect(sendChatText(TOKEN, 700, "Job done")).resolves.toBe(9);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(init?.body))).toEqual({ chat_id: 700, text: "Job done" });
  });

  it("rejects when the send fails (caller decides how to surface it)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, description: "chat not found" }, 400));
    await expect(sendChatText(TOKEN, 700, "x")).rejects.toThrow("Telegram message send failed");
  });

  it("polls getUpdates with the offset for acknowledgement, no long-poll hang", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: [{ update_id: 41, message: { chat: { id: 700, username: "tr" }, text: "run" } }],
    }));
    await expect(pollChatUpdates(TOKEN, 40)).resolves.toEqual([
      { chatId: 700, from: "tr", text: "run", updateId: 41 },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(JSON.parse(String(init?.body))).toEqual({ offset: 40, timeout: 0 });
  });

  it("lets poll transport failures reject (the loop catches per tick)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(pollChatUpdates(TOKEN, 0)).rejects.toThrow("offline");
  });
});
