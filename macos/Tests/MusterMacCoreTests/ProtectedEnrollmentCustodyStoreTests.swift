// ============================================================================
// Protected enrollment custody store — the native mapping of the reviewed W2
// contract seam (docs/plans/w2-boundary-specification.md).
//
// Cases mirror the W2 race suite in
// `server/installation-enrollment-contract.test.ts`
// (`describe("W2 — persisted restart fence and canonical issuer binding")`),
// mapped to the adapter level: the native store has no engine, no issuer
// comparison (server-owned, :1206/:1231) and no attempt store, so the cases
// here drive the store's OWN durable state — fences, the generation ledger
// and the sealed records — the way the engine would.
//
// NOT CLAIMED (same discipline as OrdinaryLoginSessionPersistenceUITests):
// no enrollment flow is wired or enabled; no issuer/authority validation
// (the store only CARRIES those strings); no security property beyond what
// each case states; no server behavior. Every test runs against an
// in-memory Keychain double — the user's real Keychain is never read or
// written, matching the SessionKeychainTests convention.
// ============================================================================

import Foundation
import Security
import XCTest
@testable import MusterMacCore

// MARK: - In-memory Keychain double

/// Models the Keychain items the store owns: service → account → bytes, plus
/// injectable per-service status faults and per-account garbage payloads so
/// corrupt and unavailable custody can be exercised without any Security API.
///
/// Module-internal (not `private`) because the consumer suite drives the SAME
/// double through the real store: custody is only integration-proven when the
/// bytes a case asserts on are the bytes the store actually wrote.
final class FakeCustodyKeychain: EnrollmentCustodyKeychainOps, @unchecked Sendable {
    struct Operation: Equatable {
        let op: String
        let service: String
        let account: String?
    }

    /// A read fault that begins once `after` further reads of the service have
    /// been served.
    struct ScheduledReadFault {
        let after: Int
        let status: OSStatus
    }

    private let lock = NSLock()
    private var items: [String: [String: Data]] = [:]
    private(set) var operations: [Operation] = []
    private(set) var addedAttributes: [[String: Any]] = []

    /// Forced status for read/readAll, per service (unavailable-custody cases).
    var readFaults: [String: OSStatus] = [:]
    /// A read fault armed to fire on a LATER read of one service, so a case can
    /// let an operation succeed and then fault the confirmation that follows it
    /// — the difference between "removal failed" and "removal could not be
    /// proven".
    private var readFaultsAfter: [String: ScheduledReadFault] = [:]
    private var readCounts: [String: Int] = [:]
    /// Successful attribute results that cannot establish a valid fence list.
    var readAllRows: [String: [[String: Any]]] = [:]
    /// Forced status for add, per service.
    var addFaults: [String: OSStatus] = [:]
    /// Forced status for delete, per service.
    var deleteFaults: [String: OSStatus] = [:]
    /// Accounts whose stored bytes read back as non-JSON (corrupt-custody cases).
    var garbageAccounts: Set<String> = []

    private func service(_ query: [String: Any]) -> String {
        query[kSecAttrService as String] as? String ?? ""
    }

    private func account(_ query: [String: Any]) -> String? {
        query[kSecAttrAccount as String] as? String
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        let service = self.service(attributes)
        let account = self.account(attributes) ?? ""
        operations.append(Operation(op: "add", service: service, account: self.account(attributes)))
        addedAttributes.append(attributes)
        if let forced = addFaults[service] { return forced }
        if items[service]?[account] != nil { return errSecDuplicateItem }
        items[service, default: [:]][account] = attributes[kSecValueData as String] as? Data
        return errSecSuccess
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        let service = self.service(query)
        let account = self.account(query) ?? ""
        operations.append(Operation(op: "update", service: service, account: self.account(query)))
        guard items[service]?[account] != nil else { return errSecItemNotFound }
        items[service]?[account] = attributes[kSecValueData as String] as? Data
        return errSecSuccess
    }

    func read(_ query: [String: Any]) -> (OSStatus, Data?) {
        lock.lock(); defer { lock.unlock() }
        let service = self.service(query)
        let account = self.account(query) ?? ""
        readCounts[service, default: 0] += 1
        let served = readCounts[service] ?? 0
        operations.append(Operation(op: "read", service: service, account: self.account(query)))
        if let forced = readFaults[service] { return (forced, nil) }
        if let scheduled = readFaultsAfter[service], served > scheduled.after {
            return (scheduled.status, nil)
        }
        guard let data = items[service]?[account] else { return (errSecItemNotFound, nil) }
        if garbageAccounts.contains(account) { return (errSecSuccess, Data("not a custody record".utf8)) }
        return (errSecSuccess, data)
    }

    /// Arm a read fault on `service` that begins once `afterSuccessfulReads`
    /// further reads have been served from now.
    func scheduleReadFault(service: String, status: OSStatus, afterSuccessfulReads: Int = 0) {
        lock.lock(); defer { lock.unlock() }
        let served = readCounts[service] ?? 0
        readFaultsAfter[service] = ScheduledReadFault(after: served + afterSuccessfulReads, status: status)
    }

    /// Disarm every scheduled read fault for `service`.
    func cancelScheduledReadFaults(service: String) {
        lock.lock(); defer { lock.unlock() }
        readFaultsAfter[service] = nil
    }

    func readAll(_ query: [String: Any]) -> (OSStatus, [[String: Any]]?) {
        lock.lock(); defer { lock.unlock() }
        let service = self.service(query)
        operations.append(Operation(op: "readAll", service: service, account: nil))
        if let forced = readFaults[service] { return (forced, nil) }
        if let rows = readAllRows[service] { return (errSecSuccess, rows) }
        let accounts = items[service] ?? [:]
        guard !accounts.isEmpty else { return (errSecItemNotFound, nil) }
        let rows: [[String: Any]] = accounts.map { account, data in
            [kSecAttrAccount as String: account, kSecValueData as String: data]
        }
        return (errSecSuccess, rows)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        let service = self.service(query)
        operations.append(Operation(op: "delete", service: service, account: self.account(query)))
        if let forced = deleteFaults[service] { return forced }
        if let account = self.account(query) {
            guard items[service]?[account] != nil else { return errSecItemNotFound }
            items[service]?[account] = nil
            return errSecSuccess
        }
        // Service-wide delete (the fence reset).
        guard let existing = items[service], !existing.isEmpty else { return errSecItemNotFound }
        items[service] = nil
        return errSecSuccess
    }

    // MARK: Inspection helpers

    func recordData(_ clientKey: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return items[ProtectedEnrollmentCustodyStore.Service.record]?[clientKey]
    }

    func ledgerData(_ clientKey: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return items[ProtectedEnrollmentCustodyStore.Service.ledger]?[clientKey]
    }

    func fenceData(_ clientKey: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return items[ProtectedEnrollmentCustodyStore.Service.fence]?[clientKey]
    }

    func tombstoneData(_ clientKey: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return items[ProtectedEnrollmentCustodyStore.Service.tombstone]?[clientKey]
    }

    func fenceCount() -> Int {
        lock.lock(); defer { lock.unlock() }
        return items[ProtectedEnrollmentCustodyStore.Service.fence]?.count ?? 0
    }

    /// Every stored value across every service, so a case can prove a secret
    /// appears in NO Keychain item rather than only in the one it expected.
    func allStoredValues() -> [Data] {
        lock.lock(); defer { lock.unlock() }
        return items.values.flatMap { $0.values }
    }
}

// MARK: - Fixtures

private let fixtureClientKey = "client-key-synthetic-0001"
private let fixtureCredential = "credential-synthetic-private-DO-NOT-LOG"

private func fixtureBinding(clientKey: String = fixtureClientKey) -> ProtectedEnrollmentBinding {
    ProtectedEnrollmentBinding(
        cloudSubject: "sub-synthetic-0001",
        cloudAuthority: "https://cloud.synthetic.invalid",
        cloudIssuer: "https://cloud.synthetic.invalid",
        workspaceId: "ws-synthetic-0001",
        localOwnerId: "owner-synthetic-0001",
        localSessionId: "session-synthetic-0001",
        clientKey: clientKey)
}

private func fixtureRequest(clientKey: String = fixtureClientKey,
                            credential: String = fixtureCredential) -> ProtectedEnrollmentCustodyRequest {
    ProtectedEnrollmentCustodyRequest(
        clientKey: clientKey,
        installationId: "installation-synthetic-0001",
        credential: credential,
        binding: fixtureBinding(clientKey: clientKey),
        platform: "macos",
        capabilities: ["fleet.read"],
        issuedAt: 1_760_000_000_000,
        credentialExpiresAt: 1_760_000_060_000)
}

// MARK: - Tests

final class ProtectedEnrollmentCustodyStoreTests: XCTestCase {
    // Production construction is restricted by the private initializer. The
    // explicit seam still permits independent actors with isolated fake stores.
    func testExplicitInjectedStoresKeepIndependentCustody() async throws {
        let backendA = FakeCustodyKeychain()
        let backendB = FakeCustodyKeychain()
        let storeA = ProtectedEnrollmentCustodyStore(ops: backendA)
        let storeB = ProtectedEnrollmentCustodyStore(ops: backendB)
        XCTAssertNotEqual(ObjectIdentifier(storeA), ObjectIdentifier(storeB))

        try await storeA.commit(fixtureRequest(), expectedGeneration: "4")
        let recordA = backendA.recordData(fixtureClientKey)
        let ledgerA = backendA.ledgerData(fixtureClientKey)
        XCTAssertNil(backendB.recordData(fixtureClientKey))
        XCTAssertNil(backendB.ledgerData(fixtureClientKey))
        XCTAssertTrue(backendB.operations.isEmpty)

        try await storeB.commit(fixtureRequest(credential: "credential-synthetic-independent"),
                                expectedGeneration: "1")
        XCTAssertEqual(backendA.recordData(fixtureClientKey), recordA)
        XCTAssertEqual(backendA.ledgerData(fixtureClientKey), ledgerA)
        let newestB = try await storeB.storedNewestGeneration(clientKey: fixtureClientKey)
        XCTAssertEqual(newestB, "1")
    }

    // W2 (a): a fence survives a restart — a fresh store instance over the
    // same durable Keychain observes what a prior instance persisted, and
    // the refusal happens before anything is allocated or written.
    func testW2aFenceSurvivesRestartIntoAFreshInstance() async throws {
        let backend = FakeCustodyKeychain()
        let storeA = ProtectedEnrollmentCustodyStore(ops: backend)
        try await storeA.fence(clientKey: fixtureClientKey, reason: "custody-unresolved")

        // RESTART: an entirely new instance over the same durable store.
        let storeB = ProtectedEnrollmentCustodyStore(ops: backend)
        let fenced = await storeB.isFenced(clientKey: fixtureClientKey)
        XCTAssertTrue(fenced)
        let newestForB = try await storeB.storedNewestGeneration(clientKey: fixtureClientKey)
        XCTAssertNil(newestForB)
        await XCTAssertThrowsErrorAsync(
            try await storeB.commit(fixtureRequest(), expectedGeneration: "1")) { error in
            XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .keyFenced)
        }
        // The fence gates the key; it is not a custody record.
        let read = await storeA.read(fixtureClientKey)
        XCTAssertEqual(read, .absent)
        // A different key was never fenced.
        let otherFenced = await storeA.isFenced(clientKey: "client-key-synthetic-other")
        XCTAssertFalse(otherFenced)
    }

    // W2 (b): a completion still holding the NEWEST generation after a
    // restart still loses to the persisted fence.
    func testW2bNewestGenerationStillLosesToPersistedFenceAfterRestart() async throws {
        let backend = FakeCustodyKeychain()
        let storeA = ProtectedEnrollmentCustodyStore(ops: backend)
        try await storeA.noteGeneration(clientKey: fixtureClientKey, generation: "1")
        // The fence is established through the durable store — the way a
        // concurrent or prior instance's cleanup would.
        try await storeA.fence(clientKey: fixtureClientKey, reason: "concurrent-cleanup")

        // RESTART: fresh instance, same ledger, same fence.
        let storeB = ProtectedEnrollmentCustodyStore(ops: backend)
        await XCTAssertThrowsErrorAsync(
            try await storeB.commit(fixtureRequest(), expectedGeneration: "1")) { error in
            XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .keyFenced)
        }
        let read = await storeB.read(fixtureClientKey)
        XCTAssertEqual(read, .absent)
    }

    // W2 (b): a superseded generation still loses to a newer one after a
    // restart — and supersession must not break the winner.
    func testW2bSupersededGenerationStillLosesToNewerOneAfterRestart() async throws {
        let backend = FakeCustodyKeychain()
        let storeA = ProtectedEnrollmentCustodyStore(ops: backend)
        try await storeA.noteGeneration(clientKey: fixtureClientKey, generation: "1")
        try await storeA.noteGeneration(clientKey: fixtureClientKey, generation: "2")
        try await storeA.commit(fixtureRequest(), expectedGeneration: "2")

        // RESTART: the ledger (the store's generations) persists in the
        // backend; the instance does not.
        let storeB = ProtectedEnrollmentCustodyStore(ops: backend)
        await XCTAssertThrowsErrorAsync(
            try await storeB.commit(fixtureRequest(), expectedGeneration: "1")) { error in
            XCTAssertEqual(
                error as? ProtectedEnrollmentCustodyError,
                .staleGeneration(expected: "1", newest: "2"))
        }
        // The stale completion's credential was never installed.
        let afterStale = await storeB.read(fixtureClientKey)
        guard case let .present(stored) = afterStale else {
            return XCTFail("expected the winner's record to survive, got \(afterStale)")
        }
        XCTAssertEqual(stored.storedGeneration, "2")
        XCTAssertEqual(stored.envelope.sealed, fixtureCredential)
        // The newest generation still completes across the restart.
        try await storeB.commit(fixtureRequest(), expectedGeneration: "2")
        let afterWinner = await storeB.read(fixtureClientKey)
        guard case .present = afterWinner else {
            return XCTFail("expected the winner's record after re-commit")
        }
    }

    // W2 (c): reset clears the DURABLE fence, not just one instance's view.
    func testW2cResetClearsThePersistedFenceForEveryInstance() async throws {
        let backend = FakeCustodyKeychain()
        let storeA = ProtectedEnrollmentCustodyStore(ops: backend)
        let storeB = ProtectedEnrollmentCustodyStore(ops: backend)
        try await storeA.fence(clientKey: fixtureClientKey, reason: "reset-test")
        let fencedInA = await storeA.isFenced(clientKey: fixtureClientKey)
        XCTAssertTrue(fencedInA)
        let fencedInB = await storeB.isFenced(clientKey: fixtureClientKey)
        XCTAssertTrue(fencedInB)

        try await storeB.resetFences()
        let clearedInA = await storeA.isFenced(clientKey: fixtureClientKey)
        XCTAssertFalse(clearedInA)
        let clearedInB = await storeB.isFenced(clientKey: fixtureClientKey)
        XCTAssertFalse(clearedInB)
        XCTAssertEqual(backend.fenceCount(), 0)
        // And the key is usable again.
        try await storeA.commit(fixtureRequest(), expectedGeneration: "1")
        let afterReset = await storeA.read(fixtureClientKey)
        guard case .present = afterReset else {
            return XCTFail("expected the commit to succeed after the reset")
        }
    }

    // W2 (d): corrupt custody fails closed — unknown, fenced, never absent —
    // and a fresh instance observes the persisted fence. Recovery is the
    // explicit owner action.
    func testW2dCorruptCustodyIsUnknownAndFencedNeverAbsent() async throws {
        let backend = FakeCustodyKeychain()
        let storeA = ProtectedEnrollmentCustodyStore(ops: backend)
        try await storeA.commit(fixtureRequest(), expectedGeneration: "1")

        // The record's bytes become unvalidatable (corrupt/corrupted format).
        backend.garbageAccounts.insert(fixtureClientKey)
        let read = await storeA.read(fixtureClientKey)
        XCTAssertEqual(read, .unknown)
        let fencedAfterCorruption = await storeA.isFenced(clientKey: fixtureClientKey)
        XCTAssertTrue(fencedAfterCorruption)

        // RESTART: a fresh instance over the same durable store sees the
        // fence, and refuses to write the key.
        let storeB = ProtectedEnrollmentCustodyStore(ops: backend)
        let fencedAcrossRestart = await storeB.isFenced(clientKey: fixtureClientKey)
        XCTAssertTrue(fencedAcrossRestart)
        await XCTAssertThrowsErrorAsync(
            try await storeB.commit(fixtureRequest(), expectedGeneration: "1")) { error in
            XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .keyFenced)
        }

        // The explicit owner action: remove the unusable record, reset the
        // fence, then announce a newer enrollment generation. The delete
        // tombstone remains authoritative for the deleted generation.
        backend.garbageAccounts.remove(fixtureClientKey)
        let removed = try await storeB.delete(fixtureClientKey)
        XCTAssertTrue(removed)
        try await storeB.resetFences()
        try await storeB.noteGeneration(clientKey: fixtureClientKey, generation: "2")
        try await storeB.commit(fixtureRequest(), expectedGeneration: "2")
        let recovered = await storeB.read(fixtureClientKey)
        guard case let .present(recoveredRecord) = recovered else {
            return XCTFail("expected recovery after the owner actions, got \(recovered)")
        }
        XCTAssertEqual(recoveredRecord.storedGeneration, "2")
    }

    // W2 (d): an unavailable (faulted, not merely corrupt) custody read is
    // unknown + fenced too, and `get` refuses to conflate it with absence.
    func testW2dUnavailableCustodyReadIsUnknownAndFenced() async throws {
        let backend = FakeCustodyKeychain()
        let storeA = ProtectedEnrollmentCustodyStore(ops: backend)
        try await storeA.commit(fixtureRequest(), expectedGeneration: "1")
        backend.readFaults[ProtectedEnrollmentCustodyStore.Service.record] = errSecInteractionNotAllowed

        let read = await storeA.read(fixtureClientKey)
        XCTAssertEqual(read, .unknown)
        let fenced = await storeA.isFenced(clientKey: fixtureClientKey)
        XCTAssertTrue(fenced)
        await XCTAssertThrowsErrorAsync(try await storeA.get(fixtureClientKey)) { error in
            XCTAssertEqual(
                error as? ProtectedEnrollmentCustodyError,
                .custodyUnreadable(status: errSecInteractionNotAllowed))
        }
        // A key with NO item at all is genuinely absent — never unknown.
        backend.readFaults.removeValue(forKey: ProtectedEnrollmentCustodyStore.Service.record)
        let absentRead = await storeA.read("client-key-synthetic-unstored")
        XCTAssertEqual(absentRead, .absent)
        let absentGet = try await storeA.get("client-key-synthetic-unstored")
        XCTAssertNil(absentGet)
    }

    // W2 (f): a fence written to the durable store by ANOTHER instance stops
    // this instance's commit — every consultation measures the store, so the
    // fence is honored without a restart.
    func testW2fFenceWrittenByAnotherInstanceStopsACommit() async throws {
        let backend = FakeCustodyKeychain()
        let storeA = ProtectedEnrollmentCustodyStore(ops: backend)
        let storeB = ProtectedEnrollmentCustodyStore(ops: backend)
        try await storeA.noteGeneration(clientKey: fixtureClientKey, generation: "1")

        // The other instance's cleanup fences the key through the durable
        // store only.
        try await storeB.fence(clientKey: fixtureClientKey, reason: "concurrent-cleanup")
        let fenced = await storeA.isFenced(clientKey: fixtureClientKey)
        XCTAssertTrue(fenced)
        await XCTAssertThrowsErrorAsync(
            try await storeA.commit(fixtureRequest(), expectedGeneration: "1")) { error in
            XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .keyFenced)
        }
        let read = await storeA.read(fixtureClientKey)
        XCTAssertEqual(read, .absent)
    }

    // The stale-generation commit refuses and preserves the newer winner,
    // within one instance as well as across a restart.
    func testStaleGenerationCommitRefusesAndPreservesNewerWinner() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "1")
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "2")
        try await store.commit(fixtureRequest(), expectedGeneration: "2")

        await XCTAssertThrowsErrorAsync(
            try await store.commit(fixtureRequest(), expectedGeneration: "1")) { error in
            XCTAssertEqual(
                error as? ProtectedEnrollmentCustodyError,
                .staleGeneration(expected: "1", newest: "2"))
        }
        let afterStale = await store.read(fixtureClientKey)
        guard case let .present(stored) = afterStale else {
            return XCTFail("expected the newer winner untouched, got \(afterStale)")
        }
        XCTAssertEqual(stored.storedGeneration, "2")
        XCTAssertEqual(stored.envelope.sealed, fixtureCredential)
        let newest = try await store.storedNewestGeneration(clientKey: fixtureClientKey)
        XCTAssertEqual(newest, "2")
    }

    // Invalidation is conditioned on the row ACTUALLY STORED: a newer
    // INTENT alone must never shield an older stored record.
    func testInvalidateRemovesTheStoredRowEvenWhenANewerIntentWasAnnounced() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        try await store.commit(fixtureRequest(), expectedGeneration: "1")
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "2")

        let invalidated = try await store.invalidate(fixtureClientKey, generation: "1")
        XCTAssertTrue(invalidated)
        let read = await store.read(fixtureClientKey)
        XCTAssertEqual(read, .absent)
    }

    // Invalidation NEVER deletes a newer winner's record.
    func testInvalidateNeverDeletesANewerWinnersRecord() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "1")
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "2")
        try await store.commit(fixtureRequest(), expectedGeneration: "2")

        let invalidated = try await store.invalidate(fixtureClientKey, generation: "1")
        XCTAssertFalse(invalidated)
        let after = await store.read(fixtureClientKey)
        guard case let .present(stored) = after else {
            return XCTFail("expected the newer winner to be kept, got \(after)")
        }
        XCTAssertEqual(stored.storedGeneration, "2")
        XCTAssertEqual(stored.envelope.sealed, fixtureCredential)
    }

    // Explicit delete after invalidate works — and is a separate operation
    // that may also remove a newest winner unconditionally.
    func testExplicitDeleteAfterInvalidateLeavesTheKeyClean() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        try await store.commit(fixtureRequest(), expectedGeneration: "1")
        let invalidated = try await store.invalidate(fixtureClientKey, generation: "1")
        XCTAssertTrue(invalidated)
        // Nothing is left; the explicit delete reports that honestly.
        let deleteAfterInvalidate = try await store.delete(fixtureClientKey)
        XCTAssertFalse(deleteAfterInvalidate)
        let afterInvalidate = await store.read(fixtureClientKey)
        XCTAssertEqual(afterInvalidate, .absent)
        // Delete is unconditional: it removes even a newest winner.
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "2")
        try await store.commit(fixtureRequest(), expectedGeneration: "2")
        let deletedWinner = try await store.delete(fixtureClientKey)
        XCTAssertTrue(deletedWinner)
        let afterDelete = await store.read(fixtureClientKey)
        XCTAssertEqual(afterDelete, .absent)
        let deletedAgain = try await store.delete(fixtureClientKey)
        XCTAssertFalse(deletedAgain)
    }

    func testDeleteTombstoneSurvivesRestartAndRequiresANewerAnnouncedGeneration() async throws {
        let backend = FakeCustodyKeychain()
        let storeA = ProtectedEnrollmentCustodyStore(ops: backend)
        let otherKey = "client-key-synthetic-other"
        try await storeA.noteGeneration(clientKey: fixtureClientKey, generation: "4")
        try await storeA.commit(fixtureRequest(), expectedGeneration: "4")
        try await storeA.noteGeneration(clientKey: otherKey, generation: "1")
        try await storeA.commit(fixtureRequest(clientKey: otherKey, credential: "credential-other"), expectedGeneration: "1")

        let deleted = try await storeA.delete(fixtureClientKey)
        XCTAssertTrue(deleted)
        XCTAssertNotNil(backend.recordData(otherKey), "Deleting one account must preserve unrelated custody")
        XCTAssertNotNil(backend.ledgerData(fixtureClientKey), "Deletion must retain the generation ledger")
        XCTAssertNotNil(backend.tombstoneData(fixtureClientKey))

        let storeB = ProtectedEnrollmentCustodyStore(ops: backend)
        let deletedRead = await storeB.read(fixtureClientKey)
        XCTAssertEqual(deletedRead, .absent)
        let unrelatedRead = await storeB.read(otherKey)
        guard case let .present(existingOther) = unrelatedRead else {
            return XCTFail("expected unrelated account custody to survive")
        }
        XCTAssertEqual(existingOther.envelope.sealed, "credential-other")
        await XCTAssertThrowsErrorAsync(
            try await storeB.commit(fixtureRequest(), expectedGeneration: "4")) { error in
            XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .keyDeleted)
        }
        await XCTAssertThrowsErrorAsync(
            try await storeB.noteGeneration(clientKey: fixtureClientKey, generation: "4")) { error in
            XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .keyDeleted)
        }

        try await storeB.noteGeneration(clientKey: fixtureClientKey, generation: "5")
        try await storeB.commit(fixtureRequest(credential: "credential-new"), expectedGeneration: "5")
        guard case let .present(newWinner) = await storeB.read(fixtureClientKey) else {
            return XCTFail("expected the newer enrollment to replace the tombstone")
        }
        XCTAssertEqual(newWinner.storedGeneration, "5")
        XCTAssertEqual(newWinner.envelope.sealed, "credential-new")
        guard case let .present(unrelated) = await storeB.read(otherKey) else {
            return XCTFail("expected unrelated account custody to survive")
        }
        XCTAssertEqual(unrelated.envelope.sealed, "credential-other")
    }

    func testDegradedFenceReadFailsClosedBeforeAnyCustodyWrite() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        backend.readFaults[ProtectedEnrollmentCustodyStore.Service.fence] = errSecInteractionNotAllowed

        let fenced = await store.isFenced(clientKey: fixtureClientKey)
        XCTAssertTrue(fenced)
        await XCTAssertThrowsErrorAsync(
            try await store.commit(fixtureRequest(), expectedGeneration: "1")) { error in
            XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .fenceStoreDegraded)
        }
        XCTAssertNil(backend.recordData(fixtureClientKey))
        XCTAssertNil(backend.ledgerData(fixtureClientKey))
    }

    func testSuccessfulNilFenceReadRefusesFreshAndReplacementCommits() async throws {
        try await assertInvalidFenceReadPreservesCustody { backend in
            backend.readFaults[ProtectedEnrollmentCustodyStore.Service.fence] = errSecSuccess
        }
    }

    func testValidatedUnrelatedFenceAllowsCommitWithoutChangingThatFence() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        let otherKey = "client-key-synthetic-other"
        try await store.fence(clientKey: otherKey, reason: "unrelated-custody")
        let originalFence = backend.fenceData(otherKey)

        let fenced = await store.isFenced(clientKey: fixtureClientKey)
        XCTAssertFalse(fenced)
        try await store.commit(fixtureRequest(), expectedGeneration: "1")
        XCTAssertNotNil(backend.recordData(fixtureClientKey))
        XCTAssertEqual(backend.fenceData(otherKey), originalFence)
        let otherFenced = await store.isFenced(clientKey: otherKey)
        XCTAssertTrue(otherFenced)
    }

    func testSuccessfulEmptyFenceReadRefusesFreshAndReplacementCommits() async throws {
        try await assertInvalidFenceReadPreservesCustody { backend in
            backend.readAllRows[ProtectedEnrollmentCustodyStore.Service.fence] = []
        }
    }

    func testMalformedFenceRowsRefuseFreshAndReplacementCommits() async throws {
        let accountAttribute = kSecAttrAccount as String
        let malformedRows: [[String: Any]] = [
            [:],
            [accountAttribute: 42],
            [accountAttribute: NSNull()],
            [accountAttribute: ""],
            [accountAttribute: " \t\n"],
        ]
        for row in malformedRows {
            // A valid unrelated fence must not hide a malformed row, regardless
            // of order. No row may be silently dropped to infer absence.
            for rows in [[row, [accountAttribute: "client-key-synthetic-other"]],
                         [[accountAttribute: "client-key-synthetic-other"], row]] {
                try await assertInvalidFenceReadPreservesCustody { backend in
                    backend.readAllRows[ProtectedEnrollmentCustodyStore.Service.fence] = rows
                }
            }
        }
    }

    private func assertInvalidFenceReadPreservesCustody(
        configure: (FakeCustodyKeychain) -> Void,
        file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        for hasExistingCustody in [false, true] {
            let backend = FakeCustodyKeychain()
            let store = ProtectedEnrollmentCustodyStore(ops: backend)
            if hasExistingCustody {
                try await store.commit(fixtureRequest(), expectedGeneration: "4")
            }
            let beforeRecord = backend.recordData(fixtureClientKey)
            let beforeLedger = backend.ledgerData(fixtureClientKey)
            let beforeOperations = backend.operations.count
            configure(backend)

            let fenced = await store.isFenced(clientKey: fixtureClientKey)
            XCTAssertTrue(fenced, file: file, line: line)
            let otherFenced = await store.isFenced(clientKey: "client-key-synthetic-new")
            XCTAssertTrue(otherFenced, "Unknown fence contents must refuse every key", file: file, line: line)
            await XCTAssertThrowsErrorAsync(
                try await store.commit(fixtureRequest(credential: "credential-synthetic-replacement"),
                                       expectedGeneration: "5"), file: file, line: line) { error in
                XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .fenceStoreDegraded,
                               file: file, line: line)
            }
            XCTAssertEqual(backend.recordData(fixtureClientKey), beforeRecord, file: file, line: line)
            XCTAssertEqual(backend.ledgerData(fixtureClientKey), beforeLedger, file: file, line: line)
            XCTAssertTrue(backend.operations.dropFirst(beforeOperations).allSatisfy { $0.op == "readAll" },
                          "Degraded fences must refuse before touching custody or its ledger", file: file, line: line)
        }
    }

    // Concurrent commit/invalidate interleaving, at the API level: whatever
    // the arrival order, a stale generation never ends up installed and the
    // newest winner owns the key.
    func testConcurrentCommitAndInvalidateNeverInstallsAStaleRecord() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        await withTaskGroup(of: Void.self) { group in
            group.addTask { _ = try? await store.commit(fixtureRequest(), expectedGeneration: "2") }
            group.addTask { _ = try? await store.invalidate(fixtureClientKey, generation: "1") }
            group.addTask { _ = try? await store.commit(fixtureRequest(), expectedGeneration: "1") }
        }
        let after = await store.read(fixtureClientKey)
        guard case let .present(stored) = after else {
            return XCTFail("expected the newest winner's record to own the key, got \(after)")
        }
        XCTAssertEqual(stored.storedGeneration, "2")
        XCTAssertEqual(stored.envelope.sealed, fixtureCredential)
        let newest = try await store.storedNewestGeneration(clientKey: fixtureClientKey)
        XCTAssertEqual(newest, "2")
    }

    // The commit lands under the house Keychain pattern, ledger before
    // record, with the credential existing ONLY inside the sealed payload.
    // (The backend starts EMPTY so this one commit performs both writes as
    // adds — an upsert over an existing item goes through the update path,
    // which is the house replacement discipline but adds nothing to log.)
    func testCommitUsesHouseKeychainPatternAndCredentialOnlyInsideSealed() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)

        try await store.commit(fixtureRequest(), expectedGeneration: "2")

        // Order of measured reads and writes: fence check, ledger read,
        // record read, ledger write, record write.
        let ops = backend.operations.map { "\($0.op):\($0.service)" }
        let recordService = ProtectedEnrollmentCustodyStore.Service.record
        let ledgerService = ProtectedEnrollmentCustodyStore.Service.ledger
        XCTAssertEqual(ops.first, "readAll:\(ProtectedEnrollmentCustodyStore.Service.fence)")
        XCTAssertLessThan(
            ops.firstIndex(of: "add:\(ledgerService)") ?? -1,
            ops.firstIndex(of: "add:\(recordService)") ?? -1,
            "the ledger write must land before the record write")

        // House pattern on both writes: generic password, dedicated service,
        // device-only accessibility.
        let adds = backend.addedAttributes
        XCTAssertEqual(adds.count, 2)
        for attributes in adds {
            XCTAssertEqual(attributes[kSecClass as String] as? String, kSecClassGenericPassword as String)
            XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String,
                           kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        }
        XCTAssertEqual(adds[0][kSecAttrService as String] as? String, ledgerService)
        XCTAssertEqual(adds[0][kSecAttrAccount as String] as? String, fixtureClientKey)
        XCTAssertEqual(adds[1][kSecAttrService as String] as? String, recordService)
        XCTAssertEqual(adds[1][kSecAttrAccount as String] as? String, fixtureClientKey)

        // The credential exists ONLY inside the record's sealed payload: the
        // ledger and fence payloads never see it.
        let ledger = try XCTUnwrap(backend.ledgerData(fixtureClientKey))
        XCTAssertFalse(String(decoding: ledger, as: UTF8.self).contains(fixtureCredential))
        try await store.fence(clientKey: fixtureClientKey, reason: "probe")
        let fence = try XCTUnwrap(backend.fenceData(fixtureClientKey))
        XCTAssertFalse(String(decoding: fence, as: UTF8.self).contains(fixtureCredential))
        let record = try XCTUnwrap(backend.recordData(fixtureClientKey))
        XCTAssertTrue(String(decoding: record, as: UTF8.self).contains(fixtureCredential))
        // The envelope itself names the full binding quadruple.
        let payload = try JSONDecoder().decode(
            ProtectedEnrollmentCustodyStoreTestsPayload.self, from: record)
        XCTAssertEqual(payload.envelope.cloudSubject, "sub-synthetic-0001")
        XCTAssertEqual(payload.envelope.cloudIssuer, "https://cloud.synthetic.invalid")
        XCTAssertEqual(payload.envelope.workspaceId, "ws-synthetic-0001")
        XCTAssertEqual(payload.envelope.clientKey, fixtureClientKey)
        XCTAssertEqual(payload.envelope.version, 3)
        XCTAssertEqual(payload.storedGeneration, "2")
        XCTAssertNil(payload.envelope.revokedAt)
    }

    /// Decodable mirror of the stored record payload, used to assert the
    /// envelope's provenance fields without reaching into the store's
    /// private codec.
    private struct ProtectedEnrollmentCustodyStoreTestsPayload: Decodable {
        struct Envelope: Decodable {
            let version: Int
            let sealed: String
            let cloudSubject: String
            let cloudIssuer: String
            let workspaceId: String
            let clientKey: String
            let revokedAt: Int64?
        }
        let envelope: Envelope
        let storedGeneration: String
    }

    // The monotonic announcement: an older generation is ignored, never
    // rolled back (:609's mapped semantics).
    func testNoteGenerationIsMonotonicAndOlderAnnouncementsAreIgnored() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "3")
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "2")
        let newestAfterOlder = try await store.storedNewestGeneration(clientKey: fixtureClientKey)
        XCTAssertEqual(newestAfterOlder, "3")
        await XCTAssertThrowsErrorAsync(
            try await store.commit(fixtureRequest(), expectedGeneration: "2")) { error in
            XCTAssertEqual(
                error as? ProtectedEnrollmentCustodyError,
                .staleGeneration(expected: "2", newest: "3"))
        }
        // An equal announcement is a no-op, not a rollback.
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "3")
        let newestAfterEqual = try await store.storedNewestGeneration(clientKey: fixtureClientKey)
        XCTAssertEqual(newestAfterEqual, "3")
    }

    // A generation that cannot be ordered against the established newest is
    // refused, never guessed at.
    func testUnorderableGenerationIsRefusedFailClosed() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "gen-synthetic")
        await XCTAssertThrowsErrorAsync(
            try await store.commit(fixtureRequest(), expectedGeneration: "1")) { error in
            XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .generationUnorderable("1"))
        }
        let read = await store.read(fixtureClientKey)
        XCTAssertEqual(read, .absent)
    }

    // A binding naming a different device than the request is refused at the
    // seam (:1210's client-key refusal), and stores nothing.
    func testBindingKeyContradictionIsRefusedAndStoresNothing() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        var request = fixtureRequest()
        request.binding = fixtureBinding(clientKey: "client-key-synthetic-other")

        await XCTAssertThrowsErrorAsync(
            try await store.commit(request, expectedGeneration: "1")) { error in
            XCTAssertEqual(
                error as? ProtectedEnrollmentCustodyError,
                .bindingKeyMismatch(request: fixtureClientKey, binding: "client-key-synthetic-other"))
        }
        let read = await store.read(fixtureClientKey)
        XCTAssertEqual(read, .absent)
        let newest = try await store.storedNewestGeneration(clientKey: fixtureClientKey)
        XCTAssertNil(newest)
    }

    func testNonCanonicalIssuerAndEmailSubjectAreRefusedBeforeWriting() async throws {
        let invalidIssuers = [
            "https://Cloud.synthetic.invalid",
            "https://cloud.synthetic.invalid:443",
            "https://cloud.synthetic.invalid/",
            "https://cloud.synthetic.invalid/path",
            "https://user@cloud.synthetic.invalid",
            "https://cloud.synthetic.invalid?query=1",
            "https://cloud.synthetic.invalid#fragment",
            "http://cloud.synthetic.invalid",
        ]

        for issuer in invalidIssuers {
            let backend = FakeCustodyKeychain()
            let store = ProtectedEnrollmentCustodyStore(ops: backend)
            var request = fixtureRequest()
            request.binding.cloudIssuer = issuer
            await XCTAssertThrowsErrorAsync(
                try await store.commit(request, expectedGeneration: "1")) { error in
                XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .invalidBinding)
            }
            XCTAssertNil(backend.recordData(fixtureClientKey), "Rejected issuer must not be stored")
            XCTAssertNil(backend.ledgerData(fixtureClientKey), "Rejected issuer must not advance the ledger")
        }

        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        var emailSubject = fixtureRequest()
        emailSubject.binding.cloudSubject = "person@example.invalid"
        await XCTAssertThrowsErrorAsync(
            try await store.commit(emailSubject, expectedGeneration: "1")) { error in
            XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .invalidBinding)
        }
        XCTAssertNil(backend.recordData(fixtureClientKey))
        XCTAssertNil(backend.ledgerData(fixtureClientKey))
    }

    // Re-committing the SAME generation is allowed and replaces in place —
    // the retry path for a commit whose ledger write landed but whose record
    // write did not.
    func testSameGenerationRecommitReplacesInPlaceWithoutDuplicates() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "1")
        try await store.commit(fixtureRequest(), expectedGeneration: "1")
        let firstAddCount = backend.addedAttributes.count
        try await store.commit(fixtureRequest(credential: "credential-synthetic-rotated"), expectedGeneration: "1")

        // The replacement updated the existing items rather than adding new ones.
        XCTAssertEqual(backend.addedAttributes.count, firstAddCount)
        let after = await store.read(fixtureClientKey)
        guard case let .present(stored) = after else {
            return XCTFail("expected the re-committed record, got \(after)")
        }
        XCTAssertEqual(stored.storedGeneration, "1")
        XCTAssertEqual(stored.envelope.sealed, "credential-synthetic-rotated")
    }

    // Invalidation of an unreadable record fences the key and refuses —
    // uncertainty, never a cleanup proof.
    func testInvalidateOnUnreadableRecordFencesAndThrows() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        try await store.commit(fixtureRequest(), expectedGeneration: "1")
        backend.garbageAccounts.insert(fixtureClientKey)

        await XCTAssertThrowsErrorAsync(
            try await store.invalidate(fixtureClientKey, generation: "1")) { error in
            XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .custodyUnreadable(status: nil))
        }
        let fenced = await store.isFenced(clientKey: fixtureClientKey)
        XCTAssertTrue(fenced)
        let read = await store.read(fixtureClientKey)
        XCTAssertEqual(read, .unknown)
    }

    // Ledger unreadable: writes are refused (a commit cannot be proven
    // conditional), reads are unaffected.
    func testUnreadableLedgerRefusesWritesButNotReads() async throws {
        let backend = FakeCustodyKeychain()
        let store = ProtectedEnrollmentCustodyStore(ops: backend)
        try await store.noteGeneration(clientKey: fixtureClientKey, generation: "2")
        backend.garbageAccounts.insert(fixtureClientKey)

        await XCTAssertThrowsErrorAsync(
            try await store.commit(fixtureRequest(), expectedGeneration: "2")) { error in
            XCTAssertEqual(error as? ProtectedEnrollmentCustodyError, .ledgerUnreadable(status: nil))
        }
        let read = await store.read(fixtureClientKey)
        XCTAssertEqual(read, .absent)
    }

    // Error descriptions carry no client key and no credential material
    // (the SessionKeychainTests discipline).
    func testErrorDescriptionsCarryNoSecretMaterial() {
        let errors: [ProtectedEnrollmentCustodyError] = [
            .staleGeneration(expected: fixtureClientKey, newest: fixtureCredential),
            .keyFenced,
            .fenceStoreDegraded,
            .custodyUnreadable(status: errSecInteractionNotAllowed),
            .ledgerUnreadable(status: nil),
            .tombstoneUnreadable(status: errSecInteractionNotAllowed),
            .keyDeleted,
            .generationUnorderable(fixtureClientKey),
            .bindingKeyMismatch(request: fixtureClientKey, binding: fixtureCredential),
            .invalidBinding,
            .writeRefused(errSecAuthFailed),
            .deleteRefused(errSecAuthFailed),
        ]
        for error in errors {
            let description = error.localizedDescription
            XCTAssertFalse(description.contains(fixtureCredential))
            XCTAssertFalse(description.contains(fixtureClientKey))
            XCTAssertFalse(description.contains("sub-synthetic"))
        }
    }
}

// MARK: - Async assertion helper

/// XCTest has no built-in async XCTAssertThrowsError; this mirrors the
/// do/catch idiom the other suites use, keeping failure lines in the caller.
/// (XCTest's own assertion autoclosures do not support `await`, so awaited
/// expressions elsewhere in this suite are hoisted into locals first.)
private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath, line: UInt = #line,
    _ errorHandler: (Error) -> Void = { _ in }
) async {
    do {
        _ = try await expression()
        XCTFail("expected an error, got success", file: file, line: line)
    } catch {
        errorHandler(error)
    }
}
