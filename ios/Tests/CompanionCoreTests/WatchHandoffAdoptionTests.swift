import XCTest
@testable import CompanionCore

private final class AdoptionTrustStore: HandoffTrustStore {
    var state = HandoffTrustState()
    func load() -> HandoffTrustState { state }
    func save(_ value: HandoffTrustState) { state = value }
}

final class WatchHandoffAdoptionTests: XCTestCase {
    private func handoff(_ id: String, token: String, generation: UInt64) -> CompanionHandoff {
        CompanionHandoff(
            connection: Connection(id: id, name: "Computer", host: "127.0.0.1", port: 8810, scheme: .http),
            token: token,
            generation: generation
        )
    }

    @MainActor
    func testFailedCandidateSavePreservesCredentialConnectionStreamAndTrustThenRetries() throws {
        enum SaveFailure: Error { case locked }
        let previous = handoff("old", token: "old-fixture", generation: 1)
        let candidate = handoff("new", token: "new-fixture", generation: 2)
        var credentials = [previous.connection.id: previous.token]
        var connectionData = try JSONEncoder().encode(previous.connection)
        let originalData = connectionData
        var active = previous.connection
        var streamCancelled = false
        var events: [String] = []
        let trust = AdoptionTrustStore()
        let ordering = WatchHandoffOrdering(store: trust)
        ordering.commitAdoption(previous)
        let originalTrust = trust.state

        XCTAssertThrowsError(try WatchHandoffAdoption.perform(
            candidate, replacing: active,
            saveCredential: { _, _ in events.append("save"); throw SaveFailure.locked },
            activate: { data in
                streamCancelled = true
                connectionData = data
                active = candidate.connection
                events.append("activate")
            },
            removeCredential: { credentials.removeValue(forKey: $0); events.append("remove") }
        ))
        XCTAssertEqual(events, ["save"])
        XCTAssertEqual(credentials, [previous.connection.id: previous.token])
        XCTAssertEqual(connectionData, originalData)
        XCTAssertEqual(active, previous.connection)
        XCTAssertFalse(streamCancelled)
        XCTAssertEqual(trust.state, originalTrust)
        // A restart still restores the old connection and its credential.
        let restoredConnection = try JSONDecoder().decode(Connection.self, from: connectionData)
        XCTAssertEqual(credentials[restoredConnection.id], previous.token)
        XCTAssertEqual(ordering.decidePairing(candidate), .adopt(candidate))

        events.removeAll()
        try WatchHandoffAdoption.perform(
            candidate, replacing: active,
            saveCredential: { token, id in credentials[id] = token; events.append("save") },
            activate: { data in
                XCTAssertEqual(credentials[candidate.connection.id], candidate.token)
                XCTAssertEqual(credentials[previous.connection.id], previous.token)
                streamCancelled = true
                connectionData = data
                active = candidate.connection
                events.append("activate")
            },
            removeCredential: { credentials.removeValue(forKey: $0); events.append("remove") }
        )
        ordering.commitAdoption(candidate) // same success-only boundary as receiver
        XCTAssertEqual(events, ["save", "activate", "remove"])
        XCTAssertTrue(streamCancelled)
        XCTAssertEqual(active, candidate.connection)
        XCTAssertEqual(credentials, [candidate.connection.id: candidate.token])
        XCTAssertEqual(ordering.decidePairing(candidate), .duplicate)
    }

    @MainActor
    func testSameConnectionCredentialRotationDoesNotDeleteNewCredential() throws {
        let previous = handoff("same", token: "old-fixture", generation: 1)
        let candidate = handoff("same", token: "new-fixture", generation: 2)
        var credentials = [previous.connection.id: previous.token]
        var activations = 0
        try WatchHandoffAdoption.perform(
            candidate, replacing: previous.connection,
            saveCredential: { token, id in credentials[id] = token },
            activate: { _ in activations += 1 },
            removeCredential: { credentials.removeValue(forKey: $0); XCTFail("must not delete a replaced key") }
        )
        XCTAssertEqual(activations, 1)
        XCTAssertEqual(credentials[candidate.connection.id], candidate.token)
    }

    @MainActor
    func testFailedSameConnectionRotationLeavesPriorCredentialAvailable() {
        enum SaveFailure: Error { case locked }
        let previous = handoff("same", token: "old-fixture", generation: 1)
        let candidate = handoff("same", token: "new-fixture", generation: 2)
        let credentials = [previous.connection.id: previous.token]
        XCTAssertThrowsError(try WatchHandoffAdoption.perform(
            candidate, replacing: previous.connection,
            saveCredential: { _, _ in throw SaveFailure.locked },
            activate: { _ in XCTFail("failed save must not alter connection or stream") },
            removeCredential: { _ in XCTFail("failed save must not remove prior credential") }
        ))
        XCTAssertEqual(credentials[previous.connection.id], previous.token)
    }

    @MainActor
    func testFirstAdoptionStoresEncodedConnectionAndHasNoCredentialToRetire() throws {
        let candidate = handoff("new", token: "new-fixture", generation: 1)
        var events: [String] = []
        var persisted: Data?
        try WatchHandoffAdoption.perform(
            candidate, replacing: nil,
            saveCredential: { _, _ in events.append("save") },
            activate: { persisted = $0; events.append("activate") },
            removeCredential: { _ in XCTFail("first pairing has no old credential") }
        )
        XCTAssertEqual(events, ["save", "activate"])
        XCTAssertEqual(try JSONDecoder().decode(Connection.self, from: XCTUnwrap(persisted)), candidate.connection)
    }
}
