import CompanionCore
import Foundation
import XCTest
@testable import MusterMacCore

/// Deliberately ignores cancellation until the test releases each response:
/// a queued completion must not regain authority after disconnect/account swap.
private actor DelayedNativeTransport: NativeSessionTransport {
    private var rosters: [CheckedContinuation<Fleet, Error>] = []
    private var memories: [CheckedContinuation<String, Error>] = []
    private var sends: [CheckedContinuation<SendReceipt, Error>] = []
    private var streams: [CheckedContinuation<Void, Error>] = []
    private var onEvent: (@Sendable (StreamFrame) -> Void)?
    private var onHello: (@Sendable (String, Bool) -> Void)?
    private(set) var streamCount = 0
    var waitingRosters: Int { rosters.count }
    var waitingMemories: Int { memories.count }
    var waitingSends: Int { sends.count }

    func roster(messages: Int) async throws -> Fleet {
        try await withCheckedThrowingContinuation { rosters.append($0) }
    }
    func memory(botId: String) async throws -> String {
        try await withCheckedThrowingContinuation { memories.append($0) }
    }
    func send(text: String, to botId: String, clientIntentId: String) async throws -> SendReceipt {
        try await withCheckedThrowingContinuation { sends.append($0) }
    }
    func respond(botId: String, requestId: String, behavior: String, message: String?) async throws -> MusterMacCore.ApprovalOutcome {
        try JSONDecoder().decode(MusterMacCore.ApprovalOutcome.self, from: Data(#"{"ok":true}"#.utf8))
    }
    func events(lastEventId: String?, onEvent: @escaping @Sendable (StreamFrame) -> Void,
                onHello: @escaping @Sendable (String, Bool) -> Void) async throws {
        self.onEvent = onEvent
        self.onHello = onHello
        streamCount += 1
        try await withCheckedThrowingContinuation { streams.append($0) }
    }
    func releaseRoster(_ value: Fleet) { rosters.removeFirst().resume(returning: value) }
    func failRoster() { rosters.removeFirst().resume(throwing: MusterTransportError.server(401, nil)) }
    func releaseMemory(_ value: String) { memories.removeFirst().resume(returning: value) }
    func releaseSend() {
        sends.removeFirst().resume(returning: SendReceipt(intentId: "old", messageId: "old-message", threadId: "thread-scout", state: "accepted"))
    }
    func emit(_ frame: StreamFrame) { onEvent?(frame) }
    func hello(resumed: Bool) { onHello?("fixture:0", resumed) }
    func dropStream() { streams.removeFirst().resume() }
    func finish() {
        for value in rosters { value.resume(throwing: CancellationError()) }; rosters = []
        for value in memories { value.resume(throwing: CancellationError()) }; memories = []
        for value in sends { value.resume(throwing: CancellationError()) }; sends = []
        for value in streams { value.resume(throwing: CancellationError()) }; streams = []
        onEvent = nil; onHello = nil
    }
}

@MainActor
final class LiveSessionLifecycleTests: XCTestCase {
    private func account(_ name: String) -> HarnessAccount {
        HarnessAccount(origin: "https://\(name).fixture.invalid", cookieName: "better-auth.session_token", cookieValue: "synthetic-\(name)")
    }
    private func fleet(_ name: String) -> Fleet {
        let sample = FixtureFleet.standard()
        var bot = sample.fleet.bots[0]
        bot.name = name
        bot.messages = sample.transcript
        return Fleet(bots: [bot], groups: [])
    }
    private func waitFor(_ predicate: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !(await predicate()) && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
        guard await predicate() else {
            XCTFail("Condition did not settle", file: file, line: line)
            throw URLError(.timedOut)
        }
    }
    private func drain() async throws { try await Task.sleep(nanoseconds: 30_000_000) }
    private func model(_ old: DelayedNativeTransport, next: DelayedNativeTransport? = nil) -> LiveSessionModel {
        let model = LiveSessionModel(transportFactory: { account in
            account.origin.contains("new.") ? (next ?? old) : old
        })
        addTeardownBlock { @MainActor in
            model.disconnect()
            await old.finish()
            if let next { await next.finish() }
        }
        return model
    }
    private func start(_ model: LiveSessionModel, _ transport: DelayedNativeTransport, name: String) async throws {
        model.connect(account: account(name))
        try await waitFor { await transport.waitingRosters == 1 }
        await transport.releaseRoster(fleet(name))
        try await waitFor { await transport.streamCount == 1 }
        XCTAssertEqual(model.state, .live)
    }

    func testDisconnectFencesDelayedBootstrapSuccessWithoutRestoringPrivateRows() async throws {
        let transport = DelayedNativeTransport(); let model = model(transport)
        model.connect(account: account("old"))
        try await waitFor { await transport.waitingRosters == 1 }
        model.disconnect()
        await transport.releaseRoster(fleet("old"))
        try await drain()
        XCTAssertEqual(model.state, .signedOut)
        XCTAssertNil(model.account)
        XCTAssertTrue(model.fleet.bots.isEmpty)
        XCTAssertTrue(model.transcripts.isEmpty)
        let count = await transport.streamCount
        XCTAssertEqual(count, 0)
    }

    func testDisconnectFencesDelayedBootstrapFailure() async throws {
        let transport = DelayedNativeTransport(); let model = model(transport)
        model.connect(account: account("old"))
        try await waitFor { await transport.waitingRosters == 1 }
        model.disconnect()
        await transport.failRoster()
        try await drain()
        XCTAssertEqual(model.state, .signedOut)
    }

    func testNewAccountWinsWhenOldBootstrapCompletesLast() async throws {
        let old = DelayedNativeTransport(); let next = DelayedNativeTransport(); let model = model(old, next: next)
        model.connect(account: account("old"))
        try await waitFor { await old.waitingRosters == 1 }
        try await start(model, next, name: "new")
        await old.releaseRoster(fleet("old"))
        try await drain()
        XCTAssertEqual(model.account, account("new"))
        XCTAssertEqual(model.fleet.bots.first?.name, "new")
        XCTAssertEqual(model.state, .live)
        let count = await old.streamCount
        XCTAssertEqual(count, 0)
    }

    func testQueuedOldStreamFramesAndHelloCannotReviveDisconnectedSession() async throws {
        let transport = DelayedNativeTransport(); let model = model(transport)
        try await start(model, transport, name: "old")
        model.disconnect()
        await transport.hello(resumed: false)
        await transport.emit(StreamFrame(frame: .message(threadId: "old-thread", message: FixtureFleet.standard().transcript[0]), seq: 1))
        try await drain()
        XCTAssertEqual(model.state, .signedOut)
        XCTAssertNil(model.account)
        XCTAssertTrue(model.transcripts.isEmpty)
        let waiting = await transport.waitingRosters
        XCTAssertEqual(waiting, 0, "Old hello must not start rehydration")
    }

    func testOldMemoryReplyCannotEnterNewAccount() async throws {
        let old = DelayedNativeTransport(); let next = DelayedNativeTransport(); let model = model(old, next: next)
        try await start(model, old, name: "old")
        let memory = Task { await model.loadMemory(botId: "bot-scout") }
        try await waitFor { await old.waitingMemories == 1 }
        try await start(model, next, name: "new")
        await old.releaseMemory("private old-account memory")
        await memory.value
        XCTAssertTrue(model.memoryText.isEmpty)
        XCTAssertEqual(model.account, account("new"))
    }

    func testDelayedRehydrationCannotRestoreDataAfterLogout() async throws {
        let transport = DelayedNativeTransport(); let model = model(transport)
        try await start(model, transport, name: "old")
        await transport.hello(resumed: false)
        try await waitFor { await transport.waitingRosters == 1 }
        model.disconnect()
        await transport.releaseRoster(fleet("old"))
        try await drain()
        XCTAssertTrue(model.fleet.bots.isEmpty)
        XCTAssertTrue(model.transcripts.isEmpty)
        XCTAssertEqual(model.state, .signedOut)
    }

    func testDisconnectCancelsScheduledReconnect() async throws {
        let transport = DelayedNativeTransport(); let model = model(transport)
        try await start(model, transport, name: "old")
        await transport.dropStream()
        try await waitFor { if case .degraded = model.state { return true }; return false }
        model.disconnect()
        try await Task.sleep(nanoseconds: 2_100_000_000)
        XCTAssertEqual(model.state, .signedOut)
        let count = await transport.streamCount
        XCTAssertEqual(count, 1)
    }

    func testOldSendCompletionCannotRestorePendingRowsOrNewAccountDraft() async throws {
        let old = DelayedNativeTransport(); let next = DelayedNativeTransport(); let model = model(old, next: next)
        try await start(model, old, name: "old")
        model.draft = "old account task"
        let send = Task { await model.sendDraft() }
        try await waitFor { await old.waitingSends == 1 }
        XCTAssertEqual(model.pendingSends.count, 1)
        try await start(model, next, name: "new")
        model.draft = "new account task"
        await old.releaseSend()
        await send.value
        XCTAssertTrue(model.pendingSends.isEmpty)
        XCTAssertEqual(model.draft, "new account task")
        XCTAssertEqual(model.account, account("new"))
    }
}
