# Native enrollment — trust-configuration request (2026-10-07)

Status: **REQUEST, not a decision.** Production enrollment is inert and stays
inert. `enrollmentEnabled = false as const`
(`server/installation-enrollment-contract.ts:59`), the engine on `main` is
constructed with `enabled: enrollmentEnabled`, an empty issuer and
`NO_REDIRECTS` (`server/installation-enrollment-contract.ts:1625-1627`), and all
eight platforms carry `approvedRedirects` entries of `""`. Nothing in this
document, and nothing merged beside it, changes that gate. Machine-checked
companions to this document: `server/installation-enrollment-trust-config.ts`
(the structured form of every bound below) and
`server/installation-enrollment-trust-config.test.ts` (every bound demonstrated
against the REAL zod schema, 24 tests).

## What is already decided and shipped (no owner action needed)

* The begin/complete/cleanup rules, the durable attempt store, the identity
  adapter and the native custody consumer are implemented and tested locally.
  The authenticated production transport/protected bridge and approved trust
  configuration still require integration and acceptance; enrollment stays off.
* Generation domains stay distinct: the custody generation is
  authority-allocated and carried verbatim; `FileEnrollmentAttemptStore`
  allocates its own attempt generation
  (`server/installation-enrollment-attempt-store.ts`); the Swift
  `NativeSignInCoordinator` generation is a separate in-memory counter in a
  different type and is never read by the custody consumer
  (`macos/Sources/MusterMacCore/NativeEnrollmentCustodyConsumer.swift:49-67`).
* Fail-closed custodianship is proven: a degraded/unavailable secure store
  refuses enrollment and never falls back to unprotected storage
  (`NativeEnrollmentCustodyConsumerTests.testUnreadableCustodyRefusesCompletionAndNeverFallsBackToUnprotectedStorage`,
  `.testADegradedFenceStoreRefusesBeginForEveryKeyAndWritesNothing`).

## The five pending values, one per owner decision

Each bound below is enforced by a zod schema at an identifiable line; passing
the bound is necessary but NOT sufficient and NOT a claim of correctness or
security. The structured, test-covered statement of each bound lives in
`ENROLLMENT_TRUST_REQUIREMENTS` in `server/installation-enrollment-trust-config.ts:63-115`.

### 1. `enrollmentIssuer` — Muster's OWN enrollment authority

* Ask: which canonical HTTPS origin is Muster's own enrollment authority?
* Bound: canonical HTTPS origin — lowercase host, empty path, no query,
  fragment, userinfo or default port; `canonicalIssuerWire` caps it at 256
  characters (`server/installation-enrollment-contract.ts:218-229`,
  `:231-238`), and the identity adapter caps it at 128
  (`server/installation-enrollment-identity.ts:40`), so **128 is the effective
  budget**. At begin, a binding's `cloudIssuer` must EQUAL this value exactly
  — refused otherwise (`server/installation-enrollment-contract.ts:1206`) —
  and the credential's `authority` header must equal it again at complete
  (`:1201`). The engine refuses to construct at all unless it is canonical
  when enabled (`:1151`).
* Owner decision remains: the origin. Nothing in the repository proposes a
  candidate.
* Impossible until answered: no begin can pass (`fail("issuer")`,
  `:1206`); no enabled engine constructs (`:1151`);
  `createEnrollmentIdentityResolver` reports `not-configured` for its whole
  surface (`server/installation-enrollment-identity.ts`).

### 2. `identityClientId` — the Google ID-token audience

* Ask: which explicit OAuth client id is the ID-token audience for this
  deployment?
* Bound: non-blank, no surrounding whitespace, at most 512 characters
  (`server/installation-enrollment-identity.ts:39`). It is an identifier,
  deliberately NOT required to be an origin
  (`installation-enrollment-trust-config.ts:126-131`).
* Owner decision remains: the client id, kept independent of any
  Calendar/Drive consent (`:59`).
* Impossible until answered: no ID token verifies, so the adapter never emits
  a binding and everything downstream of identity is unreachable.

### 3. `workspaceId` — capability scope

* Ask: which workspace does enrollment scope to?
* Bound: non-empty, at most 128 characters
  (`server/installation-enrollment-contract.ts:405`). It is resolved from the
  signed local session's account row, never accepted from a request
  (`server/installation-enrollment-identity.ts:117-118`).
* Owner decision remains: none to write here — the value binds to the
  deployment's workspace — but deployment must have ONE such workspace whose
  account rows can be resolved.
* Impossible until answered: `checkLocalContext` answers `workspace` and no
  binding is produced.

### 4. `cloudAuthority` — the binding's authority string

* Ask: which authorization string accompanies `cloudIssuer` in a binding?
* Bound: non-empty, at most 128 characters
  (`server/installation-enrollment-contract.ts:404`) — and at begin it must
  EQUAL `policy.trusted.issuer` exactly (`:1206`'s shape applied at
  `:1202-1204`; the issuer check is
  `bind.cloudAuthority !== policy.trusted.issuer → fail("authority")` — the
  adapter therefore sets it TO the trusted issuer,
  `installation-enrollment-identity.ts:204`).
* Owner decision remains: none separately — it collapses into question 1; if
  `enrollmentIssuer` is answered, `cloudAuthority` is that same origin. It is
  listed separately only because a deployment can answer 1 and then violate
  this equality in a hand-written binding (`cloudAuthority` is capped at 128,
  not enforced canonical).
* Impossible until answered: `fail("authority")` for every begin.

### 5. `macosRedirect` — the registered macOS callback

* Ask: which exact registered callback will the macOS client receive its
  enrollment callback on? The contract requires exact matching; it does not
  independently enforce an HTTPS origin for this channel.
* Bound: the request's `redirect` must be an exact equality match against the
  deployment's server-owned `trusted.approvedRedirects[req.platform]` entry —
  the request never approves its own redirect
  (`server/installation-enrollment-contract.ts:306,322,1218-1222`). Every one
  of the eight platform keys is REQUIRED in the policy object
  (`installation-enrollment-identity.ts:33-40`), and the identity adapter
  applies the same entry, refusing a blank or mismatched one
  (`:161-163`).
* Owner decision remains: a real registered HTTPS origin (associated domain /
  Universal Links style endpoint), plus the same origin supplied into
  `trusted.approvedRedirects.macos` in the engine configuration.
* Impossible until answered: every macOS begin answers
  `fail("redirect")` (`:1220-1222`).

### Platform facts (measured, not proposals)

* **macOS registers NO callback scheme.** `macos/Resources/Info.plist:21`
  declares only `CFBundleIdentifier`; there is no `CFBundleURLTypes` /
  `CFBundleURLSchemes` anywhere in that file.
* **iOS DOES register `muster://`** — `ios/project.yml:93-95` registers the
  scheme (`CFBundleURLSchemes: muster`) and `ios/App/CloudAuth.swift:35`
  carries `muster://oauth/finish`.

### Why the iOS convention does not carry over to macOS

`approvedRedirects` entries are matched by EXACT string equality against a
canonical HTTPS allowlist: a request redirect may be 1-2048 characters
(`installation-enrollment-contract.ts:322`) but it must equal the per-platform
approved entry (`:1218-1222`), and the issuer/policy machinery that validates
origins is built on `isCanonicalIssuer`, which requires `https://`, a
lowercase host, an empty path, no query/fragment/userinfo and no default port,
or non-default origin
(`:218-229`) applies canonicality to the TRUSTED ISSUER channel, while
`approvedRedirects` values are plain exact-equality strings (1-2048) — so a
custom-scheme callback such as `muster://` is NOT refused by the code, and an
enabled engine could accept it today (iOS already follows that pattern with
its own scheme callback). That makes the canonical-HTTPS-origin macOS callback
an owner-quality requirement rather than a schema-enforced bound:
enrollment. The iOS `muster://oauth/finish` convention is therefore source
evidence of an existing callback style, NOT a valid macOS redirect answer, and
no macOS scheme has been registered anywhere in this work.

## Distinction that must survive every review

**Google's identity issuer is NOT Muster's enrollment authority.** The two
answer different questions (an ID-token audience is an OAuth client
identifier; the enrollment issuer is the canonical HTTPS origin an enrollment
acts under and is compared for equality in bindings and upstream headers).
The schema mechanically CANNOT keep a perfectly canonical third-party origin
out of the issuer slot — `canonicalIssuerWire.safeParse("https://accounts.google.com")`
passes — so this distinction is an owner decision, pinned by
`IDENTITY_ISSUER_IS_NOT_ENROLLMENT_AUTHORITY` in
`installation-enrollment-trust-config.ts` and covered by
`testKeepsTheIdentityIssuerExplicitlyDistinctFromTheEnrollmentAuthority`.

## Unanswered today — normal state

An empty candidate report (`server/installation-enrollment-trust-config.ts`,
`inspectEnrollmentTrustConfiguration({})`) answers `unanswered` for all five
questions, `complete: false`, and one blocked consequence per question. That
is the expected response until each deployment value arrives from the owner.
No value has been filled, defaulted, guessed or derived — including from the
identity issuer's audience or a Google URL.
