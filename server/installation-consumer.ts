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
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.trim();
  }
}

export function loadPersistedInstallation(path: string, authority: string): PersistedInstallation | null {
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
    if (parsed.data.authority !== authorityOf(authority)) return unbound(parsed.data);
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
      authority,
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
  id: z.string(),
  label: z.string(),
  platform: z.string(),
  capabilities: z.array(z.string()),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  revokedAt: z.number().nullable(),
});

export class InstallationConsumer {
  private path: string;
  private state: PersistedInstallation;
  private fetchJson: FetchLike;
  private baseUrl: string;
  /** The origin whose credential this machine may present. Fixed at
   *  construction, which is what makes it a fence rather than a mutable field. */
  private authority: string;
  private durable = true;
  /** Absolute time the credential must be renewed before, by the injected clock. */
  private renewBeforeMs = 60 * 60_000;

  constructor(
    { dataDirectory, baseUrl, fetchJson = fetch }: { dataDirectory: string; baseUrl: string; fetchJson?: FetchLike },
    now = Date.now(),
  ) {
    this.path = installationConsumerPath(dataDirectory);
    this.baseUrl = baseUrl;
    this.fetchJson = fetchJson;
    this.authority = authorityOf(this.baseUrl);
    this.state = loadPersistedInstallation(this.path, this.authority) ?? {
      version: CONSUMER_VERSION,
      authority: this.authority,
      clientKey: `inst-${randomBytes(12).toString("base64url")}`,
      label: "This machine",
      platform: "macos",
      installationId: null,
      credential: null,
      credentialExpiresAt: null,
      updatedAt: now,
    };
    // The stable client key is the machine's identity anchor: it exists on
    // disk before any credential, so a registration that survives only as a
    // client key still reconciles to one row. A failed first write shows up
    // in isDurable rather than being hidden.
    if (!existsSync(this.path)) this.persist(now);
  }

  /** The stable client key: persisted with the credential, or minted once
   * and written even when nothing else exists yet, so a future registration
   * reconciles to the same row instead of a second machine. */
  get clientKey(): string {
    return this.state.clientKey;
  }

  get status(): InstallationConsumerStatus {
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
      return false;
    }
  }

  /** False when the last write failed — callers surface that instead of
   * claiming a durability they do not have. */
  get isDurable(): boolean {
    return this.durable;
  }

  /** Owner-driven attach: POST /register WITH the owner's session and THIS
   * machine's stable client key. The answer's one-time credential is stored
   * for the machine's own later use. Idempotent per client key — a lost
   * provisioning response reconciles to the same row, fresh secret. */
  async registerThroughOwner(
    sessionCookie: string,
    input: RegisterThroughOwnerInput,
    now = Date.now(),
  ): Promise<{ installationId: string; reactivated: boolean }> {
    this.state.clientKey = input.clientKey || this.state.clientKey;
    this.state.label = input.label || this.state.label;
    this.state.platform = input.platform;
    const response = await this.fetchJson(`${this.baseUrl}/api/installations/register`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie },
      body: JSON.stringify({ clientKey: this.state.clientKey, label: this.state.label, platform: this.state.platform }),
    });
    if (!response.ok) {
      throw new Error(`Installation registration failed: HTTP ${response.status}`);
    }
    const body = registerAnswer.parse(await response.json());
    if (body.credential === undefined) {
      throw new Error("Installation registration answered without a credential");
    }
    this.state.installationId = body.installation.id;
    this.state.credential = body.credential;
    // The server states the mint's expiry; null only from an older server.
    this.state.credentialExpiresAt = body.credentialExpiresAt ?? null;
    const saved = this.persist(now);
    if (!saved) throw new Error("The installation credential could not be stored locally");
    return { installationId: body.installation.id, reactivated: body.reactivated };
  }

  /** One bearer call: who am I, am I still active. Returns the report; throws
   * only on transport failure (offline is DEGRADED, not out-of-sync). */
  async heartbeat(now = Date.now()): Promise<ConsumerReport> {
    if (this.state.credential === null || this.state.installationId === null) {
      return { status: "unregistered", installationId: null, expiresAt: null, refreshed: false };
    }
    // The credential THIS request carried, captured before the await. A 401
    // may only ever clear its own credential.
    const sent = this.state.credential;
    let response: Response;
    try {
      response = await this.fetchJson(`${this.baseUrl}/api/installations/self`, {
        headers: { authorization: `Bearer ${sent}` },
      });
    } catch (error) {
      throw new Error(`Installation heartbeat transport failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401) {
      // A 401 is a statement about the credential that was sent, not about
      // whatever happens to be in state now. Before this, a refresh that
      // completed while the heartbeat was in flight was erased by the
      // heartbeat's older 401: the machine came back "unregistered" while
      // holding a perfectly good new secret, and only a restart or a manual
      // re-attach could recover it. If state has moved on, this response is
      // stale and carries no information about the current credential.
      if (this.state.credential !== sent) {
        return this.reportForCurrentCredential(now);
      }
      this.state.installationId = null;
      this.state.credential = null;
      this.state.credentialExpiresAt = null;
      this.persist(now);
      return { status: "out-of-sync", installationId: null, expiresAt: null, refreshed: false };
    }
    if (!response.ok) {
      throw new Error(`Installation heartbeat failed: HTTP ${response.status}`);
    }
    const body = selfAnswer.parse(await response.json());
    // Approaching expiry without a refresh path is flagged, not ignored.
    const expiresAt = this.state.credentialExpiresAt;
    const status: InstallationConsumerStatus = expiresAt !== null && expiresAt - now < this.renewBeforeMs ? "expiring" : "active";
    return { status, installationId: body.installation.id, expiresAt, refreshed: false };
  }

  /** The honest report when the caller has told us nothing about the current
   *  credential: derive it from the credential actually held, exactly as a
   *  successful heartbeat does, rather than defaulting to out-of-sync. */
  private reportForCurrentCredential(now: number): ConsumerReport {
    if (this.state.credential === null || this.state.installationId === null) {
      return { status: "unregistered", installationId: null, expiresAt: null, refreshed: false };
    }
    const expiresAt = this.state.credentialExpiresAt;
    const status: InstallationConsumerStatus = expiresAt !== null && expiresAt - now < this.renewBeforeMs ? "expiring" : "active";
    return { status, installationId: this.state.installationId, expiresAt, refreshed: false };
  }

  /** Exchange the current credential for a fresh one before it expires. The
   * old one stops working at mint time server-side; the new one is persisted
   * BEFORE the call returns, so a crash between mint and store loses only
   * the renewal, not the machine's standing. */
  async refreshCredential(now = Date.now()): Promise<{ credential: string; expiresAt: number | null }> {
    if (this.state.credential === null) throw new Error("No installation credential to refresh");
    const response = await this.fetchJson(`${this.baseUrl}/api/installations/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.state.credential}` },
    });
    if (response.status === 401) {
      this.state.installationId = null;
      this.state.credential = null;
      this.state.credentialExpiresAt = null;
      this.persist(now);
      throw new Error("Installation credential was refused at refresh — re-register through the owner");
    }
    if (!response.ok) {
      throw new Error(`Installation refresh failed: HTTP ${response.status}`);
    }
    const body = refreshAnswer.parse(await response.json());
    this.state.credential = body.credential;
    // The server states the new mint's expiry; null only from an older server.
    this.state.credentialExpiresAt = body.credentialExpiresAt ?? null;
    const saved = this.persist(now);
    if (!saved) throw new Error("The refreshed installation credential could not be stored locally");
    return { credential: body.credential, expiresAt: this.state.credentialExpiresAt };
  }

  /** Owner-driven revocation from THIS machine's side: drop the secret. The
   * server-side row is revoked by the owner's session route, not by us. */
  forget(): void {
    this.state.installationId = null;
    this.state.credential = null;
    this.state.credentialExpiresAt = null;
    this.persist(Date.now());
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
