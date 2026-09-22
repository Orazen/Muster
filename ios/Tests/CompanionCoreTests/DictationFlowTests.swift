import XCTest
import CompanionCore

/// Whose words are these? Every rule in `DictationFlow` is a way real
/// dictation loses or duplicates sentences, asserted here so the mic only
/// has to move electrons.
final class DictationFlowTests: XCTestCase {

    // MARK: - Ownership of the draft

    func testBeginSnapshotsTheDraftAndHearsNothingYet() {
        var flow = DictationFlow()
        flow.begin(base: "finish the report")
        XCTAssertEqual(flow.phase, .listening)
        XCTAssertEqual(flow.draft, "finish the report",
                       "opening the mic must not change a single character")
        XCTAssertEqual(flow.finish(), "finish the report")
    }

    func testHeardWordsAppendAfterTypedWords() {
        var flow = DictationFlow()
        flow.begin(base: "finish the report")
        flow.hear("about the merger")
        XCTAssertEqual(flow.draft, "finish the report about the merger")
    }

    func testDictatingIntoAnEmptyDraftHasNoLeadingSpace() {
        var flow = DictationFlow()
        flow.begin(base: "")
        flow.hear("hello there")
        XCTAssertEqual(flow.draft, "hello there")
    }

    // MARK: - Replace, never accumulate

    func testEachResultReplacesTheSegmentInsteadOfAppending() {
        var flow = DictationFlow()
        flow.begin(base: "")
        flow.hear("hel")
        flow.hear("hello")
        flow.hear("hello world")
        XCTAssertEqual(flow.draft, "hello world",
                       "bestTranscription rewrites the capture; appending would read hello hello world")
    }

    func testAThirdResultNeverDuplicatesTheFirstTwo() {
        var flow = DictationFlow()
        flow.begin(base: "Subject:")
        flow.hear("the")
        flow.hear("the quarterly")
        flow.hear("the quarterly numbers")
        XCTAssertEqual(flow.draft, "Subject: the quarterly numbers")
    }

    // MARK: - The draft's own edge decides the join

    func testTrailingSpaceInTheDraftAbsorbsTheSeparator() {
        var flow = DictationFlow()
        flow.begin(base: "Subject: ")
        flow.hear("quarterly numbers")
        XCTAssertEqual(flow.draft, "Subject: quarterly numbers",
                       "a trailing space already separates — a second one is a double space to hunt down")
    }

    func testTrailingNewlineIsAlsoAlreadySeparated() {
        var flow = DictationFlow()
        flow.begin(base: "line one\n")
        flow.hear("line two")
        XCTAssertEqual(flow.draft, "line one\nline two")
    }

    func testWhitespaceOnlyResultLeavesTheDraftUntouched() {
        var flow = DictationFlow()
        flow.begin(base: "keep me")
        flow.hear("   \n")
        XCTAssertEqual(flow.draft, "keep me", "blank recognition must not become a dangling space")
        XCTAssertEqual(flow.finish(), "keep me")
    }

    // MARK: - Endings commit; words are never lost

    func testStopCommitsWhatWasHeard() {
        var flow = DictationFlow()
        flow.begin(base: "")
        flow.hear("don't lose this")
        XCTAssertEqual(flow.finish(), "don't lose this")
        XCTAssertEqual(flow.phase, .idle)
        // The commit is not a disappearance: the draft reads the same after.
        XCTAssertEqual(flow.draft, "don't lose this")
    }

    func testInterruptedCaptureCommitsToo() {
        // A dead microphone is still a person mid-sentence. The controller
        // ends the capture; finish() is the single commit path for every
        // ending, so there is no path that drops spoken words.
        var flow = DictationFlow()
        flow.begin(base: "draft:")
        flow.hear("half a sent")
        flow.finish()
        XCTAssertEqual(flow.phase, .idle)
        XCTAssertEqual(flow.draft, "draft: half a sent")
    }

    func testASecondCaptureAppendsAfterTheFirst() {
        var flow = DictationFlow()
        flow.begin(base: "")
        flow.hear("first thought")
        flow.finish()
        flow.begin(base: flow.draft)
        flow.hear("second thought")
        XCTAssertEqual(flow.draft, "first thought second thought")
    }

    // MARK: - Double-taps and late callbacks

    func testFinishingTwiceDoesNotAppendTheWordsTwice() {
        var flow = DictationFlow()
        flow.begin(base: "")
        flow.hear("say it once")
        XCTAssertEqual(flow.finish(), "say it once")
        XCTAssertEqual(flow.finish(), "say it once")
        XCTAssertEqual(flow.draft, "say it once")
    }

    func testALateResultAfterStopCannotRewriteTheDraft() {
        var flow = DictationFlow()
        flow.begin(base: "Subject:")
        flow.hear("this is final")
        XCTAssertEqual(flow.finish(), "Subject: this is final")
        // The recogniser's final callback lands after the stop.
        flow.hear("this is final, rewritten")
        XCTAssertEqual(flow.draft, "Subject: this is final",
                       "a stopped capture owns nothing — late results are ignored")
    }

    func testASecondBeginWhileListeningLeavesTheCaptureAlone() {
        var flow = DictationFlow()
        flow.begin(base: "")
        flow.hear("in flight")
        flow.begin(base: flow.draft) // double-tap racing the mic
        flow.hear("in flight still")
        XCTAssertEqual(flow.draft, "in flight still",
                       "re-snapshotting mid-capture would fold dictated words into the base")
    }

    // MARK: - Refusal

    func testRefusalShowsTheReasonAndLeavesTheDraftUntouched() {
        var flow = DictationFlow()
        flow.begin(base: "typed before the prompt")
        flow.finish()
        flow.refuse("Microphone access is off.")
        XCTAssertEqual(flow.refusal, "Microphone access is off.")
        XCTAssertEqual(flow.draft, "typed before the prompt",
                       "a refused attempt heard nothing, so it changes nothing")
    }

    func testRefusalMidCaptureWouldNotSwallowHeardWords() {
        var flow = DictationFlow()
        flow.begin(base: "")
        flow.hear("almost")
        // Refusal only applies outside a capture (the guard), so an in-
        // flight capture must still be finishable.
        flow.refuse("ignored mid-capture")
        XCTAssertEqual(flow.phase, .listening)
        XCTAssertEqual(flow.finish(), "almost")
    }

    func testHearingWhileIdleIsIgnoredEntirely() {
        var flow = DictationFlow()
        flow.hear("never began")
        XCTAssertEqual(flow.draft, "")
        XCTAssertEqual(flow.phase, .idle)
    }

    func testARefusedFlowCanBeRetried() {
        var flow = DictationFlow()
        flow.refuse("Microphone access is off.")
        flow.begin(base: "retry base")
        XCTAssertNil(flow.refusal, "a new attempt clears the old refusal")
        XCTAssertEqual(flow.phase, .listening)
        flow.hear("and it works")
        XCTAssertEqual(flow.draft, "retry base and it works")
    }
}
