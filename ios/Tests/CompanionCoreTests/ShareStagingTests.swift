import XCTest
@testable import CompanionCore

/// The bundle format is the only thing crossing from another process into
/// this one, so these cases are about distrust: what the reader refuses, what
/// it bounds, and the one filename rule both sides have to agree on.
final class ShareStagingTests: XCTestCase {
    private let id = UUID(uuidString: "6F1B0A2E-1111-4222-8333-444455556666")!

    private func share(candidates: [Data], declaredText: Bool = true, declaredLink: Bool = false) -> StagedShare {
        StagedShare(id: id, declaredText: declaredText, declaredLink: declaredLink,
                    receivedAt: Date(timeIntervalSince1970: 1_700_000_000), candidates: candidates)
    }

    func testRoundTripPreservesEveryField() throws {
        let original = share(candidates: [Data("first".utf8), Data([0xC3, 0xA9])])
        let data = try XCTUnwrap(ShareStaging.encode(original))
        let decoded = try XCTUnwrap(ShareStaging.decode(data))
        XCTAssertEqual(decoded, original)
        // The multi-byte candidate must survive as bytes, not as a re-decoded
        // string that happens to look the same.
        XCTAssertEqual(decoded.candidates[1], Data([0xC3, 0xA9]))
    }

    func testAnEmptyCandidateListRoundTrips() throws {
        let decoded = try XCTUnwrap(ShareStaging.decode(try XCTUnwrap(ShareStaging.encode(share(candidates: [])))))
        XCTAssertTrue(decoded.candidates.isEmpty)
    }

    func testTheDirectoryNameIsAPlainRelativeName() {
        // This is appended to the app-group container, so anything that could
        // escape it — or that the other process might spell differently — is a
        // bug waiting to happen.
        XCTAssertEqual(ShareStaging.directoryName, "ShareInbox")
        XCTAssertFalse(ShareStaging.directoryName.contains("/"))
        XCTAssertFalse(ShareStaging.directoryName.contains(".."))
    }

    func testFilenameIsTheOnlyNameTheReaderAccepts() {        XCTAssertEqual(ShareStaging.filename(for: id), "muster-share-6F1B0A2E-1111-4222-8333-444455556666.json")
        XCTAssertEqual(ShareStaging.stagedId(inFilename: ShareStaging.filename(for: id)), id)
        // Anything else in the shared container is not ours to open.
        for name in ["", "notes.json", "muster-share-.json", "muster-share-6f1b0a2e-1111-4222-8333-444455556666.json",
                     "muster-share-6F1B0A2E-1111-4222-8333-444455556666.txt",
                     "muster-share-6F1B0A2E-1111-4222-8333-444455556666.json.bak",
                     "prefixmuster-share-6F1B0A2E-1111-4222-8333-444455556666.json",
                     "../../etc/passwd", "muster-share-not-a-uuid.json"] {
            XCTAssertNil(ShareStaging.stagedId(inFilename: name), "should refuse \(name)")
        }
    }

    func testAMalformedBundleIsDroppedRatherThanPartlyBelieved() {
        XCTAssertNil(ShareStaging.decode(Data()))
        XCTAssertNil(ShareStaging.decode(Data("not json".utf8)))
        XCTAssertNil(ShareStaging.decode(Data("{}".utf8)))
        // A truncated but well-formed prefix must not decode.
        let full = ShareStaging.encode(share(candidates: [Data("hello".utf8)])) ?? Data()
        XCTAssertNil(ShareStaging.decode(full.prefix(full.count / 2)))
    }

    func testAMissingFieldIsDropped() {
        // Every field is required. A bundle that omits `declaredText` is not
        // "text by default" — it is a bundle this reader does not understand.
        let body = #"{"id":"6F1B0A2E-1111-4222-8333-444455556666","declaredLink":false,"receivedAt":0,"candidates":[]}"#
        XCTAssertNil(ShareStaging.decode(Data(body.utf8)))
    }

    func testAnUndecodableCandidateDropsTheWholeBundle() {
        let body = """
        {"id":"6F1B0A2E-1111-4222-8333-444455556666","declaredText":true,"declaredLink":false,\
        "receivedAt":0,"candidates":["!!!not base64!!!"]}
        """
        // Half a bundle is not a share. Dropping it entirely is safer than
        // staging the subset that happened to parse.
        XCTAssertNil(ShareStaging.decode(Data(body.utf8)))
    }

    func testOversizeBundleIsRefusedBeforeAnythingIsAllocatedForIt() throws {
        let data = try XCTUnwrap(ShareStaging.encode(share(candidates: [Data(String(repeating: "a", count: 64).utf8)])))
        XCTAssertNil(ShareStaging.decode(data, maximumBytes: data.count - 1))
        // And the same bundle at exactly the limit is fine.
        XCTAssertNotNil(ShareStaging.decode(data, maximumBytes: data.count))
    }

    func testTooManyCandidatesAreRefusedOnBothSides() {
        let many = share(candidates: Array(repeating: Data("x".utf8), count: ShareStaging.maximumCandidates + 1))
        // The writer refuses to produce it...
        XCTAssertNil(ShareStaging.encode(many))
        // ...and the reader refuses to believe one, however it arrived.
        let body = """
        {"id":"6F1B0A2E-1111-4222-8333-444455556666","declaredText":true,"declaredLink":false,\
        "receivedAt":0,"candidates":\(Array(repeating: "\"eA==\"", count: ShareStaging.maximumCandidates + 1).joined(separator: ","))}
        """
        XCTAssertNil(ShareStaging.decode(Data(body.utf8)))
    }

    func testPayloadProjectsTheDeclaredFlagsAndBytes() {
        let payload = ShareStaging.payload(share(candidates: [Data("note".utf8)], declaredText: false, declaredLink: true))
        XCTAssertFalse(payload.declaredText)
        XCTAssertTrue(payload.declaredLink)
        XCTAssertEqual(payload.candidates, [Data("note".utf8)])
    }

    func testTheReaderRejectsABundleWhoseIdDisagreesWithItsFilename() throws {
        // The app decides which files to open by name, but the id inside the
        // bundle is what fences a re-read. If the two disagree, either the
        // file is not the one it claims to be or the writer has a bug, and
        // staging it under the inner id would stage words this reader cannot
        // account for. The comparison the app makes is spelled out here so
        // the two processes cannot drift apart.
        let other = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
        let data = try XCTUnwrap(ShareStaging.encode(share(candidates: [Data("note".utf8)])))
        let decoded = try XCTUnwrap(ShareStaging.decode(data))
        XCTAssertEqual(decoded.id, id)

        let mismatchedName = ShareStaging.filename(for: other)
        XCTAssertNotEqual(ShareStaging.stagedId(inFilename: mismatchedName), decoded.id)
        XCTAssertNotNil(ShareStaging.decode(data), "the bytes still decode; only the pairing is wrong")
    }

    func testAStagedBundleIdIsWhatFencesAReRead() throws {
        // The id travels in the filename, and the same id must reach
        // ShareIntake or the anti-replay fence has nothing to compare.
        let data = try XCTUnwrap(ShareStaging.encode(share(candidates: [Data("note".utf8)])))
        let decoded = try XCTUnwrap(ShareStaging.decode(data))
        XCTAssertEqual(ShareStaging.stagedId(inFilename: ShareStaging.filename(for: decoded.id)), decoded.id)
    }
}
