import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverChat, downloadBundle, pushBundle, resolveLatestFileId, verifyBot } from "./telegram-sync.ts";

// BotFather-shaped token: digits, colon, 30+ hash characters. Bad shapes are
// rejected before any request is built (the token is interpolated into the
// URL path, so a URL-shaped token could smuggle another host).
const TOKEN = "1234567890:AAAAccccccccccccccccccccccccccccccc";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("telegram-sync", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects a token that could smuggle another host before any request", async () => {
    for (const bad of ["https://evil.example/bot123", "123:short", "abc1234567:AAAAccccccccccccccccccccccccccccccc"]) {
      await expect(verifyBot(bad)).rejects.toThrow(/BotFather/);
    }
    // SAFETY: fetch is a vi.fn() here; mock.calls exists on every mock.
    expect((global.fetch as any).mock.calls).toHaveLength(0);
  });

  it("verifyBot reads the bot username from getMe", async () => {
    // SAFETY: fetch is replaced by a vi.fn() mock; only mockResolvedValue
    // exists on the double.
    (global.fetch as any).mockResolvedValue(jsonResponse({ ok: true, result: { username: "muster_sync_bot" } }));
    await expect(verifyBot(TOKEN)).resolves.toBe("muster_sync_bot");
    const url = (global.fetch as any).mock.calls[0][0] as string;
    expect(url.startsWith("https://api.telegram.org/bot")).toBe(true);
    expect(url.endsWith("/getMe")).toBe(true);
  });

  it("discoverChat finds the /start chat and confirms the update queue", async () => {
    (global.fetch as any).mockResolvedValue(
      jsonResponse({
        ok: true,
        result: [
          { update_id: 7, message: { chat: { id: 42, first_name: "Tarun" } } },
          { update_id: 8, message: { chat: { id: 42, first_name: "Tarun" } } },
        ],
      }),
    );
    await expect(discoverChat(TOKEN)).resolves.toEqual({ chatId: 42, label: "Tarun" });
    const confirmUrl = (global.fetch as any).mock.calls[1][0] as string;
    expect(confirmUrl.endsWith("/getUpdates?offset=9")).toBe(true);
  });

  it("discoverChat refuses when the owner has not messaged the bot yet", async () => {
    (global.fetch as any).mockResolvedValue(jsonResponse({ ok: true, result: [] }));
    await expect(discoverChat(TOKEN)).rejects.toThrow(/\/start/);
  });

  it("pushBundle uploads the bundle as muster-workspace.enc and returns the file_id", async () => {
    (global.fetch as any).mockResolvedValue(jsonResponse({ ok: true, result: { document: { file_id: "F1LE" } } }));
    const payload = "muster-workspace-bundle:1:salt:iv:tag:cipher";
    await expect(pushBundle(TOKEN, 42, payload)).resolves.toBe("F1LE");
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url.endsWith("/sendDocument")).toBe(true);
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("chat_id")).toBe("42");
    const doc = form.get("document") as File;
    expect(doc.name).toBe("muster-workspace.enc");
    await expect(doc.text()).resolves.toBe(payload);
  });

  it("resolveLatestFileId prefers the connected chat's newest document", async () => {
    (global.fetch as any).mockResolvedValue(
      jsonResponse({
        ok: true,
        result: [
          { update_id: 1, message: { chat: { id: 99 }, document: { file_id: "WRONG" } } },
          { update_id: 2, message: { chat: { id: 42 }, document: { file_id: "RIGHT" } } },
        ],
      }),
    );
    await expect(resolveLatestFileId(TOKEN, 42)).resolves.toBe("RIGHT");
  });

  it("downloadBundle resolves getFile then fetches the file from the fixed host", async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "documents/file_9.enc" } }))
      .mockResolvedValueOnce(new Response("muster-workspace-bundle:1:salt:iv:tag:cipher", { status: 200 }));
    await expect(downloadBundle(TOKEN, "F1LE")).resolves.toBe("muster-workspace-bundle:1:salt:iv:tag:cipher");
    const [metaUrl, metaInit] = (global.fetch as any).mock.calls[0];
    expect(metaUrl.endsWith("/getFile")).toBe(true);
    expect(JSON.parse(metaInit.body)).toEqual({ file_id: "F1LE" });
    const binUrl = (global.fetch as any).mock.calls[1][0] as string;
    expect(binUrl).toBe(`https://api.telegram.org/file/bot${TOKEN}/documents/file_9.enc`);
  });

  it("downloadBundle refuses a file_path that escapes the download tree", async () => {
    (global.fetch as any).mockResolvedValue(jsonResponse({ ok: true, result: { file_path: "documents/../../etc/passwd" } }));
    await expect(downloadBundle(TOKEN, "F1LE")).rejects.toThrow(/unexpected file path/);
    expect((global.fetch as any).mock.calls).toHaveLength(1);
  });

  it("surfaces Telegram errors including the 429 rate-limit hint", async () => {
    (global.fetch as any).mockResolvedValue(jsonResponse({ ok: false, description: "Too Many Requests: retry after 30" }, 429));
    await expect(pushBundle(TOKEN, 42, "payload")).rejects.toThrow(/rate limit/);
  });
});
