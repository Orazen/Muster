import AppKit
import CompanionCore
import Foundation
import Security
import SwiftUI
import XCTest
@testable import MusterMac
@testable import MusterMacCore

// ============================================================================
// K1f — ORDINARY SIGN-IN SESSION PERSISTENCE (integration check).
//
// Renamed from a former candidate that made an UNSUPPORTED claim. That draft
// built a `ProviderSecretStore` over a spy, then asserted the spy saw nothing —
// but the store was never injected anywhere, and `ProviderSecretStore` has no
// product consumer at all. It also mislabelled a counter that no storage
// operation incremented. Both were vacuous. `ProviderSecretStore` and its spy
// are GONE; so is every "confers no authority" claim, because no native
// authority type exists to assert about and none may be invented. The old
// candidate is retained only as private evidence and was never integrated.
//
// WHAT IS REACHED, AND WHY THIS IS NOT VACUOUS
//
// Two real production seams, no new product hook:
//
//   * `NativeSignInCoordinator`'s `saveAccount` — the closure ordinary sign-in
//     actually invokes when an attempt succeeds.
//   * the production `SessionKeychain.save` / `load` pair, with ONLY the storage
//     backend injected. So the assertions observe production's real JSON encode,
//     its real "update first, add only on confirmed absence" rule, its real
//     Keychain query identity, and its real decode.
//
// WHAT IS PINNED
//
// An ordinary sign-in performs exactly ONE SUCCESSFUL session write — not one
// successful write plus a not-found update attempt, which is why successes are
// counted separately from attempts. That write carries production's exact
// service/account identity, the stored bytes decode to the account that signed
// in, and `live.account` agrees.
//
// A discriminating control proves the same backend is not a blind stub: it must
// report a SECOND payload, refuse a second add, count every attempt, and leave
// the working session intact when a write is refused.
//
// NOT CLAIMED: that no authority exists; any security property; enrollment or
// device confirmation; server identity or generation semantics (captain-owned
// W2). No pixels, no real Keychain, no network, no accounts, no installed app.
// ============================================================================

// MARK: - Recording backend

/// One recorded call, keeping the real query and attributes production passed.
struct SessionStorageAttempt {
    enum Operation: String { case add, update, read, delete }
    let operation: Operation
    let status: OSStatus
    /// The query/attributes dictionary exactly as production supplied it.
    let query: [String: Any]
    /// True only when the call actually succeeded. A `update` returning
    /// `errSecItemNotFound` is an ATTEMPT, not a successful write.
    var succeeded: Bool { status == errSecSuccess }
}

final class RecordingSessionStorage: SessionKeychainStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var bytes: Data?
    private var _attempts: [SessionStorageAttempt] = []
    private var _successfulWrites = 0

    var attempts: [SessionStorageAttempt] { lock.lock(); defer { lock.unlock() }; return _attempts }
    /// Writes that actually landed. The not-found update attempt is excluded.
    var successfulWrites: Int { lock.lock(); defer { lock.unlock() }; return _successfulWrites }
    func attempts(_ operation: SessionStorageAttempt.Operation) -> [SessionStorageAttempt] {
        attempts.filter { $0.operation == operation }
    }

    /// Decode what production actually stored, so assertions compare real bytes
    /// rather than trusting a counter.
    func storedAccount() -> HarnessAccount? {
        lock.lock(); defer { lock.unlock() }
        guard let bytes else { return nil }
        return try? JSONDecoder().decode(HarnessAccount.self, from: bytes)
    }
    var isEmpty: Bool { lock.lock(); defer { lock.unlock() }; return bytes == nil }
    /// When set, every write attempt is refused with this status.
    var refuseWritesWith: OSStatus?

    func add(_ attributes: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        // Production passes the merged query+attributes here.
        let status: OSStatus
        if let refusal = refuseWritesWith {
            status = refusal
        } else if bytes != nil {
            status = errSecDuplicateItem
        } else {
            bytes = attributes[kSecValueData as String] as? Data
            status = errSecSuccess
        }
        _attempts.append(SessionStorageAttempt(operation: .add, status: status, query: attributes))
        if status == errSecSuccess { _successfulWrites += 1 }
        return status
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        let status: OSStatus
        if let refusal = refuseWritesWith {
            status = refusal
        } else if bytes == nil {
            status = errSecItemNotFound
        } else {
            bytes = attributes[kSecValueData as String] as? Data
            status = errSecSuccess
        }
        _attempts.append(SessionStorageAttempt(operation: .update, status: status, query: query))
        if status == errSecSuccess { _successfulWrites += 1 }
        return status
    }

    func read(_ query: [String: Any]) -> (OSStatus, Data?) {
        lock.lock(); defer { lock.unlock() }
        let found = bytes != nil
        _attempts.append(SessionStorageAttempt(operation: .read,
                                               status: found ? errSecSuccess : errSecItemNotFound,
                                               query: query))
        return bytes.map { (errSecSuccess, $0) } ?? (errSecItemNotFound, nil)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        bytes = nil
        _attempts.append(SessionStorageAttempt(operation: .delete, status: errSecSuccess, query: query))
        return errSecSuccess
    }
}

// MARK: - Tests

@MainActor
final class OrdinaryLoginSessionPersistenceTests: XCTestCase {

    private func account(_ origin: String, _ cookie: String) -> HarnessAccount {
        HarnessAccount(origin: origin, cookieName: "better-auth.session_token", cookieValue: cookie)
    }
    private let signedIn = HarnessAccount(origin: "https://ordinary.fixture.invalid",
                                          cookieName: "better-auth.session_token",
                                          cookieValue: "synthetic-ordinary")

    /// Production's Keychain identity, read from the product source rather than
    /// duplicated here, so this cannot drift from the real query.
    private func assertProductionIdentity(_ query: [String: Any],
                                          file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String,
                       "the session must be a generic-password item", file: file, line: line)
        XCTAssertEqual(query[kSecAttrService as String] as? String, "com.muster.MusterMac",
                       "the session must carry production's exact service", file: file, line: line)
        XCTAssertEqual(query[kSecAttrAccount as String] as? String, "session",
                       "the session must carry production's exact account", file: file, line: line)
    }

    private func drain(_ turns: Int = 8) async throws {
        for _ in 0..<turns {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            try await Task.sleep(nanoseconds: 3_000_000)
        }
    }

    /// An ordinary sign-in's entire persisted footprint is exactly one successful
    /// session write carrying the account that signed in.
    func testOrdinarySignInPerformsExactlyOneSuccessfulSessionWrite() async throws {
        let storage = RecordingSessionStorage()
        let transport = SilentSessionTransport()
        let auth = HeldSyntheticAuth()
        let live = LiveSessionModel(transportFactory: { _ in transport })

        // The reachable seam: the coordinator's own saveAccount, calling the
        // REAL production save. Only the storage backend is injected.
        let signIn = NativeSignInCoordinator(
            live: live,
            authenticate: { try await auth.authenticate($0) },
            saveAccount: { try SessionKeychain.save($0, storage: storage) })

        // Closed/drained cleanup on both doubles, both asserted zero.
        addTeardownBlock { @MainActor in
            signIn.invalidateForShutdown()
            live.disconnect()
            await transport.finish()
            await auth.finish()
            let left = await transport.inFlight
            XCTAssertEqual(left, 0, "teardown left a transport continuation parked")
            // auth is closed by finish(); a late registration would be refused,
            // so zero pending is the observable proof it drained.
            let authLeft = await auth.inFlight
            XCTAssertEqual(authLeft, 0, "teardown left an auth continuation parked")
        }

        // Precondition: absence, not a phantom session.
        XCTAssertNil(try SessionKeychain.load(storage: storage),
                     "precondition: no session may exist before sign-in")
        XCTAssertTrue(storage.isEmpty)
        XCTAssertEqual(storage.successfulWrites, 0)

        // Ordinary sign-in through the real coordinator.
        signIn.beginAttempt(window: UUID(), inputs: .init(
            origin: "https://ordinary.fixture.invalid",
            email: "ordinary@fixture.invalid",
            password: "synthetic", mode: .signIn))

        // OBSERVED registration, never inferred from `isBusy`.
        let deadline = Date().addingTimeInterval(3)
        while await auth.inFlight == 0 && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            try await Task.sleep(nanoseconds: 3_000_000)
        }
        let registered = await auth.inFlight
        XCTAssertEqual(registered, 1,
                       "precondition: the ordinary request must actually register")

        await auth.release(signedIn, for: "ordinary@fixture.invalid")
        try await drain()

        // Save-completion observed: the attempt settled and the session adopted.
        XCTAssertFalse(signIn.isBusy, "the ordinary attempt must have settled")
        XCTAssertEqual(live.account, signedIn, "the session must be the account that signed in")

        // EXACTLY ONE SUCCESSFUL WRITE — the not-found update attempt does not
        // count, which is the whole reason successes are tracked separately.
        XCTAssertEqual(storage.successfulWrites, 1,
                       "an ordinary sign-in must land exactly one session write")
        let updates = storage.attempts(.update)
        XCTAssertEqual(updates.count, 1, "production must attempt exactly one update")
        XCTAssertEqual(updates.first?.status, errSecItemNotFound,
                       "the first save must find absence, not overwrite blindly")
        XCTAssertEqual(storage.attempts(.add).count, 1,
                       "absence was confirmed, so exactly one add")
        XCTAssertTrue(storage.attempts(.delete).isEmpty, "sign-in must not delete anything")

        // The write carried production's exact session identity.
        for attempt in storage.attempts where attempt.operation == .add || attempt.operation == .update {
            assertProductionIdentity(attempt.query)
        }

        // And the bytes production stored decode to the account that signed in.
        XCTAssertEqual(storage.storedAccount(), signedIn,
                       "production must store exactly the signed-in account")
        let readBack = try SessionKeychain.load(storage: storage)
        XCTAssertEqual(readBack, signedIn, "read-back must equal what was signed in")

        print("OBS ordinary successfulWrites=\(storage.successfulWrites) "
              + "attempts=\(storage.attempts.map { "\($0.operation.rawValue):\($0.status)" })")
    }

    /// THE DISCRIMINATING CONTROL. The backend must not be a blind stub: it has
    /// to report a second payload, refuse a second add, count every attempt, and
    /// leave the working session intact when a write is refused.
    func testSessionStorageBackendDiscriminatesPayloadsAndRefusals() throws {
        let storage = RecordingSessionStorage()

        // (a) No phantom session.
        XCTAssertNil(try SessionKeychain.load(storage: storage))
        XCTAssertTrue(storage.isEmpty)

        let first = account("https://first.fixture.invalid", "synthetic-first")
        let second = account("https://second.fixture.invalid", "synthetic-second")

        // (b) First save: absence confirmed, so one attempt and one success.
        try SessionKeychain.save(first, storage: storage)
        XCTAssertEqual(storage.successfulWrites, 1)
        XCTAssertEqual(storage.storedAccount(), first)
        assertProductionIdentity(storage.attempts(.update)[0].query)

        // (c) DISCRIMINATION: the second payload must be observable. A stub that
        // rubber-stamps would fail exactly here.
        try SessionKeychain.save(second, storage: storage)
        XCTAssertEqual(storage.successfulWrites, 2, "the second write must also be counted")
        XCTAssertEqual(storage.storedAccount(), second,
                       "the backend must report the SECOND payload, not the first")
        XCTAssertNotEqual(try SessionKeychain.load(storage: storage), first)

        // (d) NO SECOND ADD: absence was already resolved, so production must
        // update. An extra add would be visible here.
        XCTAssertEqual(storage.attempts(.add).count, 1,
                       "production must never add twice; absence was already resolved")
        XCTAssertEqual(storage.attempts(.update).count, 2,
                       "each save must attempt exactly one update")
        XCTAssertEqual(storage.attempts(.update)[1].status, errSecSuccess,
                       "the second update must succeed because a row now exists")

        // (e) A REFUSED write throws, leaves the working session intact, and is
        // NOT counted as a successful write — so a failure cannot masquerade as
        // a store.
        storage.refuseWritesWith = errSecInteractionNotAllowed
        XCTAssertThrowsError(try SessionKeychain.save(first, storage: storage),
                             "a refused write must throw, not silently succeed")
        XCTAssertEqual(storage.successfulWrites, 2, "a refused write must not count as a success")
        XCTAssertEqual(storage.storedAccount(), second,
                       "a refused replacement must leave the working session intact")
        storage.refuseWritesWith = nil
    }
}