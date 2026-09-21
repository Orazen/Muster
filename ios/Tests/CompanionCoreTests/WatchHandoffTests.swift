// WatchHandoffTests — the phone-to-watch pairing codec is a data contract
// between two binaries that upgrade independently; pin it.
import XCTest
@testable import CompanionCore

final class WatchHandoffTests: XCTestCase {
    private func handoff() -> CompanionHandoff {
        CompanionHandoff(
            connection: Connection(id: "conn-1", name: "Muster Box", host: "192.168.1.10", port: 8810, scheme: .http),
            token: "pair-token-abc123",
            sentAt: Date(timeIntervalSince1970: 1_790_000_000)
        )
    }

    func testRoundTripPreservesEverything() {
        let original = handoff()
        let data = CompanionHandoffCodec.encode(original)!
        let decoded = CompanionHandoffCodec.decode(from: data)
        XCTAssertEqual(decoded, original)
    }

    func testDecodeFromWCDictionary() {
        let data = CompanionHandoffCodec.encode(handoff())!
        let decoded = CompanionHandoffCodec.decode(from: [CompanionHandoffCodec.key: data])
        XCTAssertEqual(decoded, handoff())
    }

    func testMalformedDictionaryReadsAsNoHandoff() {
        XCTAssertNil(CompanionHandoffCodec.decode(from: [:]))
        XCTAssertNil(CompanionHandoffCodec.decode(from: [CompanionHandoffCodec.key: "not data"]))
        XCTAssertNil(CompanionHandoffCodec.decode(from: [CompanionHandoffCodec.key: Data("junk".utf8)]))
    }

    func testConnectionSurvivesAsUsableAddress() {
        let decoded = CompanionHandoffCodec.decode(from: CompanionHandoffCodec.encode(handoff())!)!
        XCTAssertFalse(decoded.connection.baseURL!.absoluteString.isEmpty)
        XCTAssertEqual(decoded.connection.name, "Muster Box")
    }
}
