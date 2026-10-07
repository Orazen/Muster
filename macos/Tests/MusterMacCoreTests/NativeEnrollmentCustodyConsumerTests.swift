// ============================================================================
// Native enrollment custody consumer — integration coverage through the REAL
// protected custody store.
//
// These are integration cases, not fixtures: every one drives
// `NativeEnrollmentCustodyConsumer` against a real `ProtectedEnrollmentCustodyStore`
// actor writing real Keychain-shaped bytes through the injectable
// `EnrollmentCustodyKeychainOps` seam, and asserts on those bytes. A restart is
// a FRESH store and a FRESH consumer over the same backend, so it observes only
// what was persisted — never in-memory state. The user's real Keychain is never
// read or written, matching the convention the store's own suite established.
//
// NOT CLAIMED:
//   * no enrollment is enabled or wired to a route, a view or a bridge — the
//     server contract stays inert (`enrollmentEnabled = false`) and nothing in
//     this package calls the consumer in production;
//   * no issuer, audience, authority or callback value is chosen: the origins
//     below are synthetic `.invalid` fixtures, and Google's identity issuer is
//     NOT Muster's enrollment authority (see
//     `docs/plans/native-enrollment-trust-config-request-2026-10-07.md`);
//   * no security property beyond what each case name states;
//   * the server-side begin/complete rules are not re-proven here — they are the
//     server's, and this suite covers the device-side consumer only.
// ============================================================================

import Foundation
import Security
import XCTest
@testable import MusterMacCore

// MARK: - Probes over the persisted bytes
//
// The store's payload structs are private, so these decode the exact JSON the
// store wrote. Reading the bytes back — rather than trusting a returned
// envelope — is what makes "the newer winner survived" a real observation.

private struct StoredRecordProbe: Decodable {
    struct Envelope: Decodable {
        var version: Int
        var sealed: String
        var installationId: String
        var clientKey: String
        var credentialExpiresAt: Int64
    }
    var envelope: Envelope
    var storedGeneration: String
}

private struct LedgerProbe: Decodable {
    var generation: String
}

private struct TombstoneProbe: Decodable {
    var deletedGeneration: String?
}

private func ledgerGeneration(_ backend: FakeCustodyKeychain, _ clientKey: String) throws -> String {
    let data = try XCTUnwrap(backend.ledgerData(clientKey), "no persisted generation ledger for \(clientKey)")
    return try JSONDecoder().decode(LedgerProbe.self, from: data).generation
}

private func storedRecord(_ backend: FakeCustodyKeychain, _ clientKey: String) throws -> StoredRecordProbe {
    let data = try XCTUnwrap(backend.recordData(clientKey), "no persisted custody record for \(clientKey)")
    return try JSONDecoder().decode(StoredRecordProbe.self, from: data)
}

private func storedTombstone(_ backend: FakeCustodyKeychain, _ clientKey: String) throws -> TombstoneProbe {
    let data = try XCTUnwrap(backend.tombstoneData(clientKey), "no persisted tombstone for \(clientKey)")
    return try JSONDecoder().decode(TombstoneProbe.self, from: data)
}

private func containsSecret(_ backend: FakeCustodyKeychain, _ secret: String) -> Bool {
    backend.allStoredValues().contains { String(decoding: $0, as: UTF8.self).contains(secret) }
}

// MARK: - Small concurrency helpers

/// One-shot gate. Used to hold a completion at a specific boundary so a
/// cancellation, a replay or a competing consumer can land inside the window
/// without a timing assumption.
private final class Latch: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            if opened {
                lock.unlock()
                continuation.resume()
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    func open() {
        lock.lock()
        opened = true
        let pending = waiters
        waiters = []
        lock.unlock()
        for continuation in pending { continuation.resume() }
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() {
        lock.lock(); defer { lock.unlock() }
        count += 1
    }

    var value: Int {
        lock.lock(); defer { lock.unlock() }
        return count
    }
}

/// Pause one actual fence-read boundary without a timing assumption. Other
/// reads may continue, so a newer attempt can complete while the old one waits.
private actor FenceReadGate {
    let entered = Latch()
    let release = Latch()
    private let selectedRead: Int
    private var reads = 0

    init(selectedRead: Int) { self.selectedRead = selectedRead }

    func pauseIfSelected() async {
        reads += 1
        if reads == selectedRead {
            entered.open()
            await release.wait()
        }
    }
}

/// A pass-through custody store that can hold `commit` open on either side of
/// the real write, and that announces when the real write landed. Everything
/// else — the fence, the ledger, the tombstone, the conditional check — is the
/// REAL store's, delegated member by member, so the only thing this double adds
/// is a place to interleave. It is a test seam for ordering, not a substitute
/// store.
private final class GatedCustodyStore: ProtectedCredentialStore, @unchecked Sendable {
    let backing: ProtectedEnrollmentCustodyStore
    let beforeCommit = Latch()
    let afterCommit = Latch()
    let commitLanded = Latch()
    let commitCalls = Counter()
    private let holdsBeforeCommit: Bool
    private let holdsAfterCommit: Bool
    let fenceReadGate: FenceReadGate?
    /// Models an adapter whose explicit read is indeterminate but which does NOT
    /// arm the fence itself. It exists so one case can isolate the CONSUMER's own
    /// contribution: with the current store both places fence, so without this
    /// the consumer's arming would be unproven decoration.
    private let silentUnknownRead: Bool

    init(backing: ProtectedEnrollmentCustodyStore,
         holdsBeforeCommit: Bool = false,
         holdsAfterCommit: Bool = false,
         silentUnknownRead: Bool = false,
         selectedFenceRead: Int? = nil) {
        self.backing = backing
        self.holdsBeforeCommit = holdsBeforeCommit
        self.holdsAfterCommit = holdsAfterCommit
        self.silentUnknownRead = silentUnknownRead
        self.fenceReadGate = selectedFenceRead.map { FenceReadGate(selectedRead: $0) }
    }

    @discardableResult
    func commit(_ request: ProtectedEnrollmentCustodyRequest,
                expectedGeneration: String) async throws -> ProtectedEnrollmentCustodyEnvelope {
        commitCalls.increment()
        if holdsBeforeCommit { await beforeCommit.wait() }
        let envelope: ProtectedEnrollmentCustodyEnvelope
        do {
            envelope = try await backing.commit(request, expectedGeneration: expectedGeneration)
        } catch {
            // Never leave a waiter parked on a write that did not land.
            commitLanded.open()
            throw error
        }
        commitLanded.open()
        if holdsAfterCommit { await afterCommit.wait() }
        return envelope
    }

    func get(_ clientKey: String) async throws -> ProtectedEnrollmentCustodyEnvelope? {
        try await backing.get(clientKey)
    }

    func read(_ clientKey: String) async -> ProtectedEnrollmentCustodyRead {
        if silentUnknownRead { return .unknown }
        return await backing.read(clientKey)
    }

    func invalidate(_ clientKey: String, generation: String) async throws -> Bool {
        try await backing.invalidate(clientKey, generation: generation)
    }

    func delete(_ clientKey: String) async throws -> Bool {
        try await backing.delete(clientKey)
    }

    func noteGeneration(clientKey: String, generation: String) async throws {
        try await backing.noteGeneration(clientKey: clientKey, generation: generation)
    }

    func isFenced(clientKey: String) async -> Bool {
        if let fenceReadGate { await fenceReadGate.pauseIfSelected() }
        return await backing.isFenced(clientKey: clientKey)
    }

    func fence(clientKey: String, reason: String) async throws {
        try await backing.fence(clientKey: clientKey, reason: reason)
    }

    func resetFences() async throws {
        try await backing.resetFences()
    }
}

// MARK: - Fixtures

private let fixtureNow = Int64(1_760_000_000_000)
private let keyA = "client-key-consumer-a-0001"
private let keyB = "client-key-consumer-b-0002"

private func fixtureAttempt(intentId: String,
                            clientKey: String,
                            generation: String,
                            bindingClientKey: String? = nil) -> NativeEnrollmentCustodyAttempt {
    NativeEnrollmentCustodyAttempt(
        intentId: intentId,
        clientKey: clientKey,
        custodyGeneration: generation,
        // Synthetic .invalid fixture origins. This suite chooses NO production
        // issuer or authority: the trusted issuer, the approved redirects and
        // the cloudAuthority value are owner decisions, still pending.
        binding: ProtectedEnrollmentBinding(
            cloudSubject: "sub-consumer-fixture-0001",
            cloudAuthority: "https://enrollment-consumer-fixture.invalid",
            cloudIssuer: "https://enrollment-consumer-fixture.invalid",
            workspaceId: "workspace-consumer-fixture-0001",
            localOwnerId: "owner-consumer-fixture-0001",
            localSessionId: "session-consumer-fixture-0001",
            clientKey: bindingClientKey ?? clientKey),
        platform: "macos",
        capabilities: ["workspace"])
}

private func minted(_ credential: String,
                    installationId: String = "installation-consumer-fixture-0001",
                    expiresAt: Int64 = fixtureNow + 600_000) -> NativeEnrollmentIssuedCredential {
    NativeEnrollmentIssuedCredential(
        installationId: installationId,
        credential: credential,
        credentialExpiresAt: expiresAt)
}

private func fixtureMint(_ credential: String,
                         installationId: String = "installation-consumer-fixture-0001",
                         expiresAt: Int64 = fixtureNow + 600_000,
                         counter: Counter? = nil)
    -> @Sendable (NativeEnrollmentCustodyMintRequest) async throws -> NativeEnrollmentIssuedCredential {
    { _ in
        counter?.increment()
        return minted(credential, installationId: installationId, expiresAt: expiresAt)
    }
}

// MARK: - Tests

final class NativeEnrollmentCustodyConsumerTests: XCTestCase {
    /// The production wiring of the consumer under test: the REAL store over the
    /// injectable Keychain seam, and a fixed clock so expiry is deterministic.
    private func makeConsumer(_ backend: FakeCustodyKeychain,
                              store: ProtectedEnrollmentCustodyStore? = nil)
        -> (NativeEnrollmentCustodyConsumer, ProtectedEnrollmentCustodyStore) {
        let custody = store ?? ProtectedEnrollmentCustodyStore(ops: backend)
        return (NativeEnrollmentCustodyConsumer(store: custody, clock: { fixtureNow }), custody)
    }

    // MARK: Durable announcement

    func testBeginAnnouncesTheAuthorityGenerationIntoPersistedStorage() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)

        let began = await consumer.begin(fixtureAttempt(intentId: "intent-1", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))

        // The announcement is a PERSISTED ledger row, not merely a returned value.
        XCTAssertEqual(try ledgerGeneration(backend, keyA), "1")
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertEqual(backend.fenceCount(), 0)
    }

    // MARK: Generation domains

    func testPersistedGenerationsAreOnlyTheAuthorityAllocatedOnes() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)

        // Three authority-allocated generations for one key, monotonic but
        // irregularly spaced: the consumer must carry whatever the authority
        // allocated and must never mint a local counter of its own.
        for (index, generation) in ["4", "17", "103"].enumerated() {
            let began = await consumer.begin(
                fixtureAttempt(intentId: "intent-\(index)", clientKey: keyA, generation: generation))
            XCTAssertEqual(began, .announced(custodyGeneration: generation))
        }

        let outcome = await consumer.complete("intent-2", mint: fixtureMint("credential-generation-103"))
        guard case let .stored(summary) = outcome else {
            return XCTFail("expected the newest attempt to store, got \(outcome)")
        }
        XCTAssertEqual(summary.custodyGeneration, "103")

        // The only generations that reached storage are the authority's, and the
        // stored one is the newest authority value. The consumer's own local
        // ownership counter appears nowhere in the persisted bytes.
        XCTAssertEqual(try ledgerGeneration(backend, keyA), "103")
        XCTAssertEqual(try storedRecord(backend, keyA).storedGeneration, "103")
        XCTAssertEqual(try storedRecord(backend, keyA).envelope.sealed, "credential-generation-103")

        // A superseded attempt is refused before any write: the newest attempt
        // for the key owns the flow.
        let stale = await consumer.complete("intent-1", mint: fixtureMint("credential-generation-17"))
        XCTAssertEqual(stale, .refused(.superseded))
        XCTAssertEqual(try storedRecord(backend, keyA).envelope.sealed, "credential-generation-103")
    }

    func testAnOlderAnnouncedGenerationCannotRollTheLedgerBackOrOverwriteACommittedWinner() async throws {
        let backend = FakeCustodyKeychain()
        let (winner, _) = makeConsumer(backend)
        let began = await winner.begin(fixtureAttempt(intentId: "winner", clientKey: keyA, generation: "9"))
        XCTAssertEqual(began, .announced(custodyGeneration: "9"))
        let enrolled = await winner.complete("winner", mint: fixtureMint("credential-generation-9"))
        guard case .stored = enrolled else { return XCTFail("enrollment failed: \(enrolled)") }
        XCTAssertEqual(try ledgerGeneration(backend, keyA), "9")

        // A second consumer announces an OLDER generation. The durable ledger is
        // monotonic, so the announcement does not roll it back...
        let (older, _) = makeConsumer(backend)
        let olderBegan = await older.begin(fixtureAttempt(intentId: "older", clientKey: keyA, generation: "5"))
        XCTAssertEqual(olderBegan, .announced(custodyGeneration: "5"))
        XCTAssertEqual(try ledgerGeneration(backend, keyA), "9")

        // ...and that older generation cannot commit over the committed winner.
        let stale = await older.complete("older", mint: fixtureMint("credential-generation-5"))
        XCTAssertEqual(stale, .refused(.superseded))
        XCTAssertEqual(try storedRecord(backend, keyA).envelope.sealed, "credential-generation-9")
        XCTAssertEqual(try storedRecord(backend, keyA).storedGeneration, "9")
    }

    func testAGenerationThatCannotBeOrderedIsRefusedAndNothingIsPersisted() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let established = await consumer.begin(
            fixtureAttempt(intentId: "intent-base", clientKey: keyA, generation: "5"))
        XCTAssertEqual(established, .announced(custodyGeneration: "5"))

        // Absent, non-numeric, zero and non-canonical spellings are all refused:
        // inventing an order for them would let a stale completion install a
        // credential over a newer winner.
        for generation in ["", "abc", "0", "05", "5x", " 5"] {
            let began = await consumer.begin(
                fixtureAttempt(intentId: "intent-\(generation)", clientKey: keyA, generation: generation))
            XCTAssertEqual(began, .refused(.generationUnorderable),
                           "generation \(generation.debugDescription) must be refused")
        }

        // The refused announcements left the ledger exactly where it was.
        XCTAssertEqual(try ledgerGeneration(backend, keyA), "5")
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertEqual(backend.fenceCount(), 0)
    }

    // MARK: Conditional writes

    func testAConditionalWritePreservesTheNewerCredentialAndLeavesOtherAccountsUntouched() async throws {
        let backend = FakeCustodyKeychain()
        // Two independent consumers over the SAME store: the second authority
        // announces a newer generation while the first still believes it owns
        // the key. This is the cross-instance race the conditional commit exists
        // for, and neither consumer knows about the other's state.
        let (first, _) = makeConsumer(backend)
        let (second, _) = makeConsumer(backend)

        let olderBegan = await first.begin(fixtureAttempt(intentId: "first", clientKey: keyA, generation: "1"))
        XCTAssertEqual(olderBegan, .announced(custodyGeneration: "1"))

        // An unrelated account, committed first, so this case can prove the
        // older write does not disturb it.
        let otherBegan = await second.begin(
            fixtureAttempt(intentId: "other", clientKey: keyB, generation: "4"))
        XCTAssertEqual(otherBegan, .announced(custodyGeneration: "4"))
        let otherOutcome = await second.complete("other", mint: fixtureMint("credential-other-unrelated"))
        guard case .stored = otherOutcome else { return XCTFail("unrelated enrollment failed: \(otherOutcome)") }
        let otherRecordBefore = try XCTUnwrap(backend.recordData(keyB))
        XCTAssertEqual(try storedRecord(backend, keyB).storedGeneration, "4")

        // A newer generation for keyA is announced by the other consumer.
        let newerBegan = await second.begin(
            fixtureAttempt(intentId: "newer", clientKey: keyA, generation: "2"))
        XCTAssertEqual(newerBegan, .announced(custodyGeneration: "2"))

        // The OLDER attempt now tries to commit through the real store.
        let stale = await first.complete("first", mint: fixtureMint("credential-stale-generation-1"))
        XCTAssertEqual(stale, .refused(.superseded))
        XCTAssertNil(backend.recordData(keyA))

        // The newer attempt commits, and its credential is the one that survives.
        let winner = await second.complete("newer", mint: fixtureMint("credential-winner-generation-2"))
        guard case let .stored(summary) = winner else { return XCTFail("newer winner failed: \(winner)") }
        XCTAssertEqual(summary.custodyGeneration, "2")
        XCTAssertEqual(try storedRecord(backend, keyA).storedGeneration, "2")
        XCTAssertEqual(try storedRecord(backend, keyA).envelope.sealed, "credential-winner-generation-2")

        // The unrelated account is byte-for-byte untouched.
        XCTAssertEqual(backend.recordData(keyB), otherRecordBefore)
        XCTAssertEqual(try ledgerGeneration(backend, keyB), "4")
    }

    // MARK: Fail-closed degradation

    func testADegradedFenceStoreRefusesBeginForEveryKeyAndWritesNothing() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        // The fence store's contents cannot be read, so they are UNKNOWN. An
        // unknown fence state fences EVERY key — including keys never enrolled.
        backend.readFaults[ProtectedEnrollmentCustodyStore.Service.fence] = errSecInteractionNotAllowed

        for (index, key) in [keyA, keyB].enumerated() {
            let began = await consumer.begin(
                fixtureAttempt(intentId: "degraded-\(index)", clientKey: key, generation: "1"))
            XCTAssertEqual(began, .refused(.custodyUnavailable))
        }

        // Nothing was announced and nothing was committed: refusal, not a
        // half-begin.
        XCTAssertNil(backend.ledgerData(keyA))
        XCTAssertNil(backend.ledgerData(keyB))
        XCTAssertNil(backend.recordData(keyA))
        let holding = await consumer.isHolding(intentId: "degraded-0")
        XCTAssertFalse(holding)
    }

    func testADegradedFenceStoreAlsoRefusesCompletionOfAnAlreadyBegunAttempt() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let began = await consumer.begin(fixtureAttempt(intentId: "held", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))
        backend.readFaults[ProtectedEnrollmentCustodyStore.Service.fence] = errSecInteractionNotAllowed

        let outcome = await consumer.complete("held", mint: fixtureMint("credential-never-written"))
        XCTAssertEqual(outcome, .refused(.custodyUnavailable))
        XCTAssertNil(backend.recordData(keyA))
        // The issued secret reached NO Keychain item at all.
        XCTAssertFalse(containsSecret(backend, "credential-never-written"))
    }

    func testUnreadableCustodyRefusesCompletionAndNeverFallsBackToUnprotectedStorage() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let began = await consumer.begin(
            fixtureAttempt(intentId: "unreadable", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))
        // The record read faults: custody is UNKNOWN, so the store refuses the
        // write and the consumer surfaces that refusal instead of placing the
        // credential somewhere unprotected.
        backend.readFaults[ProtectedEnrollmentCustodyStore.Service.record] = errSecInteractionNotAllowed

        let outcome = await consumer.complete("unreadable", mint: fixtureMint("credential-must-not-persist"))
        XCTAssertEqual(outcome, .refused(.custodyUnavailable))
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertFalse(containsSecret(backend, "credential-must-not-persist"))

        // And there is a named refusal for reaching past custody, which throws.
        do {
            try await consumer.plaintextFallback()
            XCTFail("plaintextFallback must always refuse")
        } catch let failure as NativeEnrollmentCustodyFailure {
            XCTAssertEqual(failure.reason, .custodyUnavailable)
            XCTAssertEqual(failure.errorDescription, NativeEnrollmentCustodyRefusal.custodyUnavailable.localizedReason)
        }
    }

    func testAnUnwritableGenerationLedgerRefusesTheBeginItself() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        // The ledger cannot be written, so the generation cannot be announced
        // durably. Success must not be reported for an unannounced generation.
        backend.addFaults[ProtectedEnrollmentCustodyStore.Service.ledger] = errSecInteractionNotAllowed

        let began = await consumer.begin(fixtureAttempt(intentId: "unwritable", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .refused(.custodyUnavailable))
        XCTAssertNil(backend.ledgerData(keyA))
        let holding = await consumer.isHolding(intentId: "unwritable")
        XCTAssertFalse(holding)

        // A refused begin leaves nothing held, so it cannot be completed later.
        let outcome = await consumer.complete("unwritable", mint: fixtureMint("credential-refused-begin"))
        XCTAssertEqual(outcome, .refused(.unknownIntent))
        XCTAssertFalse(containsSecret(backend, "credential-refused-begin"))
    }

    // MARK: Replay

    func testACompletedIntentCannotBeCompletedAgain() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let counter = Counter()
        let mint = fixtureMint("credential-single-use", counter: counter)
        let began = await consumer.begin(fixtureAttempt(intentId: "single", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))

        let first = await consumer.complete("single", mint: mint)
        guard case .stored = first else { return XCTFail("first completion failed: \(first)") }
        let recordAfterFirst = try XCTUnwrap(backend.recordData(keyA))

        let replay = await consumer.complete("single", mint: mint)
        XCTAssertEqual(replay, .refused(.replayed))
        // One mint, one record, unchanged bytes: a replay is not a re-write.
        XCTAssertEqual(counter.value, 1)
        XCTAssertEqual(backend.recordData(keyA), recordAfterFirst)
        XCTAssertEqual(try storedRecord(backend, keyA).storedGeneration, "1")
    }

    func testAReplayArrivingWhileACompletionIsHeldIsRefusedBeforeAnyWrite() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let entered = Latch()
        let release = Latch()
        let began = await consumer.begin(fixtureAttempt(intentId: "held", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))

        let held = Task {
            await consumer.complete("held", mint: { _ in
                entered.open()
                await release.wait()
                return minted("credential-held")
            })
        }
        await entered.wait()
        // The second completion arrives while the first is parked on the network.
        let replay = await consumer.complete("held", mint: fixtureMint("credential-replay"))
        XCTAssertEqual(replay, .refused(.replayed))
        // Refused before the first write, so nothing can have been stored.
        XCTAssertNil(backend.recordData(keyA))

        release.open()
        let outcome = await held.value
        guard case let .stored(summary) = outcome else {
            return XCTFail("the held completion should still succeed, got \(outcome)")
        }
        XCTAssertEqual(summary.custodyGeneration, "1")
        XCTAssertEqual(try storedRecord(backend, keyA).envelope.sealed, "credential-held")
    }

    func testABeginCannotResetACompletedIntentOrItsStoredCredential() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let request = fixtureAttempt(intentId: "begin-replay", clientKey: keyA, generation: "1")
        let announced = await consumer.begin(request)
        XCTAssertEqual(announced, .announced(custodyGeneration: "1"))
        let first = await consumer.complete(request.intentId, mint: fixtureMint("credential-first"))
        guard case .stored = first else { return XCTFail("initial completion failed: \(first)") }
        let original = try XCTUnwrap(backend.recordData(keyA))
        let duplicateBegin = await consumer.begin(request)
        XCTAssertEqual(duplicateBegin, .refused(.replayed))
        let counter = Counter()
        let duplicateComplete = await consumer.complete(request.intentId,
            mint: fixtureMint("credential-replayed-begin", counter: counter))
        XCTAssertEqual(duplicateComplete, .refused(.replayed))
        XCTAssertEqual(counter.value, 0)
        XCTAssertEqual(backend.recordData(keyA), original)
        XCTAssertFalse(containsSecret(backend, "credential-replayed-begin"))
    }

    func testADuplicateBeginCannotReplaceAHeldIntentBindingOrGeneration() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let first = await consumer.begin(fixtureAttempt(intentId: "duplicate-held", clientKey: keyA, generation: "1"))
        XCTAssertEqual(first, .announced(custodyGeneration: "1"))
        let duplicate = await consumer.begin(fixtureAttempt(intentId: "duplicate-held", clientKey: keyB, generation: "2"))
        XCTAssertEqual(duplicate, .refused(.replayed))
        XCTAssertNil(backend.ledgerData(keyB))
        let outcome = await consumer.complete("duplicate-held", mint: fixtureMint("credential-original-binding"))
        guard case .stored = outcome else { return XCTFail("original intent lost ownership: \(outcome)") }
        XCTAssertEqual(try storedRecord(backend, keyA).storedGeneration, "1")
        XCTAssertNil(backend.recordData(keyB))
    }

    func testAConcurrentBeginCannotReplaceAnIntentClaimedDuringItsFenceRead() async throws {
        let backend = FakeCustodyKeychain()
        let backing = ProtectedEnrollmentCustodyStore(ops: backend)
        let gated = GatedCustodyStore(backing: backing, selectedFenceRead: 1)
        let consumer = NativeEnrollmentCustodyConsumer(store: gated, clock: { fixtureNow })
        let held = Task { await consumer.begin(fixtureAttempt(intentId: "same-begin", clientKey: keyA, generation: "1")) }
        let gate = try XCTUnwrap(gated.fenceReadGate)
        await gate.entered.wait()
        let winner = await consumer.begin(fixtureAttempt(intentId: "same-begin", clientKey: keyB, generation: "2"))
        XCTAssertEqual(winner, .announced(custodyGeneration: "2"))
        gate.release.open()
        let retired = await held.value
        XCTAssertEqual(retired, .refused(.replayed))
        let outcome = await consumer.complete("same-begin", mint: fixtureMint("credential-concurrent-begin"))
        guard case .stored = outcome else { return XCTFail("winner was discarded: \(outcome)") }
        XCTAssertNil(backend.ledgerData(keyA))
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertEqual(try storedRecord(backend, keyB).storedGeneration, "2")
    }

    func testCancelAllRetiresABeginSuspendedBeforeItsIntentClaim() async throws {
        let backend = FakeCustodyKeychain()
        let backing = ProtectedEnrollmentCustodyStore(ops: backend)
        let gated = GatedCustodyStore(backing: backing, selectedFenceRead: 1)
        let consumer = NativeEnrollmentCustodyConsumer(store: gated, clock: { fixtureNow })
        let held = Task { await consumer.begin(fixtureAttempt(intentId: "begin-before-sign-out", clientKey: keyA, generation: "1")) }
        let gate = try XCTUnwrap(gated.fenceReadGate)
        await gate.entered.wait()
        // No intent exists yet, so per-intent cancellation truthfully says false.
        let cancelledIntent = await consumer.cancel("begin-before-sign-out")
        XCTAssertFalse(cancelledIntent)
        let heldCount = await consumer.cancelAll()
        XCTAssertEqual(heldCount, 0)
        gate.release.open()
        let outcome = await held.value
        XCTAssertEqual(outcome, .refused(.cancelled))
        let stillHeld = await consumer.isHolding(intentId: "begin-before-sign-out")
        XCTAssertFalse(stillHeld)
        XCTAssertNil(backend.ledgerData(keyA))
        XCTAssertNil(backend.recordData(keyA))
        let counter = Counter()
        let completed = await consumer.complete("begin-before-sign-out", mint: fixtureMint("credential-after-early-sign-out", counter: counter))
        XCTAssertEqual(completed, .refused(.unknownIntent))
        XCTAssertEqual(counter.value, 0)
        XCTAssertEqual(gated.commitCalls.value, 0)
    }

    // MARK: Awaited fence-read ownership

    func testCancellationDuringPreMintFenceReadNeverInvokesMint() async throws {
        let backend = FakeCustodyKeychain()
        let backing = ProtectedEnrollmentCustodyStore(ops: backend)
        let gated = GatedCustodyStore(backing: backing, selectedFenceRead: 2)
        let consumer = NativeEnrollmentCustodyConsumer(store: gated, clock: { fixtureNow })
        let began = await consumer.begin(fixtureAttempt(intentId: "fence-before-mint", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))
        let counter = Counter()
        let held = Task { await consumer.complete("fence-before-mint", mint: fixtureMint("credential-never-minted", counter: counter)) }
        let gate = try XCTUnwrap(gated.fenceReadGate)
        await gate.entered.wait()
        let cancelled = await consumer.cancel("fence-before-mint")
        XCTAssertTrue(cancelled)
        gate.release.open()
        let outcome = await held.value
        XCTAssertEqual(outcome, .refused(.cancelled))
        XCTAssertEqual(counter.value, 0)
        XCTAssertNil(backend.recordData(keyA))
    }

    func testCancellationDuringPreCommitFenceReadNeverWritesCredential() async throws {
        let backend = FakeCustodyKeychain()
        let backing = ProtectedEnrollmentCustodyStore(ops: backend)
        let gated = GatedCustodyStore(backing: backing, selectedFenceRead: 3)
        let consumer = NativeEnrollmentCustodyConsumer(store: gated, clock: { fixtureNow })
        let began = await consumer.begin(fixtureAttempt(intentId: "fence-before-write", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))
        let held = Task { await consumer.complete("fence-before-write", mint: fixtureMint("credential-never-written")) }
        let gate = try XCTUnwrap(gated.fenceReadGate)
        await gate.entered.wait()
        let cancelled = await consumer.cancel("fence-before-write")
        XCTAssertTrue(cancelled)
        gate.release.open()
        let outcome = await held.value
        XCTAssertEqual(outcome, .refused(.cancelled))
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertFalse(containsSecret(backend, "credential-never-written"))
        XCTAssertEqual(gated.commitCalls.value, 0)
    }

    func testCancellationDuringPostCommitFenceReadRemovesLandedCredential() async throws {
        let backend = FakeCustodyKeychain()
        let backing = ProtectedEnrollmentCustodyStore(ops: backend)
        let gated = GatedCustodyStore(backing: backing, selectedFenceRead: 4)
        let consumer = NativeEnrollmentCustodyConsumer(store: gated, clock: { fixtureNow })
        let began = await consumer.begin(fixtureAttempt(intentId: "fence-after-write", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))
        let held = Task { await consumer.complete("fence-after-write", mint: fixtureMint("credential-landed-fence-cancel")) }
        let gate = try XCTUnwrap(gated.fenceReadGate)
        await gate.entered.wait()
        XCTAssertNotNil(backend.recordData(keyA))
        let cancelled = await consumer.cancel("fence-after-write")
        XCTAssertTrue(cancelled)
        gate.release.open()
        let outcome = await held.value
        XCTAssertEqual(outcome, .refused(.cancelled))
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertEqual(backend.fenceCount(), 0)
    }

    func testCancelAllDuringPostCommitFenceReadRemovesLandedCredential() async throws {
        let backend = FakeCustodyKeychain()
        let backing = ProtectedEnrollmentCustodyStore(ops: backend)
        let gated = GatedCustodyStore(backing: backing, selectedFenceRead: 4)
        let consumer = NativeEnrollmentCustodyConsumer(store: gated, clock: { fixtureNow })
        let began = await consumer.begin(fixtureAttempt(intentId: "fence-sign-out", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))
        let held = Task { await consumer.complete("fence-sign-out", mint: fixtureMint("credential-landed-sign-out")) }
        let gate = try XCTUnwrap(gated.fenceReadGate)
        await gate.entered.wait()
        let count = await consumer.cancelAll()
        XCTAssertEqual(count, 1)
        gate.release.open()
        let outcome = await held.value
        XCTAssertEqual(outcome, .refused(.cancelled))
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertEqual(backend.fenceCount(), 0)
    }

    func testNewerWinnerDuringPostCommitFenceReadIsPreservedByteForByte() async throws {
        let backend = FakeCustodyKeychain()
        let backing = ProtectedEnrollmentCustodyStore(ops: backend)
        let gated = GatedCustodyStore(backing: backing, selectedFenceRead: 4)
        let consumer = NativeEnrollmentCustodyConsumer(store: gated, clock: { fixtureNow })
        let first = await consumer.begin(fixtureAttempt(intentId: "fence-old", clientKey: keyA, generation: "1"))
        XCTAssertEqual(first, .announced(custodyGeneration: "1"))
        let held = Task { await consumer.complete("fence-old", mint: fixtureMint("credential-older-fence")) }
        let gate = try XCTUnwrap(gated.fenceReadGate)
        await gate.entered.wait()
        let newerBegin = await consumer.begin(fixtureAttempt(intentId: "fence-new", clientKey: keyA, generation: "2"))
        XCTAssertEqual(newerBegin, .announced(custodyGeneration: "2"))
        let newer = await consumer.complete("fence-new", mint: fixtureMint("credential-newer-fence"))
        guard case .stored = newer else { return XCTFail("newer winner failed: \(newer)") }
        let newerBytes = try XCTUnwrap(backend.recordData(keyA))
        gate.release.open()
        let old = await held.value
        XCTAssertEqual(old, .refused(.superseded))
        XCTAssertEqual(backend.recordData(keyA), newerBytes)
        XCTAssertEqual(try storedRecord(backend, keyA).storedGeneration, "2")
        XCTAssertFalse(containsSecret(backend, "credential-older-fence"))
        XCTAssertEqual(backend.fenceCount(), 0)
    }

    // MARK: Stale completion and cancellation

    func testCancellationDuringAHeldMintStoresNothing() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let entered = Latch()
        let release = Latch()
        let began = await consumer.begin(
            fixtureAttempt(intentId: "walk-away", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))

        let held = Task {
            await consumer.complete("walk-away", mint: { _ in
                entered.open()
                await release.wait()
                return minted("credential-after-cancel")
            })
        }
        await entered.wait()
        let cancelled = await consumer.cancel("walk-away")
        XCTAssertTrue(cancelled)

        release.open()
        let outcome = await held.value
        XCTAssertEqual(outcome, .refused(.cancelled))
        // The credential existed but was never placed in storage.
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertFalse(containsSecret(backend, "credential-after-cancel"))
        // Cancelling twice reports the truth rather than pretending to act again.
        let again = await consumer.cancel("walk-away")
        XCTAssertFalse(again)
        let unknown = await consumer.cancel("never-existed")
        XCTAssertFalse(unknown)
    }

    func testCancellationAfterTheWriteLandsCleansUpAndProvesRemoval() async throws {
        let backend = FakeCustodyKeychain()
        let custody = ProtectedEnrollmentCustodyStore(ops: backend)
        let gated = GatedCustodyStore(backing: custody, holdsAfterCommit: true)
        let consumer = NativeEnrollmentCustodyConsumer(store: gated, clock: { fixtureNow })
        let began = await consumer.begin(
            fixtureAttempt(intentId: "late-cancel", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))

        // The write really lands; the completion is then held BEFORE it can
        // check its own ownership, and the cancellation arrives in that window.
        let held = Task {
            await consumer.complete("late-cancel", mint: fixtureMint("credential-landed-then-cancelled"))
        }
        await gated.commitLanded.wait()
        let cancelled = await consumer.cancel("late-cancel")
        XCTAssertTrue(cancelled)
        gated.afterCommit.open()

        let outcome = await held.value
        XCTAssertEqual(outcome, .refused(.cancelled))
        // Removal was CONFIRMED by an explicit read, so this is an ordinary
        // cancellation and not unresolved custody.
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertEqual(backend.fenceCount(), 0)
    }

    func testCleanupThatCannotRemoveTheRecordFencesTheKeyAndTheFenceSurvivesRestart() async throws {
        let backend = FakeCustodyKeychain()
        let custody = ProtectedEnrollmentCustodyStore(ops: backend)
        let gated = GatedCustodyStore(backing: custody, holdsAfterCommit: true)
        let consumer = NativeEnrollmentCustodyConsumer(store: gated, clock: { fixtureNow })
        let began = await consumer.begin(fixtureAttempt(intentId: "unresolved", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))

        let held = Task {
            await consumer.complete("unresolved", mint: fixtureMint("credential-maybe-still-there"))
        }
        await gated.commitLanded.wait()
        // Removal cannot even be attempted: the record read faults, so the
        // invalidation itself refuses and nothing is known about what remains.
        backend.readFaults[ProtectedEnrollmentCustodyStore.Service.record] = errSecInteractionNotAllowed
        let cancelled = await consumer.cancel("unresolved")
        XCTAssertTrue(cancelled)
        gated.afterCommit.open()

        let outcome = await held.value
        XCTAssertEqual(outcome, .refused(.custodyUnresolved))
        // Unresolved means the credential MAY still be usable, which is exactly
        // why the key is fenced rather than merely refused.
        XCTAssertNotNil(backend.recordData(keyA))
        XCTAssertNotNil(backend.fenceData(keyA))

        // RESTART: a fresh store and a fresh consumer over the same backend see
        // the PERSISTED fence, so the unresolved key cannot be re-begun.
        backend.readFaults.removeValue(forKey: ProtectedEnrollmentCustodyStore.Service.record)
        let (restarted, _) = makeConsumer(backend)
        let afterRestart = await restarted.begin(
            fixtureAttempt(intentId: "after-restart", clientKey: keyA, generation: "2"))
        XCTAssertEqual(afterRestart, .refused(.custodyUnavailable))
        XCTAssertEqual(try ledgerGeneration(backend, keyA), "1")
    }

    func testCleanupThatCannotConfirmRemovalFencesTheKeyEvenThoughTheRecordWasRemoved() async throws {
        let backend = FakeCustodyKeychain()
        let custody = ProtectedEnrollmentCustodyStore(ops: backend)
        let gated = GatedCustodyStore(backing: custody, holdsAfterCommit: true)
        let consumer = NativeEnrollmentCustodyConsumer(store: gated, clock: { fixtureNow })
        let began = await consumer.begin(fixtureAttempt(intentId: "unproven", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))

        let held = Task {
            await consumer.complete("unproven", mint: fixtureMint("credential-removed-but-unproven"))
        }
        await gated.commitLanded.wait()
        let cancelled = await consumer.cancel("unproven")
        XCTAssertTrue(cancelled)
        // The invalidation succeeds and removes the row, but the EXPLICIT read
        // that would prove it faults. Removal happened and is unprovable, which
        // is not the same as removal being confirmed.
        backend.scheduleReadFault(service: ProtectedEnrollmentCustodyStore.Service.record,
                                  status: errSecInteractionNotAllowed,
                                  afterSuccessfulReads: 1)
        gated.afterCommit.open()

        let outcome = await held.value
        XCTAssertEqual(outcome, .refused(.custodyUnresolved))
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertNotNil(backend.fenceData(keyA))

        // Recovery is the explicit owner reset and a NEW generation, not a retry.
        backend.cancelScheduledReadFaults(service: ProtectedEnrollmentCustodyStore.Service.record)
        let (restarted, _) = makeConsumer(backend)
        let stillFenced = await restarted.begin(
            fixtureAttempt(intentId: "retry-unproven", clientKey: keyA, generation: "2"))
        XCTAssertEqual(stillFenced, .refused(.custodyUnavailable))
        try await restarted.resetFences()
        let afterReset = await restarted.begin(
            fixtureAttempt(intentId: "retry-unproven", clientKey: keyA, generation: "2"))
        XCTAssertEqual(afterReset, .announced(custodyGeneration: "2"))
    }

    func testTheConsumerItselfArmsTheFenceWhenAnAdapterReportsUnknownCustodyWithoutFencing() async throws {
        let backend = FakeCustodyKeychain()
        let custody = ProtectedEnrollmentCustodyStore(ops: backend)
        let gated = GatedCustodyStore(backing: custody, holdsAfterCommit: true, silentUnknownRead: true)
        let consumer = NativeEnrollmentCustodyConsumer(store: gated, clock: { fixtureNow })
        let began = await consumer.begin(fixtureAttempt(intentId: "silent", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))

        let held = Task {
            await consumer.complete("silent", mint: fixtureMint("credential-adapter-went-quiet"))
        }
        await gated.commitLanded.wait()
        let cancelled = await consumer.cancel("silent")
        XCTAssertTrue(cancelled)
        gated.afterCommit.open()

        let outcome = await held.value
        XCTAssertEqual(outcome, .refused(.custodyUnresolved))
        // The adapter's read went quiet without fencing anything, so the PERSISTED
        // fence row below was written by the consumer, not the store.
        XCTAssertNotNil(backend.fenceData(keyA))
    }

    func testOnlyAnExplicitOwnerResetMakesAFencedKeyBeginableAgain() async throws {
        let backend = FakeCustodyKeychain()
        let custody = ProtectedEnrollmentCustodyStore(ops: backend)
        let consumer = NativeEnrollmentCustodyConsumer(store: custody, clock: { fixtureNow })
        try await custody.fence(clientKey: keyA, reason: "custody-unresolved")

        let fenced = await consumer.begin(fixtureAttempt(intentId: "fenced", clientKey: keyA, generation: "1"))
        XCTAssertEqual(fenced, .refused(.custodyUnavailable))
        try await consumer.resetFences()
        let afterReset = await consumer.begin(
            fixtureAttempt(intentId: "after-reset", clientKey: keyA, generation: "1"))
        XCTAssertEqual(afterReset, .announced(custodyGeneration: "1"))
        XCTAssertEqual(backend.fenceCount(), 0)
    }

    func testCancelAllDropsEveryHeldAttempt() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let firstBegan = await consumer.begin(fixtureAttempt(intentId: "one", clientKey: keyA, generation: "1"))
        XCTAssertEqual(firstBegan, .announced(custodyGeneration: "1"))
        let secondBegan = await consumer.begin(fixtureAttempt(intentId: "two", clientKey: keyB, generation: "1"))
        XCTAssertEqual(secondBegan, .announced(custodyGeneration: "1"))

        let dropped = await consumer.cancelAll()
        XCTAssertEqual(dropped, 2)
        let droppedAgain = await consumer.cancelAll()
        XCTAssertEqual(droppedAgain, 0)
        let first = await consumer.complete("one", mint: fixtureMint("credential-after-cancel-all"))
        XCTAssertEqual(first, .refused(.cancelled))
        let second = await consumer.complete("two", mint: fixtureMint("credential-after-cancel-all"))
        XCTAssertEqual(second, .refused(.cancelled))
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertNil(backend.recordData(keyB))
    }

    // MARK: Deletion tombstones

    func testDeletionRefusesTheDeletedGenerationAndAcceptsANewerOne() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let began = await consumer.begin(fixtureAttempt(intentId: "doomed", clientKey: keyA, generation: "5"))
        XCTAssertEqual(began, .announced(custodyGeneration: "5"))
        let enrolled = await consumer.complete("doomed", mint: fixtureMint("credential-before-delete"))
        guard case .stored = enrolled else { return XCTFail("enrollment failed: \(enrolled)") }

        let deleted = try await consumer.deleteEnrollment(clientKey: keyA)
        XCTAssertTrue(deleted)
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertEqual(try storedTombstone(backend, keyA).deletedGeneration, "5")

        // A direct retry carrying the deleted generation is not a new enrollment
        // and cannot resurrect the credential.
        let (afterDelete, _) = makeConsumer(backend)
        let retryOld = await afterDelete.begin(
            fixtureAttempt(intentId: "retry-old", clientKey: keyA, generation: "5"))
        XCTAssertEqual(retryOld, .refused(.deleted))
        // A strictly newer generation is the only way forward, and it commits.
        let retryNew = await afterDelete.begin(
            fixtureAttempt(intentId: "retry-new", clientKey: keyA, generation: "6"))
        XCTAssertEqual(retryNew, .announced(custodyGeneration: "6"))
        let reenrolled = await afterDelete.complete("retry-new", mint: fixtureMint("credential-after-delete"))
        guard case let .stored(summary) = reenrolled else {
            return XCTFail("re-enrollment after deletion failed: \(reenrolled)")
        }
        XCTAssertEqual(summary.custodyGeneration, "6")
        XCTAssertEqual(try storedRecord(backend, keyA).envelope.sealed, "credential-after-delete")
        XCTAssertNil(backend.tombstoneData(keyA))
    }

    func testAnAlreadyExpiredCredentialIsNotAdoptedAndLeavesNoRecord() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let began = await consumer.begin(fixtureAttempt(intentId: "expired", clientKey: keyA, generation: "1"))
        XCTAssertEqual(began, .announced(custodyGeneration: "1"))

        let outcome = await consumer.complete("expired", mint: fixtureMint(
            "credential-already-expired", expiresAt: fixtureNow - 1))
        XCTAssertEqual(outcome, .refused(.credentialExpired))
        // It was stored and then removed under this consumer's own generation,
        // so the refusal is an expiry rather than unresolved custody.
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertEqual(backend.fenceCount(), 0)
    }

    // MARK: Restart read / write / delete

    func testAStoredCredentialIsReadableAndRemovableFromAFreshStoreInstance() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let began = await consumer.begin(fixtureAttempt(intentId: "durable", clientKey: keyA, generation: "3"))
        XCTAssertEqual(began, .announced(custodyGeneration: "3"))
        let enrolled = await consumer.complete("durable", mint: fixtureMint("credential-durable"))
        guard case .stored = enrolled else { return XCTFail("enrollment failed: \(enrolled)") }

        // A restart: fresh store, fresh consumer, same durable backend.
        let (restarted, freshStore) = makeConsumer(backend)
        let loaded = try await freshStore.get(keyA)
        let envelope = try XCTUnwrap(loaded, "a restarted store must read back what was persisted")
        XCTAssertEqual(envelope.clientKey, keyA)
        XCTAssertEqual(envelope.version, ProtectedEnrollmentCustodyEnvelope.currentVersion)
        let observed = await freshStore.read(keyA)
        guard case let .present(record) = observed else {
            return XCTFail("a restarted store must observe the persisted record, got \(observed)")
        }
        XCTAssertEqual(record.storedGeneration, "3")
        // A fresh consumer holds nothing: attempt ownership is per-process and
        // is not a durable claim on the stored credential.
        let holding = await restarted.isHolding(intentId: "durable")
        XCTAssertFalse(holding)

        // Deletion is unconditional, explicit and tombstoned.
        let deleted = try await restarted.deleteEnrollment(clientKey: keyA)
        XCTAssertTrue(deleted)
        let afterDelete = try await freshStore.get(keyA)
        XCTAssertNil(afterDelete)
    }

    // MARK: Shape refusals

    func testABindingThatNamesAnotherDeviceIsRefused() async throws {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let began = await consumer.begin(
            fixtureAttempt(intentId: "contradiction", clientKey: keyA, generation: "1",
                           bindingClientKey: keyB))
        XCTAssertEqual(began, .refused(.bindingRefused))
        XCTAssertNil(backend.ledgerData(keyA))
    }

    func testAnUnknownIntentIsRefused() async {
        let backend = FakeCustodyKeychain()
        let (consumer, _) = makeConsumer(backend)
        let outcome = await consumer.complete("no-such-intent", mint: fixtureMint("credential-never"))
        XCTAssertEqual(outcome, .refused(.unknownIntent))
        XCTAssertNil(backend.recordData(keyA))
        XCTAssertFalse(containsSecret(backend, "credential-never"))
    }
}
