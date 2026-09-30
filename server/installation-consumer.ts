// The credential CONSUMER for the stable installation authority
// (server/installation-authority.ts). The registry mints one-time bearer
// credentials; this module is the machine side that holds one:
//
//   register    through the OWNER'S SESSION (attach flow) — the answer's
//               credential is persisted here in a 0600 file, next to the
//               stable client key that reconciles a lost provisioning
//               response (same key, same row, fresh secret)
//   self        one bearer call: who am I on this server, am I still active
//   heartbeat   self on an interval; 401 is definitive — revoked or expired
//               means OUT OF SYNC, never a silent re-register (attaching a
//               machine to an account is the owner's act, not a loop's)
//   refresh     exchange the current UNEXPIRED credential for a fresh one
//               before expiry; an expired credential refreshes nothing
//               (re-register through the owner's session instead)
//
// Trust boundary: the file is 0600 in the data directory; the credential is
// a registration bootstrap secret, never a task permission; losing the file
// loses the machine's identity until its owner re-attaches, which the stable
// client key makes idempotent. The HTTP function is injected so tests run
// deterministically and no fetch happens at import time.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { platformWire } from "./installation-authority.ts";

const CONSUMER_VERSION = 2;
/** Version 1 predates authority binding: a credential in a v1 file was minted
 *  by whichever server that data directory last pointed at, and nothing in the
 *  file recorded which. Those files fail closed below rather than being
 *  trusted or silently upgraded. */
const LEGACY_CONSUMER_VERSION = 1;
const REQUEST_TIMEOUT_MS = 15_000;

const persistedWire = z.object({
  version: z.literal(CONSUMER_VERSION),
  /** The origin this credential was minted by and may be sent to. A
   *  credential is a bearer for ONE authority; without this, pointing the same
   *  data directory at a different base URL shipped the old secret there. */
  authority: z.string().min(1),
  clientKey: z.string().min(1),
  label: z.string().min(1),
  platform: platformWire,
  installationId: z.string().min(1).nullable(),
  credential: z.string().min(1).nullable(),
  credentialExpiresAt: z.number().refine(Number.isFinite).nullable(),
  updatedAt: z.number().refine(Number.isFinite),
});

export interface PersistedInstallation {
  version: typeof CONSUMER_VERSION;
  /** The origin this credential belongs to. A credential minted by one server
   *  is never presented to another; see loadPersistedInstallation. */
  authority: string;
  clientKey: string;
  label: string;
  platform: z.infer<typeof platformWire>;
  installationId: string | null;
  credential: string | null;
  credentialExpiresAt: number | null;
  updatedAt: number;
}

export function installationConsumerPath(dataDir: string): string {
  return `${dataDir}/installation-credential.json`;
}

/** Read persisted state for ONE authority.
 *
 * `authority` is required, not optional: the whole point is that a caller
 * cannot read a credential without saying where it is going, so an omitted
 * authority is not a way to bypass the check. Mismatched or legacy state comes
 * back with its credential and installation id cleared and its stable client
 * key intact, which is a machine that knows who it is and must explicitly
 * re-attach — not one that is holding a secret for someone else.
 */
/** The authority a base URL names. Compared as an ORIGIN so a trailing slash,
 *  a path prefix or a default port does not read as a different server — the
 *  comparison is about which server, not which spelling. */
function authorityOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("An installation authority must be an HTTP(S) URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("An installation authority must be an HTTP(S) URL without user information");
  }
  if (url.protocol === "http:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new Error("An installation authority requires HTTPS except on loopback");
  }
  return url.origin;
}

export function loadPersistedInstallation(path: string, authority: string): PersistedInstallation | null {
  const origin = authorityOf(authority);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Corrupt state never presents a secret it cannot vouch for.
    return null;
  }
  const parsed = persistedWire.safeParse(raw);
  if (parsed.success) {
    // Normalise HERE as well as in the constructor. Normalising only at the
    // write site meant the comparison depended on which caller asked, so the
    // same origin spelled with a trailing slash or an explicit :443 read as a
    // different server and locked a healthy machine out of its own credential.
    if (parsed.data.authority !== origin) return { ...unbound(parsed.data), authority: origin };
    return parsed.data;
  }
  // A v1 file parses as a v2 file with `authority` missing, so it lands here.
  // Keep the machine's identity, drop everything that is a secret for a server
  // this file never named.
  const legacy = z.object({
    version: z.literal(LEGACY_CONSUMER_VERSION),
    clientKey: z.string().min(1),
    label: z.string().min(1),
    platform: platformWire,
  }).safeParse(raw);
  if (legacy.success) {
    return {
      version: CONSUMER_VERSION,
      authority: origin,
      clientKey: legacy.data.clientKey,
      label: legacy.data.label,
      platform: legacy.data.platform,
      installationId: null,
      credential: null,
      credentialExpiresAt: null,
      updatedAt: 0,
    };
  }
  return null;
}

/** Same file, read by a different authority: identity kept, secret dropped. */
function unbound(state: PersistedInstallation): PersistedInstallation {
  return {
    ...state,
    installationId: null,
    credential: null,
    credentialExpiresAt: null,
  };
}

export type InstallationConsumerStatus =
  | "unregistered"
  | "active"
  | "expiring"
  | "out-of-sync"
  | "degraded";

export interface ConsumerReport {
  status: InstallationConsumerStatus;
  /** Set from the server's own view when self succeeded (last-known good). */
  installationId: string | null;
  expiresAt: number | null;
  /** True when the loop refreshed the credential this report. */
  refreshed: boolean;
}

export interface RegisterThroughOwnerInput {
  clientKey: string;
  label: string;
  platform: z.infer<typeof platformWire>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const installationWire = z.object({
  id: z.string().min(1),
  label: z.string(),
  platform: z.string(),
  capabilities: z.array(z.string()),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  revokedAt: z.number().nullable(),
});

interface RequestBinding {
  epoch: number;
  credential: string | null;
  installationId: string | null;
}

type RefreshResult = { credential: string; expiresAt: number | null };

function runtimePlatform(): z.infer<typeof platformWire> {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return "cli";
}

export class InstallationConsumer {
  private path: string;
  private state: PersistedInstallation;
  private fetchJson: FetchLike;
  /** Fixed at construction: no existing secret can follow an endpoint change. */
  private authority: string;
  private durable = true;
  private epoch = 0;
  private requests = new Set<AbortController>();
  private refreshInFlight: { binding: RequestBinding; promise: Promise<RefreshResult> } | null = null;
  private renewBeforeMs = 60 * 60_000;

  constructor(
    { dataDirectory, baseUrl, fetchJson = fetch }: { dataDirectory: string; baseUrl: string; fetchJson?: FetchLike },
    now = Date.now(),
  ) {
    this.path = installationConsumerPath(dataDirectory);
    this.fetchJson = fetchJson;
    this.authority = authorityOf(baseUrl);
    const loaded = loadPersistedInstallation(this.path, this.authority);
    this.state = loaded ?? {
      version: CONSUMER_VERSION,
      authority: this.authority,
      clientKey: `inst-${randomBytes(12).toString("base64url")}`,
      label: "This machine",
      platform: runtimePlatform(),
      installationId: null,
      credential: null,
      credentialExpiresAt: null,
      updatedAt: now,
    };
    // Persist a fresh identity even when replacing a corrupt file. No request
    // may provision a machine whose stable key has not reached disk.
    if (!loaded) this.persist(now);
  }

  get clientKey(): string {
    return this.state.clientKey;
  }

  /** Local credential presence, not proof of current server reachability. */
  get status(): InstallationConsumerStatus {
    if (!this.durable) return "degraded";
    if (this.state.credential === null || this.state.installationId === null) return "unregistered";
    return "active";
  }

  private persist(now: number): boolean {
    this.state.updatedAt = now;
    try {
      writeFileAtomic(this.path, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      this.durable = true;
      return true;
    } catch {
      this.durable = false;
      // A mint may already have invalidated the old server-side credential.
      // Neither an unstored replacement nor an old in-memory secret may be
      // used after this failure. Recovery requires an explicit owner attach.
      this.invalidatePending();
      this.state = unbound(this.state);
      return false;
    }
  }

  private binding(): RequestBinding {
    return { epoch: this.epoch, credential: this.state.credential, installationId: this.state.installationId };
  }

  private isCurrent(binding: RequestBinding): boolean {
    return this.durable && binding.epoch === this.epoch
      && binding.credential === this.state.credential
      && binding.installationId === this.state.installationId;
  }

  private assertCurrent(binding: RequestBinding): void {
    if (!this.isCurrent(binding)) throw new Error("The installation attachment changed while the request was pending");
  }

  private invalidatePending(): void {
    this.epoch += 1;
    this.refreshInFlight = null;
    for (const controller of this.requests) {
      controller.abort(new Error("The installation attachment changed while the request was pending"));
    }
    this.requests.clear();
  }

  private clearCredential(now: number): void {
    this.invalidatePending();
    this.state = unbound(this.state);
    this.persist(now);
  }

  /** One deadline covers headers AND body consumption. Racing the abort also
   * bounds injected transports that do not implement AbortSignal themselves;
   * their late completions still have to pass both fences before use. */
  private async request(
    route: string,
    init: RequestInit,
    binding: RequestBinding,
  ): Promise<{ response: Response; body: unknown }> {
    this.assertCurrent(binding);
    const controller = new AbortController();
    this.requests.add(controller);
    // Every cancellation below is created here as an Error.
    let rejectAbort: (reason: Error) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Installation request timed out")), REQUEST_TIMEOUT_MS);
    const check = () => {
      controller.signal.throwIfAborted();
      this.assertCurrent(binding);
    };
    try {
      const work = async () => {
        const response = await this.fetchJson(`${this.authority}${route}`, {
          ...init, redirect: "error", signal: controller.signal,
        });
        check();
        if (response.redirected || (response.url && authorityOf(response.url) !== this.authority)) {
          throw new Error("The installation response came from an unexpected authority");
        }
        // Error bodies carry no credentials or state we need to consume.
        if (!response.ok) {
          // We need only the status. Do not leave an unconsumed error stream
          // holding a socket, and do not await an untrusted body to cancel it.
          void response.body?.cancel().catch(() => undefined);
          return { response, body: undefined };
        }
        const body: unknown = await response.json();
        check();
        return { response, body };
      };
      return await Promise.race([work(), aborted]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      this.requests.delete(controller);
    }
  }

  /** False when the last write failed. No bearer requests are allowed then. */
  get isDurable(): boolean {
    return this.durable;
  }

  /** Explicit owner attach. A lost provisioning response is reconciled by
   * the same durable key on the owner's next attach, never by an auto retry. */
  async registerThroughOwner(
    sessionCookie: string,
    input: RegisterThroughOwnerInput,
    now = Date.now(),
  ): Promise<{ installationId: string; reactivated: boolean }> {
    // An explicit attach supersedes every earlier attachment immediately.
    // Save the identity before contacting the authority so a lost response
    // can be reconciled with the same stable key after a restart.
    this.invalidatePending();
    this.state = {
      ...unbound(this.state), authority: this.authority,
      clientKey: input.clientKey || this.state.clientKey,
      label: input.label || this.state.label, platform: input.platform,
    };
    if (!this.persist(now)) throw new Error("The installation identity could not be stored locally");
    const binding = this.binding();
    const { response, body: raw } = await this.request("/api/installations/register", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie },
      body: JSON.stringify({ clientKey: this.state.clientKey, label: this.state.label, platform: this.state.platform }),
    }, binding);
    this.assertCurrent(binding);
    if (!response.ok) throw new Error(`Installation registration failed: HTTP ${response.status}`);
    const body = registerAnswer.parse(raw);
    if (body.installation.revokedAt !== null) throw new Error("Installation registration answered with a revoked installation");
    if (body.credential === undefined) throw new Error("Installation registration answered without a credential");
    this.state.installationId = body.installation.id;
    this.state.credential = body.credential;
    // Null is retained for compatibility with an older authority.
    this.state.credentialExpiresAt = body.credentialExpiresAt ?? null;
    if (!this.persist(now)) throw new Error("The installation credential could not be stored locally");
    return { installationId: body.installation.id, reactivated: body.reactivated };
  }

  /** One bearer proof. Transport errors preserve the local identity; only a
   * current refusal, mismatched identity or revoked row invalidates it. */
  async heartbeat(now = Date.now()): Promise<ConsumerReport> {
    if (!this.durable || this.state.credential === null || this.state.installationId === null) {
      return this.reportForCurrentCredential(now);
    }
    const binding = this.binding();
    // A renewal owns the outcome of its credential until its response settles.
    // A concurrent self request could otherwise see the old secret's 401 in
    // the gap between server rotation and receipt of the new secret.
    const pendingRefresh = this.refreshInFlight;
    if (pendingRefresh && this.isCurrent(pendingRefresh.binding)) {
      try {
        await pendingRefresh.promise;
      } catch {
        if (this.isCurrent(binding)) throw new Error("Installation heartbeat could not verify a failed refresh");
      }
      return this.reportForCurrentCredential(now);
    }
    let result: { response: Response; body: unknown };
    try {
      result = await this.request("/api/installations/self", {
        headers: { authorization: `Bearer ${binding.credential}` },
      }, binding);
    } catch {
      if (!this.isCurrent(binding)) return this.reportForCurrentCredential(now);
      throw new Error("Installation heartbeat transport failed");
    }
    if (!this.isCurrent(binding)) return this.reportForCurrentCredential(now);
    const refresh = this.refreshInFlight;
    if (refresh && this.isCurrent(refresh.binding)) {
      try {
        await refresh.promise;
        return this.reportForCurrentCredential(now);
      } catch {
        if (!this.isCurrent(binding)) return this.reportForCurrentCredential(now);
        // The refresh failed without changing the binding. This heartbeat
        // still answers for the credential we hold, so honor its own result.
      }
    }
    const { response, body: raw } = result;
    if (response.status === 401) {
      this.clearCredential(now);
      return { ...this.reportForCurrentCredential(now), status: this.durable ? "out-of-sync" : "degraded" };
    }
    if (!response.ok) throw new Error(`Installation heartbeat failed: HTTP ${response.status}`);
    const body = selfAnswer.parse(raw);
    if (body.installation.id !== binding.installationId || body.installation.revokedAt !== null) {
      this.clearCredential(now);
      return { ...this.reportForCurrentCredential(now), status: this.durable ? "out-of-sync" : "degraded" };
    }
    return this.reportForCurrentCredential(now);
  }

  /** A stale reply says nothing about the current binding. Report only the
   * currently held durable identity, never the identity in the stale body. */
  private reportForCurrentCredential(now: number): ConsumerReport {
    if (!this.durable) return { status: "degraded", installationId: null, expiresAt: null, refreshed: false };
    if (this.state.credential === null || this.state.installationId === null) {
      return { status: "unregistered", installationId: null, expiresAt: null, refreshed: false };
    }
    const expiresAt = this.state.credentialExpiresAt;
    const status: InstallationConsumerStatus = expiresAt !== null && expiresAt - now < this.renewBeforeMs ? "expiring" : "active";
    return { status, installationId: this.state.installationId, expiresAt, refreshed: false };
  }

  /** The old credential stops working at mint time server-side. A lost
   * response or failed local save can leave no usable credential; explicit
   * owner reattachment reconciles the stable identity. No automatic retry or
   * registration is performed here. Concurrent refreshes share one request. */
  async refreshCredential(now = Date.now()): Promise<RefreshResult> {
    if (!this.durable) throw new Error("The installation credential could not be stored locally — re-register through the owner");
    if (this.state.credential === null) throw new Error("No installation credential to refresh");
    const existing = this.refreshInFlight;
    if (existing && this.isCurrent(existing.binding)) return existing.promise;
    const binding = this.binding();
    const pending = { binding, promise: this.refreshBoundCredential(binding, now) };
    this.refreshInFlight = pending;
    try {
      return await pending.promise;
    } finally {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    }
  }

  private async refreshBoundCredential(binding: RequestBinding, now: number): Promise<RefreshResult> {
    const { response, body: raw } = await this.request("/api/installations/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${binding.credential}` },
    }, binding);
    this.assertCurrent(binding);
    if (response.status === 401) {
      this.clearCredential(now);
      throw new Error("Installation credential was refused at refresh — re-register through the owner");
    }
    if (!response.ok) throw new Error(`Installation refresh failed: HTTP ${response.status}`);
    const body = refreshAnswer.parse(raw);
    this.state.credential = body.credential;
    this.state.credentialExpiresAt = body.credentialExpiresAt ?? null;
    if (!this.persist(now)) throw new Error("The refreshed installation credential could not be stored locally");
    return { credential: body.credential, expiresAt: this.state.credentialExpiresAt };
  }

  /** Forgetting is local detachment, NOT server revocation. It invalidates
   * pending replies and clears the live secret even if persistence fails.
   * Check isDurable: a failed write can leave the previous file available on
   * restart. Only the owner's server-side revoke makes that secret unusable
   * at the authority; this method cannot promise durable revocation. */
  forget(): void {
    this.clearCredential(Date.now());
  }
}

const registerAnswer = z.object({
  installation: installationWire,
  reactivated: z.boolean(),
  credential: z.string().min(1).optional(),
  credentialExpiresAt: z.number().refine(Number.isFinite).optional(),
});

const selfAnswer = z.object({ installation: installationWire });

const refreshAnswer = z.object({
  credential: z.string().min(1),
  credentialExpiresAt: z.number().refine(Number.isFinite).optional(),
});
