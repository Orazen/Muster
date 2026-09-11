import XCTest
@testable import CompanionCore

/// The transport deliberately ignores cancellation until explicitly settled.
private actor HeldApprovalTransport: ApprovalTransport {
    enum Kind: Equatable { case grant, response }
    struct Call { let kind: Kind; let reference: ApprovalReference; let action: ApprovalAction? }
    private(set) var calls: [Call] = []
    private var grants: [Int: CheckedContinuation<ApprovalGrantReceipt, Error>] = [:]
    private var responses: [Int: CheckedContinuation<ApprovalOutcome, Error>] = [:]
    func grantApproval(_ reference: ApprovalReference) async throws -> ApprovalGrantReceipt {
        try await withCheckedThrowingContinuation { continuation in
            let index = calls.count; calls.append(Call(kind: .grant, reference: reference, action: nil)); grants[index] = continuation
        }
    }
    func respondToApproval(_ reference: ApprovalReference, action: ApprovalAction) async throws -> ApprovalOutcome {
        try await withCheckedThrowingContinuation { continuation in
            let index = calls.count; calls.append(Call(kind: .response, reference: reference, action: action)); responses[index] = continuation
        }
    }
    func grant(_ index: Int = 0, receipt: ApprovalGrantReceipt? = nil) {
        grants.removeValue(forKey: index)?.resume(returning: receipt ?? ApprovalFixtures.receipt(calls[index].reference))
    }
    func respond(_ outcome: ApprovalOutcome = .allowedOnce, index: Int = 0) { responses.removeValue(forKey: index)?.resume(returning: outcome) }
    func reject(_ error: Error, index: Int = 0) {
        grants.removeValue(forKey: index)?.resume(throwing: error)
        responses.removeValue(forKey: index)?.resume(throwing: error)
    }
}

@MainActor
private final class ApprovalHarness {
    var state = ApprovalFixtures.state()
    var identity = ApprovalFixtures.sessionId
    var changes = 0
    var unauthorized = 0
    let transport = HeldApprovalTransport()
    var lease: ApprovalViewLease!
    let timeout: UInt64
    let maximum: Int
    lazy var coordinator = ApprovalActionCoordinator(readState: { [unowned self] in state },
        changed: { [unowned self] _ in changes += 1 }, unauthorized: { [unowned self] in unauthorized += 1 },
        timeoutNanoseconds: timeout, maximumContexts: maximum)
    var context: ComposerContext { .init(sessionId: identity, target: ApprovalFixtures.context.target) }
    var reference: ApprovalReference { coordinator.reference(for: context, message: state.messages["thread"]![0])! }
    init(timeout: UInt64 = 20_000_000_000, maximum: Int = 64) {
        self.timeout = timeout; self.maximum = maximum
        coordinator.bind(sessionId: identity, transport: transport); coordinator.setForeground(true); lease = coordinator.enter(context)
    }
    @discardableResult func submit(_ action: ApprovalAction = .alwaysAllow, reference: ApprovalReference? = nil) -> UUID? {
        coordinator.submit(reference ?? self.reference, action: action, lease: lease)
    }
    func calls(_ count: Int) async {
        let deadline = Date().addingTimeInterval(2)
        while await transport.calls.count < count && Date() < deadline { await Task.yield() }
        let actual = await transport.calls.count; XCTAssertEqual(actual, count)
    }
    func assertCallCount(_ count: Int) async { let actual = await transport.calls.count; XCTAssertEqual(actual, count) }
    func closed(_ reference: ApprovalReference) async {
        let deadline = Date().addingTimeInterval(2)
        while coordinator.actions[reference.key]?.inFlight == true && Date() < deadline { await Task.yield() }
        XCTAssertFalse(coordinator.actions[reference.key]?.inFlight == true)
    }
    func failed(_ reference: ApprovalReference) async {
        let deadline = Date().addingTimeInterval(2)
        while coordinator.actionState(for: reference)?.phase != .failed && Date() < deadline { await Task.yield() }
        XCTAssertEqual(coordinator.actionState(for: reference)?.phase, .failed)
    }
}

final class ApprovalCoordinatorTests: XCTestCase {
    @MainActor func testSynchronousPhysicalLockAndGrantThenAnswerOrdering() async throws {
        let h = ApprovalHarness(); let reference = h.reference
        XCTAssertNotNil(h.submit()); XCTAssertNil(h.submit(.allow)); XCTAssertNil(h.submit(.deny))
        await h.calls(1); let firstCall = await h.transport.calls[0]; XCTAssertEqual(firstCall.kind, .grant)
        h.state.bots[0].alwaysAllow = ["Bash:fixture"]; h.coordinator.reconcile()
        await h.transport.grant(); await h.calls(2)
        let call = await h.transport.calls[1]
        XCTAssertEqual(call.kind, .response); XCTAssertEqual(call.action, .alwaysAllow)
        XCTAssertTrue(h.coordinator.actionState(for: reference)!.grantSaved)
        await h.transport.respond(index: 1); await h.closed(reference)
        XCTAssertEqual(h.coordinator.actionState(for: reference)?.phase, .settled)
        XCTAssertNil(h.submit(.allow)); XCTAssertNil(h.state.messages["thread"]?[0].card?.answered, "No optimistic transcript mutation")
    }

    @MainActor func testGrantFailureNeverAnswersAndPreservesActionableRefusal() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(); await h.calls(1)
        await h.transport.reject(APIError.status(code: 409, message: "Remove an existing saved tool before adding another."))
        await h.closed(reference)
        let state = h.coordinator.actionState(for: reference)!
        XCTAssertEqual(state.phase, .failed); XCTAssertFalse(state.grantSaved)
        XCTAssertTrue(state.message!.contains("No permission answer was sent"))
        XCTAssertTrue(state.message!.contains("Remove an existing saved tool"))
        await h.assertCallCount(1)
    }

    @MainActor func testLegacyUpgradeNeverAnswersAndExplainsUpdate() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(); await h.calls(1)
        await h.transport.reject(ApprovalError.upgradeRequired); await h.closed(reference)
        XCTAssertEqual(h.coordinator.actionState(for: reference)?.message, ApprovalError.upgradeRequired.localizedDescription)
        await h.assertCallCount(1)
    }

    @MainActor func testLostGrantIsUnconfirmedAndNeverAutomaticallyReplayed() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(); await h.calls(1)
        await h.transport.reject(APIError.status(code: 502, message: "Muster is not running")); await h.closed(reference)
        let message = h.coordinator.actionState(for: reference)!.message!
        XCTAssertTrue(message.contains("whether the preference was saved")); XCTAssertFalse(message.contains("not running"))
        h.coordinator.reconcile(); h.coordinator.setForeground(false); h.coordinator.setForeground(true)
        await h.assertCallCount(1)
    }

    @MainActor func testSavedGrantThenLostAnswerRetainsBothFacts() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(); await h.calls(1)
        await h.transport.grant(); await h.calls(2)
        await h.transport.reject(APIError.transport("lost after accepted"), index: 1); await h.closed(reference)
        let state = h.coordinator.actionState(for: reference)!
        XCTAssertTrue(state.grantSaved); XCTAssertEqual(state.phase, .failed)
        XCTAssertTrue(state.message!.contains("preference was saved")); XCTAssertTrue(state.message!.contains("Couldn't confirm the answer"))
        await h.assertCallCount(2)
    }

    @MainActor func testUnavailableReceiptSurvivesSSESettlementWithoutReplay() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(); await h.calls(1)
        await h.transport.grant(); await h.calls(2)
        h.state.messages["thread"]?[0].card?.answered = "unavailable"
        h.state.messages["thread"]?[0].card?.dismissed = true; h.coordinator.reconcile()
        await h.transport.respond(.unavailable, index: 1); await h.closed(reference)
        let state = h.coordinator.actionState(for: h.context, cardId: reference.cardId, requestId: reference.requestId)
        XCTAssertEqual(state?.phase, .failed); XCTAssertEqual(state?.outcome, .unavailable); XCTAssertEqual(state?.grantSaved, true)
        XCTAssertTrue(state!.message!.contains("not delivered")); XCTAssertNil(h.submit(.allow, reference: reference))
    }

    @MainActor func testAcceptedReceiptArrivingAfterSSEIsStillAccepted() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(.deny); await h.calls(1)
        h.state.messages["thread"]?[0].card?.answered = "deny"; h.coordinator.reconcile()
        await h.transport.respond(.rejected); await h.closed(reference)
        XCTAssertEqual(h.coordinator.actionState(for: reference)?.outcome, .rejected)
    }

    @MainActor func testUnknownOrWrongOutcomeCannotSettle() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(.deny); await h.calls(1)
        await h.transport.respond(.allowedOnce); await h.closed(reference)
        XCTAssertEqual(h.coordinator.actionState(for: reference)?.phase, .failed)
        XCTAssertNil(h.coordinator.actionState(for: reference)?.outcome)
    }

    @MainActor func testLeaveBeforeTaskDispatchDoesNothing() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(); h.coordinator.leave(h.lease)
        await h.closed(reference); await h.assertCallCount(0)
    }

    @MainActor func testTaskRotationDuringGrantNeverAnswersOriginalOrNewTask() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(); await h.calls(1)
        h.state.bots[0].threadId = "new-task"; h.coordinator.reconcile()
        await h.transport.grant(); await h.closed(reference)
        await h.assertCallCount(1); XCTAssertEqual(h.coordinator.actions[reference.key]?.phase, .failed)
    }

    @MainActor func testChangedCardSignatureAndBranchDuringGrantNeverAnswer() async {
        for branch in [false, true] {
            let h = ApprovalHarness(); let reference = h.reference; h.submit(); await h.calls(1)
            if branch { h.state.bots[0].activeLeafId = "missing" }
            else { h.state.messages["thread"]?[0].card?.allowKey = "Bash:other" }
            h.coordinator.reconcile(); await h.transport.grant(); await h.closed(reference)
            await h.assertCallCount(1)
        }
    }

    @MainActor func testSettlementDuringGrantStopsContinuationButKeepsCheckedSave() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(); await h.calls(1)
        h.state.messages["thread"]?[0].card?.answered = "deny"; h.coordinator.reconcile()
        await h.transport.grant(); await h.closed(reference)
        await h.assertCallCount(1)
        XCTAssertEqual(h.coordinator.actionState(for: reference)?.grantSaved, true)
        XCTAssertTrue(h.coordinator.actionState(for: reference)!.message!.contains("No permission answer was sent"))
    }

    @MainActor func testLeaveReturnRetainsLockUntilIgnoredCancellationSettles() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(); await h.calls(1)
        h.coordinator.leave(h.lease); h.lease = h.coordinator.enter(h.context)
        XCTAssertTrue(h.coordinator.actionState(for: reference)!.inFlight); XCTAssertNil(h.submit(.allow))
        await h.transport.grant(); await h.closed(reference)
        await h.assertCallCount(1)
        XCTAssertNotNil(h.submit(.deny)); await h.calls(2); await h.transport.respond(.rejected, index: 1); await h.closed(reference)
    }

    @MainActor func testBackgroundAndReconnectCancelWithoutAutomaticReplay() async {
        for reconnect in [false, true] {
            let h = ApprovalHarness(); let reference = h.reference; h.submit(.allow); await h.calls(1)
            if reconnect { h.coordinator.connectionChanged() } else { h.coordinator.setForeground(false); h.coordinator.setForeground(true) }
            XCTAssertNil(h.submit(.allow)); await h.transport.respond(); await h.closed(reference)
            XCTAssertEqual(h.coordinator.actionState(for: reference)?.phase, .failed)
            await h.assertCallCount(1)
        }
    }

    @MainActor func testTimeoutRetainsPhysicalLockAndLateReceiptCannotClaimSuccess() async {
        let h = ApprovalHarness(timeout: 1_000_000); let reference = h.reference; h.submit(.allow); await h.calls(1)
        await h.failed(reference); XCTAssertTrue(h.coordinator.actionState(for: reference)!.inFlight); XCTAssertNil(h.submit(.allow))
        await h.transport.respond(); await h.closed(reference)
        XCTAssertNil(h.coordinator.actionState(for: reference)?.outcome); XCTAssertEqual(h.coordinator.actionState(for: reference)?.phase, .failed)
    }

    @MainActor func testNewSessionDoesNotAdoptOldGrantOrUseReplacementTransport() async {
        let h = ApprovalHarness(); h.submit(); await h.calls(1)
        let replacement = HeldApprovalTransport(); h.identity = UUID()
        h.coordinator.bind(sessionId: h.identity, transport: replacement); h.lease = h.coordinator.enter(h.context)
        await h.transport.grant()
        let deadline = Date().addingTimeInterval(2)
        while await h.transport.calls.count > 1 && Date() < deadline { await Task.yield() }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertTrue(h.coordinator.actions.isEmpty); let replacementCount = await replacement.calls.count; XCTAssertEqual(replacementCount, 0)
        await h.assertCallCount(1)
    }

    @MainActor func testOldSessionPhysicalClosurePublishesCapacityChange() async {
        let h = ApprovalHarness(maximum: 1); h.submit(.allow); await h.calls(1)
        h.identity = UUID(); h.coordinator.bind(sessionId: h.identity, transport: h.transport); h.lease = h.coordinator.enter(h.context)
        let reference = h.reference; XCTAssertFalse(h.coordinator.canSubmit(reference, lease: h.lease))
        let changes = h.changes; await h.transport.respond()
        let deadline = Date().addingTimeInterval(2)
        while h.changes == changes && Date() < deadline { await Task.yield() }
        XCTAssertGreaterThan(h.changes, changes); XCTAssertTrue(h.coordinator.canSubmit(reference, lease: h.lease))
    }

    @MainActor func testOldLeaseCannotSubmitOrDismissNewLease() {
        let h = ApprovalHarness(); let old = h.lease!
        h.lease = h.coordinator.enter(h.context); h.coordinator.leave(old)
        XCTAssertFalse(h.coordinator.canSubmit(h.reference, lease: old))
        XCTAssertTrue(h.coordinator.canSubmit(h.reference, lease: h.lease))
    }

    @MainActor func testEnteringAndLeavingPublishWithoutRequestsOrSSE() {
        let h = ApprovalHarness(); let before = h.changes
        h.coordinator.leave(h.lease); XCTAssertGreaterThan(h.changes, before)
        let afterLeave = h.changes; h.lease = h.coordinator.enter(h.context)
        XCTAssertGreaterThan(h.changes, afterLeave)
        XCTAssertTrue(h.coordinator.canSubmit(h.reference, lease: h.lease))
    }

    @MainActor func testChangedSameIDCardDoesNotInheritSavedOrAcceptedFeedback() async {
        let h = ApprovalHarness(); let old = h.reference; h.submit(); await h.calls(1)
        await h.transport.grant(); await h.calls(2); await h.transport.respond(index: 1); await h.closed(old)
        XCTAssertEqual(h.coordinator.actionState(for: h.context, cardId: old.cardId, requestId: old.requestId)?.grantSaved, true)
        h.state.messages["thread"]?[0].card?.allowKey = "Bash:new-tool"; h.coordinator.reconcile()
        XCTAssertNil(h.coordinator.actionState(for: h.context, cardId: old.cardId, requestId: old.requestId))
        XCTAssertNil(h.coordinator.actionState(for: old)); XCTAssertTrue(h.coordinator.canSubmit(h.reference, lease: h.lease))
    }

    @MainActor func testPhysicalKeyExcludesRenderedCardIdentity() async {
        let h = ApprovalHarness(); let reference = h.reference; h.submit(.allow); await h.calls(1)
        h.state.messages["thread"]?[0].id = "replacement-card"; h.state.bots[0].activeLeafId = "replacement-card"
        h.coordinator.reconcile(); XCTAssertNil(h.submit(.deny))
        await h.transport.respond(); await h.closed(reference)
    }

    @MainActor func testUnauthorizedOnlyAppliesToCurrentUncancelledOperation() async {
        for cancelled in [false, true] {
            let h = ApprovalHarness(); let reference = h.reference; h.submit(.allow); await h.calls(1)
            if cancelled { h.coordinator.leave(h.lease) }
            await h.transport.reject(APIError.status(code: 401, message: nil)); await h.closed(reference)
            XCTAssertEqual(h.unauthorized, cancelled ? 0 : 1)
        }
    }
}
