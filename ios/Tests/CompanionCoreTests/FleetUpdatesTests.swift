import XCTest
@testable import CompanionCore

/// The pill's whole job is classification: which chats are worth a
/// headline, and which of the three kinds they are. Both the pill and the
/// sheet read this one list, so the rules are asserted here rather than
/// left to the order rows happen to appear in a view.
final class FleetUpdatesTests: XCTestCase {

    // MARK: - Fixtures

    private func bot(
        _ id: String, threadId: String? = nil,
        busy: Bool? = nil, unread: Bool = false, hidden: Bool? = nil
    ) -> Bot {
        Bot(
            id: id, threadId: threadId ?? "\(id)-thread", name: id.capitalized, title: "", description: "",
            notifications: false, color: "orange", unread: unread,
            modelSelection: ModelSelection(instanceId: "offline", model: "fixture"),
            createdAt: 1, busy: busy, hidden: hidden
        )
    }

    private func room(_ id: String, unread: Bool = false, busyBotId: String? = nil) -> Room {
        Room(
            id: id, threadId: "\(id)-thread", name: id.capitalized, memberIds: [],
            defaultResponder: GroupResponder(kind: "none"), bulletin: "", unread: unread, createdAt: 1,
            busyBotId: busyBotId
        )
    }

    private func text(_ id: String, _ body: String, at: Double) -> Message {
        var message = Message(id: id, role: .bot, kind: .text, at: at)
        message.text = body
        return message
    }

    private func pendingCard(_ id: String, subtitle: String, at: Double) -> Message {
        var message = Message(id: id, role: .bot, kind: .options, at: at)
        message.card = OptionCard(
            title: "Approval needed", subtitle: subtitle, options: ["Allow", "Deny"],
            requestId: "req-\(id)", tool: "Bash"
        )
        return message
    }

    // MARK: - Nothing happening

    func testAnIdleReadFleetHasNoUpdates() {
        var state = CompanionState()
        state.bots = [bot("a"), bot("b")]
        state.rooms = [room("r")]
        XCTAssertTrue(state.updates.isEmpty)
    }

    // MARK: - Needs you

    func testAPendingCardIsNeedsYouCarryingItsQuestion() {
        var state = CompanionState()
        state.bots = [bot("a")]
        state.messages["a-thread"] = [pendingCard("m1", subtitle: "rm -rf ./build", at: 10)]

        let updates = state.updates
        XCTAssertEqual(updates.count, 1)
        XCTAssertEqual(updates[0].kind, .needsYou)
        XCTAssertEqual(updates[0].threadId, "a-thread")
        XCTAssertEqual(updates[0].line, "rm -rf ./build")
        XCTAssertEqual(updates[0].card?.requestId, "req-m1")
    }

    func testAnEmptySubtitleFallsBackToTheCardTitle() {
        var state = CompanionState()
        state.bots = [bot("a")]
        var message = Message(id: "m1", role: .bot, kind: .options, at: 10)
        message.card = OptionCard(
            title: "Which branch?", subtitle: "", options: ["main"], requestId: "req-1"
        )
        state.messages["a-thread"] = [message]

        XCTAssertEqual(state.updates.first?.line, "Which branch?")
    }

    func testAnAnsweredCardIsNotAnUpdate() {
        var state = CompanionState()
        state.bots = [bot("a", unread: true)]
        var message = Message(id: "m1", role: .bot, kind: .options, at: 10)
        message.card = OptionCard(
            title: "Approval needed", subtitle: "rm -rf ./build", options: ["Allow", "Deny"],
            answered: "Allow", requestId: "req-1", tool: "Bash"
        )
        state.messages["a-thread"] = [text("m0", "Done.", at: 11), message]

        // The card settled; what remains is the unread reply to review.
        XCTAssertEqual(state.updates.map(\.kind), [.toReview])
    }

    // MARK: - Working

    func testABusyBotIsWorkingWithTheTailOfItsStreamingReply() {
        var state = CompanionState()
        state.bots = [bot("a", busy: true)]
        state.streaming["a-thread"] = "Rewriting the parser\nin one pass"

        let updates = state.updates
        XCTAssertEqual(updates.map(\.kind), [.working])
        // One line under the name: the newline becomes a space, so it
        // cannot break the row into two.
        XCTAssertEqual(updates[0].line, "Rewriting the parser in one pass")
        XCTAssertFalse(updates[0].line.contains("\n"))
    }

    func testABusyBotWithNoStreamFallsBackToItsLastToolThenWorking() {
        var state = CompanionState()
        state.bots = [bot("a", busy: true), bot("b", busy: true)]
        var chip = Message(id: "m1", role: .bot, kind: .activity, at: 10)
        chip.tool = ToolActivity(name: "swift test", ok: nil)
        state.messages["a-thread"] = [chip]

        let lines = Dictionary(uniqueKeysWithValues: state.updates.map { ($0.threadId, $0.line) })
        XCTAssertEqual(lines["a-thread"], "swift test")
        XCTAssertEqual(lines["b-thread"], "Working…")
    }

    func testARoomWithABusyMemberIsWorking() {
        var state = CompanionState()
        state.rooms = [room("r", busyBotId: "a")]
        XCTAssertEqual(state.updates.map(\.kind), [.working])
    }

    // MARK: - To review

    func testAnUnreadBotIsToReviewWithItsLastMessage() {
        var state = CompanionState()
        state.bots = [bot("a", unread: true)]
        state.messages["a-thread"] = [text("m1", "The build is green.", at: 10)]

        let updates = state.updates
        XCTAssertEqual(updates.map(\.kind), [.toReview])
        XCTAssertEqual(updates[0].line, "The build is green.")
    }

    func testAnUnreadRoomIsToReview() {
        var state = CompanionState()
        state.rooms = [room("r", unread: true)]
        XCTAssertEqual(state.updates.map(\.kind), [.toReview])
    }

    func testAReadIdleBotNeverAppears() {
        var state = CompanionState()
        state.bots = [bot("a", busy: false, unread: false)]
        state.messages["a-thread"] = [text("m1", "Old news, already read.", at: 10)]
        XCTAssertTrue(state.updates.isEmpty)
    }

    // MARK: - One entry per chat, and the order of the kinds

    func testAPendingCardOutranksTheSameChatsOtherStates() {
        var state = CompanionState()
        // Busy, unread, *and* stopped for an answer: one headline, and it
        // has to be the one only a person can settle.
        state.bots = [bot("a", busy: true, unread: true)]
        state.messages["a-thread"] = [
            text("m0", "Working on it", at: 9),
            pendingCard("m1", subtitle: "Allow this?", at: 10),
        ]

        let updates = state.updates
        XCTAssertEqual(updates.count, 1)
        XCTAssertEqual(updates[0].kind, .needsYou)
    }

    func testKindsSortNeedsYouThenWorkingThenToReview() {
        var state = CompanionState()
        state.bots = [bot("review", unread: true), bot("work", busy: true), bot("ask")]
        state.rooms = [room("room", unread: true)]
        state.messages["ask-thread"] = [pendingCard("m1", subtitle: "Allow?", at: 10)]

        XCTAssertEqual(state.updates.map(\.kind), [.needsYou, .working, .toReview, .toReview])
    }

    func testNewestApprovalStaysFirstAmongNeedsYou() {
        var state = CompanionState()
        state.bots = [bot("older"), bot("newer")]
        state.messages["older-thread"] = [pendingCard("m1", subtitle: "First ask", at: 10)]
        state.messages["newer-thread"] = [pendingCard("m2", subtitle: "Second ask", at: 20)]

        let needsYou = state.updates.filter { $0.kind == .needsYou }
        XCTAssertEqual(needsYou.map(\.line), ["Second ask", "First ask"])
    }

    func testAHiddenBotIsNotAnUpdateUnlessItStoppedForYou() {
        var state = CompanionState()
        state.bots = [bot("hidden", busy: true, unread: true, hidden: true)]

        // Off the roster entirely: busy and unread say nothing worth a
        // headline on a chat the person put away…
        XCTAssertTrue(state.updates.isEmpty)

        // …but a card only they can answer still does.
        state.messages["hidden-thread"] = [pendingCard("m1", subtitle: "Allow?", at: 10)]
        XCTAssertEqual(state.updates.map(\.kind), [.needsYou])
    }
}
