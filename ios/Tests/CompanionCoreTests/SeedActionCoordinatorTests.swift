import XCTest
@testable import CompanionCore

func coordinatorQuestion() -> Message {
    var card = OptionCard(title: SeedCardContract.title, subtitle: SeedCardContract.subtitle, options: SeedCardContract.options)
    card.purpose = SeedCardContract.purpose
    return Message(id: "welcome-card", role: .bot, kind: .options, at: 2, card: card, parentId: "greeting")
}

func coordinatorResult(_ text: String = "Life admin", status: SeedAnswerStatus = .starting, attempt: Int? = nil) -> SeedCardResult {
    var card = coordinatorQuestion()
    card.card?.answered = text
    card.card?.seedAnswer = SeedAnswerReceipt(messageId: "saved-user", attempt: attempt ?? (status == .recorded ? 0 : 1), status: status)
    return SeedCardResult(outcome: "starting", cardMessage: card,
        userMessage: Message(id: "saved-user", role: .user, kind: .text, at: 3, text: text, parentId: card.id))
}

/// Deliberately ignores Task cancellation until the test releases the request.
private actor HeldSeedTransport: SeedCardTransport {
    struct Call: Equatable { var kind: String; var bot: String; var card: String; var thread: String; var text: String?; var attempt: Int? }
    private(set) var calls: [Call] = []
    private var pending: [Int: CheckedContinuation<SeedCardResult, Error>] = [:]
    private var nextResult: SeedCardResult?
    func respondToNextCall(_ result: SeedCardResult) { nextResult = result }
    private func hold(_ call: Call) async throws -> SeedCardResult {
        try await withCheckedThrowingContinuation { continuation in
            let index = calls.count; calls.append(call)
            if let result = nextResult {
                nextResult = nil
                continuation.resume(returning: result)
            } else {
                pending[index] = continuation
            }
        }
    }
    func answerSeedCard(botId: String, cardId: String, threadId: String, answer: String) async throws -> SeedCardResult {
        try await hold(Call(kind: "answer", bot: botId, card: cardId, thread: threadId, text: answer))
    }
    func seedCardStatus(botId: String, cardId: String, threadId: String) async throws -> SeedCardResult {
        try await hold(Call(kind: "check", bot: botId, card: cardId, thread: threadId))
    }
    func startSeedCard(botId: String, cardId: String, threadId: String, expectedAttempt: Int) async throws -> SeedCardResult {
        try await hold(Call(kind: "start", bot: botId, card: cardId, thread: threadId, attempt: expectedAttempt))
    }
    func resolve(_ result: SeedCardResult) { resolve(0, result) }
    func resolve(_ index: Int, _ result: SeedCardResult) { pending.removeValue(forKey: index)?.resume(returning: result) }
    func reject(_ error: Error) { pending.removeValue(forKey: 0)?.resume(throwing: error) }
}

@MainActor
private final class SeedHarness {
    var state = CompanionState()
    let transport = HeldSeedTransport()
    let identity = UUID()
    var actions: [SeedActionKey: SeedActionState] = [:]
    var unauthorized = 0
    var onChange: (() -> Void)?
    var reference: SeedReference!
    var lease: UUID!
    var timeout: UInt64
    lazy var coordinator: SeedActionCoordinator = SeedActionCoordinator(readState: { [unowned self] in state }, writeState: { [unowned self] in
        state = $0; coordinator.reconcile()
    }, changed: { [unowned self] in actions = $0; onChange?() }, unauthorized: { [unowned self] in unauthorized += 1 }, timeoutNanoseconds: timeout)
    init(timeout: UInt64 = 10_000_000_000) {
        self.timeout = timeout
        var bot = Bot(id: "bot-owner", threadId: "thread-distinct", name: "Renamed", title: "", description: "", notifications: false,
                      color: "orange", unread: false, modelSelection: ModelSelection(instanceId: "offline", model: "fixture"), createdAt: 1)
        bot.activeLeafId = "welcome-card"
        state.bots = [bot]
        state.messages[bot.threadId] = [Message(id: "greeting", role: .bot, kind: .text, at: 1, text: "Hey — I'm Original. Nice to meet you."), coordinatorQuestion()]
        coordinator.bind(sessionId: identity, transport: transport)
        coordinator.setForeground(true)
        lease = coordinator.viewConversation(botId: bot.id, threadId: bot.threadId)
        reference = coordinator.reference(botId: bot.id, threadId: bot.threadId, cardId: "welcome-card")!
    }
    var ledger: SeedActionState? { actions[reference.key] }
    var saved: OptionCard? { state.messages["thread-distinct"]?.first(where: { $0.id == "welcome-card" })?.card }
    func act(_ action: SeedAction) -> Task<Void, Never> {
        Task { await coordinator.act(reference, action: action) }
    }
    func apply(_ frame: Frame) { state.apply(frame); coordinator.reconcile() }
    func settle(_ result: SeedCardResult) {
        apply(.messagePatch(threadId: "thread-distinct", message: result.cardMessage))
        if let user = result.userMessage { apply(.message(threadId: "thread-distinct", message: user)) }
    }
    func waitForCalls(_ count: Int) async {
        let deadline = Date().addingTimeInterval(2)
        while await transport.calls.count < count && Date() < deadline { await Task.yield() }
        let actual = await transport.calls.count
        XCTAssertEqual(actual, count)
    }
    func waitForClose() async {
        let deadline = Date().addingTimeInterval(2)
        while ledger?.inFlight == true && Date() < deadline { await Task.yield() }
        XCTAssertNotEqual(ledger?.inFlight, true)
    }
}

final class SeedActionCoordinatorTests: XCTestCase {
    @MainActor func testAlreadyCancelledUITaskNeverBeginsTransport() async {
        let h = SeedHarness(); let task = h.act(.answer("Life admin")); task.cancel(); await task.value
        let calls = await h.transport.calls; XCTAssertTrue(calls.isEmpty); XCTAssertNil(h.ledger)
    }
    @MainActor func testNoAutomaticRequestsFromBindViewForegroundOrReconnect() async {
        let h = SeedHarness()
        h.coordinator.setForeground(false); h.coordinator.setForeground(true); h.coordinator.connectionChanged(); h.coordinator.reconcile()
        await Task.yield()
        let calls = await h.transport.calls
        XCTAssertTrue(calls.isEmpty); XCTAssertNil(h.saved?.answered)
    }

    @MainActor func testExactAnswerAndImmediateDuplicateLock() async {
        let h = SeedHarness(); let text = "  Work\n  e\u{301}  "
        let task = h.act(.answer(text)); await h.waitForCalls(1)
        await h.coordinator.act(h.reference, action: .answer(text))
        await h.coordinator.act(h.reference, action: .check)
        await h.coordinator.act(h.reference, action: .start)
        let calls = await h.transport.calls
        XCTAssertEqual(calls.count, 1); XCTAssertEqual(calls[0].bot, "bot-owner"); XCTAssertEqual(calls[0].thread, "thread-distinct")
        XCTAssertTrue(SeedCardContract.exactText(calls[0].text!, text)); XCTAssertNil(h.saved?.answered)
        await h.transport.resolve(coordinatorResult(text)); await task.value
        XCTAssertEqual(h.saved?.seedAnswer?.status, .starting); XCTAssertEqual(h.ledger?.phase, .settled)
        XCTAssertTrue(SeedCardContract.exactText(h.saved!.answered!, text))
    }

    @MainActor func testBlankAndUTF16LimitRejectBeforeTransport() async {
        for text in ["", " \n\u{FEFF}", String(repeating: "🟠", count: 2001)] {
            let h = SeedHarness(); await h.coordinator.act(h.reference, action: .answer(text))
            let calls = await h.transport.calls
            XCTAssertTrue(calls.isEmpty); XCTAssertEqual(h.ledger?.phase, .failed)
        }
    }

    @MainActor func testResponseLossRecoveryIsOnlyGETAndKeepsOneEcho() async {
        let h = SeedHarness(); let task = h.act(.answer("Life admin")); await h.waitForCalls(1)
        await h.transport.reject(APIError.transport("Lost after acceptance")); await task.value
        XCTAssertEqual(h.ledger?.phase, .failed); XCTAssertEqual(h.ledger?.lastAnswer, "Life admin")
        let checking = h.act(.check); await h.waitForCalls(2)
        var result = coordinatorResult(status: .started); result.outcome = nil
        await h.transport.resolve(1, result); await checking.value
        XCTAssertEqual(h.saved?.seedAnswer?.status, .started)
        XCTAssertEqual(h.state.messages["thread-distinct"]?.filter { $0.id == "saved-user" }.count, 1)
        let calls = await h.transport.calls
        XCTAssertEqual(calls.map(\.kind), ["answer", "check"])
    }

    @MainActor func testSameAnswerRetryDoesNotStartAndDifferentUnicodeConflicts() async {
        let h = SeedHarness(); h.settle(coordinatorResult("e\u{301}", status: .notStarted))
        await h.coordinator.act(h.reference, action: .answer("é"))
        let before = await h.transport.calls; XCTAssertTrue(before.isEmpty)
        let retry = h.act(.answer("e\u{301}")); await h.waitForCalls(1)
        var result = coordinatorResult("e\u{301}", status: .notStarted); result.outcome = "already-recorded"
        await h.transport.resolve(result); await retry.value
        let calls = await h.transport.calls; XCTAssertEqual(calls.map(\.kind), ["answer"])
        XCTAssertEqual(h.saved?.seedAnswer?.status, .notStarted)
    }

    @MainActor func testExplicitStartCapturesAttemptWithoutAnotherAnswer() async {
        for status: SeedAnswerStatus in [.recorded, .notStarted] {
            let h = SeedHarness(); h.settle(coordinatorResult(status: status))
            let task = h.act(.start); await h.waitForCalls(1)
            let calls = await h.transport.calls
            XCTAssertEqual(calls[0].kind, "start"); XCTAssertEqual(calls[0].attempt, status == .recorded ? 0 : 1)
            await h.transport.resolve(coordinatorResult(status: .starting, attempt: status == .recorded ? 1 : 2)); await task.value
            XCTAssertEqual(h.state.messages["thread-distinct"]?.filter { $0.id == "saved-user" }.count, 1)
        }
    }

    @MainActor func testStartingStartedUncertainCannotRestart() async {
        for status: SeedAnswerStatus in [.starting, .started, .uncertain] {
            let h = SeedHarness(); h.settle(coordinatorResult(status: status))
            await h.coordinator.act(h.reference, action: .start)
            let calls = await h.transport.calls; XCTAssertTrue(calls.isEmpty)
            XCTAssertEqual(h.ledger?.phase, .failed)
        }
    }

    @MainActor func testBusyAndNewerWorkBlockWritesButKeepStatusReadable() async {
        for busy in [true, false] {
            let h = SeedHarness()
            if busy { h.state.bots[0].busy = true }
            else { h.apply(.message(threadId: "thread-distinct", message: Message(id: "new-work", role: .user, kind: .text, at: 4, text: "Another job", parentId: "welcome-card"))) }
            await h.coordinator.act(h.reference, action: .answer("Life admin"))
            let task = h.act(.check); await h.waitForCalls(1)
            await h.transport.resolve(SeedCardResult(cardMessage: coordinatorQuestion(), userMessage: nil)); await task.value
            let calls = await h.transport.calls; XCTAssertEqual(calls.map(\.kind), ["check"])
        }
    }

    @MainActor func testBackgroundAndWrongViewRejectEveryAction() async {
        for wrongView in [true, false] {
            let h = SeedHarness()
            if wrongView { _ = h.coordinator.viewConversation(botId: "room-owner", threadId: "thread-distinct") }
            else { h.coordinator.setForeground(false) }
            for action: SeedAction in [.answer("Life admin"), .check, .start] { await h.coordinator.act(h.reference, action: action) }
            let calls = await h.transport.calls; XCTAssertTrue(calls.isEmpty)
        }
    }

    @MainActor func testLateRepliesAfterForegroundViewReconnectOrAccountChangeAreIgnored() async {
        for change in ["foreground", "view", "reconnect", "account", "thread", "branch", "card"] {
            let h = SeedHarness(); let task = h.act(.answer("Life admin")); await h.waitForCalls(1)
            switch change {
            case "foreground": h.coordinator.setForeground(false); h.coordinator.setForeground(true)
            case "view": h.coordinator.leaveConversation(h.lease); _ = h.coordinator.viewConversation(botId: "bot-owner", threadId: "thread-distinct")
            case "reconnect": h.coordinator.connectionChanged()
            case "account": h.coordinator.bind(sessionId: UUID(), transport: h.transport)
            case "thread": h.state.bots[0].threadId = "other"; h.coordinator.reconcile()
            case "branch": h.apply(.thread(threadId: "thread-distinct", activeLeafId: "greeting"))
            default: var card = coordinatorQuestion(); card.card?.subtitle = "Different"; h.apply(.messagePatch(threadId: "thread-distinct", message: card))
            }
            await task.value
            await h.transport.resolve(coordinatorResult()); await h.waitForClose()
            XCTAssertNil(h.saved?.answered, change)
        }
    }

    @MainActor func testSiblingBranchChangeInvalidatesSharedSeed() async {
        let h = SeedHarness()
        h.apply(.message(threadId: "thread-distinct", message: Message(id: "first", role: .bot, kind: .text, at: 3, text: "First", parentId: "welcome-card")))
        let task = h.act(.answer("Life admin")); await h.waitForCalls(1)
        h.apply(.message(threadId: "thread-distinct", message: Message(id: "sibling", role: .bot, kind: .text, at: 4, text: "Sibling", parentId: "welcome-card")))
        await task.value; await h.transport.resolve(coordinatorResult()); await h.waitForClose()
        XCTAssertNil(h.saved?.answered); XCTAssertEqual(h.state.bots[0].activeLeafId, "sibling")
    }

    @MainActor func testNormalizationEquivalentParentChangeInvalidatesCapturedSignature() async {
        let h = SeedHarness()
        h.state.messages["thread-distinct"]?[0].id = "e\u{301}"
        h.state.messages["thread-distinct"]?[1].parentId = "e\u{301}"
        h.reference = h.coordinator.reference(botId: "bot-owner", threadId: "thread-distinct", cardId: "welcome-card")!
        let captured = h.reference.signature
        let task = h.act(.answer("Life admin")); await h.waitForCalls(1)
        var changed = coordinatorQuestion(); changed.parentId = "é"
        h.apply(.messagePatch(threadId: "thread-distinct", message: changed))
        XCTAssertFalse(SeedCardContract.exactText(captured, SeedCardContract.signature(changed)))
        await task.value
        var result = coordinatorResult(); result.cardMessage.parentId = "e\u{301}"
        await h.transport.resolve(result); await h.waitForClose()
        XCTAssertNil(h.saved?.answered)
    }

    @MainActor func testTimeoutRetainsPhysicalLockUntilIgnoredCancellationSettles() async {
        let h = SeedHarness(timeout: 10_000_000); let task = h.act(.answer("Life admin")); await h.waitForCalls(1)
        await task.value
        XCTAssertEqual(h.ledger?.phase, .failed); XCTAssertEqual(h.ledger?.inFlight, true)
        h.coordinator.leaveConversation(h.lease); _ = h.coordinator.viewConversation(botId: "bot-owner", threadId: "thread-distinct")
        await h.coordinator.act(h.reference, action: .answer("Life admin")); await h.coordinator.act(h.reference, action: .check)
        let calls = await h.transport.calls; XCTAssertEqual(calls.count, 1)
        await h.transport.resolve(coordinatorResult()); await h.waitForClose()
        XCTAssertNil(h.saved?.answered)
        // Only the first request is supposed to time out. Prepare the status
        // response before dispatch so the test does not race a second 10ms
        // deadline while polling and scheduling the transport resolution.
        await h.transport.respondToNextCall(coordinatorResult(status: .started))
        let checking = h.act(.check); await checking.value
        let finalCalls = await h.transport.calls; XCTAssertEqual(finalCalls.count, 2)
        XCTAssertEqual(h.saved?.seedAnswer?.status, .started)
    }

    @MainActor func testInvalidEchoParentOrAnswerDoesNotSettle() async {
        for mismatch in ["parent", "answer", "id", "outcome"] {
            let h = SeedHarness(); let task = h.act(.answer("Life admin")); await h.waitForCalls(1)
            var result = coordinatorResult()
            switch mismatch {
            case "parent": result.userMessage?.parentId = "unknown"
            case "answer": result = coordinatorResult("Different")
            case "id": result.cardMessage.id = "other"
            default: result.outcome = nil
            }
            await h.transport.resolve(result); await task.value
            XCTAssertNil(h.saved?.answered); XCTAssertEqual(h.ledger?.phase, .failed, mismatch)
        }
    }

    @MainActor func testNewerReceiptReplyAndStreamSurviveOlderAcknowledgement() async {
        let h = SeedHarness(); let task = h.act(.answer("Life admin")); await h.waitForCalls(1)
        h.settle(coordinatorResult(status: .started))
        h.apply(.message(threadId: "thread-distinct", message: Message(id: "reply", role: .bot, kind: .text, at: 4, text: "Reply", parentId: "saved-user")))
        h.state.streaming["thread-distinct"] = "Current stream"; h.state.cursor = "cursor:5"
        await h.transport.resolve(coordinatorResult()); await task.value
        XCTAssertEqual(h.saved?.seedAnswer?.status, .started); XCTAssertEqual(h.state.bots[0].activeLeafId, "reply")
        XCTAssertEqual(h.state.streaming["thread-distinct"], "Current stream"); XCTAssertEqual(h.state.cursor, "cursor:5")
        XCTAssertEqual(h.ledger?.phase, .settled)
    }

    @MainActor func testAuthorizationOnlyAffectsCurrentSession() async {
        for replace in [false, true] {
            let h = SeedHarness(); let task = h.act(.check); await h.waitForCalls(1)
            if replace { h.coordinator.bind(sessionId: UUID(), transport: h.transport) }
            await h.transport.reject(APIError.status(code: 401, message: "Revoked")); await task.value; await h.waitForClose()
            XCTAssertEqual(h.unauthorized, replace ? 0 : 1)
        }
    }

    @MainActor func testHTTPFailuresKeepExactDraftAndSeparateRefusalFromUncertainty() async {
        for status in [400, 403, 409, 408, 503] {
            let h = SeedHarness(); let text = "  retained\n draft  "
            let task = h.act(.answer(text)); await h.waitForCalls(1)
            await h.transport.reject(APIError.status(code: status, message: "Owned refusal")); await task.value
            XCTAssertNil(h.saved?.answered); XCTAssertEqual(h.ledger?.phase, .failed); XCTAssertEqual(h.ledger?.inFlight, false)
            XCTAssertTrue(SeedCardContract.exactText(h.ledger!.lastAnswer!, text))
            XCTAssertTrue(h.ledger!.message!.contains(status == 408 || status == 503 ? "Could not confirm" : "not accepted"))
            let calls = await h.transport.calls; XCTAssertEqual(calls.count, 1)
        }
    }

    @MainActor func testStaleViewCleanupCannotRetireNewerLease() async {
        let h = SeedHarness()
        _ = h.coordinator.viewConversation(botId: "bot-owner", threadId: "thread-distinct")
        h.coordinator.leaveConversation(h.lease)
        let task = h.act(.check); await h.waitForCalls(1)
        await h.transport.resolve(SeedCardResult(cardMessage: coordinatorQuestion(), userMessage: nil)); await task.value
        XCTAssertEqual(h.ledger?.phase, .settled)
    }

    @MainActor func testSynchronousSubscriberChangesAreRecheckedBeforeTransport() async {
        for background in [true, false] {
            let h = SeedHarness()
            h.onChange = {
                guard h.ledger?.phase == .pending else { return }
                h.onChange = nil
                if background { h.coordinator.setForeground(false) }
                else { h.state.bots[0].busy = true; h.coordinator.reconcile() }
            }
            await h.coordinator.act(h.reference, action: .answer("Life admin"))
            let calls = await h.transport.calls; XCTAssertTrue(calls.isEmpty)
        }
    }
}
