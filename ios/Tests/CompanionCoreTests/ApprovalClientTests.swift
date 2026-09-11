import XCTest
@testable import CompanionCore

private final class ApprovalHTTPPlan: @unchecked Sendable {
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
private final class ApprovalHTTPRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var plans: [String: ApprovalHTTPPlan] = [:]
    func set(_ host: String, _ plan: ApprovalHTTPPlan?) { lock.lock(); defer { lock.unlock() }; plans[host] = plan }
    func get(_ host: String) -> ApprovalHTTPPlan? { lock.lock(); defer { lock.unlock() }; return plans[host] }
}
private final class ApprovalHTTPProtocol: URLProtocol {
    static let registry = ApprovalHTTPRegistry()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, let plan = Self.registry.get(url.host ?? "") else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        guard let response = plan.next(request) else { return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: response.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class ApprovalClientTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var hosts: [String] = []
    private let reference = ApprovalFixtures.reference()
    override func tearDown() {
        for session in sessions { session.invalidateAndCancel() }
        for host in hosts { ApprovalHTTPProtocol.registry.set(host, nil) }
        sessions = []; hosts = []; super.tearDown()
    }
    private func response(_ raw: String, status: Int = 200) -> ApprovalHTTPPlan.Response { .init(status: status, body: Data(raw.utf8)) }
    private var health: ApprovalHTTPPlan.Response { response(#"{"app":"muster","approvalActionVersion":1}"#) }
    private func grant(_ reference: ApprovalReference) throws -> ApprovalHTTPPlan.Response {
        .init(status: 200, body: try JSONSerialization.data(withJSONObject: ApprovalFixtures.grantBody(reference)))
    }
    private func fixture(_ responses: [ApprovalHTTPPlan.Response?]) -> (CompanionClient, ApprovalHTTPPlan) {
        let host = UUID().uuidString.lowercased() + ".invalid"
        let plan = ApprovalHTTPPlan(responses); ApprovalHTTPProtocol.registry.set(host, plan); hosts.append(host)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ApprovalHTTPProtocol.self]
        let session = URLSession(configuration: config); sessions.append(session)
        return (CompanionClient(connection: Connection(name: "Owned fixture", host: host, port: 8810), token: "owned-token", session: session), plan)
    }
    private func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let size = stream.read(&bytes, maxLength: bytes.count); if size <= 0 { break }
                data.append(contentsOf: bytes.prefix(size))
            }
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testGuardedGrantUsesFreshAuthenticatedCapabilityAndExactTuple() async throws {
        let reference = ApprovalFixtures.reference(ApprovalFixtures.message(requestId: "  provider:é/😀  "))
        let (client, plan) = fixture([health, try grant(reference)])
        let receipt = try await client.grantApproval(reference)
        XCTAssertTrue(receipt.matches(reference))
        XCTAssertEqual(plan.requests.count, 2)
        let probe = plan.requests[0], request = plan.requests[1]
        XCTAssertEqual(probe.httpMethod, "GET"); XCTAssertEqual(probe.url?.path, "/api/health")
        XCTAssertEqual(probe.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
        XCTAssertEqual(probe.value(forHTTPHeaderField: "Cache-Control"), "no-cache, no-store")
        XCTAssertEqual(probe.value(forHTTPHeaderField: "Authorization"), "Bearer owned-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer owned-token")
        XCTAssertEqual(probe.url?.host, request.url?.host); XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/bots/owner/always-allow")
        let payload = try body(request)
        XCTAssertEqual(Set(payload.keys), ["allowKey", "expectedThreadId", "requestId", "cardId"])
        XCTAssertEqual(payload["expectedThreadId"] as? String, "thread"); XCTAssertEqual(payload["cardId"] as? String, "card")
        XCTAssertTrue(ApprovalContract.exact(try XCTUnwrap(payload["requestId"] as? String), reference.requestId))
        XCTAssertTrue(ApprovalContract.exact(try XCTUnwrap(payload["allowKey"] as? String), reference.allowKey!))
    }

    func testEveryExplicitGrantHasItsOwnCapabilityProbe() async throws {
        let (client, plan) = fixture([health, try grant(reference), health, try grant(reference)])
        _ = try await client.grantApproval(reference); _ = try await client.grantApproval(reference)
        XCTAssertEqual(plan.requests.map(\.httpMethod), ["GET", "POST", "GET", "POST"])
    }

    func testLegacyMissingAndMalformedHealthNeverSendsGrant() async {
        for raw in [#"{}"#, #"null"#, #"[]"#, #"{"app":"muster"}"#,
                    #"{"app":"other","approvalActionVersion":1}"#, #"{"app":"muster","approvalActionVersion":true}"#,
                    #"{"app":"muster","approvalActionVersion":"1"}"#, #"{"app":"muster","approvalActionVersion":null}"#,
                    #"{"app":"muster","approvalActionVersion":2}"#] {
            let (client, plan) = fixture([response(raw)])
            do { _ = try await client.grantApproval(reference); XCTFail("Accepted invalid health: \(raw)") }
            catch { XCTAssertEqual(error as? ApprovalError, .upgradeRequired) }
            XCTAssertEqual(plan.requests.count, 1); XCTAssertEqual(plan.requests[0].httpMethod, "GET")
        }
    }

    func testHealthStatusMustBe200AndAuthorizationFailuresPreserved() async {
        for status in [201, 204, 401, 403, 503] {
            let (client, plan) = fixture([response(#"{"app":"muster","approvalActionVersion":1}"#, status: status)])
            do { _ = try await client.grantApproval(reference); XCTFail("Accepted status \(status)") }
            catch { if status == 401 { XCTAssertEqual((error as? APIError)?.isUnauthorized, true) } }
            XCTAssertEqual(plan.requests.count, 1)
        }
    }

    func testCancelledHealthCannotContinueToGrant() async throws {
        let (client, plan) = fixture([nil, try grant(reference)])
        let reference = self.reference
        let task = Task { try await client.grantApproval(reference) }
        let deadline = Date().addingTimeInterval(2)
        while plan.requests.isEmpty && Date() < deadline { await Task.yield() }
        XCTAssertEqual(plan.requests.count, 1); task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled health returned a grant") } catch {}
        XCTAssertEqual(plan.requests.count, 1)
    }

    func testCancellationBeforeEntrySendsNothing() async {
        let (client, plan) = fixture([health]); let reference = self.reference
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await client.grantApproval(reference)
        }
        do { _ = try await task.value; XCTFail("Cancelled entry succeeded") } catch {}
        XCTAssertTrue(plan.requests.isEmpty)
    }

    func testGrantUnexpectedStatusAndMalformedReceiptAreUnconfirmed() async {
        for (raw, status) in [(#"{"bot":{}}"#, 200), (#"{"bot":{},"grant":null}"#, 200), ("{}", 201), ("", 204), ("{}", 409), ("{}", 503)] {
            let (client, plan) = fixture([health, response(raw, status: status)])
            do { _ = try await client.grantApproval(reference); XCTFail("Accepted bad grant") } catch {}
            XCTAssertEqual(plan.requests.count, 2)
        }
    }

    func testStrictRespondHasExplicitPermissionBehaviorAndMatchingOutcome() async throws {
        for (action, outcome) in [(ApprovalAction.allow, "allowed-once"), (.deny, "rejected"), (.alwaysAllow, "allowed-once")] {
            let (client, plan) = fixture([response("{\"ok\":true,\"outcome\":\"\(outcome)\"}")])
            let actual = try await client.respondToApproval(reference, action: action)
            XCTAssertEqual(actual.rawValue, outcome); XCTAssertEqual(plan.requests.count, 1)
            XCTAssertEqual(plan.requests[0].url?.path, "/api/threads/thread/respond")
            let payload = try body(plan.requests[0]); XCTAssertEqual(Set(payload.keys), ["requestId", "behavior"])
            XCTAssertEqual(payload["behavior"] as? String, action.behavior)
        }
    }

    func testQuestionAnswerRawBytesAreNotPermissionMapping() async throws {
        let raw = "  e\u{301}\nAllow  "
        let reference = ApprovalFixtures.reference(ApprovalFixtures.message(tool: nil, options: [raw, "Allow", "Deny"]))
        let (client, plan) = fixture([response(#"{"ok":true,"outcome":"answered"}"#)])
        _ = try await client.respondToApproval(reference, action: .answer(raw))
        let payload = try body(plan.requests[0]); XCTAssertEqual(payload["behavior"] as? String, "answer")
        XCTAssertTrue(ApprovalContract.exact(try XCTUnwrap(payload["message"] as? String), raw))
    }

    func testUnavailableResponseIsExplicitAndNotAllowedOnce() async throws {
        let (client, _) = fixture([response(#"{"ok":true,"outcome":"unavailable"}"#)])
        let outcome = try await client.respondToApproval(reference, action: .allow)
        XCTAssertEqual(outcome, .unavailable)
    }

    func testRespondRejectsUnexpectedStatusAndMissingMismatchedOutcome() async {
        for (raw, status) in [(#"{"ok":true}"#, 200), (#"{"ok":true,"outcome":null}"#, 200),
                              (#"{"ok":true,"outcome":"answered"}"#, 200), (#"{"ok":true,"outcome":"allowed-once"}"#, 202),
                              ("", 204), ("{}", 503)] {
            let (client, plan) = fixture([response(raw, status: status)])
            do { _ = try await client.respondToApproval(reference, action: .allow); XCTFail("Accepted bad answer receipt") } catch {}
            XCTAssertEqual(plan.requests.count, 1)
        }
    }

    func testLegacyWatchPublicMethodsRemainSourceAndWireCompatible() async throws {
        let (client, plan) = fixture([response("{}"), response("{}")])
        try await client.alwaysAllow(botId: "owner", key: "Bash:fixture")
        try await client.respond(threadId: "thread", requestId: "legacy", behavior: "allow")
        XCTAssertEqual(plan.requests.count, 2); XCTAssertTrue(plan.requests.allSatisfy { $0.httpMethod == "POST" })
        XCTAssertEqual(Set(try body(plan.requests[0]).keys), ["allowKey"])
    }
}
