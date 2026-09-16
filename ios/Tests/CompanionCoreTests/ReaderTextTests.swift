// The reader's title rules.
//
// These are small functions, and that is the point: the choice between an
// inline title and a navigation title is the one layout decision the watch
// reader makes, and it should be answerable without a screen.
import XCTest
@testable import CompanionCore

final class ReaderTextTests: XCTestCase {

    func testShortBodyStaysInline() {
        XCTAssertFalse(ReaderText.isLongForm("Done — two checks passed."))
        XCTAssertTrue(ReaderText.isLongForm(String(repeating: "word ", count: 40)))
    }

    /// The threshold is a count of words, not characters: twenty long words
    /// is still a body that fits.
    func testThresholdCountsWordsNotCharacters() {
        let twenty = Array(repeating: "alpha", count: 20).joined(separator: " ")
        let twentyOne = twenty + " beta"
        XCTAssertFalse(ReaderText.isLongForm(twenty))
        XCTAssertTrue(ReaderText.isLongForm(twentyOne))
    }

    func testHeadingBecomesTheTitle() {
        XCTAssertEqual(ReaderText.title(for: "# Result\n\nAll green.", fallback: "Ops"), "Result")
        XCTAssertEqual(ReaderText.firstHeading(in: "## Deeper\n\ntext"), "Deeper")
    }

    /// A body with no heading is still a message from someone, and the
    /// thread's name is a better label than the word "Message".
    func testNoHeadingFallsBackToTheThreadName() {
        XCTAssertNil(ReaderText.firstHeading(in: "just prose, no structure"))
        XCTAssertEqual(ReaderText.title(for: "just prose", fallback: "Ops"), "Ops")
    }

    /// A heading inside a fence is code, not a title — the splitter already
    /// knows this, and the reader must not promote it.
    func testHeadingInsideAFenceIsNotATitle() {
        XCTAssertNil(ReaderText.firstHeading(in: "```\n# not a heading\n```"))
    }

    /// An empty heading is not a title either; promoting it would put
    /// nothing in the navigation bar.
    func testEmptyHeadingIsIgnored() {
        XCTAssertNil(ReaderText.firstHeading(in: "#\n\ntext"))
    }

    /// A partial reply mid-stream must not change the title on every delta.
    func testTitleIsStableAsABodyStreams() {
        let full = "# Result\n\nAll **two** checks passed."
        XCTAssertEqual(ReaderText.title(for: full, fallback: "Ops"), "Result")
        // Before the heading's newline arrives, it is still a heading.
        XCTAssertEqual(ReaderText.title(for: "# Result\n", fallback: "Ops"), "Result")
        // Before the space arrives, "# Result" is a hashtag, not a heading —
        // the reader shows the fallback rather than flickering to a title.
        XCTAssertEqual(ReaderText.title(for: "#Result", fallback: "Ops"), "Ops")
    }

    func testWordCountIgnoresRunsOfWhitespace() {
        XCTAssertEqual(ReaderText.wordCount("  one\ttwo\n\nthree  "), 3)
        XCTAssertEqual(ReaderText.wordCount(""), 0)
    }

    // MARK: - Preview

    func testPreviewFlattensStructure() {
        XCTAssertEqual(
            ReaderText.preview("# Title\n\n- one\n- two"),
            "Title one two"
        )
    }

    /// A snippet in the preview is its text, not its backticks — the bubble
    /// is prose, and the reader is where the fence comes back.
    func testPreviewDropsFenceMarkersButKeepsTheCode() {
        XCTAssertEqual(ReaderText.preview("```sh\npnpm test\n```"), "pnpm test")
    }

    func testShortPreviewIsReturnedWhole() {
        XCTAssertEqual(ReaderText.preview("All green.", limit: 140), "All green.")
    }

    /// Cutting mid-word reads as a typo; the preview ends on a boundary.
    func testLongPreviewCutsOnAWordBoundary() {
        let body = Array(repeating: "alpha", count: 60).joined(separator: " ")
        let preview = ReaderText.preview(body, limit: 20)
        XCTAssertTrue(preview.hasSuffix("…"))
        XCTAssertFalse(preview.contains("alph…"))
        XCTAssertEqual(preview, "alpha alpha alpha…")
    }

    /// No space to cut on is still a preview, not a crash.
    func testPreviewWithoutSpacesStillTerminates() {
        let preview = ReaderText.preview(String(repeating: "x", count: 400), limit: 20)
        XCTAssertTrue(preview.hasSuffix("…"))
        XCTAssertLessThan(preview.count, 25)
    }

    func testEmptyBodyHasAnEmptyPreview() {
        XCTAssertEqual(ReaderText.preview(""), "")
        XCTAssertEqual(ReaderText.preview("\n\n  \n"), "")
    }
}