import XCTest
@testable import CompanionCore

/// Cancellation deliberately does not settle this transport. This exercises
/// the physical lock independently from view, timeout, and session lifetimes.
private actor HeldComposerTransport: ComposerTransport {
    struct Call: Sendable { let text: String; let target: ComposerTarget }
    private(set) var calls: [Call] = []
    private var pending: [Int: CheckedContinuation<ComposerAcknowledgment, Error>] = [:]
    func sendOrdinary(text: String, to target: ComposerTarget) async throws -> ComposerAcknowledgment {
        try await withCheckedThrowingContinuation { continuation in
            let index = calls.count; calls.append(Call(text: text, target: target)); pending[index] = continuation
        }
    }
    func resolve(_ index: Int = 0, threadId: String? = nil) {
        pending.removeValue(forKey: index)?.resume(returning: ComposerAcknowledgment(threadId: threadId ?? calls[index].target.threadId))
    }
    func reject(_ error: Error, index: Int = 0) { pending.removeValue(forKey: index)?.resume(throwing: error) }
}

@MainActor
private final class ComposerHarness {
    var state = CompanionState()
    let transport = HeldComposerTransport()
    var identity = UUID()
    var changedCount = 0
    var unauthorized = 0
    var lease: ComposerViewLease!
    var timeout: UInt64
    var maximum: Int
    lazy var coordinator = ComposerCoordinator(readState: { [unowned self] in state },
        changed: { [unowned self] _ in changedCount += 1 }, unauthorized: { [unowned self] in unauthorized += 1 },
        maximumContexts: maximum, timeoutNanoseconds: timeout)
    var context: ComposerContext { ComposerContext(sessionId: identity, target: .init(kind: .bot, ownerId: "owner", threadId: "displayed-thread")) }
    var draft: ComposerDraft { coordinator.draft(for: context) }
    init(timeout: UInt64 = 20_000_000_000, maximum: Int = 64) {
        self.timeout = timeout; self.maximum = maximum
        state.bots = [Bot(id: "owner", threadId: "displayed-thread", name: "Orbit", title: "", description: "",
            notifications: false, color: "orange", unread: false, modelSelection: ModelSelection(instanceId: "offline", model: "fixture"), createdAt: 1)]
        state.rooms = [Room(id: "owner", threadId: "room-thread", name: "Room", memberIds: [],
            defaultResponder: GroupResponder(kind: "none"), bulletin: "", unread: false, createdAt: 1)]
        coordinator.bind(sessionId: identity, transport: transport); coordinator.setForeground(true)
        lease = coordinator.enter(context)
    }
    func edit(_ text: String) { coordinator.edit(text, context: context, lease: lease) }
    @discardableResult func submit() -> UUID? { coordinator.submit(context, lease: lease) }
    func calls(_ count: Int) async {
        let deadline = Date().addingTimeInterval(2)
        while await transport.calls.count < count && Date() < deadline { await Task.yield() }
        let actual = await transport.calls.count; XCTAssertEqual(actual, count)
    }
    func closed() async {
        let deadline = Date().addingTimeInterval(2)
        while draft.inFlight && Date() < deadline { await Task.yield() }
        XCTAssertFalse(draft.inFlight)
    }
    func published(after count: Int) async {
        let deadline = Date().addingTimeInterval(2)
        while changedCount <= count && Date() < deadline { await Task.yield() }
        XCTAssertGreaterThan(changedCount, count)
    }
}

final class ComposerCoordinatorTests: XCTestCase {
    @MainActor func testInactiveSystemEditorPreservesDraftButCannotSendOrUseRetiredLease() async {
        let h = ComposerHarness(); h.edit("before editor")
        let previous = h.lease
        h.coordinator.setForeground(false)
        let raw = "  editor e\u{301}\nreturn  "
        h.edit(raw)
        XCTAssertTrue(h.draft.text.utf16.elementsEqual(raw.utf16))
        XCTAssertTrue(h.coordinator.canEdit(h.context, lease: h.lease))
        XCTAssertFalse(h.coordinator.canSend(h.context, lease: h.lease)); XCTAssertNil(h.submit())
        h.coordinator.leave(previous!)
        h.lease = h.coordinator.enter(h.context)
        h.coordinator.edit("stale editor", context: h.context, lease: previous)
        XCTAssertNil(h.coordinator.submit(h.context, lease: previous))
        h.coordinator.setForeground(true)
        await Task.yield()
        let calls = await h.transport.calls; XCTAssertTrue(calls.isEmpty)
        XCTAssertTrue(h.draft.text.utf16.elementsEqual(raw.utf16))
        XCTAssertNotNil(h.submit()); XCTAssertNil(h.submit())
        await h.calls(1); await h.transport.resolve(); await h.closed()
    }

    @MainActor func testConnectionLossBeforeQueuedDispatchPreservesDraftWithoutSending() async {
        let h = ComposerHarness(); let raw = "  e\u{301}\nkeep  "
        h.edit(raw); XCTAssertNotNil(h.submit())
        h.coordinator.connectionChanged()
        await h.closed()
        XCTAssertTrue(h.draft.text.utf16.elementsEqual(raw.utf16))
        XCTAssertEqual(h.draft.message, ComposerCoordinator.recoveryMessage)
        let calls = await h.transport.calls; XCTAssertTrue(calls.isEmpty)
    }

    @MainActor func testConnectionReturnCannotReplayOrClearNewEditUntilPhysicalRequestCloses() async {
        let h = ComposerHarness(); h.edit("original"); h.submit(); await h.calls(1)
        h.coordinator.connectionChanged(); h.coordinator.connectionChanged()
        h.coordinator.reconcile() // A restored snapshot does not revive the request.
        h.edit("  newer e\u{301}\n  ")
        XCTAssertTrue(h.draft.inFlight); XCTAssertNil(h.submit())
        await h.transport.resolve(); await h.closed()
        XCTAssertTrue(h.draft.text.utf16.elementsEqual("  newer e\u{301}\n  ".utf16))
        XCTAssertEqual(h.draft.message, ComposerCoordinator.recoveryMessage)
        let calls = await h.transport.calls; XCTAssertEqual(calls.count, 1)
        XCTAssertNotNil(h.submit()); XCTAssertNil(h.submit())
        await h.calls(2); await h.transport.resolve(1); await h.closed()
        XCTAssertEqual(h.draft.text, "")
    }

    @MainActor func testConnectionRetirementCannotAdoptLateOutcomeIntoAnotherSession() async {
        for success in [true, false] {
            let h = ComposerHarness(); h.edit("previous account"); h.submit(); await h.calls(1)
            h.coordinator.connectionChanged()
            h.identity = UUID(); h.coordinator.bind(sessionId: h.identity, transport: h.transport)
            h.lease = h.coordinator.enter(h.context); h.edit("current account")
            let before = h.changedCount
            if success { await h.transport.resolve() }
            else { await h.transport.reject(APIError.status(code: 401, message: nil)) }
            await h.published(after: before)
            XCTAssertEqual(h.draft.text, "current account"); XCTAssertNil(h.draft.message)
            XCTAssertFalse(h.draft.inFlight); XCTAssertEqual(h.unauthorized, 0)
            let calls = await h.transport.calls; XCTAssertEqual(calls.count, 1)
        }
    }

    @MainActor func testSynchronousLockExactDraftAndOnlyAcknowledgmentClears() async {
        let h = ComposerHarness(); let raw = "  e\u{301}\nnext line  "
        h.edit(raw); XCTAssertNotNil(h.submit()); XCTAssertNil(h.submit())
        XCTAssertTrue(h.draft.inFlight); XCTAssertTrue(h.draft.text.utf16.elementsEqual(raw.utf16))
        await h.calls(1)
        let request = await h.transport.calls[0]
        XCTAssertTrue(request.text.utf16.elementsEqual(raw.utf16)); XCTAssertEqual(request.target, h.context.target)
        h.state.messages["displayed-thread"] = [Message(id: "echo", role: .user, kind: .text, at: 1, text: ComposerText.normalized(raw))]
        h.coordinator.reconcile()
        XCTAssertTrue(h.draft.text.utf16.elementsEqual(raw.utf16)); XCTAssertTrue(h.draft.inFlight)
        await h.transport.resolve(); await h.closed(); XCTAssertEqual(h.draft.text, ""); XCTAssertNil(h.draft.message)
    }

    @MainActor func testErrorsKeepRawDraftWithUncertainCopyAndNeverAutomaticallyRetry() async {
        for error in [APIError.status(code: 409, message: "May already have appended"), .status(code: 503, message: "Failure"), .transport("Lost after acceptance")] {
            let h = ComposerHarness(); let text = "  exact\n  text  "
            h.edit(text); h.submit(); await h.calls(1)
            await h.transport.reject(error); await h.closed()
            XCTAssertTrue(h.draft.text.utf16.elementsEqual(text.utf16)); XCTAssertEqual(h.draft.message, ComposerCoordinator.recoveryMessage)
            h.coordinator.reconcile(); h.coordinator.setForeground(false); h.coordinator.setForeground(true)
            await Task.yield(); let calls = await h.transport.calls; XCTAssertEqual(calls.count, 1)
        }
    }

    @MainActor func testAcknowledgmentPreservesNewerEdits() async {
        let h = ComposerHarness(); h.edit("first"); h.submit(); await h.calls(1)
        h.edit("new draft"); await h.transport.resolve(); await h.closed()
        XCTAssertEqual(h.draft.text, "new draft"); XCTAssertNil(h.draft.message)
    }

    @MainActor func testEditingAwayAndBackIsStillANewerDraftRevision() async {
        let h = ComposerHarness(); h.edit("same"); h.submit(); await h.calls(1)
        h.edit("different"); h.edit("same"); await h.transport.resolve(); await h.closed()
        XCTAssertEqual(h.draft.text, "same")
    }

    @MainActor func testCanonicallyEquivalentEditCannotBeCleared() async {
        let h = ComposerHarness(); h.edit("é"); h.submit(); await h.calls(1)
        h.edit("e\u{301}"); await h.transport.resolve(); await h.closed()
        XCTAssertTrue(h.draft.text.utf16.elementsEqual("e\u{301}".utf16))
    }

    @MainActor func testLeavingBeforeQueuedTaskRunsSendsNothingAndKeepsDraft() async {
        let h = ComposerHarness(); h.edit("keep"); h.submit(); h.coordinator.leave(h.lease)
        await h.closed(); let calls = await h.transport.calls; XCTAssertTrue(calls.isEmpty)
        h.lease = h.coordinator.enter(h.context)
        XCTAssertEqual(h.draft.text, "keep"); XCTAssertTrue(h.coordinator.canSend(h.context, lease: h.lease))
    }

    @MainActor func testLiveTaskChangeBeforeDispatchNeverRetargetsOriginalDraft() async {
        let h = ComposerHarness(); h.edit("old task"); h.submit()
        h.state.bots[0].threadId = "new-thread"
        await h.closed(); let calls = await h.transport.calls; XCTAssertTrue(calls.isEmpty)
        XCTAssertEqual(h.draft.text, "old task"); XCTAssertFalse(h.coordinator.canSend(h.context, lease: h.lease))
    }

    @MainActor func testNewPairingBeforeQueuedTaskRunsNeverUsesReplacementClient() async {
        let h = ComposerHarness(); h.edit("account one"); h.submit()
        let previous = h.context
        h.identity = UUID(); h.coordinator.bind(sessionId: h.identity, transport: h.transport)
        h.lease = h.coordinator.enter(h.context); h.edit("account two")
        let before = h.changedCount
        await h.published(after: before)
        let calls = await h.transport.calls; XCTAssertTrue(calls.isEmpty)
        XCTAssertEqual(h.draft.text, "account two"); XCTAssertEqual(h.coordinator.draft(for: previous).text, "")
    }

    @MainActor func testOldPairingCompletionCannotClearOrReportErrorsInNewPairing() async {
        for success in [true, false] {
            let h = ComposerHarness(); h.edit("first account"); h.submit(); await h.calls(1)
            h.identity = UUID(); h.coordinator.bind(sessionId: h.identity, transport: h.transport)
            h.lease = h.coordinator.enter(h.context); h.edit("second account")
            let before = h.changedCount
            if success { await h.transport.resolve() } else { await h.transport.reject(APIError.status(code: 401, message: nil)) }
            await h.published(after: before)
            XCTAssertEqual(h.draft.text, "second account"); XCTAssertNil(h.draft.message); XCTAssertEqual(h.unauthorized, 0)
        }
    }

    @MainActor func testLeaveReturnKeepsPhysicalLockUntilIgnoredCancellationSettles() async {
        let h = ComposerHarness(); h.edit("keep"); h.submit(); await h.calls(1)
        h.coordinator.leave(h.lease); h.lease = h.coordinator.enter(h.context)
        XCTAssertTrue(h.draft.inFlight); XCTAssertNil(h.submit())
        h.edit("new after return"); await h.transport.resolve(); await h.closed()
        XCTAssertEqual(h.draft.text, "new after return"); XCTAssertEqual(h.draft.message, ComposerCoordinator.recoveryMessage)
        XCTAssertNotNil(h.submit()); await h.calls(2); await h.transport.resolve(1); await h.closed()
        XCTAssertEqual(h.draft.text, "")
    }

    @MainActor func testTimeoutPreservesPhysicalLockAndLateSuccessCannotClear() async {
        let h = ComposerHarness(timeout: 5_000_000); h.edit("timeout draft"); h.submit(); await h.calls(1)
        let deadline = Date().addingTimeInterval(2)
        while h.draft.message == nil && Date() < deadline { await Task.yield() }
        XCTAssertNotNil(h.draft.message); XCTAssertTrue(h.draft.inFlight); XCTAssertNil(h.submit())
        await h.transport.resolve(); await h.closed()
        XCTAssertEqual(h.draft.text, "timeout draft"); XCTAssertEqual(h.draft.message, ComposerCoordinator.recoveryMessage)
    }

    @MainActor func testBackgroundReturnDoesNotReplayOrUnlockIgnoredAbort() async {
        let h = ComposerHarness(); h.edit("background"); h.submit(); await h.calls(1)
        h.coordinator.setForeground(false); h.coordinator.setForeground(true)
        XCTAssertNil(h.submit()); XCTAssertTrue(h.draft.inFlight)
        await h.transport.reject(CancellationError()); await h.closed()
        XCTAssertEqual(h.draft.text, "background"); let calls = await h.transport.calls; XCTAssertEqual(calls.count, 1)
    }

    @MainActor func testRetiredLeaseCannotEditOrSubmitAfterReopen() async {
        let h = ComposerHarness(); let old = h.lease
        h.edit("draft"); h.coordinator.leave(old!); h.lease = h.coordinator.enter(h.context)
        h.coordinator.edit("stale callback", context: h.context, lease: old)
        XCTAssertNil(h.coordinator.submit(h.context, lease: old)); XCTAssertEqual(h.draft.text, "draft")
        let calls = await h.transport.calls; XCTAssertTrue(calls.isEmpty)
    }

    @MainActor func testBotAndRoomDraftsRemainDistinctAndSurviveNavigation() {
        let h = ComposerHarness(); h.edit("bot draft")
        let room = ComposerContext(sessionId: h.identity, target: .init(kind: .room, ownerId: "owner", threadId: "room-thread"))
        let lease = h.coordinator.enter(room); h.coordinator.edit("room draft", context: room, lease: lease)
        h.lease = h.coordinator.enter(h.context)
        XCTAssertEqual(h.draft.text, "bot draft"); XCTAssertEqual(h.coordinator.draft(for: room).text, "room draft")
    }

    @MainActor func testCapacityRefusesNewDraftWithoutDiscardingExistingText() {
        let h = ComposerHarness(maximum: 1); h.edit("retained")
        let room = ComposerContext(sessionId: h.identity, target: .init(kind: .room, ownerId: "owner", threadId: "room-thread"))
        var lease = h.coordinator.enter(room)
        h.coordinator.edit("cannot store", context: room, lease: lease)
        XCTAssertEqual(h.coordinator.drafts.count, 1); XCTAssertEqual(h.draft.text, "retained")
        XCTAssertEqual(h.coordinator.draft(for: room).message, ComposerCoordinator.capacityMessage)
        h.lease = h.coordinator.enter(h.context); h.edit("")
        lease = h.coordinator.enter(room); h.coordinator.edit("now fits", context: room, lease: lease)
        XCTAssertEqual(h.coordinator.drafts.count, 1); XCTAssertEqual(h.coordinator.draft(for: room).text, "now fits")
    }

    @MainActor func testTaskRotationAwayAndBackCannotReviveCanceledAcknowledgment() async {
        let h = ComposerHarness(); h.edit("old task"); h.submit(); await h.calls(1)
        h.state.bots[0].threadId = "another-task"; h.coordinator.reconcile()
        h.state.bots[0].threadId = "displayed-thread"; h.coordinator.reconcile()
        await h.transport.resolve(); await h.closed(); XCTAssertEqual(h.draft.text, "old task")
    }

    @MainActor func testWrongAcknowledgmentThreadIsUnconfirmed() async {
        let h = ComposerHarness(); h.edit("original"); h.submit(); await h.calls(1)
        await h.transport.resolve(threadId: "wrong-thread"); await h.closed()
        XCTAssertEqual(h.draft.text, "original"); XCTAssertEqual(h.draft.message, ComposerCoordinator.recoveryMessage)
    }

    @MainActor func testKnownLocalRefusalsKeepDraftAndSpecificRecoveryCopy() async {
        for error in [ComposerSendError.tooLarge, .upgradeRequired] {
            let h = ComposerHarness(); h.edit("  keep exact  "); h.submit(); await h.calls(1)
            await h.transport.reject(error); await h.closed()
            XCTAssertEqual(h.draft.text, "  keep exact  ")
            XCTAssertEqual(h.draft.message, error.localizedDescription)
            XCTAssertFalse(h.draft.message?.contains("Couldn't confirm") ?? true)
        }
    }

    @MainActor func testMissingClientHiddenOwnerAndBlankDraftCannotSend() {
        let h = ComposerHarness(); h.edit("\u{FEFF}\n "); XCTAssertNil(h.submit())
        h.edit("text"); h.state.bots[0].hidden = true; XCTAssertNil(h.submit())
        h.state.bots[0].hidden = false; h.coordinator.bind(sessionId: h.identity, transport: nil)
        h.lease = h.coordinator.enter(h.context); h.edit("not paired"); XCTAssertNil(h.submit()); XCTAssertEqual(h.draft.text, "")
    }

    @MainActor func testOldPhysicalRequestsCountTowardBoundWithoutExposingOldDraft() async {
        let h = ComposerHarness(maximum: 1); h.edit("old secret"); h.submit(); await h.calls(1)
        h.identity = UUID(); h.coordinator.bind(sessionId: h.identity, transport: h.transport)
        h.lease = h.coordinator.enter(h.context); h.edit("new draft")
        XCTAssertNil(h.submit()); XCTAssertEqual(h.draft.text, "new draft"); XCTAssertNotNil(h.draft.message)
        await h.transport.resolve()
        let deadline = Date().addingTimeInterval(2)
        while !h.coordinator.canSend(h.context, lease: h.lease) && Date() < deadline { await Task.yield() }
        XCTAssertTrue(h.coordinator.canSend(h.context, lease: h.lease)); XCTAssertNil(h.draft.message)
    }
}
