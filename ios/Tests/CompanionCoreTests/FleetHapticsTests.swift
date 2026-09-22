import XCTest
import CompanionCore

/// The haptic vocabulary is a decision, not a feeling: every rule the
/// watch's `WKInterfaceDevice` mapping depends on is asserted here.
final class FleetHapticsTests: XCTestCase {

    // MARK: - Baselines

    func testFirstObservationIsSilentAndRecordsBaseline() {
        var planner = FleetHapticPlanner()
        XCTAssertNil(planner.observe(approvals: 3, working: 2, replies: 40),
                     "the first frame is history — hydrate must never buzz")
        // And it is a baseline: the same frame again stays silent…
        XCTAssertNil(planner.observe(approvals: 3, working: 2, replies: 40))
        // …while a real delta from it is heard.
        XCTAssertEqual(planner.observe(approvals: 4, working: 2, replies: 40), .approvalArrived)
    }

    func testResetStartsFreshAndSilent() {
        var planner = FleetHapticPlanner()
        _ = planner.observe(approvals: 0, working: 0, replies: 0)
        _ = planner.observe(approvals: 1, working: 0, replies: 0)
        planner.reset()
        // A new pairing's wipe (approvals 1 → 0) must read as a new
        // baseline, not as "an approval was answered".
        XCTAssertNil(planner.observe(approvals: 0, working: 0, replies: 0))
        XCTAssertEqual(planner.observe(approvals: 0, working: 1, replies: 0), .startedWorking)
    }

    // MARK: - Each event, distinct

    func testApprovalArrival() {
        var planner = seeded()
        XCTAssertEqual(planner.observe(approvals: 2, working: 1, replies: 10), .approvalArrived)
        // A second one arriving is its own arrival.
        XCTAssertEqual(planner.observe(approvals: 3, working: 1, replies: 10), .approvalArrived)
        // An unchanged count is nothing.
        XCTAssertNil(planner.observe(approvals: 3, working: 1, replies: 10))
    }

    func testApprovalAnsweredIsDistinctFromArrived() {
        var planner = seeded(approvals: 2)
        let answered = planner.observe(approvals: 1, working: 1, replies: 10)
        XCTAssertEqual(answered, .approvalAnswered)
        XCTAssertNotEqual(answered, FleetHapticEvent.approvalArrived,
                          "the ask and its resolution must not feel the same")
        // Settling the rest is its own resolution, not silence.
        XCTAssertEqual(planner.observe(approvals: 0, working: 1, replies: 10), .approvalAnswered)
    }

    func testReplyArrivalIsDistinctFromApprovalArrival() {
        var planner = seeded(replies: 10)
        let reply = planner.observe(approvals: 1, working: 1, replies: 11)
        XCTAssertEqual(reply, .replyArrived)
        XCTAssertNotEqual(reply, FleetHapticEvent.approvalArrived)
        // A batch of replies caught up in one frame is one buzz.
        XCTAssertEqual(planner.observe(approvals: 1, working: 1, replies: 15), .replyArrived)
        // Trimmed or replayed history shrinking is not news.
        XCTAssertNil(planner.observe(approvals: 1, working: 1, replies: 12))
    }

    func testBotFinishedIsFleetLevel() {
        var planner = seeded(working: 2)
        // One of two bots finishing: still busy, not wrist news.
        XCTAssertNil(planner.observe(approvals: 1, working: 1, replies: 10))
        // The last one going quiet is.
        XCTAssertEqual(planner.observe(approvals: 1, working: 0, replies: 10), .settled)
    }

    func testStartedWorkingIsFleetLevel() {
        var planner = seeded(working: 0)
        XCTAssertEqual(planner.observe(approvals: 1, working: 1, replies: 10), .startedWorking)
        // A second bot joining a busy fleet is not news.
        XCTAssertNil(planner.observe(approvals: 1, working: 2, replies: 10))
    }

    // MARK: - Priority: one event per frame

    func testApprovalChangesOutrankEverything() {
        var arrivals = seeded(working: 1, replies: 10)
        XCTAssertEqual(arrivals.observe(approvals: 2, working: 1, replies: 12), .approvalArrived,
                       "an arrival must not be swallowed by a reply in the same frame")

        var resolutions = seeded(approvals: 2, working: 1, replies: 10)
        XCTAssertEqual(resolutions.observe(approvals: 1, working: 0, replies: 11), .approvalAnswered,
                       "the wearer just decided — their own action leads")
    }

    func testReplyOutranksWorkEdges() {
        // The common case: the reply *is* the bot finishing.
        var finishes = seeded(working: 1, replies: 10)
        XCTAssertEqual(finishes.observe(approvals: 1, working: 0, replies: 11), .replyArrived)

        var starts = seeded(working: 0, replies: 10)
        XCTAssertEqual(starts.observe(approvals: 1, working: 1, replies: 11), .replyArrived)
    }

    func testUnchangedFrameIsAlwaysSilent() {
        var planner = seeded()
        XCTAssertNil(planner.observe(approvals: 1, working: 1, replies: 10))
        XCTAssertNil(planner.observe(approvals: 1, working: 1, replies: 10))
    }

    // MARK: - Helpers

    private func seeded(
        approvals: Int = 1,
        working: Int = 1,
        replies: Int = 10
    ) -> FleetHapticPlanner {
        var planner = FleetHapticPlanner()
        _ = planner.observe(approvals: approvals, working: working, replies: replies)
        return planner
    }
}
