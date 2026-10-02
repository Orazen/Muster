import CryptoKit
import Foundation
import XCTest
import CompanionCore
@testable import MusterWatch

private final class TestCredentialStore: CredentialStore {
    var values: [String: String]
    var rejectedRemovals = Set<String>()
    private(set) var removalAttempts: [String] = []

    init(values: [String: String]) { self.values = values }

    func save(_ token: String, for connectionId: String) throws {
        values[connectionId] = token
    }

    func token(for connectionId: String) throws -> String? {
        values[connectionId]
    }

    func remove(_ connectionId: String) -> Bool {
        removalAttempts.append(connectionId)
        guard !rejectedRemovals.contains(connectionId) else { return false }
        values.removeValue(forKey: connectionId)
        return true // Keychain's item-not-found result is also success.
    }
}

private final class MemoryTrustStore: HandoffTrustStore {
    var state = HandoffTrustState()

    func load() -> HandoffTrustState { state }
    func save(_ value: HandoffTrustState) { state = value }
}

private enum TestMarkerPersistenceError: Error {
    case rejected
}

private final class TestCalendarCleanupMarkerPersistence: CalendarCleanupMarkerPersistence {
    enum Outcome {
        case writeFails
        case interruptedAfterWrite
        case succeeds
    }

    let defaults: UserDefaults
    var outcome: Outcome
    private(set) var writes: [(String, String)] = []

    init(defaults: UserDefaults, outcome: Outcome) {
        self.defaults = defaults
        self.outcome = outcome
    }

    func persist(_ value: String, forKey key: String) throws {
        writes.append((value, key))
        switch outcome {
        case .writeFails:
            throw TestMarkerPersistenceError.rejected
        case .interruptedAfterWrite:
            defaults.set(value, forKey: key)
            throw CancellationError()
        case .succeeds:
            defaults.set(value, forKey: key)
            guard defaults.synchronize(), defaults.string(forKey: key) == value else {
                throw TestMarkerPersistenceError.rejected
            }
        }
    }
}

@MainActor
final class WatchSessionCredentialRemovalTests: XCTestCase {
    private func calendarKey(connection: Connection, token: String) -> String {
        let binding = "\(connection.id)|\(connection.scheme.rawValue)|\(connection.host)|\(connection.port)|\(token)"
        let digest = SHA256.hash(data: Data(binding.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return "calendar:" + digest
    }

    private func makeSession(
        connection: Connection,
        credentials: TestCredentialStore,
        suite: String
    ) throws -> (WatchSession, UserDefaults, Data) {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let encoded = try JSONEncoder().encode(connection)
        defaults.set(encoded, forKey: "companion.connection")
        let session = WatchSession(
            credentialStore: credentials,
            defaults: defaults,
            snapshotPublisher: { _ in }
        )
        return (session, defaults, encoded)
    }

    func testRejectedPrimaryRemovalPreservesBothCredentialsAndConnectionForRetry() throws {
        let connection = Connection(
            id: "watch-removal-test",
            name: "Test Computer",
            host: "127.0.0.1",
            port: 8810,
            scheme: .http
        )
        let token = "watch-test-token"
        let derivedKey = calendarKey(connection: connection, token: token)
        let suite = "com.muster.tests.watch-removal.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let credentials = TestCredentialStore(values: [
            connection.id: token,
            derivedKey: "calendar-enrollment-data"
        ])
        credentials.rejectedRemovals.insert(connection.id)
        let (session, defaults, encodedConnection) = try makeSession(
            connection: connection,
            credentials: credentials,
            suite: suite
        )

        XCTAssertEqual(session.connection, connection)
        XCTAssertEqual(session.status, .connecting)
        XCTAssertTrue(session.hasActiveClient)

        XCTAssertFalse(session.signOut())

        XCTAssertEqual(credentials.values[connection.id], token)
        XCTAssertEqual(credentials.values[derivedKey], "calendar-enrollment-data")
        XCTAssertEqual(defaults.data(forKey: "companion.connection"), encodedConnection)
        XCTAssertEqual(session.connection, connection)
        XCTAssertEqual(session.status, .connecting)
        XCTAssertTrue(session.hasActiveClient)
        XCTAssertTrue(session.credentialRemovalNeedsRetry)
        XCTAssertNotNil(session.actionError)

        credentials.rejectedRemovals.remove(connection.id)
        XCTAssertTrue(session.signOut())
        XCTAssertNil(credentials.values[connection.id])
        XCTAssertNil(credentials.values[derivedKey])
        XCTAssertNil(defaults.data(forKey: "companion.connection"))
        XCTAssertNil(session.connection)
        XCTAssertEqual(session.status, .unpaired)
        XCTAssertFalse(session.hasActiveClient)
        XCTAssertFalse(session.credentialRemovalNeedsRetry)
    }

    func testCalendarCleanupFailureRestoresAndRetryFinishesUnpair() throws {
        let connection = Connection(
            id: "watch-partial-removal-test",
            name: "Test Computer",
            host: "127.0.0.1",
            port: 8810,
            scheme: .http
        )
        let token = "watch-partial-test-token"
        let derivedKey = calendarKey(connection: connection, token: token)
        let suite = "com.muster.tests.watch-partial-removal.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let credentials = TestCredentialStore(values: [
            connection.id: token,
            derivedKey: "calendar-enrollment-data"
        ])
        credentials.rejectedRemovals.insert(derivedKey)
        let (session, defaults, _) = try makeSession(
            connection: connection,
            credentials: credentials,
            suite: suite
        )

        XCTAssertFalse(session.signOut())

        // These are two independent Keychain items, not an atomic transaction:
        // the primary token is gone, but the undeleted calendar credential and
        // connection identity remain available for an honest retry state.
        XCTAssertNil(credentials.values[connection.id])
        XCTAssertEqual(credentials.values[derivedKey], "calendar-enrollment-data")
        XCTAssertEqual(session.connection, connection)
        XCTAssertEqual(session.status, .offline("Calendar credential cleanup is incomplete. Retry cleanup."))
        XCTAssertFalse(session.hasActiveClient)
        XCTAssertTrue(session.credentialRemovalNeedsRetry)
        XCTAssertNotNil(defaults.data(forKey: "companion.connection"))
        XCTAssertEqual(defaults.string(forKey: "companion.pending-calendar-credential-removal"), derivedKey)
        XCTAssertNotNil(session.actionError)

        // Synchronize the durable partial-cleanup decision, then model a
        // process restart with a fresh WatchSession and the same stores.
        XCTAssertTrue(defaults.synchronize())
        let relaunchedDefaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        credentials.rejectedRemovals.remove(derivedKey)
        let restoredSession = WatchSession(
            credentialStore: credentials,
            defaults: relaunchedDefaults,
            snapshotPublisher: { _ in }
        )

        XCTAssertEqual(restoredSession.connection, connection)
        XCTAssertEqual(restoredSession.status, .offline("Unpair cleanup is incomplete. Retry cleanup."))
        XCTAssertFalse(restoredSession.hasActiveClient)
        XCTAssertTrue(restoredSession.credentialRemovalNeedsRetry)
        XCTAssertNotNil(relaunchedDefaults.data(forKey: "companion.connection"))
        XCTAssertEqual(relaunchedDefaults.string(forKey: "companion.pending-calendar-credential-removal"), derivedKey)
        XCTAssertEqual(credentials.values[derivedKey], "calendar-enrollment-data")

        XCTAssertTrue(restoredSession.signOut())

        XCTAssertNil(credentials.values[derivedKey])
        XCTAssertNil(relaunchedDefaults.data(forKey: "companion.connection"))
        XCTAssertNil(relaunchedDefaults.string(forKey: "companion.pending-calendar-credential-removal"))
        XCTAssertNil(restoredSession.connection)
        XCTAssertEqual(restoredSession.status, .unpaired)
        XCTAssertFalse(restoredSession.credentialRemovalNeedsRetry)
    }

    func testRemoteUnpairRetryCommitsAfterSessionReattachment() throws {
        let connection = Connection(
            id: "watch-remote-unpair-retry-test",
            name: "Test Computer",
            host: "127.0.0.1",
            port: 8810,
            scheme: .http
        )
        let token = "watch-remote-unpair-token"
        let oldPairing = CompanionHandoff(
            connection: connection,
            token: token,
            sentAt: Date(timeIntervalSince1970: 1_790_000_000),
            generation: 1
        )
        let suite = "com.muster.tests.watch-remote-unpair.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let ordering = WatchHandoffOrdering(
            store: UserDefaultsHandoffTrustStore(defaults: defaults)
        )
        ordering.commitAdoption(oldPairing)
        defaults.set(try JSONEncoder().encode(connection), forKey: "companion.connection")

        let credentials = TestCredentialStore(values: [connection.id: token])
        credentials.rejectedRemovals.insert(connection.id)
        let firstSession = WatchSession(
            credentialStore: credentials,
            defaults: defaults,
            snapshotPublisher: { _ in }
        )
        firstSession.setRemoteUnpairCommitHandler { ordering.commitUnpair(generation: $0) }

        XCTAssertFalse(firstSession.signOut(remoteUnpairGeneration: 2))
        XCTAssertEqual(defaults.string(forKey: "companion.pending-remote-unpair-generation"), "2")
        XCTAssertEqual(ordering.currentState().connection?.id, connection.id)
        XCTAssertFalse(ordering.currentState().pairingRevoked == true)

        XCTAssertTrue(defaults.synchronize())
        credentials.rejectedRemovals.remove(connection.id)
        // A new session instance models process restart; re-registering the
        // receiver callback lets a Settings retry finish the persisted decision.
        let relaunchedSession = WatchSession(
            credentialStore: credentials,
            defaults: try XCTUnwrap(UserDefaults(suiteName: suite)),
            snapshotPublisher: { _ in }
        )
        relaunchedSession.setRemoteUnpairCommitHandler { ordering.commitUnpair(generation: $0) }

        XCTAssertTrue(relaunchedSession.credentialRemovalNeedsRetry)
        XCTAssertTrue(relaunchedSession.signOut())
        XCTAssertNil(defaults.string(forKey: "companion.pending-remote-unpair-generation"))
        XCTAssertNil(ordering.currentState().connection)
        XCTAssertEqual(ordering.currentState().generation, 2)
        XCTAssertTrue(ordering.currentState().pairingRevoked == true)
        XCTAssertEqual(ordering.decidePairing(oldPairing), .stale)
    }

    func testAppHostConstructionUsesInertWatchComposition() {
        XCTAssertTrue(MusterWatchAppComposition.isTestHost)

        let session = MusterWatchAppComposition.makeSession()

        XCTAssertNil(session.connection)
        XCTAssertEqual(session.status, .unpaired)
        XCTAssertFalse(session.hasActiveClient)
        XCTAssertFalse(session.credentialRemovalNeedsRetry)
        XCTAssertFalse(MusterWatchAppComposition.shouldAttachHandoffReceiver)
        XCTAssertFalse(MusterWatchAppComposition.shouldBuildProductionScene)
    }

    func testCalendarSaveClosureUsesInjectedStoreWithoutRetainingSession() throws {
        let credentials = TestCredentialStore(values: [:])
        let suite = "com.muster.tests.watch-calendar-save.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        var session: WatchSession? = WatchSession(
            credentialStore: credentials,
            defaults: defaults,
            snapshotPublisher: { _ in }
        )
        weak var weakSession: WatchSession? = session
        let key = "calendar:captured-store-test"
        let save = try XCTUnwrap(session?.testingCalendarSaveClosure(for: key))

        session = nil
        XCTAssertNil(weakSession, "the escaping save closure must not retain WatchSession")

        let fixture = Data(#"{"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","grant":{"id":"grant-id","label":"Test Calendar","calendarId":"calendar-id","expiresAt":4102444800000}}"#.utf8)
        let issued = try JSONDecoder().decode(CallCalendarIssued.self, from: fixture)
        try save(issued)
        let storedJSON = try XCTUnwrap(credentials.values[key])
        let stored = try JSONDecoder().decode(CallCalendarIssued.self, from: Data(storedJSON.utf8))
        XCTAssertEqual(stored.token, issued.token)
        XCTAssertEqual(stored.grant.id, issued.grant.id)
        XCTAssertEqual(stored.grant.label, issued.grant.label)
        XCTAssertEqual(stored.grant.calendarId, issued.grant.calendarId)
        XCTAssertEqual(stored.grant.expiresAt, issued.grant.expiresAt)
    }

    private func assertMarkerPersistenceFailurePreservesSession(
        _ outcome: TestCalendarCleanupMarkerPersistence.Outcome
    ) throws {
        let connection = Connection(
            id: "watch-marker-persistence-test",
            name: "Test Computer",
            host: "127.0.0.1",
            port: 8810,
            scheme: .http
        )
        let token = "watch-marker-persistence-token"
        let derivedKey = calendarKey(connection: connection, token: token)
        let suite = "com.muster.tests.watch-marker-persistence.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let encodedConnection = try JSONEncoder().encode(connection)
        defaults.set(encodedConnection, forKey: "companion.connection")

        let credentials = TestCredentialStore(values: [
            connection.id: token,
            derivedKey: "calendar-enrollment-data"
        ])
        let markerPersistence = TestCalendarCleanupMarkerPersistence(defaults: defaults, outcome: outcome)
        let session = WatchSession(
            credentialStore: credentials,
            defaults: defaults,
            snapshotPublisher: { _ in },
            calendarCleanupMarkerPersistence: markerPersistence
        )

        XCTAssertFalse(session.signOut())

        XCTAssertEqual(markerPersistence.writes.count, 1)
        XCTAssertEqual(markerPersistence.writes.first?.0, derivedKey)
        XCTAssertEqual(markerPersistence.writes.first?.1, "companion.pending-calendar-credential-removal")
        XCTAssertTrue(credentials.removalAttempts.isEmpty, "no credential may be deleted before marker verification")
        XCTAssertEqual(credentials.values[connection.id], token)
        XCTAssertEqual(credentials.values[derivedKey], "calendar-enrollment-data")
        XCTAssertEqual(defaults.data(forKey: "companion.connection"), encodedConnection)
        XCTAssertEqual(session.connection, connection)
        XCTAssertEqual(session.status, .connecting)
        XCTAssertTrue(session.hasActiveClient)
        XCTAssertTrue(session.credentialRemovalNeedsRetry)
        XCTAssertNotNil(session.actionError)

        markerPersistence.outcome = .succeeds
        XCTAssertTrue(session.signOut(), "the preserved session must be able to retry cleanup")
        XCTAssertNil(credentials.values[connection.id])
        XCTAssertNil(credentials.values[derivedKey])
        XCTAssertNil(defaults.data(forKey: "companion.connection"))
        XCTAssertNil(defaults.string(forKey: "companion.pending-calendar-credential-removal"))
        XCTAssertNil(session.connection)
        XCTAssertEqual(session.status, .unpaired)
        XCTAssertFalse(session.credentialRemovalNeedsRetry)
    }

    func testCalendarMarkerWriteFailurePreservesPrimaryCredentialAndSession() throws {
        try assertMarkerPersistenceFailurePreservesSession(.writeFails)
    }

    func testCalendarMarkerInterruptionPreservesPrimaryCredentialAndSession() throws {
        try assertMarkerPersistenceFailurePreservesSession(.interruptedAfterWrite)
    }

    func testNewerHandoffCannotReplaceIncompleteLocalCalendarCleanup() async throws {
        let oldConnection = Connection(
            id: "watch-old-cleanup-binding",
            name: "Old Computer",
            host: "127.0.0.1",
            port: 8810,
            scheme: .http
        )
        let oldToken = "old-cleanup-token"
        let oldCalendarKey = calendarKey(connection: oldConnection, token: oldToken)
        let suite = "com.muster.tests.watch-local-cleanup-handoff.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(try JSONEncoder().encode(oldConnection), forKey: "companion.connection")

        let credentials = TestCredentialStore(values: [
            oldConnection.id: oldToken,
            oldCalendarKey: "old-calendar-enrollment"
        ])
        credentials.rejectedRemovals.insert(oldCalendarKey)
        let session = WatchSession(
            credentialStore: credentials,
            defaults: defaults,
            snapshotPublisher: { _ in }
        )
        let oldPairing = CompanionHandoff(connection: oldConnection, token: oldToken, generation: 1)
        let ordering = WatchHandoffOrdering(store: MemoryTrustStore())
        ordering.commitAdoption(oldPairing)

        XCTAssertFalse(session.signOut())
        XCTAssertNil(credentials.values[oldConnection.id])
        XCTAssertEqual(defaults.string(forKey: "companion.pending-calendar-credential-removal"), oldCalendarKey)

        let receiver = WatchHandoffReceiver()
        defer { session.disconnect() }
        receiver.attachForTesting(to: session, ordering: ordering)
        let newConnection = Connection(
            id: "watch-new-cleanup-handoff",
            name: "New Computer",
            host: "127.0.0.1",
            port: 8810,
            scheme: .http
        )
        let newPairing = CompanionHandoff(connection: newConnection, token: "new-pairing-token", generation: 2)
        let newPayload = try XCTUnwrap(CompanionHandoffCodec.encode(newPairing))
        let delivery: [String: Any] = [CompanionHandoffCodec.key: newPayload]

        receiver.ingestTestingHandoff(dictionary: delivery)

        XCTAssertEqual(session.connection, oldConnection)
        XCTAssertEqual(defaults.string(forKey: "companion.pending-calendar-credential-removal"), oldCalendarKey)
        XCTAssertEqual(credentials.values[oldCalendarKey], "old-calendar-enrollment")
        XCTAssertNil(credentials.values[newConnection.id])
        let persistedConnection = try XCTUnwrap(defaults.data(forKey: "companion.connection"))
        XCTAssertEqual(try JSONDecoder().decode(Connection.self, from: persistedConnection), oldConnection)
        XCTAssertEqual(ordering.currentState().connection?.id, oldConnection.id)

        credentials.rejectedRemovals.remove(oldCalendarKey)
        XCTAssertTrue(session.signOut())
        XCTAssertNil(defaults.string(forKey: "companion.pending-calendar-credential-removal"))

        receiver.ingestTestingHandoff(dictionary: delivery)

        XCTAssertEqual(session.connection, newConnection)
        XCTAssertEqual(credentials.values[newConnection.id], "new-pairing-token")
        XCTAssertEqual(ordering.currentState().connection?.id, newConnection.id)
        XCTAssertEqual(ordering.currentState().generation, 2)
        XCTAssertTrue(session.hasActiveStreamTaskForTesting, "successful adoption should start its stream task")
        // No await or actor yield occurs between adoption and cancellation, so
        // the real client task cannot open a socket in this test.
        session.disconnect()
        XCTAssertFalse(session.hasActiveStreamTaskForTesting)
        await Task.yield()
        XCTAssertFalse(session.hasActiveStreamTaskForTesting, "cancelled adoption task must not survive test cleanup")
    }
}
