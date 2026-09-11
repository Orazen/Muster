import XCTest
@testable import CompanionCore

private func seedResponseBytes(_ result: SeedCardResult) throws -> Data {
    var object: [String: Any] = ["ok": result.ok,
        "cardMessage": try JSONSerialization.jsonObject(with: JSONEncoder().encode(result.cardMessage)),
        "userMessage": try result.userMessage.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) } ?? NSNull()]
    if let outcome = result.outcome { object["outcome"] = outcome }
    return try JSONSerialization.data(withJSONObject: object)
}

private final class SeedHTTPPlan: @unchecked Sendable {
    struct Response { var status: Int; var body: Data }
    private let lock = NSLock()
    private var responses: [Response?]
    private var captured: [URLRequest] = []
    private var stopped = 0
    init(_ responses: [Response?]) { self.responses = responses }
    func next(_ request: URLRequest) -> Response? {
        lock.lock(); defer { lock.unlock() }
        captured.append(request)
        return responses.isEmpty ? Response(status: 500, body: Data()) : responses.removeFirst()
    }
    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return captured }
    var stopCount: Int { lock.lock(); defer { lock.unlock() }; return stopped }
    func stop() { lock.lock(); defer { lock.unlock() }; stopped += 1 }
}
private final class SeedHTTPRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var plans: [String: SeedHTTPPlan] = [:]
    func set(_ host: String, _ plan: SeedHTTPPlan?) { lock.lock(); defer { lock.unlock() }; plans[host] = plan }
    func get(_ host: String) -> SeedHTTPPlan? { lock.lock(); defer { lock.unlock() }; return plans[host] }
}
private final class SeedHTTPProtocol: URLProtocol {
    static let registry = SeedHTTPRegistry()
    private var plan: SeedHTTPPlan?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, let plan = Self.registry.get(url.host ?? "") else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        self.plan = plan
        guard let response = plan.next(request) else { return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: response.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { plan?.stop() }
}

final class SeedClientTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var hosts: [String] = []
    override func tearDown() {
        for session in sessions { session.invalidateAndCancel() }
        for host in hosts { SeedHTTPProtocol.registry.set(host, nil) }
        sessions = []; hosts = []
        super.tearDown()
    }
    private func fixture(_ responses: [SeedHTTPPlan.Response?]) -> (CompanionClient, SeedHTTPPlan) {
        let host = UUID().uuidString.lowercased() + ".invalid"
        let plan = SeedHTTPPlan(responses); SeedHTTPProtocol.registry.set(host, plan); hosts.append(host)
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [SeedHTTPProtocol.self]
        let session = URLSession(configuration: configuration); sessions.append(session)
        return (CompanionClient(connection: Connection(name: "Owned fixture", host: host, port: 8810), token: "owned-fixture-token", session: session), plan)
    }
    private func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable { let size = stream.read(&bytes, maxLength: bytes.count); if size <= 0 { break }; data.append(contentsOf: bytes.prefix(size)) }
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testAnswerRoutesExactOwnerCardThreadAndPreservesRawText() async throws {
        let text = "  \n e\u{301}  "
        let (client, plan) = fixture([.init(status: 202, body: try seedResponseBytes(coordinatorResult(text)))])
        let result = try await client.answerSeedCard(botId: "owner-distinct", cardId: "welcome-card", threadId: "thread-distinct", answer: text)
        let request = try XCTUnwrap(plan.requests.first)
        XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(request.url?.path, "/api/bots/owner-distinct/cards/welcome-card/answer")
        XCTAssertNil(request.url?.query); XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer owned-fixture-token")
        let payload = try body(request)
        XCTAssertEqual(Set(payload.keys), ["threadId", "answer"]); XCTAssertEqual(payload["threadId"] as? String, "thread-distinct")
        XCTAssertTrue(SeedCardContract.exactText(try XCTUnwrap(payload["answer"] as? String), text))
        XCTAssertEqual(result.cardMessage.card?.seedAnswer?.status, .starting)
    }

    func testStatusGETHasOnlyThreadQueryAndNoBody() async throws {
        let data = try seedResponseBytes(SeedCardResult(cardMessage: coordinatorQuestion(), userMessage: nil))
        let (client, plan) = fixture([.init(status: 200, body: data)])
        let result = try await client.seedCardStatus(botId: "owner", cardId: "welcome-card", threadId: "thread-distinct")
        let request = try XCTUnwrap(plan.requests.first)
        XCTAssertEqual(request.httpMethod, "GET"); XCTAssertEqual(request.url?.path, "/api/bots/owner/cards/welcome-card/answer")
        XCTAssertEqual(request.url?.query, "threadId=thread-distinct"); XCTAssertNil(request.httpBody); XCTAssertNil(request.httpBodyStream)
        XCTAssertNil(result.userMessage); XCTAssertNil(result.outcome)
    }

    func testStartOnlySendsExpectedAttemptWithoutAnotherAnswer() async throws {
        let (client, plan) = fixture([.init(status: 202, body: try seedResponseBytes(coordinatorResult(status: .starting, attempt: 3)))])
        _ = try await client.startSeedCard(botId: "owner", cardId: "welcome-card", threadId: "thread-distinct", expectedAttempt: 2)
        let request = try XCTUnwrap(plan.requests.first)
        XCTAssertEqual(request.url?.path, "/api/bots/owner/cards/welcome-card/answer/start")
        let payload = try body(request)
        XCTAssertEqual(Set(payload.keys), ["threadId", "expectedAttempt"]); XCTAssertEqual(payload["expectedAttempt"] as? Int, 2)
    }

    func testRejectsInvalidIdentifiersBlankAnswerAndAttemptBeforeAnyRequest() async {
        let (client, plan) = fixture([])
        for operation in 0..<6 {
            do {
                switch operation {
                case 0: _ = try await client.answerSeedCard(botId: "owner/path", cardId: "welcome-card", threadId: "thread", answer: "Life admin")
                case 1: _ = try await client.seedCardStatus(botId: "owner", cardId: "../card", threadId: "thread")
                case 2: _ = try await client.answerSeedCard(botId: "owner", cardId: "welcome-card", threadId: "thread", answer: "\u{FEFF} ")
                case 3: _ = try await client.startSeedCard(botId: "owner", cardId: "welcome-card", threadId: "thread", expectedAttempt: -1)
                case 4: _ = try await client.startSeedCard(botId: "owner", cardId: "welcome-card", threadId: "thread", expectedAttempt: 9_007_199_254_740_992)
                default: _ = try await client.startSeedCard(botId: "owner", cardId: "welcome-card", threadId: "thread", expectedAttempt: SeedCardContract.maximumAttempt)
                }
                XCTFail("Invalid input must fail")
            } catch { }
        }
        XCTAssertTrue(plan.requests.isEmpty)
    }

    func testHTTPFailuresPreserveStatusAndProviderMessage() async throws {
        for status in [400, 401, 403, 404, 409, 500, 503] {
            let (client, _) = fixture([.init(status: status, body: Data(#"{"error":"Owned fixture refusal"}"#.utf8))])
            do { _ = try await client.seedCardStatus(botId: "owner", cardId: "welcome-card", threadId: "thread"); XCTFail("Expected HTTP failure") }
            catch let APIError.status(code, message) { XCTAssertEqual(code, status); XCTAssertEqual(message, "Owned fixture refusal") }
        }
    }

    func testMalformedOrEmptySuccessNeverConfirmsReceipt() async throws {
        for data in [Data(), Data("null".utf8), Data("{".utf8), Data(#"{"ok":true}"#.utf8)] {
            let (client, _) = fixture([.init(status: 202, body: data)])
            do { _ = try await client.answerSeedCard(botId: "owner", cardId: "welcome-card", threadId: "thread", answer: "Life admin"); XCTFail("Malformed receipt must fail") }
            catch { }
        }
    }

    func testWrongCardOrCanonicallyEquivalentDifferentAnswerFails() async throws {
        for wrongCard in [false, true] {
            var result = coordinatorResult("é")
            if wrongCard { result.cardMessage.id = "different-card" }
            let (client, _) = fixture([.init(status: 202, body: try seedResponseBytes(result))])
            do { _ = try await client.answerSeedCard(botId: "owner", cardId: "welcome-card", threadId: "thread", answer: wrongCard ? "é" : "e\u{301}"); XCTFail("Mismatched receipt must fail") }
            catch { }
        }
    }

    func testPOSTRequiresOutcomeAndLinkedUserEvenForSuccessStatus() async throws {
        var noOutcome = coordinatorResult(); noOutcome.outcome = nil
        let unanswered = SeedCardResult(cardMessage: coordinatorQuestion(), userMessage: nil)
        for result in [noOutcome, unanswered] {
            let (client, _) = fixture([.init(status: 202, body: try seedResponseBytes(result))])
            do { _ = try await client.startSeedCard(botId: "owner", cardId: "welcome-card", threadId: "thread", expectedAttempt: 0); XCTFail("POST needs a durable receipt") }
            catch { }
        }
    }

    func testCancellationClosesActualURLSessionRequest() async {
        let (client, plan) = fixture([nil])
        let task = Task { try await client.seedCardStatus(botId: "owner", cardId: "welcome-card", threadId: "thread") }
        let deadline = Date().addingTimeInterval(2)
        while plan.requests.isEmpty && Date() < deadline { await Task.yield() }
        XCTAssertEqual(plan.requests.count, 1)
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled request must fail") } catch { }
        while plan.stopCount == 0 && Date() < deadline { await Task.yield() }
        XCTAssertGreaterThan(plan.stopCount, 0)
    }
}
