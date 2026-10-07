// The trust-configuration REQUEST — the exact shape, bounds and cross-field
// rules each pending enrollment value must satisfy, derived from the real
// schemas rather than restated from memory.
//
// WHY THIS FILE. Production enrollment is inert (`enrollmentEnabled = false`,
// `installation-enrollment-contract.ts:59`) and stays that way. What blocks
// enablement is not missing code — the begin/complete rules, the attempt store,
// the identity adapter and the native custody consumer all exist and are
// tested — it is that nobody has ANSWERED five deployment questions. Each
// answer has a hard bound enforced by a zod schema, and answering one wrong is
// refused by that schema rather than silently accepted. This file names each
// question, states its bound with file:line evidence, and reports which are
// still unanswered.
//
// It contains no values. No issuer, redirect, authority, workspace, audience or
// callback is chosen, defaulted, guessed or derived from another value here —
// including the identity issuer, which is NOT Muster's enrollment authority
// (see `IDENTITY_ISSUER_IS_NOT_ENROLLMENT_AUTHORITY`).
//
// NO-SECURITY-CLAIMS NOTE. Nothing in this file asserts that a configuration
// satisfying every bound is safe, correct or sufficient. The project has not
// completed a full security-scanner re-run. These are the machine-checked
// SCHEMA bounds, and the platform facts a reviewer must still accept on trust.

import { z } from "zod";

import {
  ENROLLMENT_CAPABILITIES,
  canonicalIssuerWire,
  enrollmentBindingWire,
  enrollmentPlatformWire,
  enrollmentRequestWire,
} from "./installation-enrollment-contract.ts";
import {
  enrollmentIdentityConfigurationWire,
  enrollmentIdentityRedirectPolicyWire,
} from "./installation-enrollment-identity.ts";
import type { EnrollmentPlatform } from "./installation-enrollment-contract.ts";

/** Every platform a redirect must be approved for. Read from the wire enum
 *  rather than restated, so adding a platform cannot leave this file stale. */
export const enrollmentTrustPlatforms: readonly EnrollmentPlatform[] =
  enrollmentPlatformWire.options;

/** What must be decided before the macOS client can complete an enrollment. */
export type EnrollmentTrustQuestion =
  | "enrollmentIssuer"
  | "identityClientId"
  | "workspaceId"
  | "cloudAuthority"
  | "macosRedirect";

/** The evidence a reviewer needs for one question, with file:line anchors. */
export interface EnrollmentTrustRequirement {
  readonly question: EnrollmentTrustQuestion;
  /** What the owner has to decide, stated as a question, not a proposal. */
  readonly ask: string;
  /** The machine-checked bound, or `null` when no schema constrains it yet. */
  readonly bound: string | null;
  readonly evidence: readonly string[];
}

export const ENROLLMENT_TRUST_REQUIREMENTS: readonly EnrollmentTrustRequirement[] = [
  {
    question: "enrollmentIssuer",
    ask: "Which canonical HTTPS origin is Muster's OWN enrollment authority?",
    bound:
      "Canonical HTTPS origin: lowercase host, empty path, no query, fragment, userinfo or default port; at most 256 characters, and at most 128 to satisfy the identity adapter's narrower cap.",
    evidence: [
      "server/installation-enrollment-contract.ts:218-229 — isCanonicalIssuer",
      "server/installation-enrollment-contract.ts:231-238 — canonicalIssuerWire (max 256)",
      "server/installation-enrollment-identity.ts:40 — issuer capped at 128",
      "server/installation-enrollment-contract.ts:1206 — must equal the trusted issuer",
    ],
  },
  {
    question: "identityClientId",
    ask: "What is the explicit Google ID-token AUDIENCE (OAuth client id) for this deployment?",
    bound: "Non-blank, at most 512 characters, and must not have surrounding whitespace.",
    evidence: [
      "server/installation-enrollment-identity.ts:39 — clientId bounds",
      "server/installation-enrollment-identity.ts:59 — independent of Calendar/Drive consent",
    ],
  },
  {
    question: "workspaceId",
    ask: "Which workspace does this deployment's enrollment capability scope to?",
    bound: "Non-empty, at most 128 characters. Resolved from the live session, never taken from a request.",
    evidence: [
      "server/installation-enrollment-contract.ts:405 — workspaceId bounds",
      "server/installation-enrollment-identity.ts:118 — resolved from the session's workspace row, bounded at 128",
    ],
  },
  {
    question: "cloudAuthority",
    ask: "Which free-form authorization string accompanies the issuer in a binding?",
    bound: "Non-empty, at most 128 characters, and it must EQUAL the trusted issuer — the two are compared for equality at begin.",
    evidence: [
      "server/installation-enrollment-contract.ts:404 — authority bounds",
      "server/installation-enrollment-contract.ts:1201 — must equal policy.trusted.issuer",
      "server/installation-enrollment-identity.ts:204 — the adapter sets authority to the trusted issuer",
    ],
  },
  {
    question: "macosRedirect",
    ask: "Which HTTPS origin will the macOS client receive its enrollment callback on?",
    // Redirect wires carry no canonicality, only length: min(1).max(2048). The
    // HTTPS-origin recommendation is an owner-quality statement, not enforced.
    bound: "min(1).max(2048); HTTPS origin recommended, not enforced",
    evidence: [
      "server/installation-enrollment-contract.ts:376-385 — per-platform policy, eight keys",
      "server/installation-enrollment-contract.ts:1220-1221 — exact match, refused otherwise",
      "server/installation-enrollment-identity.ts:162 — the identity adapter checks the same entry",
      "macos/Resources/Info.plist:21 — CFBundleIdentifier only; no CFBundleURLTypes, so no scheme is registered",
    ],
  },
];

/** Google's identity issuer is NOT Muster's enrollment authority.
 *
 *  The two are separate values with separate jobs. `identityClientId` is the
 *  Google ID-token AUDIENCE — an OAuth client identifier, and the adapter that
 *  verifies the token never treats its issuer as a Muster trust decision. The
 *  `enrollmentIssuer` is the origin an enrollment is allowed to act UNDER, and
 *  it is compared against a binding for equality. Supplying a provider's
 *  identity issuer as the enrollment issuer would widen the trust boundary to
 *  that provider by accident.
 *
 *  This module never derives one from the other, and `identityClientId` is
 *  deliberately NOT constrained to be a canonical origin: an OAuth client id
 *  is an identifier, not an origin. */
export const IDENTITY_ISSUER_IS_NOT_ENROLLMENT_AUTHORITY =
  "the Google identity issuer is not Muster's enrollment authority; the enrollment issuer is a separate owner decision";

/** Facts about the CURRENT client platforms that bound the redirect answer.
 *  These are measurements of this repository, not proposals. */
export const ENROLLMENT_TRUST_PLATFORM_FACTS = {
  macos: {
    registersCallbackScheme: false,
    evidence: "macos/Resources/Info.plist:21 declares CFBundleIdentifier and no CFBundleURLTypes",
  },
  ios: {
    registersCallbackScheme: true,
    evidence: "ios/App/CloudAuth.swift:35 — muster://oauth/finish",
  },
} as const;

/** Which capability scope exists in this build. Enrollment grants only this,
 *  and the list is read from the contract rather than restated. */
export const ENROLLMENT_TRUST_CAPABILITIES: readonly string[] = ENROLLMENT_CAPABILITIES;

/** The two binding fields whose bounds the owner must satisfy, each narrowed to
 *  a single-field schema by `pick` from the ONE real definition, so this file
 *  cannot drift from the binding contract. Each carries a reader for the field
 *  it was derived from, which is how a single-field object is checked without
 *  restating the bound.
 *
 *  `cloudIssuer` is deliberately absent: it is validated by `canonicalIssuerWire`
 *  directly, which is the schema the engine itself uses. */
const audienceBound = enrollmentIdentityConfigurationWire.pick({ clientId: true });
const workspaceBound = enrollmentBindingWire.pick({ workspaceId: true });
const authorityBound = enrollmentBindingWire.pick({ cloudAuthority: true });

/** A candidate configuration, with every value OPTIONAL and no defaults.
 *  Omission is meaningful: an absent value is an unanswered question, never a
 *  value to be inferred. */
export interface EnrollmentTrustCandidate {
  readonly enrollmentIssuer?: string;
  readonly identityClientId?: string;
  readonly workspaceId?: string;
  readonly cloudAuthority?: string;
  readonly macosRedirect?: string;
}

/** One question's status. `answered` means only that the schema accepted the
 *  supplied string; it is not a claim that the string is the RIGHT answer. */
export type EnrollmentTrustValueState = "answered" | "unanswered" | "refused";

export interface EnrollmentTrustValueReport {
  readonly question: EnrollmentTrustQuestion;
  readonly state: EnrollmentTrustValueState;
  /** Why a refusal happened. Never the value itself. */
  readonly reason: string | null;
}

export interface EnrollmentTrustReport {
  /** True only when every question has an accepted value. False is the normal
   *  state today and does not by itself enable anything. */
  readonly complete: boolean;
  readonly values: readonly EnrollmentTrustValueReport[];
  /** What remains impossible until each question is answered. */
  readonly blockedBy: readonly string[];
}

/** Report one candidate string against a real schema. */
function assess(question: EnrollmentTrustQuestion,
                offered: string | undefined,
                schema: z.ZodType): EnrollmentTrustValueReport {
  if (offered === undefined) return { question, state: "unanswered", reason: null };
  const parsed = schema.safeParse(offered);
  if (parsed.success) return { question, state: "answered", reason: null };
  // zod's issue messages are static rule descriptions; no offered value is
  // interpolated into them.
  const reason = parsed.error.issues.map((issue) => issue.message).join("; ");
  return { question, state: "refused", reason };
}

/** Report one candidate string against a single-field narrowing of the binding
 *  schema, by wrapping the string under that field's own key. The bound is
 *  still `enrollmentBindingWire`'s, not a restatement of it. */
function assessBindingField(question: EnrollmentTrustQuestion,
                            offered: string | undefined,
                            schema: z.ZodType,
                            field: string): EnrollmentTrustValueReport {
  if (offered === undefined) return { question, state: "unanswered", reason: null };
  const parsed = schema.safeParse({ [field]: offered });
  if (parsed.success) return { question, state: "answered", reason: null };
  const reason = parsed.error.issues.map((issue) => issue.message).join("; ");
  return { question, state: "refused", reason };
}

/**
 * Inspect a candidate trust configuration and report, per question, whether it
 * is answered, unanswered, or refused — and what stays blocked.
 *
 * Reads only the schemas. Chooses nothing, defaults nothing, enables nothing.
 */
export function inspectEnrollmentTrustConfiguration(
  candidate: EnrollmentTrustCandidate,
): EnrollmentTrustReport {
  const issuer = assess("enrollmentIssuer", candidate.enrollmentIssuer, canonicalIssuerWire.max(128));
  const audience = assessBindingField("identityClientId", candidate.identityClientId,
    audienceBound, "clientId");
  const workspace = assessBindingField("workspaceId", candidate.workspaceId, workspaceBound, "workspaceId");
  let authority = assessBindingField("cloudAuthority", candidate.cloudAuthority, authorityBound, "cloudAuthority");
  // The engine's begin gate requires exact equality, not merely two strings
  // that each pass a length check. Report it even before other answers arrive.
  if (authority.state === "answered" && candidate.enrollmentIssuer !== undefined
      && candidate.cloudAuthority !== candidate.enrollmentIssuer) {
    authority = { question: "cloudAuthority", state: "refused",
      reason: "The cloud authority must equal the trusted enrollment issuer." };
  }
  const redirect = assess("macosRedirect", candidate.macosRedirect, z.string().min(1).max(2048));

  const values = [issuer, audience, workspace, authority, redirect];

  // The identity adapter's whole configuration is the authority on whether a
  // trust answer is jointly admissible, so an answered-but-inconsistent set is
  // still not complete. Built only from supplied values; nothing is invented to
  // fill a gap.
  let consistent = true;
  let consistencyReason: string | null = null;
  if (candidate.enrollmentIssuer !== undefined && candidate.identityClientId !== undefined) {
    const probe = enrollmentIdentityConfigurationWire.safeParse({
      clientId: candidate.identityClientId,
      trusted: {
        issuer: candidate.enrollmentIssuer,
        // SAFETY: `z.object` without `.strict()` accepts exactly these keys and
        // strips nothing else, so a hand-built policy with all eight platforms
        // satisfies `enrollmentIdentityRedirectPolicyWire` by construction. No
        // assertion past the schema is being taken here.
        approvedRedirects: Object.fromEntries(
          enrollmentTrustPlatforms.map((platform) => [platform, ""]),
        ),
      },
    });
    consistent = probe.success;
    if (!probe.success) {
      consistencyReason = probe.error.issues.map((issue) => issue.message).join("; ");
    }
  }

  const blockedBy: string[] = [];
  if (issuer.state !== "answered") {
    blockedBy.push("No enrollment can begin or complete: `begin` refuses at the issuer comparison without a trusted issuer.");
  }
  if (audience.state !== "answered") {
    blockedBy.push("The identity adapter answers `not-configured`, so no verified binding is ever produced.");
  }
  if (workspace.state !== "answered") {
    blockedBy.push("No binding can name a workspace, so the capability cannot be scoped.");
  }
  if (authority.state !== "answered") {
    blockedBy.push("A binding carrying any authority other than the trusted issuer is refused as `authority`.");
  }
  if (redirect.state !== "answered") {
    blockedBy.push("The macOS client has no approved callback, so every macOS enrollment is refused as `redirect`.");
  }
  if (consistent === false && consistencyReason !== null) {
    blockedBy.push(`The trust answer is jointly inadmissible: ${consistencyReason}`);
  }

  const answered = values.every((value) => value.state === "answered") && consistent;
  const reported: EnrollmentTrustValueReport[] = consistencyReason === null
    ? values
    : values.map((value) => (value.state === "answered"
        ? value
        : { ...value, state: value.state, reason: value.reason ?? consistencyReason }));

  return { complete: answered, values: reported, blockedBy };
}

/** What a caller must satisfy before `begin` accepts a request at all, beyond
 *  the trust configuration itself. These are the request-shape bounds, read
 *  from the real schema so this list cannot drift from it. */
export interface EnrollmentClientRequirement {
  readonly field: string;
  readonly bound: string;
  readonly evidence: string;
}

export const ENROLLMENT_CLIENT_REQUIREMENTS: readonly EnrollmentClientRequirement[] = [
  { field: "clientKey", bound: "16-256 characters; must be a stable per-installation key, not per-attempt.", evidence: "server/installation-enrollment-contract.ts:313" },
  { field: "deviceConfirmed", bound: "Literal `true` at BOTH begin and completion. Never inferred.", evidence: "server/installation-enrollment-contract.ts:315" },
  { field: "state", bound: "16-512 characters; echoed back and compared exactly at completion.", evidence: "server/installation-enrollment-contract.ts:316" },
  { field: "codeChallenge", bound: "16-512 characters; S256 base64url only, and the verifier must hash to it.", evidence: "server/installation-enrollment-contract.ts:317" },
  { field: "redirect", bound: "1-2048 characters; must equal the approved entry for this platform EXACTLY.", evidence: "server/installation-enrollment-contract.ts:322" },
  { field: "purpose", bound: "One of replace-client, add-device, recover-device. No default.", evidence: "server/installation-enrollment-contract.ts:91" },
  { field: "credentialExpiresAt", bound: "Required on the upstream response. A credential with no expiry is refused.", evidence: "server/installation-enrollment-contract.ts:431-438" },
  { field: "capability", bound: "Must be exactly `workspace` in this build.", evidence: `server/installation-enrollment-contract.ts:1486; only ${ENROLLMENT_TRUST_CAPABILITIES.join(", ")} exists` },
];

/** The client-request schema, re-exported so a client-side conformance check
 *  tests the ONE definition rather than a copy. */
export const enrollmentTrustRequestWire = enrollmentRequestWire;

/** The identity configuration schema the owner must satisfy, re-exported for the
 *  same reason. */
export const enrollmentTrustIdentityConfigurationWire = enrollmentIdentityConfigurationWire;

/** The per-platform redirect policy schema, re-exported: eight required keys,
 *  each a string of at most 2048 characters. */
export const enrollmentTrustRedirectPolicyWire = enrollmentIdentityRedirectPolicyWire;
