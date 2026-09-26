// WatchHandoffClassificationTests — can a receiver tell the two messages apart?
//
// This is a separate file from the ordering tests on purpose. The ordering
// reducer answers "which of these should the watch believe"; it cannot catch a
// payload that was never correctly identified as a pairing in the first place.
//
// It is a real regression, caught after the generations change shipped: the
// tombstone carried only an OPTIONAL generation and no discriminator, so
// `decodeTombstone` succeeded for any JSON object at all — including a complete,
// valid pairing. The receiver asked "is this an unpair?" before trying to pair-
// decode, so every valid pairing answered yes and the watch signed itself out of
// a working computer. Four cases, two wrong.
//
// The fix is a required `kind` on both payloads, and ONE classification function
// so a caller cannot pair-decode a tombstone or unpair-decode a pairing. These
// cases exercise the real encode → Data → classify path, including the 1.20
// payloads that carry no discriminator at all.
import XCTest
@testable import CompanionCore

final class WatchHandoffClassificationTests: XCTestCase {
    private func connection(_ id: String = "conn-1") -> Connection {
        Connection(id: id, name: "Muster Box", host: "192.168.1.10", port: 8810, scheme: .http)
    }

    /// A current-format pairing, exactly as the phone encodes it.
    private var currentPairing: Data {
        CompanionHandoffCodec.encode(
            CompanionHandoff(connection: connection(), token: "pair-token-abc123", generation: 7)
        )!
    }

    /// A 1.20 pairing: no generation, no kind. Still has to be a PAIRING.
    private var legacyPairing: Data {
        CompanionHandoffCodec.encode(
            CompanionHandoff(connection: connection(), token: "pair-token-abc123")
        )!
    }

    /// A current-format tombstone.
    private var currentUnpair: Data {
        CompanionHandoffCodec.encode(CompanionHandoffTombstone(generation: 8))!
    }

    /// The 1.20 bare-string marker, the only compatibility case with no
    /// discriminator in it.
    private var legacyUnpair: Data { Data(CompanionHandoffCodec.unpairMarker.utf8) }

    // MARK: - The four cases the regression harness checked

    func testBothValidPairingFormatsArePairings() {
        for (name, data) in [("current", currentPairing), ("legacy", legacyPairing)] {
            XCTAssertFalse(CompanionHandoffCodec.isUnpair(data), "\(name) pairing misread as an unpair")
            guard case .pair(let handoff) = CompanionHandoffCodec.classify(data) else {
                return XCTFail("\(name) pairing did not classify as a pair")
            }
            XCTAssertEqual(handoff.token, "pair-token-abc123")
            XCTAssertEqual(handoff.connection.id, "conn-1")
        }
    }

    func testBothRealUnpairFormatsAreUnpairs() {
        for (name, data) in [("current", currentUnpair), ("legacy", legacyUnpair)] {
            XCTAssertTrue(CompanionHandoffCodec.isUnpair(data), "\(name) unpair not recognised")
            guard case .unpair(let tombstone) = CompanionHandoffCodec.classify(data) else {
                return XCTFail("\(name) unpair did not classify as an unpair")
            }
            if name == "current" {
                XCTAssertEqual(tombstone.generation, 8)
            } else {
                // The bare marker carries no ordering at all, and must not
                // pretend to.
                XCTAssertNil(tombstone.generation)
            }
        }
    }

    // MARK: - The decoders must not accept each other's payload

    func testTombstoneDecoderRejectsAPairingPayload() {
        XCTAssertNil(CompanionHandoffCodec.decodeTombstone(from: currentPairing))
        XCTAssertNil(CompanionHandoffCodec.decodeTombstone(from: legacyPairing))
    }

    func testPairingDecoderRejectsATombstonePayload() {
        XCTAssertNil(CompanionHandoffCodec.decode(from: currentUnpair))
    }

    func testEncodedPayloadsCarryAnExplicitKind() {
        let pair = CompanionHandoffCodec.decode(from: currentPairing)
        XCTAssertEqual(pair?.kind, .pair)
        let tombstone = CompanionHandoffCodec.decodeTombstone(from: currentUnpair)
        XCTAssertEqual(tombstone?.kind, .unpair)
        // And it is on the wire, not merely defaulted in memory.
        XCTAssertTrue(String(data: currentUnpair, encoding: .utf8)!.contains("unpair"))
        XCTAssertTrue(String(data: currentPairing, encoding: .utf8)!.contains("pair"))
    }

    func testTheKindFieldIsAuthoritativeInBothDirections() {
        // Hand-built, the way a future or buggy sender could produce it.

        // Claims "unpair" while carrying a full pairing body. The explicit
        // discriminator wins: a sender that says unpair is believed about being
        // an unpair, and the pairing fields are ignored. The pair decoder
        // refuses it, so there is no path where it is adopted as a pairing.
        let claimsUnpair = Data(#"{"kind":"unpair","connection":{"id":"c","name":"n","host":"h","port":1,"scheme":"http"},"token":"t","sentAt":0}"#.utf8)
        XCTAssertNil(CompanionHandoffCodec.decode(from: claimsUnpair))
        XCTAssertTrue(CompanionHandoffCodec.isUnpair(claimsUnpair))

        // Claims "pair" but is a bare tombstone shape. Nothing adopts it, and it
        // is not an unpair either: the pair decoder needs a real connection and
        // the tombstone decoder refuses a pair kind.
        let claimsPair = Data(#"{"kind":"pair","generation":3}"#.utf8)
        XCTAssertNil(CompanionHandoffCodec.decode(from: claimsPair))
        XCTAssertNil(CompanionHandoffCodec.decodeTombstone(from: claimsPair))
        XCTAssertNil(CompanionHandoffCodec.classify(claimsPair))
        XCTAssertFalse(CompanionHandoffCodec.isUnpair(claimsPair))
    }

    // MARK: - Noise must classify as nothing, not as something

    func testJunkAndEmptyClassifyAsNothing() {
        for data in [Data(), Data("not json".utf8), Data("{}".utf8), Data("[1,2,3]".utf8), Data("null".utf8)] {
            XCTAssertNil(CompanionHandoffCodec.classify(data))
            XCTAssertFalse(CompanionHandoffCodec.isUnpair(data))
        }
    }

    func testAnArbitraryJSONObjectIsNotAnUnpair() {
        // The exact shape that caused the regression: a well-formed object with
        // no relationship to this protocol at all.
        let unrelated = Data(#"{"hello":"world","count":3}"#.utf8)
        XCTAssertFalse(CompanionHandoffCodec.isUnpair(unrelated))
    }

    // MARK: - Dictionary routing, as the receiver sees it

    func testClassifiesOutOfAWCSessionDictionary() {
        let key = CompanionHandoffCodec.key
        guard case .pair(let pairing) = CompanionHandoffCodec.classify(dictionaryData([key: currentPairing])) else {
            return XCTFail("dictionary carrying a pairing must classify as a pair")
        }
        XCTAssertEqual(pairing.token, "pair-token-abc123")
        XCTAssertTrue(CompanionHandoffCodec.isUnpair(dictionaryData([key: currentUnpair])))
        XCTAssertTrue(CompanionHandoffCodec.isUnpair(dictionaryData([key: legacyUnpair])))
        XCTAssertFalse(CompanionHandoffCodec.isUnpair(dictionaryData([key: legacyPairing])))
    }

    private func dictionaryData(_ dictionary: [String: Any]) -> Data {
        // The receiver reads one key; extract it the same way.
        (dictionary[CompanionHandoffCodec.key] as? Data) ?? Data()
    }
}
