// Optional account-owned visible copies. Existing appData grants and the
// hosted whole-installation restore wall remain separate and unchanged.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";
import { createRemoteJWKSet, customFetch } from "jose";
import { z } from "zod";

import { createGoogleIdTokenVerifier, type GoogleIdTokenVerifier } from "./calendar-oauth.ts";
import { resolveFollowUpAccount, type FollowUpAccount } from "./follow-up-identity.ts";
import { acquireVisibleAccess, VisibleAccessError, type VisibleAccessLease } from "./drive-visible-access.ts";
import { ACCOUNT_PROJECTION_UNSUPPORTED } from "./drive-visible-account-bundle.ts";
import { writeAccountVisibleBackup, VisibleBackupError } from "./drive-visible-backups.ts";
import { readAccountVisibleSource, type AccountVisibleSourceInput } from "./drive-visible-data-source.ts";
import { createGoogleVisibleDriveClient } from "./drive-visible-google-client.ts";
import { cancelVisibleConsentState, consumeVisibleConsentState, createVisibleConsentState,
  getVisibleGrant, isVisibleGrantCurrent, revokeVisibleGrant, saveVisibleGrant } from "./drive-visible-grants.ts";
import { VisibleFileOAuthProvider } from "./drive-visible-oauth.ts";
import { inspectAccountVisibleRestore } from "./drive-visible-restore.ts";
import { createVisibleRuntimeProtector } from "./drive-visible-runtime-key.ts";
import { captureAccountSettings, readAccountSettings } from "./drive-visible-settings.ts";
import { normalizeRecoveryCode } from "./workspace-bundle-v2.ts";
import { parseJson, type JsonValue } from "./schema.ts";

export const VISIBLE_DRIVE_ROUTE_PREFIX = "/api/workspace/drive-visible";
const callbackPath = `${VISIBLE_DRIVE_ROUTE_PREFIX}/callback`;
const credentials = z.object({ userId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200),
  sessionToken: z.string().min(1).max(8192) }).strict();
export type VisibleRouteSession = z.infer<typeof credentials>;
export interface VisibleDriveRouteContext {
  db(): DatabaseSync;
  /** Actual signed BetterAuth lookup, with cookie cache and refresh disabled.
   * These private session values never enter a response or client metadata. */
  session(): Promise<VisibleRouteSession | null>;
  operator(): string | null;
  deploymentSecret(): string;
  /** Operator-configured PUBLIC_BASE_URL, never request Host/proxy headers. */
  publicBaseUrl: string;
  google: { clientId: string; clientSecret: string } | null;
  source(): Pick<AccountVisibleSourceInput, "store" | "plans" | "dataDir"> | null;
  appVersion: string;
  now?: () => number;
  /** Isolated test transport/identity ports. Production registration supplies neither. */
  fetch?: typeof globalThis.fetch;
  verifyIdToken?: GoogleIdTokenVerifier;
}
class RouteFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super("Visible Drive request unavailable.");
    this.status = status; this.code = code;
  }
}
function refuse(status: number, code: string): never { throw new RouteFailure(status, code); }
const emptyBody = z.object({}).strict();
const stateBody = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const settingsBody = z.object({ values: z.record(z.string().max(200),
  z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()])) }).strict();
const passphrase = z.string().min(8).max(4096);
const recoveryCode = z.string().max(128).refine(code => normalizeRecoveryCode(code) !== null);
const backupBody = z.object({ passphrase, recoveryCodes: z.array(recoveryCode).min(1).max(16).optional() }).strict();
const restoreBody = z.object({ fileId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  passphrase: passphrase.optional(), recoveryCode: recoveryCode.optional() }).strict()
  .refine(body => (body.passphrase === undefined) !== (body.recoveryCode === undefined));

function configuredUrl(base: string): URL {
  try {
    const url = new URL(base);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    // Route mounting does not support a path prefix; advertising a callback
    // under an unmounted proxy prefix would be a broken authorization flow.
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error();
    return url;
  } catch { return refuse(503, "configuration-unavailable"); }
}
const expirySchema = z.union([z.number().int().max(8.64e15), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)]);
function grantSchemaReady(db: DatabaseSync): boolean {
  const tables = {
    drive_visible_grants: ["userId", "googleSub", "accessToken", "refreshToken", "expiresAt", "scopes", "generation"],
    drive_visible_grant_generations: ["userId", "generation"],
    drive_visible_oauth_states: ["stateHash", "userId", "sessionId", "generation", "codeVerifier", "nonce", "expiresAt", "consumed"],
  };
  try {
    for (const [table, columns] of Object.entries(tables)) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false;
      const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      if (columns.some(column => !existing.has(column))) return false;
    }
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='drive_visible_oauth_states_user' AND tbl_name='drive_visible_oauth_states'").get();
  } catch { return false; }
}
/** An organization fallback is valid only AFTER the exact live session row
 * has passed. The existing resolver intentionally does not enforce expiry. */
export function readLiveVisibleAccount(db: DatabaseSync, session: VisibleRouteSession,
  operator: string | null, now = Date.now()): FollowUpAccount | null {
  if (!credentials.safeParse(session).success || !Number.isFinite(now)) return null;
  try {
    const row = db.prepare(`SELECT s.expiresAt FROM session s JOIN user u ON u.id = s.userId
      WHERE s.id = ? AND s.userId = ? AND s.token = ?`).get(session.sessionId, session.userId, session.sessionToken);
    if (!row) return null;
    const expires = expirySchema.safeParse(row.expiresAt);
    if (!expires.success) return null;
    const numeric = z.number().int().safeParse(expires.data);
    const expiresAt = numeric.success ? numeric.data : Date.parse(z.string().parse(expires.data));
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
    return resolveFollowUpAccount(db, session, session.userId === operator);
  } catch { return null; }
}
function json<T>(res: ServerResponse, status: number, value: T): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer" });
  res.end(JSON.stringify(value));
}
async function interrupted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return refuse(409, "aborted");
  let cancel: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(new RouteFailure(409, "aborted"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([promise, stopped]); }
  finally { if (cancel) signal.removeEventListener("abort", cancel); }
}
async function body(req: IncomingMessage, signal: AbortSignal): Promise<JsonValue> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") refuse(415, "json-required");
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 32_768)) refuse(413, "body-too-large");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const iterator = req[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await interrupted(iterator.next(), signal);
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!Buffer.isBuffer(chunk)) refuse(400, "invalid-body");
      bytes += chunk.byteLength;
      if (bytes > 32_768) refuse(413, "body-too-large");
      chunks.push(chunk);
    }
    if (signal.aborted) refuse(409, "aborted");
    return parseJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof RouteFailure) throw error;
    return refuse(400, "invalid-body");
  }
}
function parse<T>(schema: z.ZodType<T>, value: JsonValue | undefined): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : refuse(400, "invalid-body");
}

export async function handleVisibleDriveRoute(req: IncomingMessage, res: ServerResponse,
  method: string, path: string, ctx: VisibleDriveRouteContext): Promise<boolean> {
  if (path !== VISIBLE_DRIVE_ROUTE_PREFIX && !path.startsWith(`${VISIBLE_DRIVE_ROUTE_PREFIX}/`)) return false;
  const routes = new Map([["status", "GET"], ["consent", "POST"], ["callback", "GET"], ["cancel", "POST"],
    ["disconnect", "POST"], ["settings", "POST"], ["projection", "GET"], ["backup", "POST"], ["restore/inspect", "POST"]]);
  const action = path.slice(VISIBLE_DRIVE_ROUTE_PREFIX.length + 1);
  if (!routes.has(action)) { json(res, 404, { error: "visible-route-unavailable" }); return true; }
  if (method !== routes.get(action) || req.method === "HEAD") { json(res, 405, { error: "method-not-allowed" }); return true; }
  const controller = new AbortController();
  const aborted = () => controller.abort();
  const closed = () => { if (!res.writableFinished) controller.abort(); };
  req.once("aborted", aborted);
  res.once("close", closed);
  if (req.aborted || res.destroyed) controller.abort();
  const timeout = setTimeout(aborted, 120_000);
  const now = ctx.now ?? Date.now;
  let consentState: string | undefined;
  let pinned: VisibleRouteSession | undefined;
  try {
    const base = configuredUrl(ctx.publicBaseUrl);
    if (method === "POST" && req.headers.origin !== base.origin) refuse(403, "origin-mismatch");
    const read = async () => {
      const current = credentials.safeParse(await interrupted(ctx.session(), controller.signal));
      return current.success ? current.data : null;
    };
    pinned = (await read()) ?? undefined;
    if (!pinned) refuse(401, "session-unavailable");
    const db = ctx.db();
    const currentAccount = () => {
      if (req.aborted || res.destroyed) controller.abort();
      if (controller.signal.aborted) return null;
      return readLiveVisibleAccount(db, pinned!, ctx.operator(), now());
    };
    const account = currentAccount();
    if (!account) refuse(401, "session-unavailable");
    const signature = JSON.stringify(account);
    let signedSessionChanged = false;
    const assertCurrent = () => {
      if (req.aborted || res.destroyed) controller.abort();
      if (controller.signal.aborted) refuse(409, "aborted");
      if (signedSessionChanged) refuse(409, "authority-changed");
      const current = currentAccount();
      if (!current || JSON.stringify(current) !== signature) refuse(409, "authority-changed");
    };
    const recheck = async () => {
      assertCurrent();
      const fresh = await read();
      if (!fresh || fresh.userId !== pinned!.userId || fresh.sessionId !== pinned!.sessionId
        || fresh.sessionToken !== pinned!.sessionToken) {
        signedSessionChanged = true;
        refuse(409, "authority-changed");
      }
      assertCurrent();
    };
    let protector;
    try { protector = createVisibleRuntimeProtector(ctx.deploymentSecret()); }
    catch { return refuse(503, "key-unavailable"); }
    const providerConfigured = !!ctx.google?.clientId.trim() && !!ctx.google.clientSecret.trim();
    if (action === "status") {
      const grant = grantSchemaReady(db) ? getVisibleGrant(db, account.userId, protector) : null;
      assertCurrent();
      json(res, 200, { available: providerConfigured, connected: !!grant, scope: "account-owned",
        restoreApply: "unsupported", settingsCaptured: readAccountSettings(db, account) !== null });
      return true;
    }
    // Local control never requires a working Google provider and never
    // revokes a sign-in/appData grant or deletes an existing backup.
    const offered = method === "POST" ? await body(req, controller.signal) : undefined;
    await recheck();
    if (action === "cancel") {
      const input = parse(stateBody, offered);
      const cancelled = grantSchemaReady(db) && cancelVisibleConsentState(db, { ...pinned, state: input.state }, now());
      json(res, 200, { cancelled, priorGrant: "preserved" }); return true;
    }
    if (action === "disconnect") {
      parse(emptyBody, offered);
      revokeVisibleGrant(db, account.userId);
      json(res, 200, { disconnected: true, remoteRevocation: "not-requested", backups: "preserved" }); return true;
    }
    if (action === "settings") {
      const input = parse(settingsBody, offered);
      let captured;
      try { captured = captureAccountSettings(db, account, input.values, now()); }
      catch { return refuse(400, "invalid-settings"); }
      assertCurrent();
      json(res, 200, { captured: true, values: captured.snapshot.values, droppedSettings: captured.droppedSettings }); return true;
    }
    const backupInput = action === "backup" ? parse(backupBody, offered) : undefined;
    const restoreInput = action === "restore/inspect" ? parse(restoreBody, offered) : undefined;
    if (!providerConfigured) refuse(503, "provider-unavailable");

    let consentGuard: (() => void) | undefined;
    // OAuth and JWKS reads use the same live authority checks as media.
    // The bounded response is reconstructed only after every real body read
    // has passed. No endpoint override comes from configuration or requests.
    const guardedFetch: typeof globalThis.fetch = async (url, init) => {
      const endpoint = String(url);
      if (!["https://oauth2.googleapis.com/token", "https://www.googleapis.com/oauth2/v3/certs"].includes(endpoint)) refuse(503, "provider-unavailable");
      await recheck(); consentGuard?.();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]);
      const pending = (ctx.fetch ?? globalThis.fetch)(url, { ...init, signal, redirect: "error" });
      // A transport that settles after cancellation cannot retain an unread
      // response body owned by this request.
      void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
      const response = await interrupted(pending, signal);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        await recheck(); consentGuard?.();
        const declared = response.headers.get("content-length");
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 131_072)) refuse(502, "provider-response-invalid");
        const chunks: Buffer[] = []; let count = 0;
        reader = response.body?.getReader();
        if (reader) for (;;) {
          await recheck(); consentGuard?.();
          const next = await interrupted(reader.read(), signal);
          await recheck(); consentGuard?.();
          if (next.done) break;
          count += next.value.byteLength;
          if (count > 131_072) refuse(502, "provider-response-invalid");
          chunks.push(Buffer.from(next.value));
        }
        await recheck(); consentGuard?.();
        return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
      } finally {
        if (reader) {
          void reader.cancel().catch(() => undefined);
          try { reader.releaseLock(); } catch { /* Aborted read may still settle. */ }
        } else void response.body?.cancel().catch(() => undefined);
      }
    };
    const keys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {
      timeoutDuration: 15_000, [customFetch]: guardedFetch,
    });
    const provider = new VisibleFileOAuthProvider({ ...ctx.google!, redirectUri: new URL(callbackPath, base).toString(),
      fetch: guardedFetch, verifyIdToken: ctx.verifyIdToken ?? createGoogleIdTokenVerifier(ctx.google!.clientId, keys) });
    if (action === "consent") {
      parse(emptyBody, offered);
      assertCurrent();
      const attempt = createVisibleConsentState(db, pinned, protector, now());
      consentState = attempt.state;
      const url = provider.authorizationUrl(attempt);
      assertCurrent();
      json(res, 200, { authorizationUrl: url, state: attempt.state, expiresAt: attempt.expiresAt });
      consentState = undefined; return true;
    }
    if (action === "callback") {
      if (!grantSchemaReady(db)) refuse(400, "consent-unavailable");
      if (!req.url || Buffer.byteLength(req.url) > 8192) refuse(400, "invalid-callback");
      const query = new URL(req.url, base).searchParams;
      if ([...query.keys()].some(key => query.getAll(key).length !== 1)) refuse(400, "invalid-callback");
      const state = query.get("state") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(state)) refuse(400, "invalid-callback");
      if (query.has("error")) {
        cancelVisibleConsentState(db, { ...pinned, state }, now());
        refuse(400, "consent-declined");
      }
      const code = query.get("code") ?? "";
      if (!code || code.length > 4096 || [...code].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) refuse(400, "invalid-callback");
      const attempt = consumeVisibleConsentState(db, { ...pinned, state }, protector, now());
      if (!attempt) refuse(400, "consent-unavailable");
      consentState = state;
      consentGuard = () => {
        assertCurrent();
        const row = db.prepare(`SELECT s.generation FROM drive_visible_oauth_states s JOIN drive_visible_grant_generations g
          ON g.userId = s.userId AND g.generation = s.generation WHERE s.stateHash = ? AND s.userId = ?
          AND s.sessionId = ? AND s.generation = ? AND s.consumed = 1 AND s.expiresAt > ?`)
          .get(createHash("sha256").update(state).digest("base64url"), account.userId, account.sessionId, attempt.generation, now());
        if (!row) refuse(409, "consent-changed");
      };
      consentGuard();
      const verified = await interrupted(provider.exchange(code, attempt), controller.signal);
      await recheck(); consentGuard();
      saveVisibleGrant(db, { ...verified, userId: account.userId, expectedGeneration: attempt.generation }, protector, now());
      consentState = undefined;
      json(res, 200, { connected: true, scope: "account-owned" }); return true;
    }

    if (!grantSchemaReady(db)) refuse(409, "grant-unavailable");
    const refreshProvider: Pick<VisibleFileOAuthProvider, "refresh"> = { refresh: async offeredGrant => {
      const heldGrant = getVisibleGrant(db, account.userId, protector);
      if (!heldGrant || offeredGrant.googleSub !== heldGrant.googleSub || offeredGrant.accessToken !== heldGrant.accessToken
        || offeredGrant.refreshToken !== heldGrant.refreshToken || offeredGrant.expiresAt !== heldGrant.expiresAt
        || JSON.stringify(offeredGrant.scopes) !== JSON.stringify(heldGrant.scopes)) refuse(409, "grant-changed");
      consentGuard = () => {
        assertCurrent();
        if (!isVisibleGrantCurrent(db, heldGrant, protector)) refuse(409, "grant-changed");
      };
      try { consentGuard(); return await provider.refresh(offeredGrant); }
      finally { consentGuard = undefined; }
    } };
    const held = await interrupted(acquireVisibleAccess({ db, protector, account, readCurrentAccount: currentAccount,
      provider: refreshProvider, signal: controller.signal, now }), controller.signal);
    await recheck(); held.assertCurrent();
    const lease: VisibleAccessLease = {
      googleSub: held.googleSub,
      assertCurrent: () => { assertCurrent(); held.assertCurrent(); },
      run: async operation => {
        await recheck(); held.assertCurrent();
        const result = await held.run(operation);
        await recheck(); held.assertCurrent();
        return result;
      },
    };
    const client = createGoogleVisibleDriveClient({ lease, signal: controller.signal, fetch: ctx.fetch });
    const resolveAccount = () => {
      lease.assertCurrent();
      const current = currentAccount();
      return current ? { account: current, googleSub: lease.googleSub } : null;
    };
    if (action === "restore/inspect") {
      const input = restoreInput ?? refuse(400, "invalid-body");
      const downloaded = await client.getBinaryFile(input.fileId);
      await recheck(); lease.assertCurrent();
      const inspected = inspectAccountVisibleRestore({ bytes: downloaded.body, key: { custody: "user-held",
        passphrase: input.passphrase, recoveryCode: input.recoveryCode }, resolveAccount });
      lease.assertCurrent();
      if (inspected.status !== "ready") refuse(422, "restore-inspection-unavailable");
      json(res, 200, { status: "ready", scope: inspected.scope, apply: inspected.apply,
        sourceDigest: inspected.source.sourceDigest, projection: inspected.projection, unsupported: inspected.unsupported }); return true;
    }
    const source = ctx.source();
    if (!source) refuse(503, "source-unavailable");
    const input: AccountVisibleSourceInput = { ...source, account, settingsSnapshot: readAccountSettings(db, account) };
    if (action === "projection") {
      const projection = readAccountVisibleSource(input);
      lease.assertCurrent();
      if (projection.status !== "ready") refuse(503, projection.reason);
      json(res, 200, { ...projection, restoreApply: "unsupported", unsupported: ACCOUNT_PROJECTION_UNSUPPORTED }); return true;
    }
    const inputKey = backupInput ?? refuse(400, "invalid-body");
    const result = await writeAccountVisibleBackup({ lease, client, bundle: { source: input, resolveAccount,
      appVersion: ctx.appVersion, key: { custody: "user-held", passphrase: inputKey.passphrase,
        recovery: inputKey.recoveryCodes ? { codes: inputKey.recoveryCodes } : undefined } } });
    await recheck(); lease.assertCurrent();
    json(res, 200, result); return true;
  } catch (error) {
    if (consentState && pinned) {
      try { cancelVisibleConsentState(ctx.db(), { ...pinned, state: consentState }, now()); }
      catch { /* Preserve an older usable grant even if cleanup is unavailable. */ }
    }
    if (error instanceof RouteFailure) json(res, error.status, { error: error.code });
    else if (error instanceof VisibleAccessError) json(res, 409, { error: error.code, reconnectRequired: error.reconnectRequired });
    else if (error instanceof VisibleBackupError) json(res, 409, { error: error.code,
      createdFileId: error.createdFileId, copyPreserved: error.createdFileId ? true : undefined });
    else json(res, 502, { error: "visible-operation-unavailable" });
    return true;
  } finally {
    clearTimeout(timeout);
    req.removeListener("aborted", aborted);
    res.removeListener("close", closed);
  }
}
