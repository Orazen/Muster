// The workspace-backup route family, extracted from server/index.ts behind
// an ordered route table: capability advertisement, the hosted installation
// wall, account-linked Google Drive connect/callback, and the v2 portable
// bundles (file, installation Drive, account Drive).
//
// POSITION CONTRACT — this family is order-sensitive inside index.ts's
// request handler:
//   1. it runs INSIDE the session gate (a session, when one exists, is
//      already resolved), but ABOVE the multi-tenant ownership guard: the
//      account routes are account-scoped by session, not bot-scoped.
//   2. capability advertisement (`/api/workspace/google/status`) must answer
//      BEFORE the installation wall — it is the sole hosted workspace
//      exception, and the wall would 403 it otherwise.
//   3. the account connect/callback entries must sit BEFORE the wall: since
//      the storage-sovereignty direction (docs/plans/cloud-relay-strategy-
//      2026-09-18.md decision 14), a hosted user connects their OWN Google
//      Drive during onboarding. Connect moves no workspace data — it stores
//      only the user's verified OAuth tokens in a separate per-user Drive grant — so
//      it is safe above the wall. The callback still requires the state's
//      bound user to equal the session user.
//   4. the installation wall must run before ANY remaining family handler
//      parses a body or opens local files: the v2 bundles and installation
//      Drive push/pull are installation-scoped (buildPayloadV2 reads the
//      whole data directory) and stay desktop-only until a per-user bundle
//      builder exists.
//   5. nothing before the family's registration in index.ts may match a
//      family path (verified: every matcher above the registration point is
//      an exact path outside `/api/workspace` + `/api/vault`).
//
// `match` and `handle` are separated so the table stays declarative: match
// sees only the request line and the per-request context, handle does the
// work. Adding the next family means writing its module and registering it
// with the same one-line pattern — no other file changes.

import type { IncomingMessage, ServerResponse } from "node:http";
import { rmSync } from "node:fs";

import type { AppConfig } from "./config.ts";
import { getDb, forwardedProtoOf, SELF_HOSTED } from "./auth.ts";
import { json, readBody, isText } from "./http-helpers.ts";
import * as accountDrive from "./account-drive.ts";
import { consumeDriveState } from "./drive-grants.ts";
import * as bundleV2 from "./workspace-bundle-v2.ts";
import {
  clearPendingRestore,
  PENDING_RESTORE_FORMAT,
  readLastReceipt,
  readPendingRestore,
  stagingPathFor,
  writePendingRestore,
  type PendingRestore,
} from "./restore-apply.ts";
import * as driveSync from "./drive-sync.ts";
import * as syncState from "./sync-state.ts";
import type { WorkspaceBackupCapability } from "./contracts.ts";

/** Everything a family handler may touch for one request. index.ts owns the
 * session resolution, the live config and the data dir; the family only
 * reads through this context. */
export interface BackupRequestContext {
  /** The signed-in user, if the session gate resolved one. No session means
   * the account routes stay contained 501s — that containment is a contract,
   * pinned by server/workspace-auth-harness.test.ts. */
  requestUserId: string | null;
  session?(): Promise<{ userId: string; sessionId: string } | null>;
  /** Live config access — never a stale snapshot (the Drive-pull route
   * re-reads config mid-request to detect a swapped connection). */
  config(): AppConfig;
  appVersion(): string;
  dataDir(): string;
}

/** Ordered route table for this family. */
interface BackupRoute {
  match(method: string, path: string, ctx: BackupRequestContext): boolean;
  handle(req: IncomingMessage, res: ServerResponse, ctx: BackupRequestContext): Promise<void> | void;
}

/** The exact origin the account OAuth flow binds its consent redirect to. */
function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1:8799";
  const proto = forwardedProtoOf(req);
  const secure = proto === "https" || (!host.startsWith("127.0.0.1") && !host.startsWith("localhost"));
  return `${secure ? "https" : "http"}://${host}`;
}

const ACCOUNT_DRIVE_OFF = {
  code: "ACCOUNT_DRIVE_UNAVAILABLE",
  error: "Account-linked Google Drive backup is unavailable. Use a Drive connection configured on this computer.",
};

function payloadOf(body: any): string {
  return isText(body?.payload) ? body.payload : "";
}

// ── Portable workspace backup v2 (server/workspace-bundle-v2.ts) ───────────
// Passphrase-only, everything-included bundles: bots, groups, memory,
// transcripts, routines, goals, approval history, the social graph.
// Restores stage while the server runs and COMMIT AT BOOT
// (server/restore-apply.ts) — the live Store never races the swap. The
// whole /api/workspace/ + /api/vault/ surface is denied on hosted installs
// by the wall inside the table below; these routes are desktop/local by
// inheritance.

interface StageOkBody {
  staged: true;
  restartRequired: true;
  counts: bundleV2.StagedCounts | null;
  reconsentRequired: bundleV2.ReconsentEntry[];
  summary: bundleV2.BundleSummary | null;
}
interface StageErrBody {
  status?: string;
  error: string;
  blocked?: bundleV2.RestoreBlocked[];
}

const stageV2Restore = (
  passphrase: string,
  payloadText: string,
  source: string,
  dataDir: string,
): { ok: true; body: StageOkBody } | { ok: false; status: number; body: StageErrBody } => {
  const bytes = Buffer.from(payloadText, "utf8");
  const decrypt = bundleV2.decryptBundleV2(bytes, { passphrase });
  if (decrypt.status !== "ok" || decrypt.payload === undefined) {
    const v1Hint = payloadText.startsWith("muster-workspace-bundle:")
      ? " — that is a v1 bundle; restore it with the original v1 flow on the same installation"
      : "";
    return { ok: false, status: 400, body: { status: decrypt.status, error: `${decrypt.error ?? "the bundle could not be decrypted"}${v1Hint}` } };
  }
  const verify = bundleV2.verifyBundleV2(bytes, { passphrase });
  if (verify.status !== "ok") {
    return { ok: false, status: 400, body: { status: verify.status, error: `the bundle did not verify: ${verify.status}` } };
  }
  // ids are KEPT (remapIds: false): the commit replaces the covered files
  // wholesale, so there is nothing to merge with — and routines, goals,
  // decisions and social rows all reference bots by id.
  const staged = bundleV2.stageRestoreV2(decrypt.payload, {
    stagingDir: stagingPathFor(dataDir),
    remapIds: false,
  });
  if (staged.status !== "staged") {
    return { ok: false, status: 400, body: { status: staged.status, error: staged.error ?? "the restore was refused", blocked: staged.blocked } };
  }
  try {
    const pending: PendingRestore = {
      version: 1,
      format: PENDING_RESTORE_FORMAT,
      stagingDir: staged.stagingDir,
      createdAt: Date.now(),
      source,
      reconsentRequired: staged.reconsentRequired,
    };
    if (staged.counts !== undefined) pending.counts = staged.counts;
    writePendingRestore(dataDir, pending);
  } catch (e) {
    return { ok: false, status: 409, body: { error: e instanceof Error ? e.message : String(e) } };
  }
  return {
    ok: true,
    body: {
      staged: true,
      restartRequired: true,
      counts: staged.counts ?? null,
      reconsentRequired: staged.reconsentRequired,
      summary: verify.summary ?? null,
    },
  };
};

/** The ordered family table. Order within the family mirrors the original
 * inline sequence exactly: capability → hosted wall → account connect +
 * callback → v2 status/export/verify/restore → account push/pull → discard →
 * installation-Drive push/pull. */
const routes: BackupRoute[] = [
  {
    // This exact read-only response is the sole hosted workspace exception.
    // Hosted status does not read installation connections, account tokens or
    // backup stamps. Local readiness uses only the existing operator transport.
    match: (method, path) => path === "/api/workspace/google/status" && method === "GET",
    handle: (_req, res, ctx) => {
      const cfg = ctx.config();
      const installationDriveReady = !SELF_HOSTED
        && Boolean(cfg.driveSync?.refreshToken?.trim()) && driveSync.driveOAuthConfigured();
      // The account-linked transport exists for a signed-in user. On a local
      // install it has always been available; on hosted it is the
      // storage-sovereignty connect (decision 14): the user's own Drive
      // becomes their storage home, so the capability advertises availability
      // whenever a session exists. `connected` reports the per-user token row.
      // The push/pull transports stay behind the installation wall below
      // until a per-user bundle builder exists.
      let accountDriveReady = false;
      let accountDriveConnected = false;
      if (ctx.requestUserId) {
        const tokens = accountDrive.googleTokensFor(getDb(), ctx.requestUserId);
        accountDriveConnected = Boolean(tokens?.refreshToken);
        accountDriveReady = true;
      }
      const capability: WorkspaceBackupCapability = {
        capabilityVersion: 1,
        workspaceBackupAvailable: !SELF_HOSTED,
        unavailableReason: SELF_HOSTED ? "Workspace backups are available on local desktop installs only for now." : null,
        drive: false,
        installationDrive: { configured: installationDriveReady, operationsAvailable: installationDriveReady },
        accountDrive: { available: accountDriveReady, connected: accountDriveConnected },
      };
      json(res, 200, capability);
    },
  },
  {
    // Account-linked Google Drive connect: the signed-in user's own Google
    // account, one drive.appdata grant. Moves NO workspace data — it stores
    // only the user's verified OAuth tokens in a separate per-user Drive grant — which
    // is why it sits above the installation wall and is available on hosted
    // (storage-sovereignty onboarding, decision 14). A request without a
    // session keeps the historical contained 501 — no session means no
    // account row, so no consent URL, state, or token exchange may run.
    match: (method, path) => method === "GET" && path === "/api/workspace/google/connect",
    handle: async (req, res, ctx) => {
      if (!ctx.requestUserId) return json(res, 501, ACCOUNT_DRIVE_OFF);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      try {
        const binding = await ctx.session?.();
        if (!binding || binding.userId !== ctx.requestUserId) return json(res, 401, { error: "Sign in again to connect Drive." });
        const origin = req.headers.origin;
        if ((origin && origin !== requestOrigin(req)) || req.headers["sec-fetch-site"] === "cross-site") {
          return json(res, 403, { error: "Open Drive settings in Muster to connect." });
        }
        const url = accountDrive.startDriveConsent(getDb(), binding, requestOrigin(req));
        json(res, 200, { url });
      } catch {
        json(res, 501, ACCOUNT_DRIVE_OFF);
      }
    },
  },
  {
    match: (method, path) => method === "GET" && path === "/api/workspace/google/callback",
    handle: async (req, res, ctx) => {
      if (!ctx.requestUserId) return json(res, 501, ACCOUNT_DRIVE_OFF);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      const redirect = (ok: boolean) => { res.writeHead(302, { location: `/app?drive=${ok ? "connected" : "connect-failed"}` }).end(); };
      try {
        const binding = await ctx.session?.();
        if (!binding || binding.userId !== ctx.requestUserId) return redirect(false);
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        const pending = consumeDriveState(getDb(), { ...binding, state: query.get("state") ?? "" });
        const code = query.get("code") ?? "";
        if (!pending || !code || query.has("error")) return redirect(false);
        const guard = async () => {
          const current = await ctx.session?.();
          if (!current || current.userId !== binding.userId || current.sessionId !== binding.sessionId) throw new Error("Drive session changed");
        };
        await accountDrive.completeDriveConsent(getDb(), binding, pending, code, requestOrigin(req), guard);
        redirect(true);
      } catch { redirect(false); }
    },
  },
  {
    // Installation-scoped workspace storage: the v2 bundles and the Vault
    // belong to the whole installation, not one account — buildPayloadV2
    // reads the ENTIRE data directory, so on a shared host it would carry
    // other users' workspaces. Deny before any handler parses a body or
    // opens local files; even the primary hosted account must not export
    // shared data through a personal connection. The per-user account
    // push/pull entries below stay behind this wall on hosted until a
    // per-user bundle builder exists.
    match: (_method, path) => SELF_HOSTED
      && (path === "/api/workspace" || path.startsWith("/api/workspace/")
        || path === "/api/vault" || path.startsWith("/api/vault/")),
    handle: (_req, res) => json(res, 403, {
      code: "WORKSPACE_BACKUP_UNAVAILABLE",
      error: "Workspace backups are available on local desktop installs only for now.",
    }),
  },
  {
    match: (method, path) => path === "/api/workspace/v2/status" && (method === "GET" || method === "POST"),
    handle: (_req, res, ctx) => {
      const pending = readPendingRestore(ctx.dataDir());
      const receipt = readLastReceipt(ctx.dataDir());
      // the staging path is server-local bookkeeping — the UI never needs it
      const pendingView: { createdAt: number; source: string; reconsentRequired: unknown[]; counts?: unknown } | null =
        pending ? { createdAt: pending.createdAt, source: pending.source, reconsentRequired: pending.reconsentRequired } : null;
      if (pending && pendingView) pendingView.counts = pending.counts;
      const receiptView: { appliedAt: number; status: string; createdAt: number; source: string; reconsentRequired: unknown[]; error?: string; blocked?: { path: string; detail: string }[] } | null =
        receipt ? { appliedAt: receipt.appliedAt, status: receipt.status, createdAt: receipt.createdAt, source: receipt.source, reconsentRequired: receipt.reconsentRequired } : null;
      if (receipt && receiptView) {
        receiptView.error = receipt.error;
        receiptView.blocked = receipt.blocked;
      }
      json(res, 200, { pending: pendingView, receipt: receiptView });
    },
  },
  {
    match: (method, path) => path === "/api/workspace/v2/export" && method === "POST",
    handle: async (req, res, ctx) => {
      const body = await readBody(req);
      const passphrase = isText(body?.passphrase) ? body.passphrase : "";
      if (passphrase.length < 8) return json(res, 400, { error: "passphrase must be at least 8 characters" });
      try {
        const payload = bundleV2.buildPayloadV2({ dataDir: ctx.dataDir(), appVersion: ctx.appVersion() });
        const bytes = bundleV2.encryptBundleV2(payload, { passphrase });
        json(res, 200, {
          payload: bytes.toString("utf8"),
          counts: payload.counts,
          skipped: payload.skipped ?? [],
          skippedTruncated: payload.skippedTruncated === true,
        });
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    },
  },
  {
    match: (method, path) => path === "/api/workspace/v2/verify" && method === "POST",
    handle: async (req, res) => {
      const body = await readBody(req);
      const passphrase = isText(body?.passphrase) ? body.passphrase : "";
      const payload = payloadOf(body);
      if (!payload) return json(res, 400, { error: "payload is required" });
      const result = bundleV2.verifyBundleV2(Buffer.from(payload, "utf8"), { passphrase });
      json(res, 200, result);
    },
  },
  {
    match: (method, path) => path === "/api/workspace/v2/restore" && method === "POST",
    handle: async (req, res, ctx) => {
      const body = await readBody(req);
      const passphrase = isText(body?.passphrase) ? body.passphrase : "";
      const payload = payloadOf(body);
      if (!payload) return json(res, 400, { error: "payload is required" });
      if (body?.confirm !== true) return json(res, 400, { error: "restoring replaces the current fleet — send confirm: true to proceed" });
      const out = stageV2Restore(passphrase, payload, "file", ctx.dataDir());
      json(res, out.ok ? 200 : out.status, out.body);
    },
  },
  {
    match: (_method, path) => path === "/api/workspace/google/snapshots" && _method === "GET",
    handle: async (req, res, ctx) => {
      if (!ctx.requestUserId) return json(res, 501, ACCOUNT_DRIVE_OFF);
      try {
        const binding = await ctx.session?.();
        if (!binding || binding.userId !== ctx.requestUserId) return json(res, 401, { error: "Sign in again." });
        const guard = async () => {
          const current = await ctx.session?.();
          if (!current || current.userId !== binding.userId || current.sessionId !== binding.sessionId) throw new Error("Drive session changed");
        };
        const access = await accountDrive.accountDriveAccess(getDb(), binding.userId, requestOrigin(req), guard);
        await access.assertCurrent();
        const snapshots = await accountDrive.driveListSnapshotsFor(access.grant.accessToken, access.assertCurrent);
        await access.assertCurrent();
        json(res, 200, { snapshots });
      } catch (e) {
        json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    },
  },
  {
    match: (method, path) => method === "POST" && (path === "/api/workspace/google/push" || path === "/api/workspace/google/pull"),
    handle: async (req, res, ctx) => {
      // Session-bound: the push/pull transport moves this user's own bundle
      // through their own Drive grant. No session → contained 501, checked
      // before any body parsing, exactly like the other account routes.
      if (!ctx.requestUserId) return json(res, 501, ACCOUNT_DRIVE_OFF);
      const body = await readBody(req);
      const passphrase = isText(body?.passphrase) ? body.passphrase : "";
      if (passphrase.length < 8) return json(res, 400, { error: "passphrase must be at least 8 characters" });
      try {
        const binding = await ctx.session?.();
        if (!binding || binding.userId !== ctx.requestUserId) return json(res, 401, { error: "Sign in again to use your Drive backup." });
        const guard = async () => {
          const current = await ctx.session?.();
          if (!current || current.userId !== binding.userId || current.sessionId !== binding.sessionId) throw new Error("Drive session changed");
        };
        const access = await accountDrive.accountDriveAccess(getDb(), binding.userId, requestOrigin(req), guard);
        const accessToken = access.grant.accessToken;
        if (new URL(req.url ?? "/", "http://localhost").pathname === "/api/workspace/google/push") {
          const payload = bundleV2.buildPayloadV2({ dataDir: ctx.dataDir(), appVersion: ctx.appVersion() });
          const bytes = bundleV2.encryptBundleV2(payload, { passphrase });
          await access.assertCurrent();
          const snapshotId = await accountDrive.drivePushFor(accessToken, bytes.toString("utf8"), access.assertCurrent);
          await access.assertCurrent();
          syncState.stampSync("local", "push", "google-account");
          return json(res, 200, { uploaded: snapshotId, counts: payload.counts, skipped: payload.skipped ?? [] });
        }
        const snapshotId = isText(body?.snapshotId) ? body.snapshotId : undefined;
        const payloadText = snapshotId !== undefined
          ? await accountDrive.driveDownloadSnapshotFor(accessToken, snapshotId, access.assertCurrent)
          : await accountDrive.drivePullFor(accessToken, access.assertCurrent);
        await access.assertCurrent();
        if (!payloadText) return json(res, 404, { error: "no portable backup exists in your Google Drive yet — push from the other device first" });
        const out = stageV2Restore(passphrase, payloadText, "google-account", ctx.dataDir());
        if (out.ok) syncState.stampSync("local", "pull", "google-account");
        json(res, out.ok ? 200 : out.status, out.body);
      } catch (e) {
        json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    },
  },
  {
    match: (_method, path) => path === "/api/workspace/v2/restore/discard" && _method === "POST",
    handle: (_req, res, ctx) => {
      clearPendingRestore(ctx.dataDir());
      try {
        rmSync(stagingPathFor(ctx.dataDir()), { recursive: true, force: true });
      } catch {
        /* staging may already be gone */
      }
      json(res, 200, { discarded: true });
    },
  },
  {
    match: (method, path) => path === "/api/workspace/v2/drive/push" && method === "POST",
    handle: async (req, res, ctx) => {
      const body = await readBody(req);
      const passphrase = isText(body?.passphrase) ? body.passphrase : "";
      if (passphrase.length < 8) return json(res, 400, { error: "passphrase must be at least 8 characters" });
      const refreshToken = ctx.config().driveSync?.refreshToken;
      if (!refreshToken) return json(res, 400, { error: "Google Drive is not connected yet" });
      try {
        const token = await driveSync.refreshDriveToken(refreshToken);
        const payload = bundleV2.buildPayloadV2({ dataDir: ctx.dataDir(), appVersion: ctx.appVersion() });
        const bytes = bundleV2.encryptBundleV2(payload, { passphrase });
        const uploaded = await driveSync.uploadBundle(token.accessToken, bytes.toString("utf8"), driveSync.BUNDLE_V2_NAME);
        syncState.stampSync("local", "push", "google-drive");
        json(res, 200, { uploaded: uploaded.id, counts: payload.counts, skipped: payload.skipped ?? [] });
      } catch (e) {
        json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    },
  },
  {
    match: (method, path) => path === "/api/workspace/v2/drive/pull" && method === "POST",
    handle: async (req, res, ctx) => {
      const body = await readBody(req);
      const passphrase = isText(body?.passphrase) ? body.passphrase : "";
      if (passphrase.length < 8) return json(res, 400, { error: "passphrase must be at least 8 characters" });
      const cfg = ctx.config();
      const refreshToken = cfg.driveSync?.refreshToken;
      if (!refreshToken) return json(res, 400, { error: "Google Drive is not connected yet" });
      try {
        const token = await driveSync.refreshDriveToken(refreshToken);
        const payload = await driveSync.downloadBundle(token.accessToken, driveSync.BUNDLE_V2_NAME);
        if (cfg.driveSync?.refreshToken !== refreshToken) {
          return json(res, 409, { error: "Google Drive connection changed during download — check the connection and try again." });
        }
        if (!payload) return json(res, 404, { error: "no portable backup exists in Drive yet — push from the other device first" });
        const out = stageV2Restore(passphrase, payload, "google-drive", ctx.dataDir());
        if (out.ok) syncState.stampSync("local", "pull", "google-drive");
        json(res, out.ok ? 200 : out.status, out.body);
      } catch (e) {
        json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    },
  },
];

/** Entry point registered by index.ts: first table match wins, mirroring the
 * original inline if-chain exactly. Returns false when the family does not
 * claim the request, so index.ts continues its own chain unchanged. */
export async function handleWorkspaceBackupRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  requestUserId: string | null,
  env: {
    config(): AppConfig;
    appVersion(): string;
    dataDir(): string;
    session?(): Promise<{ userId: string; sessionId: string } | null>;
  },
): Promise<boolean> {
  const ctx: BackupRequestContext = { requestUserId, ...env };
  const route = routes.find((r) => r.match(method, path, ctx));
  if (!route) return false;
  await route.handle(req, res, ctx);
  return true;
}
