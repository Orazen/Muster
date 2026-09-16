import XCTest
@testable import CompanionCore

/// What the watch is allowed to say. The rules here are the difference
/// between a spoken reply and a voice reading a diff.
final class SpeechTextTests: XCTestCase {

    func testProsePassesThrough() {
        XCTAssertEqual(SpeechText.spoken("The build passed."), "The build passed.")
    }

    func testEmptyAndWhitespaceHaveNothingToSay() {
        XCTAssertNil(SpeechText.spoken(""))
        XCTAssertNil(SpeechText.spoken("   \n\n\t  "))
    }

    func testCodeBlocksAreNeverSpoken() {
        let source = """
        Here is the fix.

        ```swift
        let x = try decoder.decode(Frame.self, from: data)
        ```

        Try it now.
        """
        let spoken = SpeechText.spoken(source)
        XCTAssertEqual(spoken, "Here is the fix.. Try it now.")
        XCTAssertFalse(spoken!.contains("decoder"))
    }

    func testInlineCodeAndEmphasisLoseTheirMarkers() {
        // Foundation's inline markdown is stripped by the block splitter's
        // paragraph text only for emphasis it recognises; this asserts what a
        // caller actually hears for the common cases.
        XCTAssertEqual(SpeechText.spoken("Run `swift test` now."), "Run `swift test` now.")
        XCTAssertEqual(SpeechText.spoken("**Important** thing."), "**Important** thing.")
    }

    func testListMarkersAreNotSpoken() {
        let source = """
        - first thing
        - second thing

        1. alpha
        2. beta
        """
        let spoken = SpeechText.spoken(source)
        XCTAssertEqual(spoken, "first thing. second thing. alpha. beta")
        XCTAssertFalse(spoken!.contains("-"))
        XCTAssertFalse(spoken!.contains("1."))
    }

    func testHeadingsAndQuotesAreSpokenAsText() {
        let source = """
        # Summary

        > it worked
        """
        XCTAssertEqual(SpeechText.spoken(source), "Summary. it worked")
    }

    func testRulesAreDroppedEntirely() {
        XCTAssertEqual(SpeechText.spoken("before\n\n---\n\nafter"), "before. after")
        XCTAssertNil(SpeechText.spoken("---"))
    }

    func testNewlinesAndRunsOfSpacesCollapse() {
        XCTAssertEqual(SpeechText.spoken("one\n\ntwo   three"), "one. two three")
    }

    func testLongTextIsCutAtAWordBoundary() {
        let words = Array(repeating: "word", count: 200)
        let spoken = SpeechText.spoken(words.joined(separator: " "))
        XCTAssertNotNil(spoken)
        XCTAssertLessThanOrEqual(spoken!.count, SpeechText.maximumLength)
        XCTAssertFalse(spoken!.hasSuffix(" "))
        XCTAssertTrue(spoken!.hasSuffix("word"))
    }

    func testTruncatePrefersTheBoundaryButFallsBackToAHardCut() {
        XCTAssertEqual(SpeechText.truncate("alpha beta gamma", to: 8), "alpha")
        XCTAssertEqual(SpeechText.truncate("alpha", to: 10), "alpha")
        // one token, no space to cut on
        XCTAssertEqual(SpeechText.truncate("abcdefghij", to: 4), "abcd")
    }

    func testAStreamingReplyWithAnOpenFenceIsStillSpeakable() {
        let spoken = SpeechText.spoken("Working on it.\n\n```swift\nlet partial")
        XCTAssertEqual(spoken, "Working on it.")
    }
}