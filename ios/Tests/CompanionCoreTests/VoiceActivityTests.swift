import XCTest
@testable import CompanionCore

final class VoiceActivityTests: XCTestCase {
    func testSourceIsPreparedBySpeechText() {
        // The contract `SpeechText` actually holds: fenced code is dropped and
        // whitespace is collapsed. Inline emphasis is left alone — stripping
        // it is `Walkie.spokenText`'s extra step on the phone, and this type
        // deliberately does not change what the watch's voice reads.
        let activity = VoiceActivity(scope: .fleet, source: "Two   bots\nneed you.")
        XCTAssertEqual(activity?.text, "Two bots need you.")
    }

    func testCodeOnlySourceHasNothingToSay() {
        XCTAssertNil(VoiceActivity(scope: .fleet, source: "```\nlet x = 1\n```"))
        XCTAssertNil(VoiceActivity(scope: .fleet, source: "   \n  "))
    }

    func testPreparedTrimsAndRejectsEmpty() {
        XCTAssertEqual(VoiceActivity.prepared(scope: .fleet, text: "  hello  ")?.text, "hello")
        XCTAssertNil(VoiceActivity.prepared(scope: .fleet, text: "\n\t "))
    }

    func testThreadScopeMatchesOnlyItsOwnThread() {
        let activity = VoiceActivity(scope: .thread("t1"), text: "done")
        XCTAssertTrue(activity.isSpeaking(threadId: "t1"))
        XCTAssertFalse(activity.isSpeaking(threadId: "t2"))
        XCTAssertFalse(activity.isFleetSpeech)
    }

    func testFleetSpeechBelongsToNoThread() {
        let activity = VoiceActivity(scope: .fleet, text: "Everything is up to date")
        XCTAssertTrue(activity.isFleetSpeech)
        XCTAssertFalse(activity.isSpeaking(threadId: "t1"))
    }

    func testScopeIsHashableSoTwoThreadsStayApart() {
        XCTAssertEqual(VoiceScope.thread("a"), VoiceScope.thread("a"))
        XCTAssertNotEqual(VoiceScope.thread("a"), VoiceScope.thread("b"))
        XCTAssertNotEqual(VoiceScope.fleet, VoiceScope.thread("a"))
    }
}