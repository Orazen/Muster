import XCTest
import CompanionCore

/// The crown-detent rule for the fleet roster (musterwatch plan §3.6 #4).
/// The invariant: entering a screen is silent, moving between rows clicks
/// once per row, and losing focus resets rather than replaying.
final class FleetFocusTests: XCTestCase {
    func testFirstFocusIsSilent() {
        var tracker = FocusDetentTracker()
        // The system focuses the top row the moment the list appears.
        XCTAssertFalse(tracker.focus(.mascot), "entering the roster must not buzz")
    }

    func testMovingToANewRowClicksExactlyOnce() {
        var tracker = FocusDetentTracker()
        _ = tracker.focus(.mascot)
        XCTAssertTrue(tracker.focus(.bot("mimi")), "crown reaching a new row is a detent")
        XCTAssertFalse(tracker.focus(.bot("mimi")), "staying on a row must not re-click")
    }

    func testBackAndForthClicksEachTransition() {
        var tracker = FocusDetentTracker()
        _ = tracker.focus(.mascot)
        XCTAssertTrue(tracker.focus(.bot("mimi")))
        XCTAssertTrue(tracker.focus(.mascot), "crown going back up is also a detent")
        XCTAssertTrue(tracker.focus(.bot("mimi")))
    }

    func testApprovalRowsCarryTheirIdentity() {
        var tracker = FocusDetentTracker()
        _ = tracker.focus(.approval(threadId: "t1", messageId: "m1"))
        XCTAssertTrue(tracker.focus(.approval(threadId: "t1", messageId: "m2")),
                      "a second approval in the same thread is its own row")
        XCTAssertFalse(tracker.focus(.approval(threadId: "t1", messageId: "m2")))
        XCTAssertTrue(tracker.focus(.approval(threadId: "t2", messageId: "m9")))
    }

    func testLosingFocusNeverClicksAndClears() {
        var tracker = FocusDetentTracker()
        _ = tracker.focus(.mascot)
        _ = tracker.focus(.bot("mimi"))
        XCTAssertFalse(tracker.focus(nil), "focus loss is not a detent")
        // Coming back starts silent again — the visit restarted.
        XCTAssertFalse(tracker.focus(.bot("mimi")),
                       "the first row of a new visit must be silent")
        XCTAssertTrue(tracker.focus(.room("daily")))
    }

    func testApprovalAnsweredOutFromUnderTheCrownIsSafe() {
        var tracker = FocusDetentTracker()
        _ = tracker.focus(.approval(threadId: "t1", messageId: "m1"))
        // The row disappears (answered elsewhere); SwiftUI clears focus.
        XCTAssertFalse(tracker.focus(nil))
        // Focus may land on whatever now occupies the position; that is the
        // first focus of a fresh visit and stays silent.
        XCTAssertFalse(tracker.focus(.bot("mimi")))
        XCTAssertTrue(tracker.focus(.settings))
    }

    func testResetForgetsTheRememberedRow() {
        var tracker = FocusDetentTracker()
        _ = tracker.focus(.mascot)
        _ = tracker.focus(.bot("mimi"))
        tracker.reset()
        XCTAssertFalse(tracker.focus(.bot("mimi")), "after reset the next focus is silent")
        XCTAssertTrue(tracker.focus(.settings))
    }

    func testFullCrownWalk() {
        var tracker = FocusDetentTracker()
        let walk: [FleetFocusRow?] = [
            .mascot,                                   // silent (appear)
            .approval(threadId: "t", messageId: "m"),  // click
            .bot("a"),                                 // click
            .bot("b"),                                 // click
            .bot("b"),                                 // no click (same row)
            .room("r"),                                // click
            .settings,                                 // click
        ]
        var clicks = 0
        for row in walk where tracker.focus(row) { clicks += 1 }
        XCTAssertEqual(clicks, 5, "five real moves between distinct rows")
    }
}
