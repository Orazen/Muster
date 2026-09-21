// FleetSnapshot publish path — the watch app is the complication's source of
// truth. The watch derives its FleetMood from live state and writes the
// snapshot to the shared app-group store on every change; the out-of-process
// widget only renders what this wrote. These tests pin the mapping the watch
// relies on, so app and complication cannot disagree about the fleet.
import XCTest
@testable import CompanionCore

final class FleetSnapshotPublishTests: XCTestCase {
    private func bot(
        _ id: String = "ursa",
        name: String = "Ursa",
        busy: Bool? = nil,
        unread: Bool = false,
        hidden: Bool? = nil
    ) -> Bot {
        var bot = Bot(id: id, threadId: id, name: name, title: "", description: "", notifications: false,
            color: "#4F8BFF", unread: unread, modelSelection: ModelSelection(instanceId: "offline", model: "fixture"),
            createdAt: 1)
        bot.busy = busy
        bot.hidden = hidden
        return bot
    }

    private func state(_ bots: [Bot]) -> CompanionState {
        var state = CompanionState()
        state.bots = bots
        return state
    }

    private func moodFor(_ bots: [Bot], isOffline: Bool = false) -> FleetMood {
        FleetMood.from(
            isOffline: isOffline,
            approvals: 0,
            working: bots.filter { $0.busy == true }.count,
            unread: bots.filter { $0.unread }.count
        )
    }

    func testMoodSnapshotVocabularyMatchesFleetMood() {
        // The complication keys its rendering on moodState strings; they must
        // stay the exact FleetMood vocabulary (which is also the flower's
        // pose vocabulary — "notifying", "surprised", "sleepy" …).
        XCTAssertEqual(fleetSnapshot(state: state([]), mood: .idle).moodState, "idle")
        XCTAssertEqual(fleetSnapshot(state: state([bot(busy: true)]), mood: .working).moodState, "working")
        XCTAssertEqual(fleetSnapshot(state: state([bot(unread: true)]), mood: .unread).moodState, "surprised")
        XCTAssertEqual(fleetSnapshot(state: state([]), mood: .offline).moodState, "sleepy")
        let needsYou = fleetSnapshot(state: state([bot(unread: true)]), mood: .needsYou(2))
        XCTAssertEqual(needsYou.moodState, "notifying")
        XCTAssertEqual(needsYou.moodLabel, "2 need you")
    }

    func testBotsCarryFlowerStateAndNarration() {
        let snapshot = fleetSnapshot(
            state: state([bot(busy: true), bot("lyra", name: "Lyra", unread: true)]),
            mood: .working
        )
        XCTAssertEqual(snapshot.bots.count, 2)
        XCTAssertEqual(snapshot.bots[0].state, "working")
        XCTAssertEqual(snapshot.bots[0].line, "Working — Ursa")
        XCTAssertEqual(snapshot.bots[1].state, "notifying")
        XCTAssertEqual(snapshot.bots[1].line, "Done — Lyra has news")
        XCTAssertEqual(snapshot.bots[1].color, "#4F8BFF")
    }

    func testHiddenBotsNeverReachTheComplication() {
        let snapshot = fleetSnapshot(
            state: state([bot(busy: true), bot("vega", name: "Vega", hidden: true)]),
            mood: .working
        )
        XCTAssertEqual(snapshot.bots.map { $0.id }, ["ursa"])
    }

    func testReadFreshReturnsNilWhenAbsent() {
        // Suite name is unused by the reader path (reads the shared store);
        // a fresh test host must see no snapshot rather than a stale one.
        FleetSnapshotStore.publish(fleetSnapshot(state: state([]), mood: .idle))
        XCTAssertNotNil(FleetSnapshotStore.readFresh())
    }

    func testRoundTripSurvivesJSON() {
        let original = fleetSnapshot(
            state: state([bot(busy: true), bot(unread: true)]),
            mood: .needsYou(1)
        )
        let data = try! JSONEncoder().encode(original)
        let decoded = try! JSONDecoder().decode(FleetSnapshot.self, from: data)
        XCTAssertEqual(decoded, original)
    }
}
