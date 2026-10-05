// Bounded Google Drive transport, scoped by the real dedicated visible lease.
// No sign-in/appData token fallback, retries, redirects, routes or overwrite.
import { createHash, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { DriveVisibleError, FOLDER_MIME, type DriveFileRef, type DriveListArgs, type VisibleDriveClient, type VisibleErrorCode } from "./drive-visible.ts";
import { VisibleAccessError, type VisibleAccessLease } from "./drive-visible-access.ts";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const MAX_MEDIA = 24 * 1024 * 1024;
const MAX_METADATA = 128 * 1024;
const MAX_FILES = 10_000;
const MAX_PAGES = 64;
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const nameSchema = z.string().min(1).max(255).refine(name => Buffer.byteLength(name) <= 1_024);
const checksumSchema = z.string().regex(/^[a-fA-F0-9]{32}$/);
const fileSchema = z.object({
  id: idSchema, name: z.string().max(1_024), parents: z.array(idSchema).max(100), mimeType: z.string().min(1).max(200),
  md5Checksum: checksumSchema.optional(), createdTime: z.string().max(100).optional(), modifiedTime: z.string().max(100).optional(),
});
const mediaSchema = fileSchema.extend({
  size: z.string().regex(/^\d{1,16}$/), md5Checksum: checksumSchema,
  capabilities: z.object({ canDownload: z.boolean() }).optional(),
});
const pageSchema = z.object({
  files: z.array(fileSchema).max(1_000), nextPageToken: z.string().min(1).max(4_096).optional(), incompleteSearch: z.boolean().optional(),
});
const metadataFields = "id,name,parents,mimeType,md5Checksum,createdTime,modifiedTime";
const listFields = `nextPageToken,incompleteSearch,files(${metadataFields})`;
const errorSchema = z.object({ error: z.object({ errors: z.array(z.object({ reason: z.string().max(200) })).max(30).optional() }) });
export type GoogleVisibleFailure = "transport" | "timeout" | "aborted" | "corrupt" | "missing" | "unauthorized" | "forbidden" | "quota" | "rate-limited" | "server" | "conflict";
export class GoogleVisibleClientError extends DriveVisibleError {
  readonly failure: GoogleVisibleFailure;
  readonly status?: number;
  constructor(failure: GoogleVisibleFailure, code: VisibleErrorCode = "transport_error", status?: number) {
    super("Visible Drive operation unavailable", code);
    this.failure = failure;
    this.status = status;
    this.name = "GoogleVisibleClientError";
  }
}
function refuse(failure: GoogleVisibleFailure, code?: VisibleErrorCode): never { throw new GoogleVisibleClientError(failure, code); }
const md5 = (body: Buffer): string => createHash("md5").update(body).digest("hex");

export interface GoogleVisibleClientOptions {
  readonly lease: VisibleAccessLease;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
  /** Whole method, including all requests, pages and body reads. */
  readonly timeoutMs?: number;
}
export interface GoogleVisibleDriveClient extends VisibleDriveClient {
  resolveRootId(): Promise<string>;
  createBinaryFile(name: string, parentId: string, body: Buffer): Promise<DriveFileRef>;
  getBinaryFile(id: string): Promise<{ body: Buffer; md5Checksum: string }>;
}
interface Operation {
  readonly signal: AbortSignal;
  check(): void;
  await<T>(promise: Promise<T>): Promise<T>;
}

function statusFailure(status: number, bytes: Buffer): GoogleVisibleClientError {
  let reasons: string[] = [];
  try {
    const decoded = errorSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (decoded.success) reasons = (decoded.data.error.errors ?? []).map(error => error.reason);
  } catch { /* English messages and malformed upstream bodies are never trusted or echoed. */ }
  if (status === 401) return new GoogleVisibleClientError("unauthorized", "consent_revoked", status);
  if (status === 404) return new GoogleVisibleClientError("missing", "not_found", status);
  if (status === 429 || (status === 403 && reasons.some(reason => ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason)))) {
    return new GoogleVisibleClientError("rate-limited", "throttled", status);
  }
  if (status === 403 && reasons.some(reason => ["dailyLimitExceeded", "storageQuotaExceeded", "quotaExceeded"].includes(reason))) {
    return new GoogleVisibleClientError("quota", "transport_error", status);
  }
  if (status === 403) return new GoogleVisibleClientError("forbidden", "transport_error", status);
  if (status >= 500) return new GoogleVisibleClientError("server", "transport_error", status);
  return new GoogleVisibleClientError("transport", "transport_error", status);
}

export function createGoogleVisibleDriveClient(options: GoogleVisibleClientOptions): GoogleVisibleDriveClient {
  const transport = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!z.number().int().min(1).max(60_000).safeParse(timeoutMs).success) refuse("corrupt", "corrupt");
  const operate = async <T>(run: (operation: Operation) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const check = () => {
      if (controller.signal.aborted) refuse(timedOut ? "timeout" : "aborted");
      options.lease.assertCurrent();
    };
    const operation: Operation = {
      signal: controller.signal, check,
      async await<T>(promise: Promise<T>): Promise<T> {
        let onAbort = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new GoogleVisibleClientError(timedOut ? "timeout" : "aborted"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
        try { const result = await Promise.race([promise, aborted]); check(); return result; }
        finally { controller.signal.removeEventListener("abort", onAbort); }
      },
    };
    try { check(); const result = await run(operation); check(); return result; }
    catch (error) {
      // A changed account/grant or cancellation outranks an upstream failure.
      check();
      if (error instanceof GoogleVisibleClientError || error instanceof VisibleAccessError) throw error;
      refuse("transport");
    } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", cancel); controller.abort(); }
  };

  const readBody = async (response: Response, max: number, operation: Operation): Promise<Buffer> => {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d{1,16}$/.test(length) || Number(length) > max)) {
      void response.body?.cancel().catch(() => {}); refuse("corrupt", "corrupt");
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        operation.check();
        const next = await operation.await(options.lease.run(async () => {
          try { return { ok: true as const, result: await reader.read() }; }
          catch { return { ok: false as const }; }
        }));
        if (!next.ok) refuse("transport");
        if (next.result.done) break;
        size += next.result.value.byteLength;
        if (size > max) refuse("corrupt", "corrupt");
        chunks.push(Buffer.from(next.result.value));
      }
      operation.check();
      return Buffer.concat(chunks, size);
    } finally {
      void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch { /* Cancellation may leave a read pending. */ }
    }
  };
  const request = async (url: URL, init: RequestInit, max: number, operation: Operation): Promise<Buffer> => {
    operation.check();
    let ownedResponse: Response | undefined;
    try {
    const response = await operation.await(options.lease.run(async token => {
      try {
        ownedResponse = await transport(url, {
        ...init, redirect: "error", signal: operation.signal,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        });
        if (operation.signal.aborted) { void ownedResponse.body?.cancel().catch(() => {}); return { ok: false as const }; }
        return { ok: true as const, response: ownedResponse };
      } catch { return { ok: false as const }; }
    }));
    if (!response.ok) refuse("transport");
    if (response.response.redirected || response.response.status >= 300 && response.response.status < 400) {
      void response.response.body?.cancel().catch(() => {}); refuse("transport");
    }
    const body = await readBody(response.response, response.response.ok ? max : MAX_METADATA, operation);
    if (!response.response.ok) throw statusFailure(response.response.status, body);
    return body;
    } finally { void ownedResponse?.body?.cancel().catch(() => {}); }
  };
  const decode = (body: Buffer): ReturnType<typeof JSON.parse> => {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { refuse("corrupt", "corrupt"); }
  };
  const urlFor = (id: string): URL => {
    if (!idSchema.safeParse(id).success) refuse("corrupt", "corrupt");
    return new URL(`${API}/${encodeURIComponent(id)}`);
  };
  const upload = async (name: string, parentId: string, body: Buffer, mimeType: string, operation: Operation): Promise<DriveFileRef> => {
    if (!Buffer.isBuffer(body) || !nameSchema.safeParse(name).success || !idSchema.safeParse(parentId).success || body.length > MAX_MEDIA) refuse("corrupt", "corrupt");
    const bytes = Buffer.from(body); // Own the awaited operation's immutable input.
    const metadata = JSON.stringify({ name, parents: [parentId], mimeType });
    let boundary: string;
    do { boundary = `muster-${randomBytes(24).toString("hex")}`; } while (bytes.includes(boundary) || metadata.includes(boundary));
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const url = new URL(UPLOAD); url.searchParams.set("uploadType", "multipart"); url.searchParams.set("fields", metadataFields);
    const result = fileSchema.safeParse(decode(await request(url, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: new Uint8Array(multipart).buffer }, MAX_METADATA, operation)));
    if (!result.success || result.data.name !== name || result.data.mimeType !== mimeType
      || parentId !== "root" && !result.data.parents.includes(parentId)
      || result.data.md5Checksum?.toLowerCase() !== md5(bytes)) refuse("corrupt", "corrupt");
    return result.data;
  };
  const get = async (id: string, operation: Operation): Promise<{ body: Buffer; md5Checksum: string }> => {
    const metadataUrl = urlFor(id); metadataUrl.searchParams.set("fields", `${metadataFields},size,capabilities(canDownload)`);
    const metadata = mediaSchema.safeParse(decode(await request(metadataUrl, { method: "GET" }, MAX_METADATA, operation)));
    if (!metadata.success || metadata.data.id !== id || metadata.data.mimeType.startsWith("application/vnd.google-apps.")
      || metadata.data.capabilities?.canDownload === false) refuse("corrupt", "corrupt");
    const size = Number(metadata.data.size);
    if (!Number.isSafeInteger(size) || size > MAX_MEDIA) refuse("corrupt", "corrupt");
    const mediaUrl = urlFor(id); mediaUrl.searchParams.set("alt", "media");
    const body = await request(mediaUrl, { method: "GET" }, MAX_MEDIA, operation);
    if (body.length !== size || md5(body) !== metadata.data.md5Checksum.toLowerCase()) refuse("corrupt", "corrupt");
    return { body, md5Checksum: metadata.data.md5Checksum.toLowerCase() };
  };
  return {
    resolveRootId: () => operate(async operation => {
      const url = urlFor("root"); url.searchParams.set("fields", "id");
      const root = z.object({ id: idSchema }).safeParse(decode(await request(url, { method: "GET" }, MAX_METADATA, operation)));
      if (!root.success || root.data.id === "root") refuse("corrupt", "corrupt");
      return root.data.id;
    }),
    listFiles: (args: DriveListArgs) => operate(async operation => {
      if (!z.string().min(1).max(8_192).safeParse(args.q).success) refuse("corrupt", "corrupt");
      const files: DriveFileRef[] = []; const tokens = new Set<string>(); const ids = new Set<string>();
      let pageToken: string | undefined;
      for (let count = 0; count < MAX_PAGES; count++) {
        const url = new URL(API);
        for (const [key, value] of Object.entries({ q: args.q, spaces: "drive", corpora: "user", pageSize: "1000", fields: listFields })) url.searchParams.set(key, value);
        if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
        const page = pageSchema.safeParse(decode(await request(url, { method: "GET" }, MAX_METADATA, operation)));
        if (!page.success || page.data.incompleteSearch) refuse("corrupt", "corrupt");
        for (const file of page.data.files) {
          if (ids.has(file.id) || files.length >= MAX_FILES) refuse("corrupt", "corrupt");
          ids.add(file.id); files.push(file);
        }
        if (!page.data.nextPageToken) return files;
        if (tokens.has(page.data.nextPageToken)) refuse("corrupt", "corrupt");
        tokens.add(page.data.nextPageToken); pageToken = page.data.nextPageToken;
      }
      refuse("corrupt", "corrupt");
    }),
    createFolder: (name, parentId) => operate(async operation => {
      if (!nameSchema.safeParse(name).success || !idSchema.safeParse(parentId).success) refuse("corrupt", "corrupt");
      const url = new URL(API); url.searchParams.set("fields", metadataFields);
      const result = fileSchema.safeParse(decode(await request(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parents: [parentId], mimeType: FOLDER_MIME }) }, MAX_METADATA, operation)));
      if (!result.success || result.data.name !== name || result.data.mimeType !== FOLDER_MIME
        || parentId !== "root" && !result.data.parents.includes(parentId)) refuse("corrupt", "corrupt");
      return result.data;
    }),
    createFile: (name, parentId, body) => operate(operation => upload(name, parentId, Buffer.from(body, "utf-8"),
      name.endsWith(".md") ? "text/markdown" : "application/json", operation)),
    createBinaryFile: (name, parentId, body) => operate(operation => upload(name, parentId, body, "application/octet-stream", operation)),
    getBinaryFile: id => operate(operation => get(id, operation)),
    getFile: id => operate(async operation => {
      const result = await get(id, operation);
      try { return { body: new TextDecoder("utf-8", { fatal: true }).decode(result.body), md5Checksum: result.md5Checksum }; }
      catch { refuse("corrupt", "corrupt"); }
    }),
    // MD5 is output-only. A check then PATCH has a race and is not a verified
    // atomic precondition; never overwrite existing user data under that claim.
    async updateFile() { refuse("conflict", "conflict"); },
  };
}
