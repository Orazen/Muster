import XCTest
@testable import CompanionCore

private actor CallFixture: ForegroundCallTransport {
    struct Request: Sendable { let action: String; let capability: String; let requestId: String?; let text: String? }
    var requests: [Request] = []
    var record: ForegroundCallRecord?
    var heldAction: String?
    var failureAction: String?
    var notFoundAction: String?
    private var held: [CheckedContinuation<ForegroundCallRecord, Error>] = []
    func hold(_ action: String) { heldAction = action }
    func fail(_ action: String?) { failureAction = action }
    func missing(_ action: String?) { notFoundAction = action }
    func resolve(_ result: ForegroundCallRecord) { let pending = held; held = []; pending.forEach { $0.resume(returning: result) } }
    func replace(_ value: ForegroundCallRecord) { record = value }
    func value() -> ForegroundCallRecord { record! }
    private func run(_ action: String, capability: String, requestId: String? = nil, text: String? = nil) async throws -> ForegroundCallRecord {
        requests.append(.init(action: action, capability: capability, requestId: requestId, text: text))
        if failureAction == action { throw URLError(.networkConnectionLost) }
        if notFoundAction == action { throw APIError.status(code: 404, message: nil) }
        if heldAction == action { return try await withCheckedThrowingContinuation { held.append($0) } }
        return record!
    }
    func beginCall(botId: String, threadId: String, requestId: String, capability: String) async throws -> ForegroundCallRecord {
        record = .init(id: requestId, botId: botId, threadId: threadId, state: .ringing, revision: 1, expiresAt: 100000, endReason: nil, turn: nil)
        return try await run("begin", capability: capability, requestId: requestId)
    }
    func readCall(botId: String, callId: String, capability: String) async throws -> ForegroundCallRecord { try await run("read", capability: capability) }
    func acceptCall(botId: String, callId: String, capability: String) async throws -> ForegroundCallRecord {
        record = changed(state: .connected)
        return try await run("accept", capability: capability)
    }
    func sendCallMessage(botId: String, callId: String, requestId: String, text: String, capability: String) async throws -> ForegroundCallRecord {
        record = changed(turn: .init(requestId: requestId, state: .working, messageId: "message", reply: nil, error: nil))
        return try await run("send", capability: capability, requestId: requestId, text: text)
    }
    func endCall(botId: String, callId: String, capability: String) async throws -> ForegroundCallRecord {
        record = changed(state: .ended)
        return try await run("end", capability: capability)
    }
    func changed(state: ForegroundCallRecord.State? = nil, revision: Int? = nil, bot: String? = nil, turn: ForegroundCallTurn? = nil) -> ForegroundCallRecord {
        let r = record!
        return .init(id: r.id, botId: bot ?? r.botId, threadId: r.threadId, state: state ?? r.state, revision: revision ?? r.revision + 1,
                     expiresAt: r.expiresAt, endReason: nil, turn: turn ?? r.turn)
    }
    func wait(_ action: String) async {
        for _ in 0..<10000 { if requests.contains(where: { $0.action == action }) { return }; await Task.yield() }
        XCTFail("Missing transport operation \(action)")
    }
}

@MainActor
final class ForegroundCallTests: XCTestCase {
    private func fixture() -> (ForegroundCallCoordinator, CallFixture) {
        let transport = CallFixture(); let coordinator = ForegroundCallCoordinator()
        coordinator.bind(sessionId: UUID(), transport: transport)
        return (coordinator, transport)
    }
    private func connected() async -> (ForegroundCallCoordinator, CallFixture) {
        let (c, t) = fixture(); await c.begin(botId: "bot", threadId: "thread"); await c.accept(); return (c, t)
    }
    func testRingAcceptExplicitSendAndMemoryCapability() async {
        let (c,t) = fixture(); await c.begin(botId: "bot", threadId: "thread")
        XCTAssertEqual(c.phase, .ringing); await c.send("not accepted")
        var calls = await t.requests; XCTAssertEqual(calls.map(\.action), ["begin"])
        await c.accept(); await c.send("  plan my day  ")
        calls = await t.requests; XCTAssertEqual(calls.map(\.action), ["begin", "accept", "send"])
        XCTAssertEqual(calls.last?.text, "plan my day")
        XCTAssertEqual(Set(calls.map(\.capability)).count, 1)
        XCTAssertEqual(calls[0].capability.count, 64)
        XCTAssertNotNil(UUID(uuidString: calls.last!.requestId!))
        await c.send("second while busy")
        let after = await t.requests; XCTAssertEqual(after.count, 3)
        await c.end(); XCTAssertEqual(c.phase, .ended)
        await c.begin(botId: "bot", threadId: "thread")
        let next = await t.requests; XCTAssertNotEqual(next.first?.capability, next.last?.capability)
    }
    func testUncertainSendNeverReplaysAndReadReconcilesSameRequest() async {
        let (c,t) = await connected(); await t.fail("send"); await c.send("plan")
        XCTAssertEqual(c.phase, .uncertain); let id = c.pendingRequestId; XCTAssertNotNil(id)
        await c.send("plan"); await t.fail(nil); await c.poll()
        XCTAssertEqual(c.call?.turn?.requestId, id); XCTAssertNil(c.pendingRequestId)
        let calls = await t.requests; XCTAssertEqual(calls.filter { $0.action == "send" }.count, 1)
    }
    func testEndFailureIsExplicitAndRetriesOnlyEndWithSameCapability() async {
        let (c,t) = await connected(); await t.fail("end"); await c.end()
        XCTAssertEqual(c.phase, .uncertain); XCTAssertTrue(c.notice!.contains("may still be working"))
        await c.poll(); await c.send("no"); await c.begin(botId: "other", threadId: "other")
        let before = await t.requests; XCTAssertEqual(before.map(\.action), ["begin", "accept", "end"])
        await t.fail(nil); await c.end(); XCTAssertEqual(c.phase, .ended)
        let after = await t.requests; XCTAssertEqual(after.suffix(2).map(\.capability), [before.last!.capability, before.last!.capability])
    }
    func testBackgroundEndsAndDiscardsLateRead() async {
        let (c,t) = await connected(); let old = await t.value(); await t.hold("read")
        let reading = Task { await c.poll() }; await t.wait("read")
        await c.setForeground(false); XCTAssertEqual(c.phase, .ended)
        await t.resolve(old); await reading.value; XCTAssertEqual(c.phase, .ended)
        await c.begin(botId: "bot", threadId: "thread")
        let calls = await t.requests; XCTAssertEqual(calls.filter { $0.action == "begin" }.count, 1)
    }
    func testNewAccountDiscardsLateBegin() async {
        let (c,t) = fixture(); await t.hold("begin")
        let beginning = Task { await c.begin(botId: "bot", threadId: "thread") }; await t.wait("begin")
        let old = await t.value(); c.bind(sessionId: UUID(), transport: CallFixture())
        await t.resolve(old); await beginning.value
        XCTAssertEqual(c.phase, .idle); XCTAssertNil(c.call)
    }
    func testEndInvalidatesInFlightSendBeforeResponse() async {
        let (c,t) = await connected(); await t.hold("send")
        let sending = Task { await c.send("plan") }; await t.wait("send"); let old = await t.value()
        await c.end(); await t.resolve(old); await sending.value
        XCTAssertEqual(c.phase, .ended); XCTAssertEqual(c.call?.state, .ended)
    }
    func testRevisionRegressionIsIgnoredAndForeignIdentityRefused() async {
        let (c,t) = await connected(); let original = c.call
        await t.replace(await t.changed(revision: 0)); await c.poll(); XCTAssertEqual(c.call, original)
        await t.replace(await t.changed(revision: 4, bot: "other")); await c.poll()
        XCTAssertEqual(c.phase, .uncertain); XCTAssertEqual(c.call, original)
    }
    func testUncertainBeginReadsOriginalIdRatherThanCreatingAgain() async {
        let (c,t) = fixture(); await t.fail("begin"); await c.begin(botId: "bot", threadId: "thread")
        XCTAssertEqual(c.phase, .uncertain); await c.begin(botId: "bot", threadId: "thread")
        await t.fail(nil); await c.poll(); XCTAssertEqual(c.phase, .ringing)
        let calls = await t.requests; XCTAssertEqual(calls.map(\.action), ["begin", "read"])
    }
    func testInvalidTextNeverLeavesDevice() async {
        let (c,t) = await connected(); await c.send(" \n "); await c.send(String(repeating: "x", count: 8001))
        let calls = await t.requests; XCTAssertEqual(calls.count, 2)
    }
    func testCancelledCallerCannotApplyLateAcknowledgment() async {
        let (c,t) = await connected(); await t.hold("send")
        let sending = Task { await c.send("plan") }; await t.wait("send"); let receipt = await t.value()
        sending.cancel(); await t.resolve(receipt); await sending.value
        XCTAssertEqual(c.phase, .uncertain); XCTAssertNotNil(c.pendingRequestId); XCTAssertNil(c.call?.turn)
    }
    func testUnknownHostStateNeverRecreatesCallOrReplaysWork() async {
        let (c,t) = await connected(); await t.fail("read"); await c.poll(); await c.poll()
        await c.begin(botId: "bot", threadId: "thread"); await c.send("plan")
        XCTAssertEqual(c.phase, .uncertain)
        let calls = await t.requests; XCTAssertEqual(calls.map(\.action), ["begin", "accept", "read", "read"])
    }
    func testOtherRequestReceiptDoesNotReleaseUncertainMessage() async {
        let (c,t) = await connected(); await t.fail("send"); await c.send("plan")
        let pending = c.pendingRequestId
        await t.fail(nil)
        let other = ForegroundCallTurn(requestId: UUID().uuidString.lowercased(), state: .completed, messageId: "other", reply: "other reply", error: nil)
        await t.replace(await t.changed(turn: other)); await c.poll(); await c.send("new plan")
        XCTAssertEqual(c.pendingRequestId, pending)
        let calls = await t.requests; XCTAssertEqual(calls.filter { $0.action == "send" }.count, 1)
    }

    func testConcurrentEndSubmissionsShareOneTransportRequest() async {
        let (c,t) = await connected(); await t.hold("end")
        let first = Task { await c.end() }; await t.wait("end")
        let second = Task { await c.end() }
        for _ in 0..<100 { await Task.yield() }
        let calls = await t.requests
        XCTAssertEqual(calls.filter { $0.action == "end" }.count, 1)
        await t.resolve(await t.value())
        await first.value; await second.value
        XCTAssertEqual(c.phase, .ended)
    }

    func testMissingHostCallNeedsExplicitLocalDismissalBeforeNewCall() async {
        let (c,t) = await connected(); await t.missing("read"); await c.poll()
        XCTAssertEqual(c.phase, .uncertain); XCTAssertTrue(c.canDismissUnknown)
        await c.begin(botId: "bot", threadId: "thread")
        let before = await t.requests; XCTAssertEqual(before.filter { $0.action == "begin" }.count, 1)
        c.dismissUnknownCall()
        XCTAssertEqual(c.phase, .ended); XCTAssertNil(c.call); XCTAssertNil(c.pendingRequestId)
        XCTAssertTrue(c.notice!.contains("may still be running"))
        let dismissed = await t.requests; XCTAssertEqual(dismissed.count, before.count)
        await c.begin(botId: "bot", threadId: "thread")
        let after = await t.requests; XCTAssertEqual(after.filter { $0.action == "begin" }.count, 2)
        XCTAssertNotEqual(after.first?.capability, after.last?.capability)
    }
    func testNetworkUncertaintyCannotBeDismissedAsMissingCall() async {
        let (c,t) = await connected(); await t.fail("read"); await c.poll()
        XCTAssertFalse(c.canDismissUnknown); c.dismissUnknownCall()
        XCTAssertEqual(c.phase, .uncertain); XCTAssertNotNil(c.call)
    }
    func testForegroundFenceIsImmediateAndCannotEndReboundAccount() async {
        let (c,t) = await connected()
        c.setForegroundImmediately(false)
        XCTAssertEqual(c.phase, .ending)
        let next = CallFixture(); c.bind(sessionId: UUID(), transport: next)
        c.setForegroundImmediately(true)
        await c.begin(botId: "new-bot", threadId: "new-thread")
        for _ in 0..<100 { await Task.yield() }
        XCTAssertEqual(c.phase, .ringing); XCTAssertEqual(c.call?.botId, "new-bot")
        let calls = await next.requests; XCTAssertEqual(calls.map(\.action), ["begin"])
        let old = await t.requests; XCTAssertEqual(old.filter { $0.action == "end" }.count, 1)
    }
    func testQuickForegroundResumeStillEndsCapturedCallOnce() async {
        let (c,t) = await connected()
        c.setForegroundImmediately(false); c.setForegroundImmediately(true)
        await c.end()
        XCTAssertEqual(c.phase, .ended)
        let calls = await t.requests; XCTAssertEqual(calls.filter { $0.action == "end" }.count, 1)
    }

    func testAccountChangeDoesNotDuplicateAnEndAlreadyOnTheTransport() async {
        let (c,t) = await connected(); await t.hold("end")
        c.endImmediately(); await t.wait("end")
        let receipt = await t.value()
        c.bind(sessionId: UUID(), transport: CallFixture())
        for _ in 0..<100 { await Task.yield() }
        let calls = await t.requests; XCTAssertEqual(calls.filter { $0.action == "end" }.count, 1)
        await t.resolve(receipt)
        for _ in 0..<100 { await Task.yield() }
        XCTAssertEqual(c.phase, .idle); XCTAssertNil(c.call)
    }

}
