import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleVisibleDriveClient, type GoogleVisibleDriveClient } from "./drive-visible-google-client.ts";
import { acquireVisibleAccess, VisibleAccessError, type VisibleAccessLease } from "./drive-visible-access.ts";
import { createVisibleConsentState, consumeVisibleConsentState, revokeVisibleGrant, saveVisibleGrant, VISIBLE_FILE_SCOPE } from "./drive-visible-grants.ts";
import { VisibleTokenProtector } from "./drive-visible-token-protection.ts";
import { FOLDER_MIME, writeVisibleFiles } from "./drive-visible.ts";
import { produceVisibleFiles } from "./drive-visible-producers.ts";

const token = "SYNTHETIC-VISIBLE-TOKEN";
const file = (id = "file-id", name = "settings.json", mimeType = "application/json") => ({ id, name, parents: ["parent-id"], mimeType });
const checksum = (bytes: Buffer): string => createHash("md5").update(bytes).digest("hex");
const metadata = (bytes: Buffer) => new Response(JSON.stringify({ ...file(), size: String(bytes.length), md5Checksum: checksum(bytes), capabilities: { canDownload: true } }));
const media = (bytes: Buffer) => new Response(new Uint8Array(bytes).buffer);
const page = (files: ReturnType<typeof file>[], nextPageToken?: string, incompleteSearch?: boolean) => new Response(JSON.stringify({ files, nextPageToken, incompleteSearch }));
const statuses: { status: number; reason: string; failure: string }[] = [
  { status: 401, reason: "", failure: "unauthorized" }, { status: 404, reason: "", failure: "missing" },
  { status: 429, reason: "", failure: "rate-limited" }, { status: 500, reason: "", failure: "server" },
  { status: 403, reason: "rateLimitExceeded", failure: "rate-limited" },
  { status: 403, reason: "storageQuotaExceeded", failure: "quota" }, { status: 403, reason: "insufficientFilePermissions", failure: "forbidden" },
];

describe("bounded lease-bound Google Drive client", () => {
  let active: boolean;
  let lease: VisibleAccessLease;
  let calls: { url: URL; init: RequestInit }[];
  let reply: (url: URL, init: RequestInit) => Promise<Response>;
  let transport: typeof globalThis.fetch;
  let client: GoogleVisibleDriveClient;
  beforeEach(() => {
    active = true; calls = [];
    const assertCurrent = () => { if (!active) throw new VisibleAccessError("grant-changed"); };
    lease = { googleSub: "google-sub", assertCurrent,
      async run<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
        assertCurrent(); const result = await operation(token); assertCurrent(); return result;
      },
    };
    reply = async () => page([]);
    transport = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://www.googleapis.com");
      expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      if (!init) throw new Error("Expected explicit request options");
      calls.push({ url, init }); return reply(url, init);
    });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected outbound request"); }));
    client = createGoogleVisibleDriveClient({ lease, fetch: transport });
  });
  afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("resolves the official root alias to its actual opaque parent ID", async () => {
    reply = async url => { expect(url.pathname).toBe("/drive/v3/files/root"); expect(url.search).toBe("?fields=id"); return new Response('{"id":"opaque-root-id"}'); };
    await expect(client.resolveRootId()).resolves.toBe("opaque-root-id");
    reply = async () => new Response('{"id":"root"}');
    await expect(client.resolveRootId()).rejects.toMatchObject({ failure: "corrupt" });
  });
  it("keeps exact q bytes and control fields across empty/populated pages", async () => {
    const q = "name = 'O\\'Brien' and 'parent-id' in parents and trashed = false";
    reply = async url => url.searchParams.has("pageToken") ? page([file()]) : page([], "next+token");
    expect(await client.listFiles({ q, fields: "files(id)" })).toEqual([file()]);
    expect(calls).toHaveLength(2); expect(calls[0]?.url.searchParams.get("q")).toBe(q);
    expect(calls[0]?.url.searchParams.get("fields")).toContain("nextPageToken,incompleteSearch,files(");
    expect(calls[0]?.url.searchParams.get("spaces")).toBe("drive"); expect(calls[0]?.url.searchParams.get("corpora")).toBe("user");
    expect(calls[1]?.url.searchParams.get("pageToken")).toBe("next+token");
  });
  it.each(["repeated-token", "incomplete-search", "malformed-file", "duplicate-id"])("rejects partial discovery %s", async failure => {
    reply = async () => failure === "repeated-token" ? page([], "again") : failure === "incomplete-search" ? page([], undefined, true)
      : failure === "duplicate-id" ? page([file(), file()]) : new Response('{"files":[{"id":"missing-metadata"}]}');
    await expect(client.listFiles({ q: "trashed = false" })).rejects.toMatchObject({ failure: "corrupt" });
    if (failure === "repeated-token") expect(calls).toHaveLength(2);
  });
  it("bounds pages rather than returning truncated success", async () => {
    reply = async () => page([], `token-${calls.length}`);
    await expect(client.listFiles({ q: "trashed = false" })).rejects.toMatchObject({ failure: "corrupt" }); expect(calls).toHaveLength(64);
  });
  it("bounds the total file inventory without returning a partial list", async () => {
    reply = async () => page(Array.from({ length: 1_000 }, (_, index) => file(`file-${calls.length}-${index}`)), `token-${calls.length}`);
    await expect(client.listFiles({ q: "trashed = false" })).rejects.toMatchObject({ failure: "corrupt" });
    expect(calls).toHaveLength(11);
  });
  it("rechecks custody before another page", async () => {
    reply = async () => { active = false; return page([], "next"); };
    await expect(client.listFiles({ q: "trashed = false" })).rejects.toMatchObject({ code: "grant-changed" }); expect(calls).toHaveLength(1);
  });
  it("creates only parent-scoped folder metadata", async () => {
    reply = async (_url, init) => { expect(JSON.parse(String(init.body))).toEqual({ name: "Muster", parents: ["parent-id"], mimeType: FOLDER_MIME });
      return new Response(JSON.stringify(file("folder-id", "Muster", FOLDER_MIME))); };
    expect(await client.createFolder("Muster", "parent-id")).toMatchObject({ id: "folder-id" });
    expect(calls[0]?.init.method).toBe("POST"); expect(calls[0]?.url.pathname).toBe("/drive/v3/files");
  });
  it("uploads multipart metadata and exact UTF-8 bytes with MD5 receipt", async () => {
    const bytes = Buffer.from("గుర్తింపు 🐱");
    reply = async (url, init) => {
      expect(url.pathname).toBe("/upload/drive/v3/files"); expect(url.searchParams.get("uploadType")).toBe("multipart");
      const body = Buffer.from(await new Response(init.body).arrayBuffer());
      expect(body.includes(bytes)).toBe(true); expect(body.toString()).toContain('"parents":["parent-id"]');
      expect(new Headers(init.headers).get("content-type")).toMatch(/^multipart\/related; boundary=muster-/);
      return new Response(JSON.stringify({ ...file(), md5Checksum: checksum(bytes) }));
    };
    await expect(client.createFile("settings.json", "parent-id", bytes.toString())).resolves.toMatchObject({ md5Checksum: checksum(bytes) });
  });
  it("uploads arbitrary binary octets without text conversion", async () => {
    const bytes = Buffer.from([0xff, 0, 0x80, 1]);
    reply = async (_url, init) => {
      expect(Buffer.from(await new Response(init.body).arrayBuffer()).includes(bytes)).toBe(true);
      return new Response(JSON.stringify({ ...file("file-id", "archive.enc", "application/octet-stream"), md5Checksum: checksum(bytes) }));
    };
    await expect(client.createBinaryFile("archive.enc", "parent-id", bytes)).resolves.toMatchObject({ mimeType: "application/octet-stream" });
  });
  it.each(["[]", '{"type":"Buffer","data":[255,0,128]}', '{"length":999999999}'])("rejects JSON-shaped binary input before copying or requesting %s", async malformed => {
    await expect(client.createBinaryFile("archive.enc", "parent-id", JSON.parse(malformed))).rejects.toMatchObject({ failure: "corrupt" });
    expect(calls).toHaveLength(0);
  });
  it("rejects an oversized real Buffer before copying or requesting", async () => {
    await expect(client.createBinaryFile("archive.enc", "parent-id", Buffer.alloc(24 * 1024 * 1024 + 1))).rejects.toMatchObject({ failure: "corrupt" });
    expect(calls).toHaveLength(0);
  });
  it("never retries an ambiguous failed create or echoes upstream credentials", async () => {
    reply = async () => { throw new Error(`private upstream ${token}`); };
    await expect(client.createFolder("Muster", "parent-id")).rejects.toMatchObject({ failure: "transport", message: "Visible Drive operation unavailable" }); expect(calls).toHaveLength(1);
  });
  it("refuses upload success without returned checksum", async () => {
    reply = async () => new Response(JSON.stringify(file()));
    await expect(client.createFile("settings.json", "parent-id", "body")).rejects.toMatchObject({ failure: "corrupt" });
  });
  it("fetches metadata then media and verifies raw MD5", async () => {
    const bytes = Buffer.from("Hello 🐱"); reply = async url => url.searchParams.get("alt") === "media" ? media(bytes) : metadata(bytes);
    await expect(client.getFile("file-id")).resolves.toEqual({ body: bytes.toString(), md5Checksum: checksum(bytes) });
    expect(calls).toHaveLength(2); expect(calls[0]?.url.searchParams.get("fields")).toContain("size,capabilities(canDownload)");
  });
  it.each(["checksum", "size"])("refuses torn download %s evidence", async mismatch => {
    const bytes = Buffer.from("original");
    reply = async url => url.searchParams.get("alt") === "media" ? media(Buffer.from(mismatch === "size" ? "changed-size" : "changed!")) : metadata(bytes);
    await expect(client.getFile("file-id")).rejects.toMatchObject({ failure: "corrupt" });
  });
  it("preserves binary octets but refuses invalid UTF-8 text", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0]); reply = async url => url.searchParams.get("alt") === "media" ? media(bytes) : metadata(bytes);
    await expect(client.getBinaryFile("file-id")).resolves.toEqual({ body: bytes, md5Checksum: checksum(bytes) });
    await expect(client.getFile("file-id")).rejects.toMatchObject({ failure: "corrupt" });
  });
  it.each([FOLDER_MIME, "application/vnd.google-apps.document", "application/vnd.google-apps.shortcut"])("never follows/exports %s", async mimeType => {
    reply = async () => new Response(JSON.stringify({ ...file("file-id", "file", mimeType), size: "0", md5Checksum: checksum(Buffer.alloc(0)) }));
    await expect(client.getFile("file-id")).rejects.toMatchObject({ failure: "corrupt" }); expect(calls).toHaveLength(1);
  });
  it("rejects invalid ID or lost download capability before media", async () => {
    await expect(client.getFile("../outside?token=private")).rejects.toMatchObject({ failure: "corrupt" }); expect(calls).toHaveLength(0);
    reply = async () => new Response(JSON.stringify({ ...file(), size: "0", md5Checksum: checksum(Buffer.alloc(0)), capabilities: { canDownload: false } }));
    await expect(client.getFile("file-id")).rejects.toMatchObject({ failure: "corrupt" }); expect(calls).toHaveLength(1);
  });
  it("bounds metadata during streaming without a declared length", async () => {
    reply = async () => media(Buffer.alloc(128 * 1024 + 1));
    await expect(client.listFiles({ q: "trashed = false" })).rejects.toMatchObject({ failure: "corrupt" });
  });
  it("bounds chunked media even when declared length lies", async () => {
    const claimed = Buffer.alloc(24 * 1024 * 1024);
    reply = async url => url.searchParams.get("alt") === "media" ? new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(claimed)); controller.enqueue(new Uint8Array([1])); controller.close();
    } }), { headers: { "Content-Length": "1" } }) : metadata(claimed);
    await expect(client.getBinaryFile("file-id")).rejects.toMatchObject({ failure: "corrupt" });
  });
  it("cancels a stalled body at the whole-operation deadline", async () => {
    vi.useFakeTimers(); let canceled = false;
    reply = async () => new Response(new ReadableStream({ cancel() { canceled = true; } }));
    client = createGoogleVisibleDriveClient({ lease, fetch: transport, timeoutMs: 10 });
    const pending = expect(client.listFiles({ q: "trashed = false" })).rejects.toMatchObject({ failure: "timeout" });
    await vi.advanceTimersByTimeAsync(10); await pending; expect(canceled).toBe(true);
  });
  it("refuses caller cancellation before requests", async () => {
    const controller = new AbortController(); controller.abort(); client = createGoogleVisibleDriveClient({ lease, fetch: transport, signal: controller.signal });
    await expect(client.listFiles({ q: "trashed = false" })).rejects.toMatchObject({ failure: "aborted" }); expect(calls).toHaveLength(0);
  });
  it("refuses caller cancellation during metadata completion without requesting media", async () => {
    const controller = new AbortController();
    client = createGoogleVisibleDriveClient({ lease, fetch: transport, signal: controller.signal });
    reply = async () => { controller.abort(); return metadata(Buffer.from("not accepted")); };
    await expect(client.getFile("file-id")).rejects.toMatchObject({ failure: "aborted" });
    expect(calls).toHaveLength(1);
  });
  it("checks custody on every streamed read and cancels its reader", async () => {
    let canceled = false; let pulls = 0;
    reply = async () => new Response(new ReadableStream({ pull(controller) { pulls++; if (pulls === 2) active = false; controller.enqueue(new Uint8Array([32])); },
      cancel() { canceled = true; } }, { highWaterMark: 0 }));
    await expect(client.listFiles({ q: "trashed = false" })).rejects.toMatchObject({ code: "grant-changed" }); expect(pulls).toBe(2); expect(canceled).toBe(true);
  });
  it.each(statuses)("classifies status/reason $status $reason without echoing messages", async ({ status, reason, failure }) => {
    reply = async () => new Response(JSON.stringify({ error: { message: `private ${token}`, errors: [{ reason }] } }), { status });
    await expect(client.listFiles({ q: "trashed = false" })).rejects.toMatchObject({ failure, message: "Visible Drive operation unavailable" });
  });
  it("refuses redirects and overwrites without another network request", async () => {
    reply = async () => new Response("private", { status: 302, headers: { location: "https://example.invalid/leak" } });
    await expect(client.listFiles({ q: "trashed = false" })).rejects.toMatchObject({ failure: "transport" }); expect(calls).toHaveLength(1);
    await expect(client.updateFile("file-id", "new", "md5-is-not-an-etag")).rejects.toMatchObject({ code: "conflict" }); expect(calls).toHaveLength(1);
  });
  it("reports an actual writer's partial progress when an existing-file overwrite is refused", async () => {
    const files = produceVisibleFiles({}).files;
    const previous = Buffer.from("previous editable memory");
    reply = async (url, init) => {
      if (init.method === "POST") return new Response(JSON.stringify({ ...file("created-soul", "soul.md", "text/markdown"), md5Checksum: checksum(Buffer.from(files["soul.md"])) }));
      if (url.searchParams.has("q")) return page(url.searchParams.get("q")?.includes("memory.json") ? [file("existing-memory", "memory.json")] : []);
      if (url.searchParams.get("alt") === "media") return media(previous);
      return new Response(JSON.stringify({ ...file("existing-memory", "memory.json"), size: String(previous.length), md5Checksum: checksum(previous) }));
    };
    await expect(writeVisibleFiles(client, "parent-id", files)).rejects.toMatchObject({ wrote: ["soul.md"], cause: { code: "conflict" } });
    expect(calls.filter(call => call.init.method === "POST")).toHaveLength(1);
    expect(calls.some(call => call.init.method === "PATCH")).toBe(false);
  });
});

it.each(["revocation", "authority-change"])("binds a real protected lease and blocks media after %s", async change => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice')");
    const account = { userId: "alice", sessionId: "session", workspaceId: "org", isPrimary: false };
    const protector = new VisibleTokenProtector(Buffer.alloc(32, 7));
    const consent = createVisibleConsentState(db, account, protector, 1); consumeVisibleConsentState(db, { ...account, state: consent.state }, protector, 2);
    saveVisibleGrant(db, { userId: "alice", googleSub: "google-sub", accessToken: token, refreshToken: "SYNTHETIC-REFRESH",
      expiresAt: 100_000, scopes: [VISIBLE_FILE_SCOPE], expectedGeneration: consent.generation }, protector, 3);
    let current = account;
    const lease = await acquireVisibleAccess({ db, protector, account, readCurrentAccount: () => current,
      provider: { refresh: async () => { throw new Error("No refresh expected"); } }, now: () => 10 });
    let calls = 0;
    const transport: typeof globalThis.fetch = async (_url, init) => { calls++; expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      if (change === "revocation") revokeVisibleGrant(db, "alice"); else current = { ...account, workspaceId: "other-workspace" };
      return metadata(Buffer.from("protected data")); };
    const client = createGoogleVisibleDriveClient({ lease, fetch: transport });
    await expect(client.getFile("file-id")).rejects.toMatchObject({ code: change === "revocation" ? "grant-unavailable" : "authority-changed" }); expect(calls).toBe(1);
  } finally { db.close(); }
});
