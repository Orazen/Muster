// The Walkie decisions, tested without a mouth: what the panel says the bot
// is doing, what it quotes, which reply gets spoken next, and what a reply
// sounds like once the markdown is taken out of it.
import XCTest
@testable import CompanionCore

final class WalkieTests: XCTestCase {
    // MARK: - Fixtures

    func bot(
        id: String = "b1",
        threadId: String = "t1",
        busy: Bool? = nil
    ) -> Bot {
        var bot = Bot(
            id: id,
            threadId: threadId,
            name: "Prodi",
            title: "General purpose",
            description: "",
            notifications: false,
            color: "red",
            unread: false,
            modelSelection: ModelSelection(instanceId: "i", model: "m"),
            createdAt: 1
        )
        bot.busy = busy
        return bot
    }

    func message(
        _ id: String,
        role: Message.Role,
        text: String? = nil,
        kind: Message.Kind = .text,
        card: OptionCard? = nil
    ) -> Message {
        var message = Message(id: id, role: role, kind: kind, at: 1)
        message.text = text
        message.card = card
        return message
    }

    func card(title: String, requestId: String?) -> OptionCard {
        var card = OptionCard(title: title, subtitle: "", options: ["Yes"])
        card.requestId = requestId
        return card
    }

    // MARK: - Status

    func testBusyBotIsWorking() {
        let state = CompanionState()
        XCTAssertEqual(Walkie.status(bot: bot(busy: true), state: state), .working)
    }

    func testPendingApprovalOutranksIdle() {
        var state = CompanionState()
        state.bots = [bot()]
        state.messages["t1"] = [message("m1", role: .bot, kind: .options, card: card(title: "Run this?", requestId: "r1"))]
        XCTAssertEqual(Walkie.status(bot: bot(), state: state), .waitingOnYou)
    }

    func testSettledCardIsNotWaiting() {
        var state = CompanionState()
        state.bots = [bot()]
        state.messages["t1"] = [message("m1", role: .bot, kind: .options, card: card(title: "Run this?", requestId: nil))]
        XCTAssertEqual(Walkie.status(bot: bot(), state: state), .ready)
    }

    func testStatusLines() {
        XCTAssertEqual(Walkie.statusLine(.working), "Working…")
        XCTAssertEqual(Walkie.statusLine(.waitingOnYou), "Waiting on you")
        XCTAssertEqual(Walkie.statusLine(.ready), "Ready")
    }

    // MARK: - Quote

    func testPartialTranscriptWinsEverything() {
        var state = CompanionState()
        state.bots = [bot()]
        state.streaming["t1"] = "streaming answer"
        state.messages["t1"] = [message("m1", role: .user, text: "Yo")]
        let quote = Walkie.quote(bot: bot(busy: true), state: state, partial: "  take two  ")
        XCTAssertEqual(quote, Walkie.Quote(text: "take two", live: true))
    }

    func testStreamingReplyBeatsSettledTranscript() {
        var state = CompanionState()
        state.bots = [bot()]
        state.streaming["t1"] = "half an answer"
        state.messages["t1"] = [message("m1", role: .bot, text: "old answer")]
        let quote = Walkie.quote(bot: bot(), state: state)
        XCTAssertEqual(quote, Walkie.Quote(text: "half an answer", live: true))
    }

    func testWhileWorkingTheQuoteIsYourLastWords() {
        var state = CompanionState()
        state.bots = [bot()]
        state.messages["t1"] = [
            message("m1", role: .bot, text: "an answer"),
            message("m2", role: .user, text: "Yo"),
        ]
        let quote = Walkie.quote(bot: bot(busy: true), state: state)
        XCTAssertEqual(quote, Walkie.Quote(text: "Yo", live: false))
    }

    func testWhenReadyTheQuoteIsItsLastAnswer() {
        var state = CompanionState()
        state.bots = [bot()]
        state.messages["t1"] = [
            message("m1", role: .user, text: "Yo"),
            message("m2", role: .bot, text: "Hey — what do you need?"),
        ]
        let quote = Walkie.quote(bot: bot(), state: state)
        XCTAssertEqual(quote, Walkie.Quote(text: "Hey — what do you need?", live: false))
    }

    func testWaitingQuotesTheCardTitle() {
        var state = CompanionState()
        state.bots = [bot()]
        state.messages["t1"] = [
            message("m1", role: .user, text: "delete the cache"),
            message("m2", role: .bot, kind: .options, card: card(title: "Run rm -rf?", requestId: "r1")),
        ]
        let quote = Walkie.quote(bot: bot(), state: state)
        XCTAssertEqual(quote, Walkie.Quote(text: "Run rm -rf?", live: false))
    }

    func testEmptyTranscriptQuotesNothing() {
        var state = CompanionState()
        XCTAssertNil(Walkie.quote(bot: bot(), state: state))
    }

    // MARK: - What gets spoken

    func testNothingIsSpokenWithoutNewMessages() {
        let transcript = [
            message("m1", role: .user, text: "Yo"),
            message("m2", role: .bot, text: "Hey"),
        ]
        XCTAssertNil(Walkie.nextSpeakable(in: transcript, after: "m2"))
    }

    func testNewBotTextIsSpokenPastUserChatter() {
        let transcript = [
            message("m1", role: .bot, text: "Hey"),
            message("m2", role: .user, text: "Yo"),
            message("m3", role: .user, text: "again"),
            message("m4", role: .bot, text: "Got it"),
        ]
        XCTAssertEqual(Walkie.nextSpeakable(in: transcript, after: "m1")?.id, "m4")
    }

    func testTheWalkStopsAtTheSeed() {
        // Opening the panel seeds lastSpokenId at the transcript's end; a
        // reply that never arrives must not resurrect an older one.
        let transcript = [
            message("m1", role: .bot, text: "old answer"),
            message("m2", role: .user, text: "new question"),
        ]
        XCTAssertNil(Walkie.nextSpeakable(in: transcript, after: "m1"))
    }

    func testActivityAndCardsAreNotSpokenWhole() {
        let transcript = [
            message("m1", role: .bot, text: "Hey"),
            message("m2", role: .bot, kind: .activity),
            message("m3", role: .bot, kind: .options, card: card(title: "Run?", requestId: "r")),
        ]
        // m3 is newer than the seed but not speakable text; the walk keeps
        // going back and stops at the seed without offering the card.
        XCTAssertNil(Walkie.nextSpeakable(in: transcript, after: "m1"))
    }

    func testBlankBotTextIsNotSpoken() {
        let transcript = [
            message("m1", role: .bot, text: "Hey"),
            message("m2", role: .bot, text: "   "),
        ]
        XCTAssertNil(Walkie.nextSpeakable(in: transcript, after: "m1"))
    }

    // MARK: - Markdown to words

    func testInlineMarkdownResolves() {
        let spoken = Walkie.spokenText("Check [the report](https://example.com) — it is **ready**.")
        XCTAssertEqual(spoken, "Check the report — it is ready.")
    }

    func testHeadingsAndListsLoseTheirMarkers() {
        let spoken = Walkie.spokenText("# Status\n- done\n- 2. still cooking")
        XCTAssertEqual(spoken, "Status done 2. still cooking")
    }

    func testFencedCodeIsDropped() {
        let spoken = Walkie.spokenText("Here you go:\n```json\n{\"a\": 1}\n```\nEnjoy.")
        XCTAssertEqual(spoken, "Here you go: Enjoy.")
    }

    func testTablesAreDropped() {
        let spoken = Walkie.spokenText("Summary:\n| bot | state |\n|---|---|\n| Prodi | ready |\nDone.")
        XCTAssertEqual(spoken, "Summary: Done.")
    }

    func testQuotesLoseTheirGt() {
        let spoken = Walkie.spokenText("> as you asked")
        XCTAssertEqual(spoken, "as you asked")
    }

    func testWhitespaceCollapses() {
        let spoken = Walkie.spokenText("line one\n\n\nline   two")
        XCTAssertEqual(spoken, "line one line two")
    }

    func testPlainSentencesSurvive() {
        let spoken = Walkie.spokenText("The deploy finished at 3pm.")
        XCTAssertEqual(spoken, "The deploy finished at 3pm.")
    }
}
