// W1b synthetic enrollment contract — DISABLED BY DEFAULT, no route wiring.
//
// What this is. Ordinary login hands a client `{ email, name }` and registers
// nothing. Enrollment is a DIFFERENT act: it registers an installation, binds
// it to a canonical cloud subject and a local owner, and grants nothing else.
// The two were easy to conflate because both start with a sign-in, so this
// module keeps them apart on purpose:
//
//   ordinary login   unchanged response shape, zero registrations, zero
//                    authority, zero permission requests
//   enrollment       explicit discriminated purpose + explicit device
//                    confirmation, and every binding below proven
//
// Why a contract and not an endpoint. The boundaries that matter here
// (custody of a held attempt, invalidation on sign-out, protected-store
// failure, restart) cannot be proven by synthetic tests against a real route,
// and a real route cannot be safely enabled until native protected custody
// exists. So this slice defines and tests the rules and ships them
// INERT: `enrollmentEnabled` defaults false, nothing calls `complete()`
// except a caller that opted in, and no route, consumer or dispatcher imports
// this module yet. Passing every test in the companion suite does not turn
// enrollment on — that is a deliberate design property, not an oversight.
//
// What this module deliberately does NOT do:
//   - activate any route or wire task dispatch
//   - mint real authority or capabilities
//   - accept a legacy proof fallback (missing/plain/malformed fails closed)
//   - treat a local account matched BY EMAIL as proof of the cloud subject
//
// The threat this shape answers. A loopback OAuth handoff delivers identity
// over a channel any local process can race (see desktop-auth.ts). Enrollment
// is the step that turns that identity into something durable and powerful, so
// an enrollment that accepted "a local account with this email exists" or "a
// proof was absent but the shape looked right" would turn a spoofable signal
// into a registered installation. Everything below is bound explicitly so
// that no single spoofable input is sufficient.
//
// W2 additions, still inert. (1) The custody fence is PERSISTED: the fence
// registry writes through an injectable `FencePersistence` whose file-backed
// default lives under the data dir, so a fence survives the restart that used
// to lift it. (2) The binding names canonical identity provenance —
// {cloudSubject, cloudIssuer, workspaceId, clientKey} — where `cloudIssuer`
// is a strict HTTPS origin and a mismatched issuer is a refusal, per the
// recorded decision to treat the verified provider `sub` as identity and make
// issuer/audience/expiry/nonce validation the ID-token layer's job.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { FileFencePersistence, defaultEnrollmentFencePath } from "./installation-fence-persistence.ts";
import type { FencePersistence } from "./installation-fence-persistence.ts";

/** Enrollment is opt-in. Nothing here is reachable unless a caller flips
 * this on AND supplies a protected-store implementation. There is deliberately
 * no environment variable or route that sets it: enabling enrollment is an
 * explicit code decision by the integrator, made after native custody is
 * accepted, not a deployment toggle someone can turn on by accident. */
export const enrollmentEnabled = false as const;

/** Bumped when the wire shape changes. A client speaking another revision is
 * refused rather than misread — the same posture desktop-auth.ts takes with
 * EXCHANGE_VERSION. */
export const ENROLLMENT_PROTOCOL_VERSION = 1;

/** How long a proven intent stays redeemable. Short on purpose: this is a
 * bootstrap exchange, not a session. */
export const ENROLLMENT_INTENT_TTL_MS = 90_000;

/** Only workspace scope exists today. Named here so a future capability has
 * to be added deliberately rather than inherited from a request body. */
export const ENROLLMENT_CAPABILITIES = ["workspace"] as const;

export const enrollmentPlatformWire = z.enum([
  "ios",
  "watchos",
  "android",
  "macos",
  "windows",
  "linux",
  "cli",
  "web",
]);

export type EnrollmentPlatform = z.infer<typeof enrollmentPlatformWire>;

/** Why this enrollment is happening. Discriminated and explicit: an intent
 * with no purpose, or a purpose outside this list, is refused. There is no
 * "default purpose" — defaulting a purpose is how an enrollment becomes an
 * implicit side effect of signing in. */
export const enrollmentPurposeWire = z.enum(["replace-client", "add-device", "recover-device"]);

export type EnrollmentPurpose = z.infer<typeof enrollmentPurposeWire>;

/** Why a redemption was refused. Distinct codes exist so a test (and an
 * operator) can tell "you sent the wrong thing" from "you sent nothing",
 * rather than collapsing every failure into one opaque error. */
export type EnrollmentFailure =
  | "disabled"
  | "unknown-intent"
  | "expired"
  | "version"
  | "purpose"
  | "device-confirmation"
  | "subject"
  | "local-owner"
  | "local-session"
  | "authority"
  /** The binding's canonical issuer was malformed, or was canonical but is
   * not the deployment's trusted one. Distinct from `authority` (the
   * free-form authorization string) so an operator can tell "the issuer you
   * named is not ours" from "the authority string did not match". */
  | "issuer"
  | "device"
  | "client-key"
  | "state"
  | "proof"
  | "redirect"
  | "capability"
  | "superseded"
  | "cancelled"
  /** A write may have landed and cleanup could not be CONFIRMED. A usable
   * credential may still be in the store, so this is deliberately distinct from
   * an ordinary refusal and must fence the key locally. */
  | "custody-unresolved"
  | "intent-persist-failed"
  | "credential-persist-failed"
  | "credential-expired"
  | "session-changed"
  | "endpoint-changed";

export type EnrollmentResult<T> = { ok: true; value: T } | { ok: false; reason: EnrollmentFailure };

/** What begin returns. Named so the shape is a contract, not an inference. */
export interface EnrollmentBeginValue {
  intentId: string;
  challenge: string;
}

/* Input types.
 *
 * These are the SCHEMA's own input types, not `object` and not `unknown`. That
 * is the honest answer to "what can this function accept": whatever the
 * validator accepts, and nothing wider. `z.input` (rather than `z.infer`, which
 * is the OUTPUT type) is what makes that true — the parsed domain type would
 * be a lie, claiming the caller already did the validating this module is
 * about to do again, and `unknown` would refuse every legitimate caller while
 * advertising that a bare number is acceptable input.
 *
 * Every use still runs `safeParse` before a field is read; these types name the
 * contract rather than replace the check.
 */
export type EnrollmentRequestInput = z.input<typeof enrollmentRequestWire>;
export type EnrollmentBindingInput = z.input<typeof enrollmentBindingWire>;
export type ProtectedEnvelopeInput = z.input<typeof protectedEnvelopeWire>;

/** What a custody adapter is asked to protect. The credential appears HERE and
 * nowhere else: it is never placed on the envelope, never returned in an
 * outcome, and never logged. An adapter that cannot establish custody reports
 * failure and the caller mints nothing usable. */
export interface CustodyRequest {
  clientKey: string;
  installationId: string;
  /** The credential issued by the cloud. The adapter's job. */
  credential: string;
  /** Every authenticated binding that must travel with the secret. */
  binding: EnrollmentBinding;
  platform: EnrollmentPlatform;
  capabilities: string[];
  issuedAt: number;
  credentialExpiresAt: number;
}

/** A protected-store boundary. Deliberately tiny and deliberately with NO
 * plaintext fallback: if an implementation cannot store under protected
 * custody it must report failure. This is the seam where native custody plugs
 * in later — a mode-0600 file is NOT a conforming implementation.
 *
 * `commitIfCurrent` exists because a post-write boolean check is not enough: a
 * write that lands after the caller was invalidated is still a usable record
 * after a restart. The adapter must therefore make the write CONDITIONAL on
 * the generation the caller still holds, so a stale completion cannot install
 * a credential over a newer winner. */
export interface ProtectedCredentialStore {
  /** Seal the credential under protected custody and return an opaque handle,
   * or null when custody could not be established. */
  commit(request: CustodyRequest, expectedGeneration: string): Promise<ProtectedEnvelope | null>;
  get(clientKey: string): Promise<ProtectedEnvelope | null>;
  /** EXPLICIT read for cleanup verification.
   *
   * `get` returning null conflates "no record" with "the read failed", so it
   * cannot be used as proof of removal. This returns a discriminated result:
   * a genuinely absent row is `absent`, a failed or indeterminate read is
   * `unknown`, and a present row reports the GENERATION it was committed under
   * so a caller can tell its own record from a newer winner's. */
  read(clientKey: string): Promise<CustodyRead>;
  /** Inactivate a record without deleting a newer winner's record. */
  invalidate(clientKey: string, generation: string): Promise<boolean>;
  delete(clientKey: string): Promise<boolean>;
}

/** What a canonical issuer IS: an exact HTTPS origin string.
 *
 * The value must already BE canonical when it arrives — the boundary refuses
 * non-canonical forms rather than silently normalizing them, because two
 * spellings of one issuer would be two identities. Concretely the string must
 * equal its own `URL` origin: https scheme only, no path beyond the empty
 * one, no query, no fragment, no userinfo, lowercase host (the parser
 * lowercases hosts, so an uppercase spelling fails the equality), and no
 * default port spelled out (the parser drops `:443`, so the equality fails
 * there too). A non-default port is preserved and therefore allowed.
 *
 * This is the canonical ISSUER STRING entering the contract only. Validating
 * a real ID token — its signature, issuer, audience, expiry and the flow
 * nonce — is the ID-token layer's job (the recorded decision: use the
 * verified provider `sub` as provider identity, not email); nothing here
 * parses or accepts tokens. */
export function isCanonicalIssuer(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  return url.pathname === "/" && url.origin === value;
}

export const canonicalIssuerWire = z
  .string()
  .min(1)
  .max(256)
  .refine(isCanonicalIssuer, {
    message:
      "issuer must be a canonical HTTPS origin: lowercase host, no path, query, fragment, userinfo, or default port",
  });

/** The versioned sealed envelope. Binding cloud subject AND local owner (not
 * just authority/device identity) is what makes a legacy record —
 * one that predates these bindings — unusable until it is explicitly
 * reattached, rather than quietly accepted on the strength of its device id
 * alone. Version 3 adds the canonical issuer and workspace binding: a record
 * whose issuing origin is not re-checkable is not an authorization, and a
 * record that does not name its workspace is not a workspace capability. */
export const protectedEnvelopeVersion = 3;

export interface ProtectedEnvelope {
  version: number;
  /** Opaque to this module. What is INSIDE is the store's business — and it
   * is the ONLY thing that may carry the credential. */
  sealed: string;
  cloudSubject: string;
  /** The issuer that authorized this enrollment, in the free-form shape the
   * binding carried it. Persisted because a record whose authority is not
   * re-checkable is not an authorization. Superseded in precision by
   * `cloudIssuer` (below) but retained so a version-2 record's field is
   * still the same field. */
  cloudAuthority: string;
  /** The CANONICAL issuer this enrollment may act under: a strict HTTPS
   * origin, validated at the boundary. Equal to the deployment's trusted
   * issuer at commit time; persisted so the equality can be re-proven later. */
  cloudIssuer: string;
  /** The workspace this enrollment's capability is scoped to. Named at the
   * boundary; only the workspace scope exists in this build. */
  workspaceId: string;
  localOwnerId: string;
  localSessionId: string;
  installationId: string;
  clientKey: string;
  platform: EnrollmentPlatform;
  capabilities: string[];
  createdAt: number;
  /** When the issued credential stops working. */
  credentialExpiresAt: number;
  /** Revocation is carried on the envelope so a tombstone survives a
   * credential-store loss; reattachment must not resurrect it. */
  revokedAt: number | null;
}

/** Shape check only. `version` is deliberately a plain number rather than a
 * `z.literal` so a LEGACY record parses and can be answered with the accurate
 * "version" reason. Pinning it here would make every older record look merely
 * malformed, collapsing two genuinely different recovery paths — "this record
 * predates the bindings and needs explicit reattachment" versus "this is not a
 * record at all" — into one indistinguishable error. */
export const protectedEnvelopeWire = z.object({
  version: z.number().int().positive(),
  sealed: z.string().min(1).max(8192),
  cloudSubject: z.string().min(1).max(256),
  cloudAuthority: z.string().min(1).max(256),
  cloudIssuer: canonicalIssuerWire,
  workspaceId: z.string().min(1).max(128),
  localOwnerId: z.string().min(1).max(256),
  localSessionId: z.string().min(1).max(256),
  installationId: z.string().min(8).max(128),
  clientKey: z.string().min(1).max(256),
  platform: enrollmentPlatformWire,
  capabilities: z.array(z.string().max(64)).max(16),
  createdAt: z.number().refine(Number.isFinite),
  credentialExpiresAt: z.number().refine(Number.isFinite),
  revokedAt: z.number().refine(Number.isFinite).nullable(),
});

/** What the client asks for. Every field is required — an absent field is not
 * defaulted, because a default here would be an implicit enrollment. */
export const enrollmentRequestWire = z.object({
  protocolVersion: z.literal(ENROLLMENT_PROTOCOL_VERSION),
  purpose: enrollmentPurposeWire,
  platform: enrollmentPlatformWire,
  label: z.string().max(128),
  clientKey: z.string().min(16).max(256),
  /** Explicit device confirmation: the human/host asserted THIS device. */
  deviceConfirmed: z.literal(true),
  state: z.string().min(16).max(512),
  codeChallenge: z.string().min(16).max(512),
  codeChallengeMethod: z.literal("S256"),
  /** The redirect the client will receive. It is CHECKED against the
   * deployment's server-owned allowlist for this platform — a request does not
   * approve its own redirect, which is the whole defect the review found. */
  redirect: z.string().min(1).max(2048),
  expiresAt: z.number().refine(Number.isFinite),
});

export type EnrollmentRequest = z.infer<typeof enrollmentRequestWire>;

/** Everything the proof is bound to. The enrollment cannot complete unless
 * the caller's live context matches ALL of these.
 *
 * The binding NAMES the identity quadruple in one place —
 * {cloudSubject, cloudIssuer, workspaceId, clientKey} — so a custody adapter
 * (including the native one, when it exists) receives the full provenance of
 * what it is asked to protect, not a fragment of it. */
export interface EnrollmentBinding {
  /** Canonical cloud account subject — NOT an email. An email can be
   * reassigned, aliased, or matched locally by anyone who signs up. */
  cloudSubject: string;
  /** The CANONICAL cloud issuer this enrollment may act under: a strict
   * HTTPS origin (see `canonicalIssuerWire`). Compared against the
   * deployment's trusted issuer; a mismatch is a refusal, never a silent
   * mismatch. Validating the ID token itself — issuer, audience, expiry,
   * flow nonce — belongs to the ID-token layer that produced this string. */
  cloudIssuer: string;
  /** The cloud issuer this enrollment may act under, in the free-form shape
   * carried since version 2 of the envelope. Must ALSO equal the trusted
   * issuer; `cloudIssuer` is the canonical, schema-validated form. */
  cloudAuthority: string;
  /** The workspace the enrollment's capability is scoped to. */
  workspaceId: string;
  /** The device key this binding is about. Must be the same key the request
   * carries: a binding that binds one key while the request begins another
   * is a contradiction, refused rather than resolved by whichever arrived. */
  clientKey: string;
  /** The local owner session the installation will belong to. */
  localOwnerId: string;
  /** The local session id, so a session change invalidates in-flight work. */
  localSessionId: string;
  /** Verified by re-reading the cloud session at completion, not carried in
   * from the start of the flow. Typed `true` because `false` is not a variant
   * of this binding — it is the refusal, and it has its own failure code. */
  cloudSessionValid: true;
}

/** The deployment's trusted cloud issuer. Server-owned: a caller cannot widen
 * it, and an issuer that is not in this list is refused. Supplied by the
 * integrator as configuration, never taken from a request. */
export interface TrustedCloudConfig {
  /** The only accepted canonical issuer, e.g. the cloud's own origin. */
  issuer: string;
  /** Exact redirects this deployment may complete an enrollment against,
   * per platform. A request picks one; it does not approve one. */
  approvedRedirects: EnrollmentRedirectPolicy;
}

export interface EnrollmentRedirectPolicy {
  macos: string;
  ios: string;
  watchos: string;
  android: string;
  windows: string;
  linux: string;
  cli: string;
  web: string;
}

export const enrollmentBindingWire = z.object({
  // Explicitly NOT an email address. An email is a routing label that can be
  // aliased, reassigned, or claimed locally by anyone who signs up — so a
  // subject that looks like an address is refused at the boundary rather than
  // trusted and compared later. Refusing here means the mistake is caught at
  // begin, not discovered when an upstream header disagrees.
  cloudSubject: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => !value.includes("@"), {
      message: "cloudSubject must be a canonical subject id, not an email address",
    }),
  // Canonical issuer provenance: a strict HTTPS origin, refused — not
  // normalized — when it arrives in any other spelling. See
  // `canonicalIssuerWire` for exactly what canonical means here.
  cloudIssuer: canonicalIssuerWire,
  cloudAuthority: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  // The same bounds the request's clientKey has, so a binding cannot name a
  // key the request shape would not have allowed in the first place.
  clientKey: z.string().min(16).max(256),
  localOwnerId: z.string().min(1).max(256),
  localSessionId: z.string().min(1).max(256),
  cloudSessionValid: z.literal(true),
});

/** The upstream headers the cloud returned, held SEPARATELY from the body.
 * Holding them together is what lets a partially-observed response be treated
 * as partial: a body without its headers is not a validated credential. */
export interface UpstreamHeaders {
  installationId?: string;
  cloudSubject?: string;
  /** The issuer the credential was minted by. Must equal the trusted issuer. */
  authority?: string;
  capability?: string;
  /** Unix ms after which the issued credential stops working. */
  credentialExpiresAt?: number;
  issuedAt?: string;
}

/** The upstream header shape, validated at the boundary so no downstream check
 * has to re-establish that a field is the right type. `credentialExpiresAt` is
 * required: a credential that never expires is a permanent credential. */
export const upstreamHeadersWire = z.object({
  installationId: z.string().min(8),
  cloudSubject: z.string().min(1),
  authority: z.string().min(1),
  capability: z.string().min(1),
  credentialExpiresAt: z.number().refine(Number.isFinite),
  issuedAt: z.string().optional(),
});

export interface UpstreamExchange {
  headers: UpstreamHeaders;
  /** The credential material. Server-to-server only. */
  credential: string;
}

/** An intent, persisted and awaiting proof of possession. */
export interface EnrollmentIntent {
  id: string;
  request: EnrollmentRequest;
  binding: EnrollmentBinding;
  /** What the intent was created against, so a later change can invalidate
   * it rather than silently completing under new conditions. */
  context: EnrollmentContext;
  /** Monotonic generation for this client key. A completion only commits if it
   * still holds the newest generation, so a superseded or cancelled attempt
   * cannot install a credential even if its upstream call was already in
   * flight. */
  generation: string;
  createdAt: number;
  expiresAt: number;
  /** Set when the intent is cancelled, superseded or invalidated. A completion
   * already awaiting a response reads this and stops. */
  invalidatedAt: number | null;
  /** The completion that earned single-use status, identified by a per-call
   * owner token. The row is retained so a replay is refused AND an in-flight
   * completion can still observe a later cancellation. */
  claimedBy: string | null;
}

/** The ambient facts an intent depends on. Any change invalidates
 * outstanding work — this is the invalidation surface for sign-out, account
 * or endpoint change, and shutdown. */
export interface EnrollmentContext {
  ownerId: string;
  sessionId: string;
  endpoint: string;
}

/** What a successful enrollment yields. Note it carries no credential: the
 * credential went to protected storage, and handing it back here would
 * recreate the leak this whole shape exists to prevent. */
export interface EnrollmentOutcome {
  installationId: string;
  clientKey: string;
  platform: EnrollmentPlatform;
  capabilities: string[];
  envelopeVersion: number;
  /** When the stored credential stops working. Metadata only — the credential
   * itself never leaves custody. */
  credentialExpiresAt: number;
}

function fail<T>(reason: EnrollmentFailure): EnrollmentResult<T> {
  return { ok: false, reason };
}

/** Constant-time compare for anything secret-shaped. Length is compared
 * first (a length mismatch is not secret) and timingSafeEqual is only called
 * on equal-length buffers, which it requires. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Base64url without padding, the encoding PKCE specifies. */
function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/** The verifier contract RFC 7636 asks for, enforced rather than assumed: a
 * verifier is 43-128 characters of unreserved ASCII. Without the bounds a
 * one-character verifier satisfies the hash check and "proves" nothing — the
 * review demonstrated exactly that.
 *
 * The challenge is the base64url SHA-256 of the verifier: 43 characters, no
 * padding. Both bounds live in the schema so the shape is established once,
 * at a boundary, instead of being re-derived at each call site. */
const enrollmentProofWire = z.object({
  verifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9\-._~]+$/),
  challenge: z.string().length(43).regex(/^[A-Za-z0-9\-_]+$/),
});

/** Strict S256: the verifier MUST be well-formed AND hash to the challenge
 * under SHA-256. A "plain" method or a malformed challenge fails closed. There
 * is no legacy fallback here by design — a missing proof is not an invitation
 * to guess. */
export function verifyEnrollmentProof(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256") return false;
  // Shape is established by the schemas, not by ad-hoc runtime checks: a
  // caller cannot hand this function a non-string, and a malformed verifier
  // never reaches the hash comparison.
  const proof = enrollmentProofWire.safeParse({ verifier, challenge });
  if (!proof.success) return false;
  return base64url(createHash("sha256").update(proof.data.verifier, "ascii").digest()) === proof.data.challenge;
}

/** A verifier/challenge pair. Named so callers get a real contract rather than
 * an inferred shape. */
export interface EnrollmentProofPair {
  verifier: string;
  challenge: string;
}

/** Mint a fresh S256 challenge (server side, never client side).
 *
 * Note what is NOT here: there is no "mint a verifier". The verifier belongs
 * to the CLIENT — it is the thing that proves possession at completion, and a
 * server that held one would be holding the secret it is meant to check. An
 * earlier draft of this file minted a verifier at begin and then verified it
 * against the client's challenge, which is unsatisfiable by construction: a
 * freshly minted verifier never hashes to a challenge it did not produce. The
 * contract suite caught it on the first run. */
export function mintEnrollmentChallenge(): string {
  return base64url(createHash("sha256").update(randomBytes(32)).digest());
}

/** Mint a verifier/challenge pair. Test-side only, so a suite can drive a
 * real proof instead of a stubbed one. */
export function mintEnrollmentVerifier(): EnrollmentProofPair {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier, "ascii").digest()) };
}

/**
 * Synthetic in-memory protected store, for tests only.
 *
 * This is NOT a conforming production store: nothing here is protected
 * against anything, and the sealed payload is just JSON in a Map. It exists
 * so the contract's failure and ordering rules can be exercised without a
 * keychain. `conformsToProtectedCustody` returns false on purpose so no
 * production wiring can pick it up by accident.
 */
export class MemoryProtectedStore implements ProtectedCredentialStore {
  conformsToProtectedCustody = false;
  /** Simulated custody failures, by call ordinal. */
  failCommitAt: number | null = null;
  failGetAt: number | null = null;
  /** Test seam: make the Nth EXPLICIT read indeterminate. */
  failReadAt: number | null = null;
  /** Test seam: make commit REJECT (not return null) after writing. */
  rejectCommitAt: number | null = null;
  /** Test seam: make invalidate REJECT. */
  rejectInvalidateAt: number | null = null;
  private commitCount = 0;
  private getCount = 0;
  private readCount = 0;
  private invalidateCount = 0;
  private rows = new Map<string, ProtectedEnvelope>();
  /** The newest generation the caller holds per client key. A commit for an
   * older generation is refused — this is what stops a stale in-flight
   * completion from installing a credential over a newer winner. */
  private currentGeneration = new Map<string, string>();
  /** The sealed credentials, so a round-trip test can prove the exact issued
   * secret survived. Test seam only. */
  sealedCredentials = new Map<string, string>();

  /** Test seam: record which generation is newest for a client key.
   *
   * MONOTONIC: an announcement for an OLDER generation is IGNORED. Concurrent
   * begins persist in one order but can RETURN in another, and a late return
   * that overwrote a newer announcement rolled the custody generation back,
   * so the still-current intent was refused by its own store. */
  noteGeneration(clientKey: string, generation: string): void {
    const current = this.currentGeneration.get(clientKey);
    if (current !== undefined && Number(generation) < Number(current)) return;
    this.currentGeneration.set(clientKey, generation);
  }

  /** The generation of the row ACTUALLY STORED, tracked separately from the
   * newest generation merely ANNOUNCED.
   *
   * Invalidation has to be conditioned on the row being removed, not on the
   * newest announcement: a commit whose return was held while a newer intent
   * was begun left the old row in place, because `invalidate` compared against
   * the newest announced generation and so protected a record it should have
   * deleted. A newer intent alone must never shield an older stored record. */
  private storedGeneration = new Map<string, string>();

  async commit(request: CustodyRequest, expectedGeneration: string): Promise<ProtectedEnvelope | null> {
    this.commitCount += 1;
    // Defence in depth at the adapter seam, and MEASURED as such. Removing it
    // does NOT let a credential survive: the post-commit guard observes the
    // fence and cleanup removes the row. So this is not the load-bearing
    // check — it avoids a pointless write-and-remove cycle, and it makes the
    // fake behave like a conforming adapter rather than relying on every caller
    // checking first. The load-bearing enforcement is the synchronous fence read
    // before `deps.exchange`, plus the post-commit guard and cleanup.
    if (sharedFenceHandle.isFenced(request.clientKey)) return null;
    if (this.failCommitAt === this.commitCommitOrdinal()) return null;
    // Reject AFTER the write, so a caller that trusts "it threw, nothing
    // landed" is wrong: the record is on disk and must still be cleaned up.
    if (this.rejectCommitAt === this.commitCount) {
      // fall through to write first
    }
    const current = this.currentGeneration.get(request.clientKey);
    if (current !== undefined && current !== expectedGeneration) return null;
    this.storedGeneration.set(request.clientKey, expectedGeneration);
    this.sealedCredentials.set(request.clientKey, request.credential);
    const envelope: ProtectedEnvelope = {
      version: protectedEnvelopeVersion,
      sealed: `sealed:${request.binding.cloudSubject}`,
      cloudSubject: request.binding.cloudSubject,
      cloudAuthority: request.binding.cloudAuthority,
      cloudIssuer: request.binding.cloudIssuer,
      workspaceId: request.binding.workspaceId,
      localOwnerId: request.binding.localOwnerId,
      localSessionId: request.binding.localSessionId,
      installationId: request.installationId,
      clientKey: request.clientKey,
      platform: request.platform,
      capabilities: [...request.capabilities],
      createdAt: request.issuedAt,
      credentialExpiresAt: request.credentialExpiresAt,
      revokedAt: null,
    };
    this.rows.set(request.clientKey, envelope);
    if (this.rejectCommitAt === this.commitCount) {
      throw new Error("synthetic: custody write landed but the call rejected");
    }
    return envelope;
  }

  private commitCommitOrdinal(): number {
    return this.commitCount;
  }

  async get(clientKey: string): Promise<ProtectedEnvelope | null> {
    this.getCount += 1;
    if (this.failGetAt === this.getCount) return null;
    return this.rows.get(clientKey) ?? null;
  }

  async read(clientKey: string): Promise<CustodyRead> {
    this.readCount += 1;
    // An injected read FAULT is `unknown`, never `absent`. Mapping it to null is
    // exactly the conflation that made an I/O failure look like cleanup.
    if (this.failReadAt === this.readCount) return { kind: "unknown" };
    const row = this.rows.get(clientKey);
    if (!row) return { kind: "absent" };
    const generation = this.storedGeneration.get(clientKey);
    if (generation === undefined) return { kind: "unknown" };
    return { kind: "present", record: { ...row, storedGeneration: generation } };
  }

  /** Inactivate the stored row ONLY if it is the generation being removed.
   *
   * A newer INTENT does not protect an older stored record; a newer COMMITTED
   * record is left intact. Returns false when the stored row is not the one
   * named, which the caller must treat as UNCERTAIN rather than as proof of
   * cleanup — the engine re-reads the row to find out which case it is. */
  async invalidate(clientKey: string, generation: string): Promise<boolean> {
    this.invalidateCount += 1;
    if (this.rejectInvalidateAt === this.invalidateCount) {
      throw new Error("synthetic: custody invalidation rejected");
    }
    const stored = this.storedGeneration.get(clientKey);
    if (stored !== undefined && stored !== generation) return false;
    if (stored === undefined && this.rows.has(clientKey)) return false;
    this.storedGeneration.delete(clientKey);
    this.sealedCredentials.delete(clientKey);
    return this.rows.delete(clientKey);
  }

  async delete(clientKey: string): Promise<boolean> {
    this.storedGeneration.delete(clientKey);
    this.sealedCredentials.delete(clientKey);
    return this.rows.delete(clientKey);
  }

  /** Test seam: the generation of the row actually in storage. */
  storedGenerationFor(clientKey: string): string | null {
    return this.storedGeneration.get(clientKey) ?? null;
  }

  /** Test seam: what is actually in the fake custody. */
  keys(): string[] {
    return [...this.rows.keys()];
  }

  row(clientKey: string): ProtectedEnvelope | null {
    return this.rows.get(clientKey) ?? null;
  }

  /** Test seam: prove the exact issued secret survived the round-trip. */
  credential(clientKey: string): string | null {
    return this.sealedCredentials.get(clientKey) ?? null;
  }
}

export interface EnrollmentAttemptStore {
  /** ATOMIC: supersede every live intent for this client key, allocate a
   * uniquely new generation, persist the row stamped with THAT generation, and
   * return it.
   *
   * These used to be four separate awaited steps (supersede, insert, read the
   * counter, stamp the row). Two concurrent begins for one client key both
   * superseded before either inserted, both then read generation 2, and both
   * rows stayed live — so the same device enrolled twice and the upstream
   * exchange ran twice. A generation must never be INFERRED by reading a
   * shared counter after the fact; the store allocates it and hands back the
   * value belonging to the exact row it wrote. Returns null when the row could
   * not be persisted, which means nothing was minted at all. */
  putIntentWithGeneration(intent: EnrollmentIntent): Promise<string | null>;
  /** READ without consuming. Every rejection path uses this, so a refused
   * attempt cannot burn the intent it was refused for. */
  peekIntent(id: string): Promise<EnrollmentIntent | null>;
  /** ATOMIC COMPARE-AND-CLAIM of a single-use intent.
   *
   * The claim succeeds only if, in one indivisible step, the row is still
   * UNCLAIMED, still LIVE, and still the newest generation for its client key.
   * It previously overwrote `claimedBy` unconditionally, so two concurrent
   * completions both passed the earlier unclaimed guard and both called the
   * upstream exchange; one was refused only AFTER a credential had been
   * minted. Returns null — and mints nothing — when the comparison fails. The
   * row is retained (not deleted) so a later guard or cancellation can still
   * observe it. */
  claimIntent(id: string, owner: string): Promise<EnrollmentIntent | null>;
  /** Mark an intent invalid WITHOUT removing it, so a completion already in
   * flight can observe the cancellation at its next boundary. Removal loses
   * the record a waiter needs in order to see it cancelled. */
  invalidateIntent(id: string, now: number): Promise<boolean>;
  deleteIntent(id: string): Promise<boolean>;
  /** Every live intent. Needed by invalidation, which must be able to find
   * work it does not hold an id for. Declared on the interface rather than
   * reached for on a concrete class. */
  listIntents(): EnrollmentIntent[];
  /** The newest generation issued for a client key. Supersession is decided
   * by generation, not by object identity, so it has to be readable. */
  generationFor(clientKey: string): number;
}

/** Synthetic intent store. Same caveat as MemoryProtectedStore: tests only. */
export class MemoryAttemptStore implements EnrollmentAttemptStore {
  rows = new Map<string, EnrollmentIntent>();
  failPutAt: number | null = null;
  private putCount = 0;
  private generations = new Map<string, number>();

  /** Test seam: the newest generation issued for a client key. */
  generationFor(clientKey: string): number {
    return this.generations.get(clientKey) ?? 0;
  }

  async putIntentWithGeneration(intent: EnrollmentIntent): Promise<string | null> {
    this.putCount += 1;
    if (this.failPutAt === this.putCount) return null;
    // No await between the supersession sweep, the allocation and the write:
    // that indivisibility IS the atomicity, and it is what stops two
    // overlapping begins from sharing one generation.
    const clientKey = intent.request.clientKey;
    for (const row of this.rows.values()) {
      if (row.request.clientKey !== clientKey || row.invalidatedAt !== null) continue;
      this.rows.set(row.id, { ...row, invalidatedAt: intent.createdAt });
    }
    const generation = this.generationFor(clientKey) + 1;
    this.generations.set(clientKey, generation);
    const stamped: EnrollmentIntent = { ...intent, generation: String(generation) };
    this.rows.set(stamped.id, stamped);
    return stamped.generation;
  }

  async invalidateIntent(id: string, now: number): Promise<boolean> {
    const intent = this.rows.get(id);
    if (!intent || intent.invalidatedAt !== null) return false;
    // Marked, not removed: a completion already awaiting a response must be
    // able to observe the cancellation.
    this.rows.set(id, { ...intent, invalidatedAt: now });
    return true;
  }

  async peekIntent(id: string): Promise<EnrollmentIntent | null> {
    return this.rows.get(id) ?? null;
  }

  async claimIntent(id: string, owner: string): Promise<EnrollmentIntent | null> {
    const row = this.rows.get(id) ?? null;
    if (!row) return null;
    // Compare-and-claim. Each of these refusals used to be a separate check
    // somewhere else, so a cancellation or a concurrent replay landing inside
    // the awaited gap still reached the upstream exchange.
    if (row.invalidatedAt !== null) return null;
    if (row.claimedBy !== null) return null;
    if (row.generation !== String(this.generationFor(row.request.clientKey))) return null;
    // MARKED claimed, not deleted. The original version removed the row before
    // the upstream exchange, so every post-exchange guard re-peeked a missing
    // intent and reported "unknown-intent" — a safe-looking refusal that
    // silently made every successful completion impossible.
    const claimed: EnrollmentIntent = { ...row, claimedBy: owner };
    this.rows.set(id, claimed);
    return claimed;
  }

  async deleteIntent(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  listIntents(): EnrollmentIntent[] {
    return [...this.rows.values()];
  }
}

export interface EnrollmentDeps {
  attempts: EnrollmentAttemptStore;
  store: ProtectedCredentialStore;
  /** Mints the upstream exchange. Injected so a test can hold the response,
   * supersede it, or fail it — the custody rules are about what happens
   * around this call, not about it. */
  exchange(binding: EnrollmentBinding, intent: EnrollmentIntent): Promise<UpstreamExchange>;
  /** Mints the stable installation id. Injected for determinism. */
  mintInstallationId(): string;
  /** Test seam on the store: record the newest generation for a client key.
   * Optional so a conforming adapter is not forced to implement bookkeeping
   * the contract already does; the compare-and-commit inside `commit` is the
   * real enforcement, and this only lets the fake be brought up to date. */
  noteGeneration?(clientKey: string, generation: string): void;
  /** Reads the caller's CURRENT context, live.
   *
   * Not a value captured at call time: the post-exchange check exists to
   * catch a sign-out that happens WHILE the upstream call is in flight, and a
   * captured snapshot cannot observe that by definition. Calling this again
   * after the exchange is what makes a held response safe rather than merely
   * late. */
  currentContext(): EnrollmentContext;
  /** Whether the cloud session is valid RIGHT NOW, re-read after the exchange
   * for the same reason `currentContext` is re-read. */
  cloudSessionValid(): boolean;
  now(): number;
}

export interface CompleteOptions {
  /** The caller's CURRENT context, re-read at completion rather than
   * trusted from the start of the flow. */
  context: EnrollmentContext;
  /** Whether the cloud session is still valid RIGHT NOW. */
  cloudSessionValid: boolean;
  /** The client's PKCE verifier, proving possession against the challenge it
   * sent at begin. The server never held this. */
  verifier: string;
  /** The client's state, echoed back so a mismatched flow is refused rather
   * than completed. */
  state: string;
  /** True when the user/host explicitly confirmed this device at
   * completion. Required even if it was true at begin. */
  deviceConfirmed: boolean;
}

/**
 * The rules, as an injectable engine.
 *
 * Why an engine and not bare module functions. The module-level exports below
 * are inert in this build (`enrollmentEnabled === false`), which is correct
 * for production — but it would leave every rule in here untestable, and
 * untested boundaries are the ones that quietly stop holding. So the logic
 * lives in an engine that takes its policy as input, the inert exports are
 * thin wrappers that check the flag and delegate, and a suite drives the
 * engine directly.
 *
 * The consequence that matters: enabling enrollment is a ONE-LINE change that
 * cannot accidentally skip a guard, because no guard sits behind the flag.
 * The flag gates REACHABILITY, not the rules.
 */
export interface EnrollmentPolicy {
  enabled: boolean;
  /** Server-owned cloud configuration. Required even when disabled so a
   * half-configured engine cannot be constructed by omission. */
  trusted: TrustedCloudConfig;
}

/** Per-engine options. Everything here is optional; omitting all of it yields
 * exactly the pre-W2 engine wired to the process-wide fence registry. */
export interface EnrollmentEngineOptions {
  /** The durable fence store THIS engine's fence registry persists to.
   *
   * Omitted: the engine shares the process-wide registry, whose default
   * persistence is the file-backed store under the data dir.
   *
   * Supplied: the engine gets its OWN registry — empty memory plus exactly
   * this store — which is what a fresh process after a restart must look
   * like: it observes what a prior instance PERSISTED and nothing it merely
   * held in memory. */
  fencePersistence?: FencePersistence;
}

/** Inactivate the record a completion just wrote, and SAY whether it is gone.
 *
 * A returned boolean is not proof of cleanup: the adapter may have refused
 * because a newer committed record now occupies the key, or for any other
 * reason. So the row is re-read, and only an EXPLICITLY absent row — or one
 * carrying a DIFFERENT committed generation than ours — counts as cleaned.
 * Anything else is reported to the CALLER as unresolved, which is what
 * previously let a failed invalidation be reported as ordinary cancellation
 * while the credential stayed usable in the store.
 *
 * Returns one of the CleanupOutcome states; the caller must branch on it. */
/** What cleanup of a possibly-landed write actually established. The caller
 * branches on this: `unresolved` is NOT an ordinary refusal, because a usable
 * credential may still be in the store. */
export type CleanupOutcome =
  /** Read back explicitly absent: our record is gone. */
  | "removed"
  /** A newer committed winner occupies the key; ours is not there. Legitimate. */
  | "superseded-winner-kept"
  /** Removal could not be confirmed. The credential may still be usable. */
  | "unresolved";

/** An EXPLICIT custody read. A bare `null` conflates "absent" with "the read
 * failed", and that conflation is what made a fault look like cleanup. */
export type CustodyRead =
  | { kind: "present"; record: ProtectedEnvelope & { storedGeneration: string } }
  | { kind: "absent" }
  | { kind: "unknown" };

async function cleanupCommittedRecord(
  deps: EnrollmentDeps,
  intent: EnrollmentIntent,
  fence: FenceRegistry,
): Promise<CleanupOutcome> {
  const clientKey = intent.request.clientKey;
  try {
    await deps.store.invalidate(clientKey, intent.generation);
  } catch {
    // The adapter refused or faulted. Nothing is known about what it removed,
    // so nothing may be assumed about what remains.
    return unresolved(fence, clientKey);
  }
  // Read back with an EXPLICIT read result. `get` returning null cannot serve as
  // proof of absence, because a failed read and a genuinely absent row are the
  // same value on a naive adapter: treating that null as "clean" would report a
  // credential as removed on the strength of an I/O error.
  let observed: CustodyRead;
  try {
    observed = await deps.store.read(clientKey);
  } catch {
    return unresolved(fence, clientKey);
  }
  // Only an EXPLICIT absence is proof. An unknown read is not.
  if (observed.kind === "absent") return "removed";
  if (observed.kind === "unknown") return unresolved(fence, clientKey);
  // A remaining row is only acceptable when it is demonstrably NOT ours. The
  // discriminator is the RECORD GENERATION the adapter reports, never a
  // timestamp: issuedAt comes from credential issuance while the intent's
  // createdAt comes from begin, so for the SAME generation they normally
  // DIFFER, and two generations can share a timestamp.
  if (observed.record.storedGeneration !== intent.generation) return "superseded-winner-kept";
  return unresolved(fence, clientKey);
}

/** The ONE place "removal unconfirmed" is established, so the fence is set on
 * every unresolved path and no caller can forget. An earlier version fenced only
 * the same-generation-row path, which meant an indeterminate read or a
 * rejecting adapter reported unresolved custody while the key stayed reusable. */
function unresolved(fence: FenceRegistry, clientKey: string): CleanupOutcome {
  fence.fence(clientKey, "custody-unresolved");
  return "unresolved";
}

/**
 * Locally fence a client key whose custody could not be confirmed.
 *
 * A `custody-unresolved` result means a write may have landed and removal could
 * not be proven, so the credential MAY still be usable. Refusing the enrollment
 * is not enough on its own — something has to stop the key being trusted again.
 * This marks the key fenced; `begin` refuses to start new work against a fenced
 * key, so recovery requires an explicit owner action rather than a retry that
 * silently rides on top of the unresolved record.
 *
 * Persisted since W2, and that persistence is the point: the record the fence
 * guards against is itself durable across a restart, so an in-memory fence was
 * lifted by exactly the event it exists to survive. The in-memory Set remains
 * the FAST PATH; the injected `FencePersistence` (file-backed by default, see
 * `installation-fence-persistence.ts`) is what is authoritative across
 * restarts. This is still a contract, not a substitute for a real adapter's
 * own fencing.
 */
interface FenceRegistry {
  /** Fence a key. The durable write completes BEFORE this returns. */
  fence(clientKey: string, reason?: string): void;
  /** Memory first, then the persisted store. Fail-closed: while the store is
   * degraded — or a read faults — every key counts as fenced. */
  isFenced(clientKey: string): boolean;
  /** The explicit owner action: clears memory AND the persisted store. */
  reset(): void;
}

function createFenceRegistry(persistence: () => FencePersistence | null): FenceRegistry {
  /** The fast path. Fenced keys are answered from memory without touching
   * the persisted store; the store is consulted only on a memory miss. */
  const memory = new Set<string>();
  return {
    fence(clientKey, reason) {
      memory.add(clientKey);
      const store = persistence();
      if (!store || store.degraded) {
        // Degraded means every key already counts as fenced, and the store
        // accepts no writes over unknown contents; a missing store means the
        // registry is memory-only. The memory fence stands either way.
        return;
      }
      try {
        store.add(clientKey, reason === undefined ? undefined : { reason });
      } catch {
        // Durability could not be confirmed. The memory fence still stands
        // for this process; a restart may not see this fence. Contained
        // rather than thrown: `fence` runs inside cleanup paths whose
        // promise is a RESULT, never a thrown error, and retrying a wedged
        // disk from here would hold custody hostage on I/O. Over-fencing
        // (a stale file that still names the key) is the safe direction.
      }
    },
    isFenced(clientKey) {
      if (memory.has(clientKey)) return true;
      const store = persistence();
      if (!store) return false;
      // Fail CLOSED. A store whose contents are UNKNOWN fences every key —
      // including keys never fenced — because "absent" cannot be distinguished
      // from "fenced" when the file cannot be read. A read that faults is the
      // same ambiguity. Recovery is the explicit reset, which rewrites a
      // valid file; until then `begin` refuses new work on every key.
      if (store.degraded) return true;
      try {
        return store.read().includes(clientKey);
      } catch {
        return true;
      }
    },
    reset() {
      memory.clear();
      try {
        persistence()?.clear();
      } catch {
        // A clear that failed leaves the file stale — which OVER-fences after
        // a restart. Safe direction; the next reset can try again.
      }
    },
  };
}

/** What the SHARED registry persists to. `undefined` until overridden: the
 * file-backed default is resolved lazily on first fence use, so importing
 * this module resolves no path, reads no file and writes none. An explicit
 * `null` override disables persistence (the pre-W2 memory-only behavior). */
let sharedFencePersistenceOverride: FencePersistence | null | undefined;
let defaultSharedFencePersistence: FileFencePersistence | null = null;

function resolveSharedFencePersistence(): FencePersistence | null {
  if (sharedFencePersistenceOverride !== undefined) return sharedFencePersistenceOverride;
  defaultSharedFencePersistence ??= new FileFencePersistence({ path: defaultEnrollmentFencePath() });
  return defaultSharedFencePersistence;
}

/** The process-wide fence registry. The fence is deliberately process-wide:
 * unresolved custody for a key is a fact about the KEY, not about whichever
 * engine noticed it, so every engine that does not bring its own persistence
 * shares this one. */
let sharedFence: FenceRegistry = createFenceRegistry(resolveSharedFencePersistence);

/** Test/integrator seam: point the shared registry at a specific durable
 * store, or `null` for memory-only. Installing one REPLACES the registry,
 * memory included — that is the restart seam. A freshly constructed instance
 * observes exactly what the previous instance PERSISTED, and nothing it
 * merely held in memory, which is precisely what a new process after a
 * restart observes. */
export function setEnrollmentFencePersistence(persistence: FencePersistence | null): void {
  sharedFencePersistenceOverride = persistence;
  sharedFence = createFenceRegistry(resolveSharedFencePersistence);
}

/** The handle engines WITHOUT their own persistence share. It delegates to
 * the CURRENT shared registry on every call, so a seam install applies even
 * to engines constructed before it. */
const sharedFenceHandle: FenceRegistry = {
  fence: (clientKey, reason) => sharedFence.fence(clientKey, reason),
  isFenced: (clientKey) => sharedFence.isFenced(clientKey),
  reset: () => sharedFence.reset(),
};

/** Test seam: clear the fence registry between cases. Clears the in-memory
 * fast path AND the persisted store. */
export function resetEnrollmentFences(): void {
  sharedFenceHandle.reset();
}

/** Whether a client key is locally fenced after unresolved custody. Consults
 * memory AND the persisted store, so a fence written by a prior process — or
 * a prior registry instance — is still honored. */
export function isEnrollmentKeyFenced(clientKey: string): boolean {
  return sharedFenceHandle.isFenced(clientKey);
}

/** Test seam: establish the fence directly, standing in for a CONCURRENT
 * completion whose own cleanup just failed. Needed to exercise the window
 * between this completion's post-commit guard and its adoption. Persists
 * before returning. */
export function fenceEnrollmentKey(clientKey: string, reason?: string): void {
  sharedFenceHandle.fence(clientKey, reason);
}

export function createEnrollmentEngine(policy: EnrollmentPolicy, options?: EnrollmentEngineOptions) {
  // An ENABLED engine cannot be constructed against a non-canonical issuer:
  // every downstream comparison treats the trusted issuer as the canonical
  // form, so a deployment that configures a non-canonical spelling would make
  // every legitimate binding mismatch. The inert engine (issuer "") is
  // unaffected — the check fires only when enrollment is enabled, which is an
  // explicit integrator decision.
  if (policy.enabled && !isCanonicalIssuer(policy.trusted.issuer)) {
    throw new Error("enrollment: the trusted issuer must be a canonical HTTPS origin");
  }
  const enginePersistence = options?.fencePersistence;
  const fence: FenceRegistry = enginePersistence
    ? createFenceRegistry(() => enginePersistence)
    : sharedFenceHandle;
  return {
    /**
     * Step 1 — begin an enrollment.
     *
     * Persists the intent BEFORE anything can be minted, and supersedes any
     * earlier attempt for the same device so two live enrollments for one
     * client key cannot both complete.
     */
    async begin(
      request: EnrollmentRequestInput,
      binding: EnrollmentBindingInput,
      context: EnrollmentContext,
      deps: EnrollmentDeps,
    ): Promise<EnrollmentResult<EnrollmentBeginValue>> {
      if (!policy.enabled) return fail("disabled");

      const parsedRequest = enrollmentRequestWire.safeParse(request);
      if (!parsedRequest.success) return fail("purpose");
      const parsedBinding = enrollmentBindingWire.safeParse(binding);
      // An email-shaped subject is refused here, at the boundary. So is any
      // other malformed binding field — but a malformed canonical issuer is
      // named as the ISSUER problem it is, so the refusal is actionable
      // rather than mislabelled as a subject failure.
      if (!parsedBinding.success) {
        // SAFETY: the wire parse already failed, so the input's runtime shape
        // is unproven; this probe only READS one field through an optional
        // chain (never dereferences null) to decide WHICH refusal to report,
        // and every value it can observe is re-validated by safeParse below.
        const offeredIssuer = (binding as { cloudIssuer?: unknown } | null)?.cloudIssuer;
        if (offeredIssuer !== undefined && !canonicalIssuerWire.safeParse(offeredIssuer).success) {
          return fail("issuer");
        }
        return fail("subject");
      }

      const req = parsedRequest.data;
      const bind = parsedBinding.data;

      // Explicit device confirmation, not an inferred one.
      if (req.deviceConfirmed !== true) return fail("device-confirmation");

      // The AUTHORITY must be the deployment's trusted issuer. A binding that
      // names its own origin authorizes nothing.
      if (bind.cloudAuthority !== policy.trusted.issuer) return fail("authority");
      // The CANONICAL issuer must be the deployment's trusted one too. A
      // canonical-but-foreign issuer is a refusal, never a silent mismatch:
      // identity provenance that names a different origin is a different
      // identity, whatever the authority string says.
      if (bind.cloudIssuer !== policy.trusted.issuer) return fail("issuer");
      // The binding must be about the device key the request carries. A
      // binding that names one key while the request begins another is a
      // contradiction, refused rather than resolved by whichever arrived.
      if (bind.clientKey !== req.clientKey) return fail("client-key");

      // The binding's owner and session must be the ones the caller is
      // actually authenticated as. Without this, an enrollment can be minted
      // for owner A while the live session belongs to owner B.
      if (!secretsMatch(bind.localOwnerId, context.ownerId)) return fail("local-owner");
      if (!secretsMatch(bind.localSessionId, context.sessionId)) return fail("local-session");

      // The redirect is checked against the server-owned allowlist for this
      // platform. The request no longer approves its own redirect.
      const approved = policy.trusted.approvedRedirects[req.platform];
      if (!approved || !secretsMatch(req.redirect, approved)) return fail("redirect");

      const now = deps.now();
      // An already-expired request is refused rather than given a fresh window.
      if (req.expiresAt <= now) return fail("expired");

      // A key whose custody could not be confirmed is fenced: no new work may
      // be layered on top of a record nobody can prove was removed. The
      // consult covers memory AND the persisted store, so a fence written by
      // a prior process stops work in this one.
      if (fence.isFenced(req.clientKey)) return fail("custody-unresolved");

      // A new begin supersedes the previous attempt for the same device, and
      // the store allocates THIS row's generation inside that same indivisible
      // operation. The generation is never inferred afterwards by reading a
      // shared counter, which is exactly what let two overlapping begins both
      // believe they held the same one.
      const provisional: EnrollmentIntent = {
        id: randomBytes(16).toString("base64url"),
        request: req,
        binding: bind,
        // IMMUTABLE SNAPSHOT, not the caller's object by reference. The caller
        // owns a mutable public context and may legitimately mutate it in
        // place when the live session changes; capturing the reference meant
        // the intent's own "original binding" changed with it, so every later
        // guard compared the new owner against itself and a completion
        // succeeded under owner B while storing an owner-A envelope.
        context: Object.freeze({ ...context }),
        generation: "",
        createdAt: now,
        expiresAt: Math.min(now + ENROLLMENT_INTENT_TTL_MS, req.expiresAt),
        invalidatedAt: null,
        claimedBy: null,
      };

      // Ordering: the intent reaches durable storage BEFORE a credential can
      // exist. A failure here means nothing was minted at all.
      const generation = await deps.attempts.putIntentWithGeneration(provisional);
      if (generation === null) return fail("intent-persist-failed");

      const intent: EnrollmentIntent = { ...provisional, generation };

      // Tell the custody store which generation is newest, so a stale
      // in-flight completion cannot commit over this one.
      deps.noteGeneration?.(req.clientKey, intent.generation);

      return { ok: true, value: { intentId: intent.id, challenge: req.codeChallenge } };
    },

    /**
     * Step 2 — complete an enrollment.
     *
     * Every boundary re-checks: still-current generation, not cancelled,
     * context, expiry, and cloud session. The checks are repeated after each
     * await because an await is exactly when the world can change underneath
     * us, and a check performed only before the first await is not a custody
     * property — it is a snapshot.
     */
    async complete(
      intentId: string,
      options: CompleteOptions,
      deps: EnrollmentDeps,
    ): Promise<EnrollmentResult<EnrollmentOutcome>> {
      if (!policy.enabled) return fail("disabled");

      // PEEK, not take. A refused attempt must not destroy the intent it was
      // refused for, or anyone who learned an intent id could burn a live
      // enrollment with one bad presentation.
      // Identifies THIS completion, so single-use can distinguish the owner of
      // a claim from a later replay.
      const owner = randomBytes(8).toString("base64url");
      let intent: EnrollmentIntent | null = await deps.attempts.peekIntent(intentId);
      if (!intent) return fail("unknown-intent");

      /** Every pre-commit guard, in one place, so no boundary can skip one.
       *
       * The fence IS read here, and it is load-bearing for the boundaries AFTER
       * an awaited exchange. A previous revision removed this check after a
       * mutation survived it — but the surviving mutation demonstrated a
       * MISSING TEST, not redundancy: it proved nothing about a fence that
       * arrives while `deps.exchange` is in flight, which no pre-exchange read
       * can observe.
       *
       * HONESTY NOTE, added at refreeze 6 after measurement: deleting THIS read
       * also leaves the suite at 75/75, because the synchronous pre-commit read
       * catches the same case. So the fence is genuinely enforced — deleting
       * all five reads fails 7 tests — but no test isolates this particular
       * line. Both this read and the pre-commit read are retained; the earlier
       * claim that each is individually load-bearing is withdrawn as
       * unverified. */
      const guard = async (stage: string): Promise<EnrollmentFailure | null> => {
        const live = await deps.attempts.peekIntent(intentId);
        if (!live) return "unknown-intent";
        // A cancellation or supersession is visible even mid-flight, because
        // the intent is MARKED invalid rather than removed.
        if (live.invalidatedAt !== null) {
          // Distinguish "the user walked away" from "a newer attempt replaced
          // this one". Both stop the completion; they are different facts and
          // an operator needs to tell them apart.
          const newest = deps.attempts.generationFor(live.request.clientKey);
          return Number(live.generation) < newest ? "superseded" : "cancelled";
        }
        // Single-use. The completion that CLAIMED the intent owns the rest of
        // its own stages; a DIFFERENT completion arriving later finds it
        // already claimed and is refused. Tracking ownership by id is what
        // distinguishes the two — checking "claimed at all" refused the
        // legitimate owner as soon as it passed the claim point.
        if (live.claimedBy !== null && live.claimedBy !== owner) return "unknown-intent";
        // The generation must still be the newest: a superseded attempt must
        // not commit over its replacement.
        if (live.generation !== intent!.generation) return "superseded";
        if (deps.attempts.generationFor(live.request.clientKey) !== Number(live.generation)) return "superseded";
        // Expiry is re-read from the clock at every boundary.
        if (deps.now() >= live.expiresAt) return "expired";
        // A fence established while an awaited exchange was in flight applies to
        // this intent too. The synchronous pre-exchange read cannot observe it,
        // because that fence lands during the exchange itself.
        if (fence.isFenced(live.request.clientKey)) return "custody-unresolved";
        // LIVE state, not the caller's snapshot. Comparing the intent against
        // `options.context` re-proves the same values the caller already held
        // and therefore cannot observe a sign-out that happened during an
        // await — which is precisely what this guard exists to catch.
        const currentContext = deps.currentContext();
        if (!secretsMatch(live.context.ownerId, currentContext.ownerId)) return "local-owner";
        if (!secretsMatch(live.context.sessionId, currentContext.sessionId)) return "session-changed";
        if (!secretsMatch(live.context.endpoint, currentContext.endpoint)) return "endpoint-changed";
        if (!options.cloudSessionValid || !deps.cloudSessionValid()) return "subject";
        if (options.deviceConfirmed !== true) return "device-confirmation";
        void stage;
        intent = live;
        return null;
      };

      const first = await guard("pre-exchange");
      if (first) return fail(first);

      const current = intent!;
      // Possession proof: the verifier must be well-formed and must hash to the
      // challenge THIS intent pinned.
      if (!verifyEnrollmentProof(options.verifier, current.request.codeChallenge, current.request.codeChallengeMethod)) {
        return fail("proof");
      }
      // The client must echo the state it sent.
      if (!secretsMatch(options.state, current.request.state)) return fail("state");

      // Past every refusal the intent is spent. The claim is a COMPARE-AND-CLAIM:
      // it succeeds only for a row that is still unclaimed, still live and still
      // newest, so a concurrent replay or a cancellation landing in the gap is
      // refused HERE — before anything is minted, rather than after.
      const consumed = await deps.attempts.claimIntent(intentId, owner);
      if (!consumed) return fail("unknown-intent");

      // Revalidate after the claim's await and BEFORE the exchange. The claim
      // itself checks the row, but the world can change during its await, and
      // the re-peek below is the only thing that observes it.
      const afterClaim = await guard("post-claim");
      if (afterClaim) return fail(afterClaim);

      // SYNCHRONOUS fence re-read, with NO intervening await, immediately before
      // the exchange is invoked.
      //
      // The guard's fence check happens inside its own synchronous tail, so a
      // microtask queued during that tail runs only AFTER the guard has finished
      // comparing and returned — and before the caller resumes here. Reading the
      // fence again here, with nothing awaited in between, closes that window: no
      // microtask can interleave between this read and the call below.
      //
      // HONESTY NOTE, added at refreeze 6 after measurement: this comment
      // previously asserted that a fence armed from the guard's
      // `currentContext()` call reaches `deps.exchange` with the key already
      // fenced, and that the post-claim guard alone does not stop it. That
      // specific mechanism is NOT what the suite verifies. What is verified, by
      // bounded mutation: deleting THIS read fails the existing LATE-FENCE case
      // "a fence landing after the post-claim guard stops issuance", so this
      // read is load-bearing for that path. The claimed `currentContext()`
      // arming route is withdrawn as unverified — it was never tested, and the
      // test that appears to cover it (a fence queued from `generationFor`)
      // does not isolate this line.
      if (fence.isFenced(current.request.clientKey)) return fail("custody-unresolved");

      const binding: EnrollmentBinding = { ...current.binding, cloudSessionValid: true };

      // The exchange is HELD, not raced. Everything after it can invalidate it.
      const upstream = await deps.exchange(binding, consumed);

      // Re-check after the await.
      const afterExchange = await guard("post-exchange");
      if (afterExchange) return fail(afterExchange);

      // Headers and body are validated SEPARATELY. The header shape is
      // established by the schema, so downstream checks branch on domain values
      // rather than re-narrowing a representation. A credential with no usable
      // expiry is a permanent credential, so a missing expiry is refused here.
      // Every field is REQUIRED by the schema, so a header set missing any of
      // them — including the credential expiry — is refused here rather than
      // surfacing as a confusing failure three checks later. A response with no
      // expiry is a permanent credential, which is never acceptable.
      const parsedHeaders = upstreamHeadersWire.safeParse(upstream.headers);
      if (!parsedHeaders.success) return fail("credential-expired");
      const headers = parsedHeaders.data;

      if (!headers.installationId || headers.installationId.length < 8) {
        return fail("authority");
      }
      if (!secretsMatch(headers.cloudSubject, binding.cloudSubject)) return fail("subject");
      // An upstream that answers with an email is answering about the wrong
      // thing, whatever the binding claimed.
      if (headers.cloudSubject.includes("@")) return fail("subject");
      // The issuing authority must be the trusted issuer, not just "present".
      if (headers.authority !== policy.trusted.issuer) return fail("authority");
      if (headers.capability !== "workspace") return fail("capability");
      if (!upstream.credential) return fail("proof");
      const now = deps.now();
      if (headers.credentialExpiresAt <= now) return fail("credential-expired");

      // From here on a write MAY land. Everything that can reject between the
      // write and the outcome is caught, and a rejection is never allowed to
      // escape as an exception while a credential might be sitting in the
      // store: the contract's promise is a result, not a thrown error.
      let committed: ProtectedEnvelope | null = null;
      /** Set once a write may have landed, so the catch knows cleanup is owed. */
      let writeAttempted = false;

      // SYNCHRONOUS fence read immediately before the protected write, with NO
      // intervening await. The post-exchange guard runs in its own synchronous
      // tail, so a microtask queued during that tail — or during any helper it
      // awaits — can land before the caller reaches `commit`. Refusing here
      // means an unresolved key never receives the credential at all, rather
      // than receiving it and cleaning up afterwards.
      //
      // HONESTY NOTE, added at refreeze 6 after measurement: deleting this read
      // leaves the suite at 75/75, because the post-exchange guard's fence read
      // catches the same case. A surviving mutation means a MISSING TEST, not
      // redundancy — so no claim is made here that this line is load-bearing on
      // its own. It is retained as defence in depth; what is proven is that the
      // fence is enforced before a commit somewhere on every path, not that
      // this particular read is the one doing it.
      if (fence.isFenced(current.request.clientKey)) return fail("custody-unresolved");

      try {
        // The credential is handed to the CUSTODY ADAPTER, which seals it. It
        // never appears on the envelope, in the outcome, or in any log.
        writeAttempted = true;
        committed = await deps.store.commit(
          {
            clientKey: current.request.clientKey,
            installationId: headers.installationId,
            credential: upstream.credential,
            binding,
            platform: current.request.platform,
            capabilities: [...ENROLLMENT_CAPABILITIES],
            issuedAt: now,
            credentialExpiresAt: headers.credentialExpiresAt,
          },
          current.generation,
        );

        // Re-check AFTER the protected write. A commit that returns is not
        // enough on its own: if we were invalidated while it was in flight, the
        // record we just wrote must be inactivated rather than left usable.
        const afterCommit = await guard("post-commit");
        if (afterCommit) {
          // The reason is only reported when cleanup CONFIRMED removal. If it
          // did not, saying "cancelled" would be a lie: the credential is
          // still usable and the caller must be told custody is unresolved.
          const cleanup = await cleanupCommittedRecord(deps, current, fence);
          return cleanup === "unresolved" ? fail("custody-unresolved") : fail(afterCommit);
        }
      } catch {
        // The adapter faulted — including the case where it wrote and THEN
        // rejected. Either way a record may be on disk, so cleanup is owed and
        // the refusal is unresolved unless the readback proves removal.
        if (!writeAttempted) return fail("credential-persist-failed");
        const cleanup = await cleanupCommittedRecord(deps, current, fence);
        return cleanup === "unresolved" ? fail("custody-unresolved") : fail("credential-persist-failed");
      }

      if (!committed) {
        // Custody could not be established. The credential exists upstream but
        // is NOT usable locally, and the caller is told so rather than being
        // handed a completed enrollment.
        //
        // A null return while the key is FENCED is not an ordinary persistence
        // failure: the refusal reason would tell the caller the wrong thing
        // about custody, and unresolved custody must stay visible. The adapter
        // seam check is a fake's convenience and cannot stand in for engine-side
        // enforcement, so this branch reports the honest reason.
        if (fence.isFenced(current.request.clientKey)) return fail("custody-unresolved");
        return fail("credential-persist-failed");
      }

      // The ISSUED credential's own expiry, re-read from the clock now that the
      // record is stored and adopted. Checking it only before the write let a
      // credential that expired during a held commit be reported as a
      // successful enrollment with an already-expired secret in custody. The
      // intent window says nothing about this value.
      // FINAL adoption boundary. The post-commit guard already ran, but a fence
      // can be established by ANOTHER completion between that guard and this
      // outcome, and every refusal below must respect it. A fence means custody
      // is unresolved for this key REGARDLESS of which check happens to fire
      // first, so it is consulted first and again after the expiry cleanup's own
      // await — that await is precisely where a concurrent fence can land.
      const fenced = () => fence.isFenced(current.request.clientKey);
      if (fenced()) {
        await cleanupCommittedRecord(deps, current, fence);
        return fail("custody-unresolved");
      }
      // The expiry branch is the last await before adoption, so the fence is
      // re-read after it. When the credential has NOT expired there is no await
      // between the check above and adoption, so no second read is possible or
      // needed — an earlier draft had one, and a mutation showed it was
      // unreachable rather than load-bearing.
      if (deps.now() >= committed.credentialExpiresAt) {
        const cleanup = await cleanupCommittedRecord(deps, current, fence);
        if (cleanup === "unresolved" || fenced()) return fail("custody-unresolved");
        return fail("credential-expired");
      }

      return {
        ok: true,
        value: {
          installationId: committed.installationId,
          clientKey: committed.clientKey,
          platform: committed.platform,
          capabilities: [...committed.capabilities],
          envelopeVersion: committed.version,
          credentialExpiresAt: committed.credentialExpiresAt,
        },
      };
    },
  };
}

export type EnrollmentEngine = ReturnType<typeof createEnrollmentEngine>;

/** Every platform's redirect is empty: the inert engine has no trusted cloud to
 * approve anything against. Built explicitly rather than cast, so the shape is
 * checked by the compiler instead of asserted past it. */
const NO_REDIRECTS: EnrollmentRedirectPolicy = {
  macos: "",
  ios: "",
  watchos: "",
  android: "",
  windows: "",
  linux: "",
  cli: "",
  web: "",
};

/** Inert in this build: every entry point refuses. */
const inertEngine = createEnrollmentEngine({
  enabled: enrollmentEnabled,
  trusted: { issuer: "", approvedRedirects: NO_REDIRECTS },
});

/** Step 1 — begin an enrollment. Inert while enrollment is disabled. */
export function beginEnrollment(
  request: EnrollmentRequestInput,
  binding: EnrollmentBindingInput,
  context: EnrollmentContext,
  deps: EnrollmentDeps,
): Promise<EnrollmentResult<EnrollmentBeginValue>> {
  return inertEngine.begin(request, binding, context, deps);
}

/** Step 2 — complete an enrollment. Inert while enrollment is disabled. */
export function completeEnrollment(
  intentId: string,
  options: CompleteOptions,
  deps: EnrollmentDeps,
): Promise<EnrollmentResult<EnrollmentOutcome>> {
  return inertEngine.complete(intentId, options, deps);
}

/**
 * Cancel an outstanding intent.
 *
 * The intent is MARKED invalid, not deleted: a completion already awaiting an
 * upstream response reads `invalidatedAt` at its next boundary and stops. The
 * original version deleted the row, which meant cancellation returned false for
 * an in-flight attempt and the attempt went on to store a credential.
 */
export async function cancelEnrollment(intentId: string, deps: EnrollmentDeps): Promise<boolean> {
  return deps.attempts.invalidateIntent(intentId, deps.now());
}

/**
 * RETAIN matching work: invalidate outstanding work belonging to a DIFFERENT
 * context than the one now current. This is the account-change / endpoint-change
 * surface, and it deliberately leaves work that matches the new current context
 * alone — that work is still wanted.
 *
 * This is NOT the shutdown surface. Shutdown must invalidate work belonging to
 * the context that is ENDING even when its identity fields are unchanged; see
 * `endEnrollmentContext`. The previous single function documented shutdown and
 * sign-out but skipped exactly matching contexts, so it was a no-op for the
 * case it advertised.
 */
export async function invalidateEnrollmentContext(
  context: EnrollmentContext,
  deps: EnrollmentDeps,
): Promise<number> {
  let dropped = 0;
  for (const intent of deps.attempts.listIntents()) {
    const sameOwner = secretsMatch(intent.context.ownerId, context.ownerId);
    const sameSession = secretsMatch(intent.context.sessionId, context.sessionId);
    const sameEndpoint = secretsMatch(intent.context.endpoint, context.endpoint);
    if (sameOwner && sameSession && sameEndpoint) continue;
    // Marked, not deleted, for the same reason cancelEnrollment marks.
    if (await deps.attempts.invalidateIntent(intent.id, deps.now())) dropped += 1;
  }
  return dropped;
}

/**
 * END a context: invalidate EVERY outstanding intent belonging to it, including
 * work whose identity fields match exactly.
 *
 * The shutdown / sign-out / process-exit surface. A session ending is not
 * observable from its owner, session id or endpoint — all three can be
 * identical while the session itself is gone — so this operation is defined by
 * WHAT it ends rather than by what it differs from. It exists separately from
 * `invalidateEnrollmentContext` precisely because "retain work matching this
 * new current context" and "invalidate work belonging to this ending context"
 * are opposite requirements that one function cannot satisfy.
 *
 * Returns how many intents were marked invalid.
 */
export async function endEnrollmentContext(
  context: EnrollmentContext,
  deps: EnrollmentDeps,
): Promise<number> {
  let dropped = 0;
  for (const intent of deps.attempts.listIntents()) {
    const sameOwner = secretsMatch(intent.context.ownerId, context.ownerId);
    const sameSession = secretsMatch(intent.context.sessionId, context.sessionId);
    const sameEndpoint = secretsMatch(intent.context.endpoint, context.endpoint);
    if (!sameOwner || !sameSession || !sameEndpoint) continue;
    if (await deps.attempts.invalidateIntent(intent.id, deps.now())) dropped += 1;
  }
  return dropped;
}

/* Reattachment is deliberately NOT implemented in this slice.
 *
 * The review reproduced the original version accepting a caller-minted
 * verifier against a caller-minted challenge for a caller-supplied record,
 * with no accepted intent, no authenticated cloud session, no current local
 * context and no registry lookup: a stale local null tombstone was being
 * treated as proof of current remote non-revocation.
 *
 * The honest repair is narrower than a fix. Reattachment is a second
 * authenticated exchange — it must go through the same cloud-proven,
 * single-use, cancellation-safe path and the same owner/client-key registry
 * that carries the revocation tombstone. Until that flow exists, offering a
 * function called `reattach` invites a caller to believe recovery is
 * available. Recovery now requires a NEW enrollment begin/complete.
 *
 * A legacy record therefore stays unusable until it is explicitly
 * re-enrolled, which is the posture the contract already described and is
 * strictly safer than a self-issued proof.
 */

/** What an ordinary login is allowed to do. Named so the shape is a contract. */
export interface OrdinaryLoginEffect {
  registrations: number;
  authority: number;
  permissions: number;
}

/** SYNTHETIC ONLY. What this module claims an ordinary login does.
 *
 * This is a declaration by the contract, not evidence about real HTTP login
 * behaviour: it returns constants and exercises no route, no registration and
 * no session. The review called that out correctly. HTTP compatibility of
 * ordinary login is therefore PENDING and must be proven by a real-HTTP test
 * against the actual login route before anyone claims it — this function only
 * records the intent that enrollment must not touch ordinary login.
 */
export function ordinaryLoginEffect(): OrdinaryLoginEffect {
  return { registrations: 0, authority: 0, permissions: 0 };
}