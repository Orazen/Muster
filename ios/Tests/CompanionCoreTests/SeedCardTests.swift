import Foundation
import XCTest
@testable import CompanionCore

final class SeedCardTests: XCTestCase {
    private func wireCard(_ changes: [String: Any] = [:]) -> [String: Any] {
        var card: [String: Any] = ["title": SeedCardContract.title, "subtitle": SeedCardContract.subtitle,
            "options": SeedCardContract.options, "purpose": SeedCardContract.purpose]
        card.merge(changes) { _, new in new }; return card
    }
    private func wireMessage(card: [String: Any]? = nil, changes: [String: Any] = [:]) -> [String: Any] {
        var message: [String: Any] = ["id": "seed", "role": "bot", "kind": "options", "at": 2,
            "parentId": "greeting", "card": card ?? wireCard()]
        message.merge(changes) { _, new in new }; return message
    }
    private func decode<T: Decodable>(_ object: Any, as: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func seed() throws -> Message { try decode(wireMessage()) }
    private func greeting() -> Message {
        Message(id: "greeting", role: .bot, kind: .text, at: 1, text: "Hey — I'm Juno. Nice to meet you.")
    }
    private func state() throws -> CompanionState {
        var state = CompanionState()
        state.bots = [try decode(["id": "b", "threadId": "t", "name": "Juno", "title": "Helper",
            "description": "", "notifications": true, "color": "orange", "unread": false,
            "modelSelection": ["instanceId": "fake", "model": "fake"], "createdAt": 1, "activeLeafId": "seed"])]
        state.messages["t"] = [greeting(), try seed()]
        return state
    }
    private func result(_ status: SeedAnswerStatus = .starting, attempt: Int = 1, answer: String = "  Work\n ", parent: String = "seed") throws -> SeedCardResult {
        var card = try seed()
        card.card?.answered = answer
        card.card?.seedAnswer = .init(messageId: "echo", attempt: attempt, status: status)
        let echo = Message(id: "echo", role: .user, kind: .text, at: 3, text: answer, parentId: parent)
        return .init(outcome: "starting", cardMessage: card, userMessage: echo)
    }
    private func wireResult() -> [String: Any] {
        ["ok": true, "outcome": "starting", "cardMessage": wireMessage(card: wireCard([
            "answered": " Work ", "seedAnswer": ["messageId": "echo", "attempt": 1, "status": "starting"]])),
         "userMessage": ["id": "echo", "role": "user", "kind": "text", "at": 3, "text": " Work ", "parentId": "seed"]]
    }
    func testUTF16AnswerLimitPreservesGraphemesAndRawWhitespace() {
        XCTAssertTrue(SeedCardContract.isValidAnswer(String(repeating: "😀", count: 2000)))
        XCTAssertFalse(SeedCardContract.isValidAnswer(String(repeating: "😀", count: 2001)))
        XCTAssertTrue(SeedCardContract.isValidAnswer(" \n Work\t "))
        XCTAssertFalse(SeedCardContract.isValidAnswer(String(repeating: "a", count: 4001)))
    }
    func testECMAScriptWhitespaceIncludesBOMAndExcludesNEL() {
        for value: UInt32 in [9, 10, 11, 12, 13, 32, 0xA0, 0x1680, 0x2000, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF] {
            XCTAssertFalse(SeedCardContract.isValidAnswer(String(UnicodeScalar(value)!)), "\(value)")
        }
        XCTAssertFalse(SeedCardContract.isValidAnswer(""))
        XCTAssertTrue(SeedCardContract.isValidAnswer("\u{85}"))
        XCTAssertTrue(SeedCardContract.isValidAnswer("\u{200B}"))
    }
    func testExactTextDoesNotCanonicalizeUnicode() {
        XCTAssertEqual("é", "e\u{301}", "Swift equality alone would accept a different server answer")
        XCTAssertFalse(SeedCardContract.exactText("é", "e\u{301}"))
        XCTAssertTrue(SeedCardContract.exactText(" e\u{301}\n", " e\u{301}\n"))
    }
    func testReceiptStrictSchemaAndSafeIntegerBounds() throws {
        let valid: [String: Any] = ["messageId": "u", "attempt": SeedCardContract.maximumAttempt, "status": "started"]
        let receipt: SeedAnswerReceipt = try decode(valid)
        XCTAssertTrue(receipt.isValid)
        for changes: [String: Any] in [["attempt": -1], ["attempt": 1.5], ["attempt": SeedCardContract.maximumAttempt + 1],
            ["attempt": 0], ["messageId": ""], ["status": "future"], ["status": "recorded"], ["extra": true], ["error": NSNull()]] {
            var bad = valid; bad.merge(changes) { _, new in new }
            XCTAssertThrowsError(try decode(bad, as: SeedAnswerReceipt.self), "\(changes)")
        }
        XCTAssertNoThrow(try decode(["messageId": "u", "attempt": 0, "status": "recorded"], as: SeedAnswerReceipt.self))
    }
    func testMalformedCardMetadataIsRetainedButInert() throws {
        for changes: [String: Any] in [["purpose": NSNull()], ["purpose": 1], ["seedAnswer": NSNull()], ["seedAnswer": [:]],
            ["answered": 2], ["dismissed": NSNull()], ["requestId": NSNull()], ["tool": false], ["held": NSNull()], ["allowKey": 3]] {
            let message: Message = try decode(wireMessage(card: wireCard(changes)))
            XCTAssertEqual(message.card?.title, SeedCardContract.title)
            XCTAssertTrue(message.card?.seedInvalid == true, "\(changes)")
            XCTAssertFalse(SeedCardContract.isRecognized(message, in: [greeting(), message]))
        }
    }
    func testMalformedContextCannotBecomeLegacyProof() throws {
        var legacyCard = wireCard(); legacyCard.removeValue(forKey: "purpose")
        let legacy: Message = try decode(wireMessage(card: legacyCard))
        for changes: [String: Any] in [["role": "unknown"], ["role": 5], ["from": [:]], ["from": "wrong"], ["parentId": false]] {
            var raw: [String: Any] = ["id": "greeting", "role": "bot", "kind": "text", "at": 1, "text": greeting().text!]
            raw.merge(changes) { _, new in new }
            let greeting: Message = try decode(raw)
            XCTAssertTrue(greeting.seedContextInvalid)
            XCTAssertFalse(SeedCardContract.isRecognized(legacy, in: [greeting, legacy]))
        }
    }
    func testMalformedMessageFieldsAndNativeNullSender() throws {
        for changes: [String: Any] in [["parentId": 1], ["from": []], ["role": "future"], ["kind": "future"]] {
            let message: Message = try decode(wireMessage(changes: changes))
            XCTAssertTrue(message.seedContextInvalid)
            XCTAssertFalse(SeedCardContract.isRecognized(message, in: [greeting(), message]))
        }
        let message: Message = try decode(wireMessage(changes: ["from": NSNull()]))
        XCTAssertFalse(message.seedContextInvalid)
        XCTAssertTrue(SeedCardContract.isRecognized(message, in: [message]))
    }
    func testInvalidProvenanceSurvivesCodableRoundtrip() throws {
        let message: Message = try decode(wireMessage(card: wireCard(["requestId": NSNull()]), changes: ["role": "future"]))
        let roundtrip = try JSONDecoder().decode(Message.self, from: JSONEncoder().encode(message))
        XCTAssertTrue(roundtrip.seedContextInvalid)
        XCTAssertTrue(roundtrip.card?.seedInvalid == true)
        XCTAssertFalse(SeedCardContract.isRecognized(roundtrip, in: [greeting(), roundtrip]))
    }
    func testUnknownPurposeAndAlreadyAnsweredLegacyStayInert() throws {
        for changes: [String: Any] in [["purpose": "future"], ["answered": "Work"], ["dismissed": true], ["tool": "Bash"], ["held": "manual"], ["allowKey": "Bash:git"]] {
            let message: Message = try decode(wireMessage(card: wireCard(changes)))
            XCTAssertFalse(SeedCardContract.isRecognized(message, in: [greeting(), message]))
        }
    }
    func testMarkedSeedNeedsNoLegacyHistoryButCanonicalFields() throws {
        let marked = try seed()
        XCTAssertTrue(SeedCardContract.isRecognized(marked, in: [marked]))
        for changes: [String: Any] in [["title": "Future title"], ["subtitle": "Future subtitle"], ["options": ["Writing & research", "Work & projects"]]] {
            let message: Message = try decode(wireMessage(card: wireCard(changes)))
            XCTAssertFalse(SeedCardContract.isRecognized(message, in: [greeting(), message]))
        }
    }
    func testLegacyRequiresOriginalGreetingPositionAndParent() throws {
        var card = wireCard(); card.removeValue(forKey: "purpose")
        var legacy: Message = try decode(wireMessage(card: card))
        XCTAssertTrue(SeedCardContract.isRecognized(legacy, in: [greeting(), legacy]))
        XCTAssertFalse(SeedCardContract.isRecognized(legacy, in: [legacy]))
        XCTAssertFalse(SeedCardContract.isRecognized(legacy, in: [greeting(), greeting(), legacy]))
        legacy.parentId = "other"
        XCTAssertFalse(SeedCardContract.isRecognized(legacy, in: [greeting(), legacy]))
    }
    func testLegacyRejectsEmptyOrMultilineGreetingName() throws {
        var card = wireCard(); card.removeValue(forKey: "purpose")
        let legacy: Message = try decode(wireMessage(card: card))
        for name in ["", "Ju\nno", "Ju\u{2028}no"] {
            var hello = greeting(); hello.text = "Hey — I'm \(name). Nice to meet you."
            XCTAssertFalse(SeedCardContract.isRecognized(legacy, in: [hello, legacy]))
        }
    }
    func testWatchPendingPredicateIsNotBroadened() throws {
        var state = try state()
        XCTAssertTrue(state.pendingApprovals.isEmpty)
        var card = try seed(); card.card?.requestId = "request"; card.card?.tool = "Bash"
        state.messages["t"] = [card]
        XCTAssertEqual(state.pendingApprovals.map(\.message.id), ["seed"])
        XCTAssertTrue(card.card?.isPermission == true)
    }
    func testStrictResultDecodesSavedAndUnanswered() throws {
        let saved: SeedCardResult = try decode(wireResult())
        XCTAssertTrue(saved.isValid)
        XCTAssertEqual(saved.userMessage?.text, " Work ")
        let empty: SeedCardResult = try decode(["ok": true, "cardMessage": wireMessage(), "userMessage": NSNull()])
        XCTAssertNil(empty.userMessage)
    }
    func testStrictResultRejectsEnvelopeAndEchoMismatch() {
        for changes: [String: Any] in [["ok": false], ["outcome": "done"], ["outcome": NSNull()], ["userMessage": NSNull()],
            ["userMessage": ["id": "other", "role": "user", "kind": "text", "at": 3, "text": " Work "]]] {
            var raw = wireResult(); raw.merge(changes) { _, new in new }
            XCTAssertThrowsError(try decode(raw, as: SeedCardResult.self))
        }
        var missing = wireResult(); missing.removeValue(forKey: "userMessage")
        XCTAssertThrowsError(try decode(missing, as: SeedCardResult.self))
    }
    func testUnansweredResponseRejectsNullAnsweredAndOutcome() {
        for raw: [String: Any] in [
            ["ok": true, "cardMessage": wireMessage(card: wireCard(["answered": NSNull()])), "userMessage": NSNull()],
            ["ok": true, "outcome": "recorded", "cardMessage": wireMessage(), "userMessage": NSNull()]] {
            XCTAssertThrowsError(try decode(raw, as: SeedCardResult.self))
        }
    }
    func testStrictResultRejectsCanonicallyEquivalentDifferentAnswer() throws {
        var response = try result(answer: "é")
        response.userMessage?.text = "e\u{301}"
        XCTAssertFalse(response.isValid)
    }
    func testCurrentBotThreadHiddenRoomAndUnknownLeafFences() throws {
        var state = try state()
        XCTAssertNotNil(state.seedCard(botId: "b", threadId: "t", cardId: "seed"))
        XCTAssertNil(state.seedCard(botId: "wrong", threadId: "t", cardId: "seed"))
        XCTAssertNil(state.seedCard(botId: "b", threadId: "other", cardId: "seed"))
        state.bots[0].hidden = true
        XCTAssertNil(state.seedCard(botId: "b", threadId: "t", cardId: "seed"))
        state.bots[0].hidden = false; state.bots[0].activeLeafId = "missing"
        XCTAssertNil(state.seedCard(botId: "b", threadId: "t", cardId: "seed"))
        state.bots.removeAll()
        XCTAssertNil(state.seedCard(botId: "b", threadId: "t", cardId: "seed"))
    }
    func testSiblingBranchAndCycleCannotAuthorizeSeed() throws {
        var state = try state()
        state.messages["t"]?.append(Message(id: "sibling", role: .user, kind: .text, at: 3, text: "other", parentId: "greeting"))
        state.bots[0].activeLeafId = "sibling"
        XCTAssertNil(state.seedCard(botId: "b", threadId: "t", cardId: "seed"))
        state.bots[0].activeLeafId = "seed"; state.messages["t"]?[0].parentId = "seed"
        XCTAssertNil(state.seedCard(botId: "b", threadId: "t", cardId: "seed"))
    }
    func testWriteBlockerAllowsReadDuringBusyAndLaterWork() throws {
        var state = try state()
        XCTAssertNil(state.seedWriteBlocker(botId: "b", threadId: "t", cardId: "seed"))
        state.bots[0].busy = true
        XCTAssertNotNil(state.seedWriteBlocker(botId: "b", threadId: "t", cardId: "seed"))
        XCTAssertNotNil(state.seedCard(botId: "b", threadId: "t", cardId: "seed"))
        state.bots[0].busy = false
        state.apply(.message(threadId: "t", message: Message(id: "later", role: .user, kind: .text, at: 4, text: "new", parentId: "seed")))
        XCTAssertNotNil(state.seedWriteBlocker(botId: "b", threadId: "t", cardId: "seed"))
        XCTAssertNotNil(state.seedCard(botId: "b", threadId: "t", cardId: "seed"))
    }
    func testMergeInsertsOneExactUserAndPreservesOtherState() throws {
        var state = try state(); state.streaming["t"] = "live"; state.reasoning["t"] = "reason"; state.cursor = "stream:9"; state.hasMore["t"] = true
        let response = try result()
        XCTAssertEqual(state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: response), .accepted)
        XCTAssertEqual(state.messages["t"]?.count, 3)
        XCTAssertTrue(SeedCardContract.exactText(state.messages["t"]!.last!.text!, response.userMessage!.text!))
        XCTAssertEqual(state.bots[0].activeLeafId, "echo")
        XCTAssertEqual(state.streaming["t"], "live"); XCTAssertEqual(state.reasoning["t"], "reason")
        XCTAssertEqual(state.cursor, "stream:9"); XCTAssertEqual(state.hasMore["t"], true)
        XCTAssertEqual(state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: response), .accepted)
        XCTAssertEqual(state.messages["t"]?.count, 3)
    }
    func testInterveningBotParentIsValidButMissingEarlierAndSiblingParentsReject() throws {
        var state = try state()
        state.apply(.message(threadId: "t", message: Message(id: "activity", role: .bot, kind: .activity, at: 3, parentId: "seed")))
        XCTAssertEqual(state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result(parent: "activity")), .accepted)
        for parent in ["missing", "greeting", "other"] {
            var state = try self.state()
            XCTAssertEqual(state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result(parent: parent)), .rejected)
            XCTAssertNil(state.messages["t"]?[1].card?.seedAnswer)
            XCTAssertEqual(state.messages["t"]?.count, 2)
        }
    }
    func testCollidingEchoRejectsWithoutPublishingReceipt() throws {
        for changes: (inout Message) -> Void in [{ $0.text = "other" }, { $0.parentId = "greeting" }, { $0.role = .bot }, { $0.kind = .activity }] {
            var state = try state()
            var collision = try result().userMessage!; changes(&collision)
            state.messages["t"]?.append(collision)
            XCTAssertEqual(state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result()), .rejected)
            XCTAssertNil(state.messages["t"]?[1].card?.seedAnswer)
        }
    }
    func testReceiptMergePreservesNewerReplyLeafAndStream() throws {
        var state = try state()
        let response = try result()
        state.apply(.message(threadId: "t", message: response.userMessage!))
        state.apply(.message(threadId: "t", message: Message(id: "reply", role: .bot, kind: .text, at: 4, text: "reply", parentId: "echo")))
        state.streaming["t"] = "next reply"
        XCTAssertEqual(state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: response), .accepted)
        XCTAssertEqual(state.bots[0].activeLeafId, "reply")
        state.apply(.message(threadId: "t", message: response.userMessage!))
        XCTAssertEqual(state.bots[0].activeLeafId, "reply")
        XCTAssertEqual(state.streaming["t"], "next reply")
    }
    func testDuplicateSeedMessageDoesNotRewindLeaf() throws {
        var state = try state(); let response = try result()
        _ = state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: response)
        state.streaming["t"] = "stream"
        state.apply(.message(threadId: "t", message: try seed()))
        XCTAssertEqual(state.bots[0].activeLeafId, "echo")
        XCTAssertEqual(state.messages["t"]?[1].card?.seedAnswer?.status, .starting)
        XCTAssertEqual(state.streaming["t"], "stream")
    }
    func testSSEPatchAndSearchPageCannotRegressReceipt() throws {
        var state = try state()
        _ = state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result(.started, attempt: 2))
        for old in [try seed(), try result(.notStarted, attempt: 1).cardMessage, try result(.starting, attempt: 2).cardMessage,
                    try result(.uncertain, attempt: 2).cardMessage] {
            state.apply(.messagePatch(threadId: "t", message: old))
            state.merge(ThreadPage(messages: [old]), intoThread: "t")
            XCTAssertEqual(state.messages["t"]?.first(where: { $0.id == "seed" })?.card?.seedAnswer?.status, .started)
            XCTAssertEqual(state.messages["t"]?.first(where: { $0.id == "seed" })?.card?.seedAnswer?.attempt, 2)
        }
    }
    func testOlderValidResponseRetainsNewerReceiptWithoutLosingEcho() throws {
        var state = try state()
        _ = state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result(.started, attempt: 2))
        XCTAssertEqual(state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result(.notStarted, attempt: 1)), .accepted)
        XCTAssertEqual(state.messages["t"]?[1].card?.seedAnswer?.attempt, 2)
        XCTAssertEqual(state.messages["t"]?.count, 3)
    }
    func testKnownReceiptRejectsDifferentAnswerAndMalformedResult() throws {
        var state = try state()
        _ = state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result(answer: "é"))
        XCTAssertEqual(state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result(answer: "e\u{301}")), .rejected)
        var response = try result(answer: "é"); response.ok = false
        XCTAssertEqual(state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: response), .rejected)
    }
    func testReceiptLinkedUserBlocksGenericRetryUntilStarted() throws {
        for status in [SeedAnswerStatus.recorded, .starting, .notStarted, .uncertain, .started] {
            var state = try state()
            _ = state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result(status, attempt: status == .recorded ? 0 : 1))
            XCTAssertEqual(state.unresolvedSeedAnswerUser(threadId: "t", messageId: "echo"), status != .started)
            XCTAssertFalse(state.unresolvedSeedAnswerUser(threadId: "other", messageId: "echo"))
            XCTAssertFalse(state.unresolvedSeedAnswerUser(threadId: "t", messageId: "other"))
        }
    }
    func testRecordedEchoDoesNotCountAsNewerWorkButNextUserDoes() throws {
        var state = try state()
        _ = state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result(.recorded, attempt: 0))
        XCTAssertNil(state.seedWriteBlocker(botId: "b", threadId: "t", cardId: "seed"))
        state.apply(.message(threadId: "t", message: Message(id: "new", role: .user, kind: .text, at: 4, text: "new", parentId: "echo")))
        XCTAssertNotNil(state.seedWriteBlocker(botId: "b", threadId: "t", cardId: "seed"))
    }
    func testAbsentEchoUnderEarlierAncestorCannotSettleOffActiveBranch() throws {
        var state = try state()
        state.apply(.message(threadId: "t", message: Message(id: "later-bot", role: .bot, kind: .text, at: 3, text: "later", parentId: "seed")))
        XCTAssertEqual(state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result()), .rejected)
        XCTAssertNil(state.messages["t"]?[1].card?.seedAnswer)
        XCTAssertEqual(state.messages["t"]?.count, 3)
        XCTAssertEqual(state.bots[0].activeLeafId, "later-bot")
    }
    func testConflictingSameAttemptTerminalResponseCannotLookConfirmed() throws {
        var state = try state()
        _ = state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result(.started))
        XCTAssertEqual(state.mergeSeedAnswer(botId: "b", threadId: "t", cardId: "seed", result: try result(.uncertain)), .rejected)
        XCTAssertEqual(state.messages["t"]?[1].card?.seedAnswer?.status, .started)
        XCTAssertEqual(state.messages["t"]?.count, 3)
    }

}
