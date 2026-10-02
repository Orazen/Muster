import Foundation
import XCTest
import CompanionCore
@testable import MusterCompanion

private final class TestCredentialStore: CredentialStore {
    var values: [String: String]
    var rejectedRemovals = Set<String>()

    init(values: [String: String]) { self.values = values }

    func save(_ token: String, for connectionId: String) throws {
        values[connectionId] = token
    }

    func token(for connectionId: String) throws -> String? {
        values[connectionId]
    }

    func remove(_ connectionId: String) -> Bool {
        guard !rejectedRemovals.contains(connectionId) else { return false }
        values.removeValue(forKey: connectionId)
        return true // Keychain's item-not-found result is also success.
    }
}

@MainActor
final class SessionCredentialRemovalTests: XCTestCase {
    func testRejectedPrimaryRemovalPreservesPairingAndRetryDoesNotSendEarlyTombstone() throws {
        let connection = Connection(
            id: "phone-removal-test",
            name: "Test Computer",
            host: "127.0.0.1",
            port: 8810,
            scheme: .http
        )
        let suite = "com.muster.tests.session-removal.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let encodedConnection = try JSONEncoder().encode(connection)
        defaults.set(encodedConnection, forKey: "companion.connection")

        let credentials = TestCredentialStore(values: [connection.id: "phone-test-token"])
        credentials.rejectedRemovals.insert(connection.id)
        var unpairTombstones = 0
        let session = Session(
            credentialStore: credentials,
            defaults: defaults,
            pushUnpair: { unpairTombstones += 1 },
            activateWatchBridge: {},
            pushPairing: { _, _ in },
            snapshotPublisher: nil,
            testHostInert: true
        )

        XCTAssertEqual(session.connection, connection)
        XCTAssertEqual(session.status, .connecting)
        XCTAssertTrue(session.hasActiveClient, "restore should have built the authenticated client")

        XCTAssertFalse(session.signOut())

        XCTAssertEqual(credentials.values[connection.id], "phone-test-token")
        XCTAssertEqual(defaults.data(forKey: "companion.connection"), encodedConnection)
        XCTAssertEqual(session.connection, connection)
        XCTAssertEqual(session.status, .connecting)
        XCTAssertTrue(session.hasActiveClient)
        XCTAssertTrue(session.credentialRemovalNeedsRetry)
        XCTAssertNotNil(session.actionError)
        XCTAssertEqual(unpairTombstones, 0, "a failed primary delete must not publish an unpair tombstone")

        credentials.rejectedRemovals.remove(connection.id)
        XCTAssertTrue(session.signOut())

        XCTAssertNil(credentials.values[connection.id])
        XCTAssertNil(defaults.data(forKey: "companion.connection"))
        XCTAssertNil(session.connection)
        XCTAssertEqual(session.status, .unpaired)
        XCTAssertFalse(session.hasActiveClient)
        XCTAssertFalse(session.credentialRemovalNeedsRetry)
        XCTAssertEqual(unpairTombstones, 1)
    }

    func testAppHostConstructionUsesInertPhoneComposition() {
        XCTAssertTrue(CompanionAppComposition.isTestHost)

        let session = CompanionAppComposition.makeSession()

        XCTAssertTrue(session.isTestHostInert)
        XCTAssertNil(session.connection)
        XCTAssertEqual(session.status, .unpaired)
        XCTAssertFalse(session.hasActiveClient)
        XCTAssertFalse(session.credentialRemovalNeedsRetry)
    }
}
