import { z } from "zod";

export const VISIBLE_DRIVE_PREFIX = "/api/workspace/drive-visible";
export const visibleReceiptSchema = z.object({ viewRevision: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  grantRevision: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const visibleStatusSchema = visibleReceiptSchema.extend({ available: z.boolean(), connected: z.boolean(),
  scope: z.literal("account-owned"), restoreApply: z.literal("unsupported"), settingsCaptured: z.boolean() });
export type VisibleStatus = z.infer<typeof visibleStatusSchema>;
const fileId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const visibleCopySchema = visibleReceiptSchema.extend({ status: z.literal("verified"), scope: z.literal("account-owned"),
  apply: z.literal("unsupported"), format: z.literal("account-recovery-v1"), fileId,
  sha256: digest, bytes: z.number().int().positive(), created: z.boolean() });
export const visibleInspectionSchema = visibleReceiptSchema.extend({ status: z.literal("ready"), format: z.literal("account-recovery-v1"),
  scope: z.literal("account-owned"), apply: z.literal("unsupported"), sourceDigest: digest,
  counts: z.object({ bots: z.number().int().nonnegative(), groups: z.number().int().nonnegative(),
    threads: z.number().int().nonnegative(), messages: z.number().int().nonnegative(),
    plans: z.number().int().nonnegative(), transitions: z.number().int().nonnegative() }) });
export const visibleCaptureSchema = visibleReceiptSchema.extend({ captured: z.literal(true), values: z.record(z.string(),
  z.union([z.string(), z.number().finite(), z.boolean(), z.null()])), droppedSettings: z.array(z.string()) });
export const visibleConsentSchema = visibleReceiptSchema.extend({ authorizationUrl: z.string().max(8192),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number().int().positive() });
export type VisibleBinding = { userId: string; sessionId: string; sessionToken: string; origin: string };

class VisibleBrowserFailure extends Error {}
export function visibleBrowserErrorText(failure: Error | null): string {
  return failure instanceof VisibleBrowserFailure ? failure.message : "Drive operation could not be confirmed. Refresh the status before retrying.";
}

const sessionSchema = z.object({ user: z.object({ id: z.string().min(1) }), session: z.object({
  id: z.string().min(1), userId: z.string().min(1), token: z.string().min(1), expiresAt: z.string(),
}) });
const errorSchema = z.object({ error: z.string().max(200), reconnectRequired: z.boolean().optional(),
  copyPreserved: z.boolean().optional(), createdFileId: fileId.optional() });

/** Only a deliberately owned popup can complete this consent. Neither an
 * existing connected grant nor a message from another window proves success. */
export function visibleAuthorizationUrl(input: z.infer<typeof visibleConsentSchema>, origin: string): string {
  let url: URL;
  try { url = new URL(input.authorizationUrl); } catch { throw new VisibleBrowserFailure("Drive consent could not be verified. Please retry."); }
  const scope = url.searchParams.get("scope")?.split(/\s+/).filter(Boolean).sort();
  if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth"
    || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)
    || url.searchParams.get("state") !== input.state
    || url.searchParams.get("redirect_uri") !== `${origin}${VISIBLE_DRIVE_PREFIX}/callback`
    || JSON.stringify(scope) !== JSON.stringify(["https://www.googleapis.com/auth/drive.file", "openid"])
    || url.searchParams.get("response_type") !== "code") throw new VisibleBrowserFailure("Drive consent could not be verified. Please retry.");
  return url.toString();
}

export function visiblePopupResult(href: string, text: string, state: string, origin: string):
  ({ status: "connected" } & z.infer<typeof visibleReceiptSchema>) | { status: "declined" } | null {
  const url = new URL(href);
  if (url.origin !== origin || url.pathname !== `${VISIBLE_DRIVE_PREFIX}/callback` || url.hash
    || url.searchParams.get("state") !== state || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)
    || text.length > 4096) return null;
  let offered: unknown;
  try { offered = JSON.parse(text); } catch { return null; }
  const receipt = visibleReceiptSchema.extend({ connected: z.literal(true), scope: z.literal("account-owned") }).strict().safeParse(offered);
  if (receipt.success && !!url.searchParams.get("code") && !url.searchParams.has("error"))
    return { status: "connected", viewRevision: receipt.data.viewRevision, grantRevision: receipt.data.grantRevision };
  if (z.object({ error: z.string().max(200) }).strict().safeParse(offered).success) return { status: "declined" };
  return null;
}

export type VisibleFailureBody = z.infer<typeof errorSchema>;
export type VisibleRouteBody = Record<string, never> | { state: string } | { values: Record<string, string | number | boolean | null> }
  | { format: "account-recovery-v1"; passphrase: string; fileId?: string };
export function visibleFailureText(error: VisibleFailureBody | null): string {
  if (!error) return "Drive operation could not be confirmed. Refresh the status before retrying.";
  if (error.copyPreserved && error.createdFileId) return `The copy was preserved (${error.createdFileId}), but verification failed. No restore was applied.`;
  if (error.reconnectRequired) return "Reconnect this optional Drive connection before retrying.";
  if (["session-unavailable", "authority-changed", "account-changed", "grant-changed", "consent-changed", "view-changed"].includes(error.error))
    return "Your account or connection changed. Refresh the status before retrying.";
  if (error.error === "provider-unavailable") return "Optional Drive copies are unavailable on this workspace.";
  if (error.error === "consent-declined") return "Drive consent was declined. Existing backups were preserved.";
  if (error.error === "settings-unavailable" || error.error === "source-unavailable") return "Capture your preferences before creating a copy.";
  if (error.error === "restore-inspection-unavailable") return "The copy could not be inspected. Check its ID and passphrase; no restore was applied.";
  return "Drive operation could not be confirmed. Refresh the status before retrying.";
}

/** Pins the real signed session and workspace before/after each await. The
 * client never turns an old 401 into navigation or retries under a new cookie. */
export function createVisibleBrowserClient(binding: VisibleBinding, stillBound: () => boolean, fetcher: typeof fetch = fetch) {
  let active = true;
  let viewRevision: string | undefined;
  const controllers = new Set<AbortController>();
  const current = () => active && stillBound();
  const assertCurrent = () => { if (!current()) throw new VisibleBrowserFailure("Your account or connection changed. Refresh the status before retrying."); };
  const interrupted = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    let abort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new VisibleBrowserFailure("The request was cancelled. Refresh the status before retrying."));
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
    try { return await Promise.race([promise, cancelled]); } finally { signal.removeEventListener("abort", abort); }
  };
  const proof = async (signal: AbortSignal, live = assertCurrent) => {
    live();
    const response = await interrupted(fetcher("/api/auth/get-session?disableCookieCache=true", { credentials: "include", cache: "no-store", redirect: "error", signal }), signal);
    live();
    if (!response.ok) throw new VisibleBrowserFailure("Your sign-in could not be checked. Reconnect before retrying.");
    const parsed = sessionSchema.safeParse(await interrupted(response.json(), signal));
    live();
    if (!parsed.success || parsed.data.user.id !== binding.userId || parsed.data.session.userId !== binding.userId
      || parsed.data.session.id !== binding.sessionId || parsed.data.session.token !== binding.sessionToken
      || !Number.isFinite(Date.parse(parsed.data.session.expiresAt)) || Date.parse(parsed.data.session.expiresAt) <= Date.now())
      throw new VisibleBrowserFailure("Your account or connection changed. Refresh the status before retrying.");
  };
  const changed = () => new VisibleBrowserFailure("Your account, workspace or connection changed. Reopen Backups before retrying.");
  const read = async (action: string, signal: AbortSignal, body?: VisibleRouteBody, grantPrecondition?: string) => {
    assertCurrent();
    const headers = new Headers({ "content-type": "application/json" });
    if (viewRevision) headers.set("x-muster-visible-view", viewRevision);
    if (grantPrecondition) headers.set("x-muster-visible-grant", grantPrecondition);
    const pending = fetcher(`${VISIBLE_DRIVE_PREFIX}/${action}`, { method: body === undefined ? "GET" : "POST",
      credentials: "include", cache: "no-store", redirect: "error", signal,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body) });
    void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
    const response = await interrupted(pending, signal); assertCurrent();
    const value: unknown = await interrupted(response.json(), signal); assertCurrent();
    if (!response.ok) { const error = errorSchema.safeParse(value); throw new VisibleBrowserFailure(visibleFailureText(error.success ? error.data : null)); }
    return value;
  };
  const statusProof = async (signal: AbortSignal) => {
    const parsed = visibleStatusSchema.safeParse(await read("status", signal));
    if (!parsed.success) throw new VisibleBrowserFailure("Drive operation returned an unsupported response. No restore was applied.");
    if (viewRevision !== undefined && parsed.data.viewRevision !== viewRevision) throw changed();
    viewRevision = parsed.data.viewRevision;
    return parsed.data;
  };
  const retireConsent = async (state: string, revision: string) => {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 5000);
    const live = () => { if (!stillBound() || controller.signal.aborted) throw changed(); };
    try {
      live(); await proof(controller.signal, live); live();
      const headers = new Headers({ "content-type": "application/json", "x-muster-visible-view": revision });
      const statusResponse = await interrupted(fetcher(`${VISIBLE_DRIVE_PREFIX}/status`, { credentials: "include", cache: "no-store", redirect: "error", signal: controller.signal, headers }), controller.signal);
      live();
      if (!statusResponse.ok) return;
      const currentStatus = visibleStatusSchema.safeParse(await interrupted(statusResponse.json(), controller.signal));
      live();
      if (!currentStatus.success || currentStatus.data.viewRevision !== revision) return;
      await proof(controller.signal, live); live();
      headers.set("x-muster-visible-grant", currentStatus.data.grantRevision);
      const response = await interrupted(fetcher(`${VISIBLE_DRIVE_PREFIX}/cancel`, { method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        signal: controller.signal, headers, body: JSON.stringify({ state }) }), controller.signal);
      void response.body?.cancel().catch(() => undefined);
    } catch { /* A retired account or offline transport leaves only the bounded server state TTL. */ }
    finally { clearTimeout(timeout); controller.abort(); }
  };
  return {
    current,
    dispose(ownedConsentState?: string) {
      active = false; for (const controller of controllers) controller.abort(); controllers.clear();
      if (ownedConsentState && /^[A-Za-z0-9_-]{43}$/.test(ownedConsentState) && viewRevision)
        void retireConsent(ownedConsentState, viewRevision);
    },
    async request<T>(action: "status" | "consent" | "cancel" | "disconnect" | "settings" | "backup" | "restore/inspect",
      schema: z.ZodType<T>, body?: VisibleRouteBody): Promise<T> {
      const controller = new AbortController(); controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 120_000);
      const live = () => { assertCurrent(); if (controller.signal.aborted) throw new VisibleBrowserFailure("The request was cancelled. Refresh the status before retrying."); };
      try {
        await proof(controller.signal); live();
        // Resolve the server's actual workspace fallback, rather than assuming
        // that a possibly absent client activeOrganizationId is authority.
        const before = await statusProof(controller.signal); live();
        const value = action === "status" ? before : await read(action, controller.signal, body, before.grantRevision); live();
        const parsed = schema.safeParse(value);
        const receipt = visibleReceiptSchema.safeParse(value);
        if (!parsed.success || !receipt.success) throw new VisibleBrowserFailure("Drive operation returned an unsupported response. No restore was applied.");
        await proof(controller.signal); live();
        const after = await statusProof(controller.signal); live();
        await proof(controller.signal); live();
        // A refresh owned by this operation may replace encrypted token bytes.
        // Its reply must still equal the latest custody, while the stable
        // signed account/workspace view must remain the original one.
        if (before.viewRevision !== receipt.data.viewRevision || after.viewRevision !== receipt.data.viewRevision
          || after.grantRevision !== receipt.data.grantRevision) throw changed();
        return parsed.data;
      } catch (failure) {
        if (failure instanceof VisibleBrowserFailure) throw failure;
        throw new VisibleBrowserFailure("Drive operation could not be confirmed. Refresh the status before retrying.");
      } finally { clearTimeout(timeout); controllers.delete(controller); controller.abort(); }
    },
  };
}
