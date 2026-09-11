import XCTest
@testable import CompanionCore

enum ApprovalFixtures {
    static let sessionId = UUID()
    static var context: ComposerContext { .init(sessionId: sessionId, target: .init(kind: .bot, ownerId: "owner", threadId: "thread")) }
    static func message(requestId: String = "provider:request/1", tool: String? = "Bash",
                        options: [String] = ["Allow", "Deny", "Always allow"]) -> Message {
        Message(id: "card", role: .bot, kind: .options, at: 1,
            card: OptionCard(title: "Bash", subtitle: "Exact command", options: options, requestId: requestId,
                tool: tool, allowKey: tool == nil ? nil : "Bash:fixture"))
    }
    static func state(message: Message = message()) -> CompanionState {
        var state = CompanionState()
        state.bots = [Bot(id: "owner", threadId: "thread", name: "Orbit", title: "", description: "", notifications: false,
            color: "orange", unread: false, modelSelection: ModelSelection(instanceId: "offline", model: "fixture"), createdAt: 1,
            activeLeafId: message.id)]
        state.messages["thread"] = [message]
        return state
    }
    static func reference(_ message: Message = message(), context: ComposerContext = context) -> ApprovalReference {
        ApprovalContract.reference(for: context, message: message, in: state(message: message))!
    }
    static func receipt(_ reference: ApprovalReference) -> ApprovalGrantReceipt {
        .init(botId: reference.context.target.ownerId, threadId: reference.context.target.threadId,
            requestId: reference.requestId, cardId: reference.cardId, allowKey: reference.allowKey!)
    }
    static func grantBody(_ reference: ApprovalReference) -> [String: Any] {
        ["bot": ["id": reference.context.target.ownerId, "threadId": reference.context.target.threadId,
                  "alwaysAllow": [reference.allowKey!]],
         "grant": ["threadId": reference.context.target.threadId, "requestId": reference.requestId,
                    "cardId": reference.cardId, "allowKey": reference.allowKey!]]
    }
}

final class ApprovalContractTests: XCTestCase {
    func testPermissionLiteralActionsAndDedicatedAlwaysAllow() throws {
        let reference = ApprovalFixtures.reference(ApprovalFixtures.message(options: ["ALLOW", "deny", "Always allow", "Yes", "Allow once"]))
        XCTAssertEqual(ApprovalContract.action(for: "ALLOW", reference: reference), .allow)
        XCTAssertEqual(ApprovalContract.action(for: "deny", reference: reference), .deny)
        XCTAssertEqual(ApprovalContract.action(for: "Always allow", reference: reference), .alwaysAllow)
        XCTAssertNil(ApprovalContract.action(for: "Yes", reference: reference))
        XCTAssertNil(ApprovalContract.action(for: "Allow once", reference: reference))
        XCTAssertNil(ApprovalContract.action(for: "Allow", reference: reference), "Choice must be actually offered")
        XCTAssertTrue(ApprovalContract.canAlwaysAllow(reference))
    }

    func testQuestionLabelsNeverBecomePermissionBehaviors() {
        let message = ApprovalFixtures.message(tool: nil, options: ["Allow", "Deny", "Always allow", "  e\u{301}\n "])
        let reference = ApprovalFixtures.reference(message)
        for option in message.card!.options {
            XCTAssertEqual(ApprovalContract.action(for: option, reference: reference), .answer(option))
        }
        XCTAssertFalse(ApprovalContract.canAlwaysAllow(reference))
        XCTAssertFalse(ApprovalContract.allows(.allow, reference: reference))
        XCTAssertFalse(ApprovalContract.allows(.answer("  é\n "), reference: reference))
        XCTAssertNotEqual(ApprovalAction.answer("é"), .answer("e\u{301}"))
    }

    func testAlwaysAllowRequiresExplicitAllowToolAndNonblankKey() {
        for options in [["Yes", "Deny"], ["Always allow", "Deny"], [" Allow", "Deny"]] {
            XCTAssertFalse(ApprovalContract.canAlwaysAllow(ApprovalFixtures.reference(ApprovalFixtures.message(options: options))))
        }
        for key in [nil, "", " \n\u{FEFF}"] as [String?] {
            var message = ApprovalFixtures.message(); message.card?.allowKey = key
            XCTAssertFalse(ApprovalContract.canAlwaysAllow(ApprovalFixtures.reference(message)))
        }
        for tool in ["", " \n"] {
            let message = ApprovalFixtures.message(tool: tool)
            XCTAssertNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: message, in: ApprovalFixtures.state(message: message)))
        }
    }

    func testOpaqueRequestIdPreservedAndPhysicalKeysUseExactUTF16() {
        let raw = "  provider:/e\u{301}  "
        let reference = ApprovalFixtures.reference(ApprovalFixtures.message(requestId: raw))
        XCTAssertTrue(ApprovalContract.exact(reference.requestId, raw))
        let first = ApprovalActionKey(sessionId: reference.context.sessionId, threadId: "thread", requestId: "é")
        let second = ApprovalActionKey(sessionId: reference.context.sessionId, threadId: "thread", requestId: "e\u{301}")
        XCTAssertNotEqual(first, second); XCTAssertEqual(Set([first, second]).count, 2)
        XCTAssertTrue(ApprovalContract.validRequestId(String(repeating: "😀", count: 2048)))
        XCTAssertFalse(ApprovalContract.validRequestId(String(repeating: "😀", count: 2049)))
        XCTAssertFalse(ApprovalContract.validRequestId(" \n\u{FEFF}"))
    }

    func testRetiredHiddenAndUnknownCardsAreInert() {
        for mutate in [
            { (m: inout Message) in m.card?.answered = "allow" },
            { (m: inout Message) in m.card?.dismissed = true },
            { (m: inout Message) in m.card?.requestId = nil },
            { (m: inout Message) in m.card?.purpose = "onboarding-v1" },
            { (m: inout Message) in m.card?.seedInvalid = true },
            { (m: inout Message) in m.seedContextInvalid = true },
            { (m: inout Message) in m.role = .user },
            { (m: inout Message) in m.kind = .unknown },
        ] {
            var message = ApprovalFixtures.message(); mutate(&message)
            XCTAssertNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: message, in: ApprovalFixtures.state(message: message)))
        }
        let message = ApprovalFixtures.message(); var state = ApprovalFixtures.state(message: message)
        state.bots[0].hidden = true
        XCTAssertNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: message, in: state))
        state.bots[0].hidden = false; state.bots[0].threadId = "new-thread"
        XCTAssertNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: message, in: state))
    }

    func testActualActiveBranchRequiredWithoutMissingLeafFallback() {
        let message = ApprovalFixtures.message(); var state = ApprovalFixtures.state(message: message)
        state.bots[0].activeLeafId = "missing"
        XCTAssertNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: message, in: state))
        state.messages["thread"]?.append(Message(id: "other", role: .bot, kind: .text, at: 2))
        state.bots[0].activeLeafId = "other"
        XCTAssertNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: message, in: state))
        state.messages["thread"]?[1].parentId = "card"
        XCTAssertNotNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: message, in: state))
        state.messages["thread"]?[0].parentId = "other"
        XCTAssertNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: state.messages["thread"]![0], in: state))
    }

    func testStaleRenderedSignatureRejectedButGrantBroadcastDoesNotChangeIt() {
        let supplied = ApprovalFixtures.message(); var state = ApprovalFixtures.state(message: supplied)
        state.bots[0].alwaysAllow = ["Bash:fixture"]
        XCTAssertNotNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: supplied, in: state))
        state.messages["thread"]?[0].card?.subtitle = "Changed command"
        XCTAssertNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: supplied, in: state))
        state.messages["thread"]?[0].card?.subtitle = "é"
        var old = supplied; old.card?.subtitle = "e\u{301}"
        XCTAssertNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: old, in: state))
    }

    func testRoomRequiresExactCurrentSpeakerAndDisallowsGrant() throws {
        var message = ApprovalFixtures.message(); message.from = Sender(botId: "owner", name: "Orbit", color: "orange")
        var state = ApprovalFixtures.state(message: message)
        state.rooms = [Room(id: "room", threadId: "room-thread", name: "Room", memberIds: ["owner"],
            defaultResponder: GroupResponder(kind: "none"), bulletin: "", unread: false, createdAt: 1, busyBotId: "owner")]
        state.messages["room-thread"] = [message]
        let context = ComposerContext(sessionId: ApprovalFixtures.sessionId, target: .init(kind: .room, ownerId: "room", threadId: "room-thread"))
        let reference = try XCTUnwrap(ApprovalContract.reference(for: context, message: message, in: state))
        XCTAssertFalse(ApprovalContract.canAlwaysAllow(reference))
        state.rooms[0].busyBotId = "someone-else"
        XCTAssertFalse(ApprovalContract.matches(reference, in: state, pending: false))
        state.rooms[0].busyBotId = nil
        XCTAssertNil(ApprovalContract.reference(for: context, message: message, in: state))
        state.messages["room-thread"]?[0].card?.answered = "allow"
        XCTAssertTrue(ApprovalContract.matches(reference, in: state, pending: false))
    }

    func testPresentMalformedMetadataCannotBeLaunderedIntoQuestion() throws {
        let base = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ApprovalFixtures.message())) as! [String: Any]
        for (key, value) in [("tool", 7 as Any), ("dismissed", "false"), ("answered", 2), ("requestId", NSNull())] {
            var raw = base; var card = raw["card"] as! [String: Any]; card[key] = value; raw["card"] = card
            let message = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: raw))
            XCTAssertNil(ApprovalContract.reference(for: ApprovalFixtures.context, message: message, in: ApprovalFixtures.state(message: message)))
        }
    }

    func testResponseOutcomesMatchExplicitActionAndUnavailableIsDistinct() throws {
        for (action, outcome) in [(ApprovalAction.allow, "allowed-once"), (.deny, "rejected"), (.answer("Allow"), "answered"), (.alwaysAllow, "allowed-once")] {
            XCTAssertEqual(try ApprovalContract.response(Data("{\"ok\":true,\"outcome\":\"\(outcome)\"}".utf8), action: action).rawValue, outcome)
            XCTAssertEqual(try ApprovalContract.response(Data(#"{"ok":true,"outcome":"unavailable"}"#.utf8), action: action), .unavailable)
        }
        for raw in [#"{}"#, #"{"ok":true}"#, #"{"ok":false,"outcome":"allowed-once"}"#,
                    #"{"ok":true,"outcome":null}"#, #"{"ok":true,"outcome":"future"}"#,
                    #"{"ok":true,"outcome":"answered"}"#, #"{"ok":1,"outcome":"allowed-once"}"#] {
            XCTAssertThrowsError(try ApprovalContract.response(Data(raw.utf8), action: .allow))
        }
    }

    func testGrantReceiptRequiresWholeExactTupleAndActuallyStoredKey() throws {
        let reference = ApprovalFixtures.reference(ApprovalFixtures.message(requestId: "e\u{301}"))
        let valid = ApprovalFixtures.grantBody(reference)
        XCTAssertTrue(try ApprovalGrantReceipt.decode(JSONSerialization.data(withJSONObject: valid), reference: reference).matches(reference))
        for (key, value) in [("threadId", "other" as Any), ("requestId", "é"), ("cardId", "other"), ("allowKey", "other"), ("allowKey", NSNull())] {
            var body = valid; var grant = body["grant"] as! [String: Any]; grant[key] = value; body["grant"] = grant
            XCTAssertThrowsError(try ApprovalGrantReceipt.decode(JSONSerialization.data(withJSONObject: body), reference: reference))
        }
        for bot in [["id": "other", "threadId": "thread", "alwaysAllow": ["Bash:fixture"]],
                    ["id": "owner", "threadId": "other", "alwaysAllow": ["Bash:fixture"]],
                    ["id": "owner", "threadId": "thread", "alwaysAllow": []],
                    ["id": "owner", "threadId": "thread", "alwaysAllow": NSNull()]] as [[String: Any]] {
            var body = valid; body["bot"] = bot
            XCTAssertThrowsError(try ApprovalGrantReceipt.decode(JSONSerialization.data(withJSONObject: body), reference: reference))
        }
    }
}
