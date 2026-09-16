import XCTest
@testable import CompanionCore

/// The one face the watch shows. Precedence is the whole point, so it is
/// asserted rather than left to the order of rows in a view.
final class FleetMoodTests: XCTestCase {

    func testOfflineOutranksEverythingIncludingApprovals() {
        let mood = FleetMood.from(isOffline: true, approvals: 5, working: 3, unread: 2)
        XCTAssertEqual(mood, .offline)
    }

    func testApprovalsOutrankWorkAndUnread() {
        XCTAssertEqual(FleetMood.from(isOffline: false, approvals: 1, working: 3, unread: 2), .needsYou(1))
    }

    func testWorkOutranksUnread() {
        XCTAssertEqual(FleetMood.from(isOffline: false, approvals: 0, working: 2, unread: 4), .working)
    }

    func testUnreadShowsWhenNothingIsRunningOrWaiting() {
        XCTAssertEqual(FleetMood.from(isOffline: false, approvals: 0, working: 0, unread: 3), .unread)
    }

    func testNothingHappeningIsIdle() {
        XCTAssertEqual(FleetMood.from(isOffline: false, approvals: 0, working: 0, unread: 0), .idle)
    }

    func testNegativeCountsDoNotReadAsWaiting() {
        XCTAssertEqual(FleetMood.from(isOffline: false, approvals: -1, working: -1, unread: -1), .idle)
    }

    func testEveryMoodNamesAStateTheFlowerKnows() {
        let moods: [FleetMood] = [.needsYou(1), .working, .unread, .idle, .offline]
        for mood in moods {
            XCTAssertFalse(mood.state.isEmpty)
            XCTAssertFalse(mood.label.isEmpty)
            XCTAssertFalse(mood.spoken.isEmpty)
        }
    }

    func testSingularAndPluralReadCorrectly() {
        XCTAssertEqual(FleetMood.needsYou(1).label, "1 needs you")
        XCTAssertEqual(FleetMood.needsYou(2).label, "2 need you")
        XCTAssertEqual(FleetMood.needsYou(1).spoken, "One bot needs your approval")
        XCTAssertEqual(FleetMood.needsYou(3).spoken, "3 bots need your approval")
    }
}