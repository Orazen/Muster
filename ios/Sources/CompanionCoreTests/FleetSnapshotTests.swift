import Foundation
import XCTest
@testable import CompanionCore

final class FleetSnapshotTests: XCTestCase {
    private func bot(name: String, busy: Bool? = nil, unread: Bool = false, hidden: Bool? = nil) -> Bot {
        var bot = Bot(
            id: name, threadId: name, name: name, title: "", description: "",
            notifications: false, color: "orange", unread: unread,
            modelSelection: ModelSelection(), createdAt: 0
        )
        bot.busy = busy
        bot.hidden = hidden
        return bot
    }

    func testSnapshotMirrorsFleetFacts() throws {
        let state = CompanionState(bots: [
            bot(name: "A", busy: true),
            bot(name: "B", unread: true),
            bot(name: "C"),
            bot(name: "D", hidden: true),
        ])
        let snapshot = fleetSnapshot(state: state, mood: .working)
        XCTAssertEqual(snapshot.bots.count, 3, "hidden bots never reach external surfaces")
        let working = try XCTUnwrap(snapshot.bots.first { $0.name == "A" })
        XCTAssertEqual(working.state, "working")
        XCTAssertEqual(working.line, "Working — A")
        let unread = try XCTUnwrap(snapshot.bots.first { $0.name == "B" })
        XCTAssertEqual(unread.line, "Done — B has news")
        let idle = try XCTUnwrap(snapshot.bots.first { $0.name == "C" })
        XCTAssertEqual(idle.line, "", "idle bots carry no line — silence is honest")
    }

    func testStoreRoundTripCodable() throws {
        // Without the app-group entitlement (as in plain `swift test`) the
        // store no-ops; this exercises the Codable round-trip directly.
        let snapshot = FleetSnapshot(moodState: "working", moodLabel: "Working", bots: [])
        let data = try JSONEncoder().encode(snapshot)
        let decoded = try JSONDecoder().decode(FleetSnapshot.self, from: data)
        XCTAssertEqual(decoded, snapshot)
    }
}
