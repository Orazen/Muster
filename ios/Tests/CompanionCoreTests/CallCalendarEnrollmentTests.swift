import XCTest
@testable import CompanionCore

private final class EnrollmentHTTPPlan: @unchecked Sendable {
    struct Response { let status: Int; let body: Data }
    private let lock = NSLock()
    private var responses: [Response?]
    private var captured: [URLRequest] = []
    init(_ responses: [Response?]) { self.responses = responses }
    func next(_ request: URLRequest) -> Response? {
        lock.lock(); defer { lock.unlock() }
        captured.append(request)
        return responses.isEmpty ? Response(status: 500, body: Data()) : responses.removeFirst()
    }
    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return captured }
}
private final class EnrollmentHTTPRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var plans: [String: EnrollmentHTTPPlan] = [:]
    func set(_ host: String, _ plan: EnrollmentHTTPPlan?) { lock.lock(); defer { lock.unlock() }; plans[host] = plan }
    func get(_ host: String) -> EnrollmentHTTPPlan? { lock.lock(); defer { lock.unlock() }; return plans[host] }
}
private final class EnrollmentHTTPProtocol: URLProtocol {
    static let registry = EnrollmentHTTPRegistry()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, let plan = Self.registry.get(url.host ?? "") else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        guard let response = plan.next(request) else { return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: response.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private let enrollmentID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
private let callID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
private let callToken = String(repeating: "ab", count: 32)
private let calendarToken = String(repeating: "cd", count: 32)
private let scope = CallCalendarScope(botId: "bot", threadId: "thread", callId: callID, capability: callToken)
private func receipt(_ state: CallCalendarEnrollment.State, issued: Bool = false, thread: String = "thread", id: String = enrollmentID, expired: Bool = false) -> CallCalendarEnrollmentReceipt {
    .init(enrollment: .init(id: id, code: state == .waiting ? "0123ABCD" : nil, state: state,
        expiresAt: Date().timeIntervalSince1970 * 1000 + (expired ? -1 : 300_000), botId: "bot", threadId: thread, callId: callID),
        issued: issued ? .init(token: calendarToken, grant: .init(id: "grant", label: "Work", calendarId: "selected", expiresAt: Date().timeIntervalSince1970 * 1000 + 60_000)) : nil)
}
private actor EnrollmentFake: CallCalendarTransport {
    var starts = 0, checks = 0, cancels = 0, prepares = 0
    var activeID = enrollmentID
    var holdCancel = false, wrongID = false, expired = false
    var cancelWait: CheckedContinuation<Void, Never>?
    func configureCancel() { holdCancel = true }
    func configureReceipt(wrongID: Bool = false, expired: Bool = false) { self.wrongID = wrongID; self.expired = expired }
    func waitingCancel() -> Bool { cancelWait != nil }
    func releaseCancel() { cancelWait?.resume(); cancelWait = nil }
    var holdCheck = false, failCheck = false, holdPrepare = false, wrongThread = false
    var checkWait: CheckedContinuation<CallCalendarEnrollmentReceipt, Error>?
    var prepareWait: CheckedContinuation<CallCalendarPlanDraft, Error>?
    func configure(holdCheck: Bool = false, failCheck: Bool = false, holdPrepare: Bool = false, wrongThread: Bool = false) {
        self.holdCheck = holdCheck; self.failCheck = failCheck; self.holdPrepare = holdPrepare; self.wrongThread = wrongThread
    }
    func beginCalendarEnrollment(botId: String, callId: String, capability: String, requestId: String) async throws -> CallCalendarEnrollmentReceipt {
        starts += 1; activeID = requestId
        return receipt(.waiting, thread: wrongThread ? "other" : "thread", id: wrongID ? enrollmentID : activeID, expired: expired)
    }
    func checkCalendarEnrollment(botId: String, callId: String, capability: String, enrollmentId: String) async throws -> CallCalendarEnrollmentReceipt {
        checks += 1
        if holdCheck { return try await withCheckedThrowingContinuation { checkWait = $0 } }
        if failCheck { throw URLError(.networkConnectionLost) }
        return receipt(.consumed, issued: true, id: activeID)
    }
    func cancelCalendarEnrollment(botId: String, callId: String, capability: String, enrollmentId: String) async throws {
        cancels += 1
        if holdCancel { await withCheckedContinuation { cancelWait = $0 } }
    }
    func prepareCallCalendarPlan(botId: String, callId: String, capability: String, calendarCapability: String, input: CallCalendarPlanRequest) async throws -> CallCalendarPlanDraft {
        prepares += 1
        if holdPrepare { return try await withCheckedThrowingContinuation { prepareWait = $0 } }
        return .init(draft: "Unsent proposal", date: input.date, timeZone: input.timeZone, calendarId: "selected")
    }
    func releaseCheck() { checkWait?.resume(returning: receipt(.consumed, issued: true, id: activeID)); checkWait = nil }
    func releasePrepare() { prepareWait?.resume(returning: .init(draft: "late", date: "2026-09-20", timeZone: "UTC", calendarId: "selected")); prepareWait = nil }
    func waitingCheck() -> Bool { checkWait != nil }
    func waitingPrepare() -> Bool { prepareWait != nil }
    func counts() -> [Int] { [starts, checks, cancels, prepares] }
}
@MainActor final class CallCalendarCoordinatorTests: XCTestCase {
    private let input = CallCalendarPlanRequest(date: "2026-09-20", timeZone: "UTC", workStart: "09:00", workEnd: "17:00", commitments: [.init(title: "Report", minutes: 30)])
    func testReplacementReservesOperationWhileCancellationIsPending() async {
        let fake = EnrollmentFake(), coordinator = CallCalendarCoordinator()
        coordinator.bind(scope: scope, transport: fake, issued: nil, save: { _ in })
        await coordinator.start(); await fake.configureCancel()
        let replacement = Task { await coordinator.start() }
        for _ in 0..<1000 { if await fake.waitingCancel() { break }; await Task.yield() }
        XCTAssertTrue(coordinator.busy)
        await coordinator.start()
        let before = await fake.counts(); XCTAssertEqual(before[0], 1); XCTAssertEqual(before[2], 1)
        await fake.releaseCancel(); await replacement.value
        let after = await fake.counts(); XCTAssertEqual(after[0], 2); XCTAssertFalse(coordinator.busy)
    }
    func testResetWhileReplacementCancellationPendingCannotStartOldContext() async {
        let fake = EnrollmentFake(), coordinator = CallCalendarCoordinator()
        coordinator.bind(scope: scope, transport: fake, issued: nil, save: { _ in })
        await coordinator.start(); await fake.configureCancel()
        let replacement = Task { await coordinator.start() }
        for _ in 0..<1000 { if await fake.waitingCancel() { break }; await Task.yield() }
        coordinator.reset(); await fake.releaseCancel(); await replacement.value
        let counts = await fake.counts(); XCTAssertEqual(counts[0], 1); XCTAssertNil(coordinator.enrollment)
    }
    func testMismatchedAndExpiredStartReceiptsNeverShowCode() async {
        for expired in [false, true] {
            let fake = EnrollmentFake(), coordinator = CallCalendarCoordinator()
            await fake.configureReceipt(wrongID: !expired, expired: expired)
            coordinator.bind(scope: scope, transport: fake, issued: nil, save: { _ in XCTFail("Saved invalid receipt") })
            await coordinator.start()
            XCTAssertNil(coordinator.code); XCTAssertNil(coordinator.enrollment); XCTAssertNotNil(coordinator.notice)
        }
    }
    func testApprovalOnlyPersistsThenExplicitPreparationReturnsUnsentDraft() async throws {
        let fake = EnrollmentFake(), coordinator = CallCalendarCoordinator(); var saved = 0
        coordinator.bind(scope: scope, transport: fake, issued: nil, save: { _ in saved += 1 })
        await coordinator.start(); XCTAssertEqual(coordinator.code, "0123ABCD")
        await coordinator.check(); XCTAssertEqual(saved, 1); XCTAssertNil(coordinator.code)
        let before = await fake.counts(); XCTAssertEqual(before, [1, 1, 0, 0])
        let draft = await coordinator.prepare(input); XCTAssertEqual(draft?.draft, "Unsent proposal")
        let after = await fake.counts(); XCTAssertEqual(after, [1, 1, 0, 1])
    }
    func testLateConsumedReceiptCannotPersistAfterContextReset() async throws {
        let fake = EnrollmentFake(), coordinator = CallCalendarCoordinator(); var saved = 0
        await fake.configure(holdCheck: true)
        coordinator.bind(scope: scope, transport: fake, issued: nil, save: { _ in saved += 1 })
        await coordinator.start()
        let task = Task { await coordinator.check() }
        for _ in 0..<1000 { if await fake.waitingCheck() { break }; await Task.yield() }
        let waiting = await fake.waitingCheck(); XCTAssertTrue(waiting)
        coordinator.reset(); await fake.releaseCheck(); await task.value
        XCTAssertEqual(saved, 0); XCTAssertNil(coordinator.issued); XCTAssertNil(coordinator.enrollment)
    }
    func testLostConsumeReceiptRequiresExplicitNewEnrollmentNoReplay() async {
        let fake = EnrollmentFake(), coordinator = CallCalendarCoordinator()
        await fake.configure(failCheck: true)
        coordinator.bind(scope: scope, transport: fake, issued: nil, save: { _ in XCTFail("Persisted failed receipt") })
        await coordinator.start(); await coordinator.check(); await coordinator.check()
        XCTAssertNil(coordinator.enrollment); XCTAssertNotNil(coordinator.notice)
        let counts = await fake.counts(); XCTAssertEqual(counts[1], 1)
        await coordinator.start(); let restarted = await fake.counts(); XCTAssertEqual(restarted[0], 2)
    }
    func testLatePreparedDraftDiscardedOnEndOrAccountSwitch() async {
        let fake = EnrollmentFake(), coordinator = CallCalendarCoordinator()
        await fake.configure(holdPrepare: true)
        coordinator.bind(scope: scope, transport: fake, issued: receipt(.consumed, issued: true).issued, save: { _ in })
        let task = Task { await coordinator.prepare(input) }
        for _ in 0..<1000 { if await fake.waitingPrepare() { break }; await Task.yield() }
        let waiting = await fake.waitingPrepare(); XCTAssertTrue(waiting)
        coordinator.reset(); await fake.releasePrepare()
        let result = await task.value; XCTAssertNil(result); XCTAssertFalse(coordinator.busy)
    }
    func testWrongThreadReceiptAndMissingCapabilityNeverEnablePreparation() async {
        let fake = EnrollmentFake(), coordinator = CallCalendarCoordinator()
        await fake.configure(wrongThread: true)
        coordinator.bind(scope: scope, transport: fake, issued: nil, save: { _ in XCTFail("Saved wrong scope") })
        await coordinator.start(); XCTAssertNil(coordinator.enrollment); XCTAssertNotNil(coordinator.notice)
        let result = await coordinator.prepare(input); XCTAssertNil(result)
        let counts = await fake.counts(); XCTAssertEqual(counts[3], 0)
    }
    func testCancelInvalidatesLateConsumption() async {
        let fake = EnrollmentFake(), coordinator = CallCalendarCoordinator(); var saved = 0
        await fake.configure(holdCheck: true)
        coordinator.bind(scope: scope, transport: fake, issued: nil, save: { _ in saved += 1 })
        await coordinator.start(); let task = Task { await coordinator.check() }
        for _ in 0..<1000 { if await fake.waitingCheck() { break }; await Task.yield() }
        await coordinator.cancel(); await fake.releaseCheck(); await task.value
        XCTAssertEqual(saved, 0); XCTAssertNil(coordinator.code)
        let counts = await fake.counts(); XCTAssertEqual(counts[2], 1)
    }
}
final class CallCalendarEnrollmentClientTests: XCTestCase {
    func testExactEnrollmentRoutesNeverForwardCalendarCapability() async throws {
        let host = UUID().uuidString.lowercased() + ".invalid"
        let plan = EnrollmentHTTPPlan([
            .init(status: 201, body: try JSONEncoder().encode(receipt(.waiting))),
            .init(status: 200, body: try JSONEncoder().encode(receipt(.consumed, issued: true))),
            .init(status: 200, body: Data("{\"ok\":true}".utf8))])
        EnrollmentHTTPProtocol.registry.set(host, plan)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [EnrollmentHTTPProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel(); EnrollmentHTTPProtocol.registry.set(host, nil) }
        let client = CompanionClient(connection: .init(name: "Owned", host: host, port: 8810), token: "paired", session: session)
        _ = try await client.beginCalendarEnrollment(botId: "bot", callId: callID, capability: callToken, requestId: enrollmentID)
        let consumed = try await client.checkCalendarEnrollment(botId: "bot", callId: callID, capability: callToken, enrollmentId: enrollmentID)
        XCTAssertTrue(consumed.issued?.token == calendarToken)
        try await client.cancelCalendarEnrollment(botId: "bot", callId: callID, capability: callToken, enrollmentId: enrollmentID)
        XCTAssertEqual(plan.requests.map { $0.url!.path }, ["calendar-enrollment", "calendar-enrollment-status", "calendar-enrollment-cancel"].map { "/api/bots/bot/calls/\(callID)/\($0)" })
        for (index, request) in plan.requests.enumerated() {
            XCTAssertEqual(request.httpMethod, "POST"); XCTAssertNil(request.url?.query)
            XCTAssertTrue(request.value(forHTTPHeaderField: "X-Muster-Call-Token") == callToken)
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Muster-Calendar-Token"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired")
            var data = request.httpBody ?? Data()
            if data.isEmpty, let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }; var bytes = [UInt8](repeating: 0, count: 1024)
                while true { let n = stream.read(&bytes, maxLength: bytes.count); if n <= 0 { break }; data.append(contentsOf: bytes.prefix(n)) }
            }
            let body = try JSONDecoder().decode([String: String].self, from: data)
            XCTAssertEqual(body, [index == 0 ? "requestId" : "enrollmentId": enrollmentID])
        }
        do { _ = try await client.checkCalendarEnrollment(botId: "bot", callId: callID, capability: callToken, enrollmentId: "../bad"); XCTFail("Invalid identifier accepted") } catch {}
        XCTAssertEqual(plan.requests.count, 3)
    }
}
