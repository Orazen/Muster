import XCTest
@testable import CompanionCore

private final class CallHTTPPlan: @unchecked Sendable {
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
private final class CallHTTPRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var plans: [String: CallHTTPPlan] = [:]
    func set(_ host: String, _ plan: CallHTTPPlan?) { lock.lock(); defer { lock.unlock() }; plans[host] = plan }
    func get(_ host: String) -> CallHTTPPlan? { lock.lock(); defer { lock.unlock() }; return plans[host] }
}
private final class CallHTTPProtocol: URLProtocol {
    static let registry = CallHTTPRegistry()
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

final class ForegroundCallClientTests: XCTestCase {
    private let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let message = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    private let capability = String(repeating: "ab", count: 32)
    private var sessions: [URLSession] = []
    private var hosts: [String] = []
    override func tearDown() {
        sessions.forEach { $0.invalidateAndCancel() }; hosts.forEach { CallHTTPProtocol.registry.set($0, nil) }
        super.tearDown()
    }
    private func fixture() -> (CompanionClient, CallHTTPPlan) {
        let host = UUID().uuidString.lowercased() + ".invalid"
        let body = Data("{\"call\":{\"id\":\"\(id)\",\"botId\":\"bot\",\"threadId\":\"thread\",\"state\":\"connected\",\"revision\":2,\"expiresAt\":123456}}".utf8)
        let plan = CallHTTPPlan([201,200,200,202,200].map { .init(status: $0, body: body) })
        CallHTTPProtocol.registry.set(host, plan); hosts.append(host)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CallHTTPProtocol.self]
        let session = URLSession(configuration: config); sessions.append(session)
        return (CompanionClient(connection: Connection(name: "Owned", host: host, port: 8810), token: "paired-device", session: session), plan)
    }
    private func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }; var bytes = [UInt8](repeating: 0, count: 1024)
            while true { let size = stream.read(&bytes, maxLength: bytes.count); if size <= 0 { break }; data.append(contentsOf: bytes.prefix(size)) }
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    func testExactRoutesHeadersBodiesAnd202Receipt() async throws {
        let (client, plan) = fixture()
        _ = try await client.beginCall(botId: "bot", threadId: "thread", requestId: id, capability: capability)
        _ = try await client.readCall(botId: "bot", callId: id, capability: capability)
        _ = try await client.acceptCall(botId: "bot", callId: id, capability: capability)
        _ = try await client.sendCallMessage(botId: "bot", callId: id, requestId: message, text: "  plan  ", capability: capability)
        _ = try await client.endCall(botId: "bot", callId: id, capability: capability)
        let requests = plan.requests
        XCTAssertEqual(requests.map { $0.httpMethod }, ["POST", "GET", "POST", "POST", "POST"])
        XCTAssertEqual(requests.map { $0.url!.path }, ["/api/bots/bot/calls", "/api/bots/bot/calls/\(id)", "/api/bots/bot/calls/\(id)/accept", "/api/bots/bot/calls/\(id)/messages", "/api/bots/bot/calls/\(id)/end"])
        for request in requests {
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-device")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Muster-Call-Token"), capability)
            XCTAssertNil(request.url!.query)
            XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
        }
        XCTAssertEqual(try body(requests[0])["threadId"] as? String, "thread")
        XCTAssertEqual(try body(requests[0])["requestId"] as? String, id)
        XCTAssertNil(requests[1].httpBody)
        XCTAssertTrue(try body(requests[2]).isEmpty)
        XCTAssertEqual(try body(requests[3])["requestId"] as? String, message)
        XCTAssertEqual(try body(requests[3])["text"] as? String, "plan")
        XCTAssertTrue(try body(requests[4]).isEmpty)
    }
    func testMalformedTargetsAndCapabilityFailBeforeNetwork() async {
        let (client, plan) = fixture()
        do { _ = try await client.readCall(botId: "../other", callId: id, capability: capability); XCTFail("accepted path") } catch {}
        do { _ = try await client.readCall(botId: "bot", callId: "../other", capability: capability); XCTFail("accepted id") } catch {}
        do { _ = try await client.readCall(botId: "bot", callId: id, capability: String(repeating: "A", count: 64)); XCTFail("accepted token") } catch {}
        do { _ = try await client.sendCallMessage(botId: "bot", callId: id, requestId: message, text: " ", capability: capability); XCTFail("accepted text") } catch {}
        XCTAssertTrue(plan.requests.isEmpty)
    }
}
