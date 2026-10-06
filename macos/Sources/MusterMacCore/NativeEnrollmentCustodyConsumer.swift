// Native enrollment custody consumer — the consumer path for
// `ProtectedEnrollmentCustodyStore`.
//
// WHY THIS FILE EXISTS. The custody store was merged as a standalone mapping of
// the reviewed W2 seam (`ProtectedEnrollmentCustodyStore.swift`, 898 lines, with
// its own in-memory-Keychain suite). Its own header recorded the honest gap:
// "Nothing calls it; there is no route, no view hook, no `NativeSignInCoordinator`,
// `SessionKeychain` or `ProviderCredentialBroker` change". That was true and is
// still true of every OTHER file. So the store's read/write/delete, generation
// ledger, restart fence and deletion tombstones were only ever exercised by the
// store's own tests, and nothing anywhere stated what a CALLER must do when
// custody is unavailable. This file is that caller.
//
// It is a CONSUMER, not a second authority. The server already owns the
// authoritative begin/complete rules (`server/installation-enrollment-contract.ts`,
// `begin` at :1166, `complete` at :1334, `CleanupOutcome` at :944). This type
// mirrors those rules at the client end, for exactly the operations the server
// cannot perform on this Mac:
//
//   * the credential exists here, on the device, and only protected storage on
//     this device may ever hold it;
//   * the durable generation announcement, the conditional commit, the fence
//     consultation and the post-commit cleanup are all device-side acts.
//
// The BRIDGE that would carry a commit request from the server process to this
// type is NOT implemented and is not invented here: its shape, its
// authentication and its owner are pending decisions recorded in
// `docs/plans/native-enrollment-trust-config-request-2026-10-07.md`. What this file
// provides is the device-side consumer such a bridge would drive, so the custody
// rules are proven end-to-end through the real store rather than only through
// fixtures. Nothing here enables enrollment: `enrollmentEnabled` stays false,
// and no transport, route or view calls this type.
//
// SCOPE — WHAT IS DELIBERATELY NOT DONE HERE:
//   * No issuer, audience, authority or callback value is chosen, read or
//     guessed. This type validates SHAPE only, and refuses; it never decides
//     which issuer is trusted. Google's identity issuer is NOT Muster's
//     enrollment authority — see the trust request.
//   * No bridge protocol, no network path, no `muster://` or HTTPS callback.
//     A custom URL scheme cannot satisfy `approvedRedirects`, which require
//     exact canonical origins (`installation-enrollment-contract.ts:320-322`,
//     `:376-385`, `:1220-1221`).
//   * No plaintext fallback, anywhere, for any reason (see
//     `plaintextFallback()`).
//   * No re-implementation of the attempt store. The custody GENERATION is
//     allocated by the authority and carried in verbatim; this type never
//     allocates one.
//
// GENERATION DOMAINS STAY DISTINCT — the standing rule, and the thing most
// likely to be broken by accident here:
//
//   * the enrollment CUSTODY generation is a per-client-key integer STRING the
//     authority allocated. It is the only generation this type reads, writes or
//     compares, and it is stored verbatim;
//   * the sign-in attempt counter (`NativeSignInCoordinator.generation`, an
//     in-memory Swift `Int`, `NativeSignInCoordinator.swift:105`) is a different
//     domain in a different type and is never read or written here;
//   * the installation registry generation is a server lane (`FileEnrollmentAttemptStore`
//     allocates it, `installation-enrollment-attempt-store.ts:208`) and is never
//     consulted here.
//
// This type's own ownership counter (`epoch`) is a fourth, LOCAL domain used
// only to decide which pending attempt still owns the flow. It is never written
// to storage: `beginAnnouncement.generation` and the envelope's `storedGeneration`
// are the only generations that ever reach the Keychain, and both are the
// authority's string. `testPersistedGenerationsAreOnlyTheAuthorityAllocatedOnes`
// pins that by decoding the stored bytes.
//
// FAIL-CLOSED DEGRADATION. A degraded or unavailable secure store must REFUSE,
// never silently continue. Concretely, and each proven by a test in
// `NativeEnrollmentCustodyConsumerTests.swift`:
//
//   * the store is a non-optional dependency — a consumer cannot be built
//     without one, so there is no "no custody configured" branch;
//   * `begin` consults the fence BEFORE announcing and refuses on a fenced or
//     unreadable fence store;
//   * an announcement that throws is `.custodyUnavailable`, never a success with
//     an unannounced generation;
//   * `complete` consults the fence before minting and again before committing,
//     so an unresolved key never receives the credential at all;
//   * every typed store refusal maps to a named refusal; none is retried, and
//     none is treated as success-by-default;
//   * cleanup distinguishes "proved removed" from "could not prove removal",
//     and only the latter fences;
//   * `plaintextFallback()` exists solely to throw.

import Foundation

// MARK: - Wire-level values this consumer is handed

/// One enrollment attempt, as the authority describes it. Contains NO
/// credential: the credential arrives later, from the mint closure, and only
/// ever enters protected storage.
struct NativeEnrollmentCustodyAttempt: Equatable, Sendable {
    /// The authority's intent identity. Its single-use state is enforced HERE
    /// (one claim per intent) rather than re-derived from storage.
    var intentId: String
    var clientKey: String
    /// The authority-allocated custody generation, carried VERBATIM. This type
    /// never allocates, increments, reformats or substitutes one — see the
    /// generation-domain note in the file header.
    var custodyGeneration: String
    /// The authenticated binding quadruple plus the owner/session bindings and
    /// the authority string. Carried verbatim; the store is what validates it.
    var binding: ProtectedEnrollmentBinding
    var platform: String
    /// The capability list the authority asked for. Bounds mirror
    /// `protectedEnvelopeWire.capabilities`
    /// (`installation-enrollment-contract.ts:300`): at most 16 entries of at
    /// most 64 characters. Carried verbatim — this type never widens a
    /// capability scope.
    var capabilities: [String]
}

/// What a commit needs to know BEFORE a credential exists. Deliberately
/// credential-free: a mint closure receives this, and nothing else.
struct NativeEnrollmentCustodyMintRequest: Equatable, Sendable {
    var intentId: String
    var clientKey: String
    /// The custody generation the commit will be conditioned on.
    var custodyGeneration: String
    var platform: String
    var capabilities: [String]
    /// The binding the credential must be consistent with.
    var binding: ProtectedEnrollmentBinding
    var issuedAt: Int64
}

/// The credential the upstream minted. `credential` is the secret: it enters
/// this type only as an argument to `commit`, never onto an outcome, an error
/// or a description.
struct NativeEnrollmentIssuedCredential: Equatable, Sendable {
    var installationId: String
    var credential: String
    /// Epoch milliseconds. Never absent: a credential that never expires is a
    /// permanent credential (`upstreamHeadersWire`,
    /// `installation-enrollment-contract.ts:431-438`).
    var credentialExpiresAt: Int64
}

// MARK: - Results

/// Why the consumer refused. Every case means "this enrollment did not happen",
/// and none is ever reported as a success. No case carries a client key or any
/// credential material.
enum NativeEnrollmentCustodyRefusal: Equatable, Sendable {
    /// The attempt is not one this consumer is holding.
    case unknownIntent
    /// A newer attempt or a newer committed credential owns this client key.
    case superseded
    /// The attempt was cancelled (window closed, sign-out, shutdown).
    case cancelled
    /// The intent was already claimed. One completion per intent.
    case replayed
    /// The secure store is unavailable, degraded, fenced, or its state could
    /// not be validated. NEVER a fallback to unprotected storage.
    case custodyUnavailable
    /// The custody generation is absent or not an orderable integer string. The
    /// consumer refuses rather than substituting a locally allocated one.
    case generationUnorderable
    /// The binding or request provenance is incomplete, contradictory or
    /// non-canonical.
    case bindingRefused
    /// This key was deleted; a strictly newer announced generation is required.
    case deleted
    /// The issued credential had already expired when it reached custody.
    case credentialExpired
    /// A write may have landed and removal could not be CONFIRMED, so the key
    /// has been fenced. Recovery is an explicit owner reset, not a retry.
    case custodyUnresolved
    /// The credential could not be written, and nothing may be reported as
    /// stored.
    case credentialPersistFailed

    var localizedReason: String {
        switch self {
        case .unknownIntent:
            return "This enrollment is no longer being held on this Mac."
        case .superseded:
            return "A newer enrollment already owns this Mac's record. The older attempt was refused."
        case .cancelled:
            return "This enrollment was cancelled on this Mac."
        case .replayed:
            return "This enrollment was already completed. It cannot be completed twice."
        case .custodyUnavailable:
            return "Muster could not reach protected storage on this Mac, so nothing was enrolled. It will not fall back to unprotected storage."
        case .generationUnorderable:
            return "The enrollment generation was missing or could not be ordered, so nothing was enrolled."
        case .bindingRefused:
            return "The enrollment identity binding was incomplete or non-canonical."
        case .deleted:
            return "This enrollment was deleted. A newer enrollment generation is required."
        case .credentialExpired:
            return "The enrollment credential had already expired, so it was not kept."
        case .custodyUnresolved:
            return "Muster could not confirm whether the enrollment credential was removed, so this Mac's enrollment is now paused and needs your explicit reset."
        case .credentialPersistFailed:
            return "Muster could not store this enrollment credential in protected storage. Nothing was stored."
        }
    }
}

/// A refusal as a throwable error, for the one surface that must THROW rather
/// than return: the attempt to reach unprotected storage. `errorDescription`
/// carries the measured reason and no client key, no issuer and no credential.
struct NativeEnrollmentCustodyFailure: Error, Equatable, Sendable {
    var reason: NativeEnrollmentCustodyRefusal

    var errorDescription: String? { reason.localizedReason }

    init(reason: NativeEnrollmentCustodyRefusal) {
        self.reason = reason
    }
}

/// What a successful enrollment yields. Metadata only: no credential, no client
/// key value and nothing the caller could use to reconstruct the secret.
struct NativeEnrollmentCustodySummary: Equatable, Sendable {
    var installationId: String
    var custodyGeneration: String
    var envelopeVersion: Int
    var credentialExpiresAt: Int64
}

/// The begin result: the generation was announced durably, or it was not.
enum NativeEnrollmentCustodyBeginResult: Equatable, Sendable {
    case announced(custodyGeneration: String)
    case refused(NativeEnrollmentCustodyRefusal)
}

/// The complete result.
enum NativeEnrollmentCustodyOutcome: Equatable, Sendable {
    case stored(NativeEnrollmentCustodySummary)
    case refused(NativeEnrollmentCustodyRefusal)
}

// MARK: - Cleanup, measured rather than assumed

/// What cleanup of a possibly-landed write actually established. Mirrors the
/// server's `CleanupOutcome` (`installation-enrollment-contract.ts:944-950`):
/// only an EXPLICIT absent row — or one demonstrably carrying a different
/// committed generation — counts as removed. Anything else fences.
enum NativeEnrollmentCleanupOutcome: Equatable, Sendable {
    /// Read back explicitly absent: our record is gone.
    case removed
    /// A newer committed winner occupies the key; ours is not there.
    case supersededWinnerKept
    /// Removal could not be confirmed. The credential may still be usable.
    case unresolved
}

// MARK: - The consumer

/// The device-side consumer of protected enrollment custody.
///
/// An actor, so its own flow state (which attempt owns which client key, which
/// intent is claimed) cannot be mutated by two callers at once. It is NOT
/// atomic across its `await`s — every decision is therefore re-read after every
/// await, exactly as the server's `guard` re-reads live state
/// (`installation-enrollment-contract.ts:1366-1407`). Re-entrancy across an
/// await is exactly how a held completion, a cancellation and a newer attempt
/// interleave in production, and each of those is proven by a test here.
actor NativeEnrollmentCustodyConsumer {
    /// Non-optional by construction: a consumer without a secure store has no
    /// honest behaviour, so the type does not admit one.
    private let store: any ProtectedCredentialStore
    private let clock: @Sendable () -> Int64

    /// Pending attempts, by intent id. Retained after completion so a replay is
    /// refused rather than mistaken for a fresh intent — the same reason the
    /// server's `claimIntent` MARKS the row rather than deleting it
    /// (`installation-enrollment-contract.ts:753-763`).
    private var attempts: [String: PendingAttempt] = [:]
    /// The local ownership epoch. Incremented on every begin, supersede, cancel
    /// and context invalidation. LOCAL ONLY — never persisted, never compared
    /// against a custody generation.
    private var epoch: UInt64 = 0

    private struct PendingAttempt {
        var attempt: NativeEnrollmentCustodyAttempt
        var epoch: UInt64
        var claimed: Bool
        var cancelled: Bool
        var superseded: Bool
    }

    init(store: any ProtectedCredentialStore,
         clock: @escaping @Sendable () -> Int64 = {
             Int64(Date().timeIntervalSince1970 * 1000)
         }) {
        self.store = store
        self.clock = clock
    }

    // MARK: Begin

    /// Announce an enrollment the authority has begun, DURABLY, before the
    /// caller may continue. Success means the custody store holds the
    /// generation in its persisted ledger — not merely that a request was sent.
    func begin(_ incoming: NativeEnrollmentCustodyAttempt) async -> NativeEnrollmentCustodyBeginResult {
        guard isWellFormed(incoming) else { return .refused(.bindingRefused) }
        guard Self.isOrderableGeneration(incoming.custodyGeneration) else {
            return .refused(.generationUnorderable)
        }
        // Consult the fence BEFORE announcing. A degraded fence store answers
        // `isFenced == true` for every key, so a store whose fence state cannot
        // be read refuses here rather than half-beginning.
        if await store.isFenced(clientKey: incoming.clientKey) {
            return .refused(.custodyUnavailable)
        }

        epoch += 1
        let startingEpoch = epoch
        // A newer attempt for this key retires the older one FIRST, so the old
        // completion cannot reach its commit on a stale claim.
        supersedeHeldAttempts(for: incoming.clientKey)
        attempts[incoming.intentId] = PendingAttempt(
            attempt: incoming, epoch: startingEpoch, claimed: false, cancelled: false, superseded: false)

        do {
            try await store.noteGeneration(clientKey: incoming.clientKey,
                                           generation: incoming.custodyGeneration)
        } catch let refusal as ProtectedEnrollmentCustodyError {
            attempts[incoming.intentId] = nil
            return .refused(Self.map(refusal, fallback: .custodyUnavailable))
        } catch {
            attempts[incoming.intentId] = nil
            return .refused(.custodyUnavailable)
        }

        // Re-read after the await: a newer begin or a cancellation may have
        // landed while the durable announcement was in flight, and an
        // announcement for a retired attempt must not report success.
        if let pending = attempts[incoming.intentId],
           pending.epoch == startingEpoch, !pending.cancelled, !pending.superseded {
            return .announced(custodyGeneration: incoming.custodyGeneration)
        }
        attempts[incoming.intentId] = nil
        return .refused(.superseded)
    }

    // MARK: Complete

    /// Complete a held enrollment: mint, then commit under the custody
    /// generation `begin` announced, and verify afterwards that this attempt
    /// still owns the outcome.
    ///
    /// The credential exists only between the mint closure and `commit`. It is
    /// never returned, described or logged.
    func complete(_ intentId: String,
                  mint: @Sendable (NativeEnrollmentCustodyMintRequest) async throws -> NativeEnrollmentIssuedCredential)
        async -> NativeEnrollmentCustodyOutcome {
        guard var pending = attempts[intentId] else { return .refused(.unknownIntent) }
        if let refusal = ownershipRefusal(for: pending) { return .refused(refusal) }
        if pending.claimed { return .refused(.replayed) }

        let clientKey = pending.attempt.clientKey
        let generation = pending.attempt.custodyGeneration

        // Single-use, claimed BEFORE the mint so a concurrent replay is refused
        // even while the first completion is held on the network.
        pending.claimed = true
        attempts[intentId] = pending
        let claimedEpoch = pending.epoch

        if await store.isFenced(clientKey: clientKey) { return .refused(.custodyUnavailable) }

        let issuedAt = clock()
        let request = NativeEnrollmentCustodyMintRequest(
            intentId: intentId,
            clientKey: clientKey,
            custodyGeneration: generation,
            platform: pending.attempt.platform,
            capabilities: pending.attempt.capabilities,
            binding: pending.attempt.binding,
            issuedAt: issuedAt)

        let issued: NativeEnrollmentIssuedCredential
        do {
            issued = try await mint(request)
        } catch {
            // No credential exists, so nothing was written and nothing needs
            // cleanup. The intent stays CLAIMED: a refused mint is not a licence
            // to replay the same intent.
            return .refused(.credentialPersistFailed)
        }

        // Re-read ownership after the mint's await, BEFORE any write. A
        // cancellation or a newer attempt that landed while the mint was held
        // must stop here: the credential is dropped, not stored.
        guard let current = attempts[intentId], current.epoch == claimedEpoch else {
            return .refused(.unknownIntent)
        }
        if let refusal = ownershipRefusal(for: current) { return .refused(refusal) }

        // Fence again immediately before the write. Between the post-mint read
        // and this line another completion may have established that custody is
        // unresolved for this key; an unresolved key must not receive a
        // credential at all.
        if await store.isFenced(clientKey: clientKey) { return .refused(.custodyUnavailable) }

        let envelope: ProtectedEnrollmentCustodyEnvelope
        do {
            envelope = try await store.commit(
                ProtectedEnrollmentCustodyRequest(
                    clientKey: clientKey,
                    installationId: issued.installationId,
                    credential: issued.credential,
                    binding: current.attempt.binding,
                    platform: current.attempt.platform,
                    capabilities: current.attempt.capabilities,
                    issuedAt: issuedAt,
                    credentialExpiresAt: issued.credentialExpiresAt),
                expectedGeneration: generation)
        } catch let refusal as ProtectedEnrollmentCustodyError {
            // Nothing this consumer can do about a store refusal, and nothing
            // this consumer may soften: each maps to a named refusal.
            return .refused(Self.map(refusal, fallback: .credentialPersistFailed))
        } catch {
            return .refused(.credentialPersistFailed)
        }

        // A write MAY have landed from here on. Every refusal below is therefore
        // paired with cleanup, and cleanup that cannot prove removal fences.
        let afterWrite = ownershipRefusal(for: attempts[intentId])
        let fencedAfterWrite = await store.isFenced(clientKey: clientKey)
        if afterWrite != nil || fencedAfterWrite {
            let cleanup = await cleanupLandedWrite(clientKey: clientKey, generation: generation)
            switch cleanup {
            case .unresolved: return .refused(.custodyUnresolved)
            case .removed, .supersededWinnerKept:
                return .refused(afterWrite ?? .custodyUnavailable)
            }
        }

        // An already-expired credential must not be adopted and must not sit in
        // custody. The intent window says nothing about this value.
        if clock() >= envelope.credentialExpiresAt {
            let cleanup = await cleanupLandedWrite(clientKey: clientKey, generation: generation)
            if cleanup == .unresolved { return .refused(.custodyUnresolved) }
            return .refused(.credentialExpired)
        }

        return .stored(NativeEnrollmentCustodySummary(
            installationId: envelope.installationId,
            custodyGeneration: generation,
            envelopeVersion: envelope.version,
            credentialExpiresAt: envelope.credentialExpiresAt))
    }

    // MARK: Cancellation and removal

    /// Cancel a held attempt. MARKED, not removed, so a completion already held
    /// on the network can still observe the cancellation at its next boundary.
    @discardableResult
    func cancel(_ intentId: String) -> Bool {
        guard var pending = attempts[intentId] else { return false }
        guard !pending.cancelled else { return false }
        epoch += 1
        pending.cancelled = true
        attempts[intentId] = pending
        return true
    }

    /// Cancel everything held. The sign-out / account-change / endpoint-change /
    /// shutdown surface: one call, no attempt survives it.
    func cancelAll() -> Int {
        let live = attempts.filter { !$0.value.cancelled && !$0.value.superseded }
        guard !live.isEmpty else { return 0 }
        epoch += 1
        for intentId in live.keys { attempts[intentId]?.cancelled = true }
        return live.count
    }

    /// The explicit, unconditional removal: the Keychain record AND a deletion
    /// tombstone naming the generation it removed. A later completion carrying
    /// that same generation cannot resurrect it.
    func deleteEnrollment(clientKey: String) async throws -> Bool {
        try await store.delete(clientKey)
    }

    /// The explicit owner action: clear every persisted fence, including a
    /// degraded episode. The only way a fenced or unresolved key becomes
    /// begin-able again.
    func resetFences() async throws {
        try await store.resetFences()
    }

    /// Always throws. There is no unprotected fallback for an enrollment
    /// credential, so a caller reaching for one gets a named refusal instead of
    /// a plain write. Mirrors `ProviderSecretStore.plaintextFallback()`.
    func plaintextFallback() throws -> Never {
        throw NativeEnrollmentCustodyFailure(reason: .custodyUnavailable)
    }

    /// Whether this consumer currently holds an attempt for the intent. A
    /// review seam for the state the refusals are derived from; it exposes no
    /// credential.
    func isHolding(intentId: String) -> Bool {
        attempts[intentId] != nil
    }

    // MARK: Internals

    /// Order the attempt's own state, newest-local-epoch first.
    private func ownershipRefusal(for pending: PendingAttempt?) -> NativeEnrollmentCustodyRefusal? {
        guard let pending else { return .unknownIntent }
        if pending.cancelled { return .cancelled }
        if pending.superseded || pending.epoch != epochFor(pending.attempt.clientKey) { return .superseded }
        return nil
    }

    /// The newest local epoch seen for a client key, derived from the pending
    /// set rather than a second counter, so it cannot drift from the attempts it
    /// describes.
    private func epochFor(_ clientKey: String) -> UInt64 {
        attempts.values
            .filter { $0.attempt.clientKey == clientKey && !$0.superseded }
            .map { $0.epoch }
            .max() ?? 0
    }

    private func supersedeHeldAttempts(for clientKey: String) {
        let live = attempts.filter {
            $0.value.attempt.clientKey == clientKey && !$0.value.cancelled && !$0.value.superseded
        }
        for intentId in live.keys { attempts[intentId]?.superseded = true }
    }

    /// Remove a write that may have landed, and MEASURE what that removal
    /// established. `invalidate` conditioned on the row actually stored cannot
    /// delete a newer winner, so a `false` there is uncertainty, not proof —
    /// hence the explicit three-way read that follows it.
    private func cleanupLandedWrite(clientKey: String,
                                    generation: String) async -> NativeEnrollmentCleanupOutcome {
        do {
            _ = try await store.invalidate(clientKey, generation: generation)
        } catch {
            return await fenceUnresolved(clientKey: clientKey)
        }
        let observed = await store.read(clientKey)
        switch observed {
        case .absent:
            return .removed
        case .unknown:
            return await fenceUnresolved(clientKey: clientKey)
        case let .present(record):
            // Only demonstrably-NOT-ours is acceptable. The discriminator is
            // the generation the row was committed under, never a timestamp:
            // `issuedAt` comes from credential issuance and `createdAt` from
            // begin, so for one generation they normally differ.
            if record.storedGeneration != generation { return .supersededWinnerKept }
            return await fenceUnresolved(clientKey: clientKey)
        }
    }

    /// The ONE place an unresolved cleanup arms the fence, so no caller can
    /// forget it. A write may have landed and removal could not be proven, so
    /// the key stops being begin-able until an explicit owner reset.
    private func fenceUnresolved(clientKey: String) async -> NativeEnrollmentCleanupOutcome {
        try? await store.fence(clientKey: clientKey, reason: "custody-unresolved")
        return .unresolved
    }

    /// Well-formedness checks only (shape, not trust): nothing here decides
    /// whether a value is TRUSTED, and
    /// the issuer is not inspected — the store owns that (:862-893).
    private func isWellFormed(_ attempt: NativeEnrollmentCustodyAttempt) -> Bool {
        !attempt.intentId.isEmpty
            && !attempt.clientKey.isEmpty
            && !attempt.platform.isEmpty
            && attempt.binding.clientKey == attempt.clientKey
            && !attempt.binding.cloudSubject.isEmpty
            && !attempt.binding.cloudAuthority.isEmpty
            && !attempt.binding.cloudIssuer.isEmpty
            && !attempt.binding.workspaceId.isEmpty
            && !attempt.binding.localOwnerId.isEmpty
            && !attempt.binding.localSessionId.isEmpty
            && attempt.capabilities.count <= 16
            && attempt.capabilities.allSatisfy { !$0.isEmpty && $0.count <= 64 }
    }

    /// This build's custody generations are integer strings, because the
    /// authority allocates them as per-key counters. A value that cannot be
    /// ordered is REFUSED rather than guessed at — inventing an order would let
    /// a stale completion install a credential over a newer winner, which is
    /// precisely what the conditional commit exists to prevent.
    static func isOrderableGeneration(_ generation: String) -> Bool {
        guard let value = Int(generation), value > 0 else { return false }
        return String(value) == generation
    }

    /// Map a typed store refusal onto a named consumer refusal. The mapping is
    /// total, and no case resolves to a success.
    static func map(_ refusal: ProtectedEnrollmentCustodyError,
                    fallback: NativeEnrollmentCustodyRefusal) -> NativeEnrollmentCustodyRefusal {
        switch refusal {
        case .staleGeneration: return .superseded
        case .keyFenced, .fenceStoreDegraded, .custodyUnreadable, .ledgerUnreadable, .tombstoneUnreadable:
            return .custodyUnavailable
        case .keyDeleted: return .deleted
        case .generationUnorderable: return .generationUnorderable
        case .bindingKeyMismatch, .invalidBinding: return .bindingRefused
        case .writeRefused: return fallback
        case .deleteRefused: return .custodyUnavailable
        }
    }
}
