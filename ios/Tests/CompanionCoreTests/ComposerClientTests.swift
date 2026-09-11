import XCTest
@testable import CompanionCore

private final class ComposerHTTPPlan: @unchecked Sendable {
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
private final class ComposerHTTPRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var plans: [String: ComposerHTTPPlan] = [:]
    func set(_ host: String, _ plan: ComposerHTTPPlan?) { lock.lock(); defer { lock.unlock() }; plans[host] = plan }
    func get(_ host: String) -> ComposerHTTPPlan? { lock.lock(); defer { lock.unlock() }; return plans[host] }
}
private final class ComposerHTTPProtocol: URLProtocol {
    static let registry = ComposerHTTPRegistry()
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

final class ComposerClientTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var hosts: [String] = []
    private let target = ComposerTarget(kind: .bot, ownerId: "owner", threadId: "displayed-thread")
    override func tearDown() {
        for session in sessions { session.invalidateAndCancel() }
        for host in hosts { ComposerHTTPProtocol.registry.set(host, nil) }
        sessions = []; hosts = []; super.tearDown()
    }
    private func response(_ body: String, status: Int = 202) -> ComposerHTTPPlan.Response {
        .init(status: status, body: Data(body.utf8))
    }
    private var health: ComposerHTTPPlan.Response { response(#"{"app":"muster","messageSendVersion":1}"#, status: 200) }
    private var accepted: ComposerHTTPPlan.Response { response(#"{"ok":true,"threadId":"displayed-thread"}"#) }
    private func fixture(_ responses: [ComposerHTTPPlan.Response?]) -> (CompanionClient, ComposerHTTPPlan) {
        let host = UUID().uuidString.lowercased() + ".invalid"
        let plan = ComposerHTTPPlan(responses); ComposerHTTPProtocol.registry.set(host, plan); hosts.append(host)
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ComposerHTTPProtocol.self]
        let session = URLSession(configuration: configuration); sessions.append(session)
        return (CompanionClient(connection: Connection(name: "Owned fixture", host: host, port: 8810), token: "owned-test-token", session: session), plan)
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

    func testExactRawBodyExpectedThreadAndFreshAuthenticatedCapabilityProbe() async throws {
        let raw = " \u{FEFF} e\u{301}\nsecond line  "
        let echo: [String: Any] = ["ok": true, "threadId": target.threadId,
            "message": ["id": "message-id", "role": "user", "kind": "text", "text": ComposerText.normalized(raw)]]
        let (client, plan) = fixture([health, .init(status: 202, body: try JSONSerialization.data(withJSONObject: echo))])
        let ack = try await client.sendOrdinary(text: raw, to: target)
        XCTAssertEqual(ack.threadId, target.threadId); XCTAssertEqual(ack.messageId, "message-id"); XCTAssertFalse(ack.queued)
        XCTAssertEqual(plan.requests.count, 2)
        let probe = plan.requests[0]; let request = plan.requests[1]
        XCTAssertEqual(probe.httpMethod, "GET"); XCTAssertEqual(probe.url?.path, "/api/health")
        XCTAssertEqual(probe.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
        XCTAssertEqual(probe.value(forHTTPHeaderField: "Cache-Control"), "no-cache, no-store")
        XCTAssertEqual(probe.value(forHTTPHeaderField: "Authorization"), "Bearer owned-test-token")
        XCTAssertEqual(probe.url?.host, request.url?.host); XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/bots/owner/messages"); XCTAssertNil(request.url?.query)
        let payload = try body(request)
        XCTAssertEqual(Set(payload.keys), ["text", "expectedThreadId"])
        XCTAssertTrue((try XCTUnwrap(payload["text"] as? String)).utf16.elementsEqual(raw.utf16))
        XCTAssertEqual(payload["expectedThreadId"] as? String, "displayed-thread")
    }

    func testRoomRouteAndQueuedBotAcknowledgments() async throws {
        let room = ComposerTarget(kind: .room, ownerId: "room-owner", threadId: target.threadId)
        let (roomClient, roomPlan) = fixture([health, accepted])
        _ = try await roomClient.sendOrdinary(text: "room", to: room)
        XCTAssertEqual(roomPlan.requests.last?.url?.path, "/api/groups/room-owner/messages")
        let (botClient, _) = fixture([health, response(#"{"ok":true,"threadId":"displayed-thread","queued":true,"messageId":"queued-id","message":{"id":"queued-id","role":"user","kind":"text","text":"queued"}}"#)])
        let result = try await botClient.sendOrdinary(text: "queued", to: target)
        XCTAssertTrue(result.queued); XCTAssertEqual(result.messageId, "queued-id")
    }

    func testMissingOptionalEchoStillMeansOnlyCheckedNetworkAcknowledgment() async throws {
        let (client, _) = fixture([health, accepted])
        let result = try await client.sendOrdinary(text: "without echo", to: target)
        XCTAssertNil(result.messageId); XCTAssertFalse(result.queued)
    }

    func testLegacyWatchSendContractDoesNotProbeOrRequireNewReceipt() async throws {
        let (client, plan) = fixture([response(#"{"ok":true}"#, status: 200), response(#"{"ok":true}"#, status: 202)])
        try await client.send(text: "watch", toBot: "owner")
        try await client.send(text: "watch room", toRoom: "room-owner")
        XCTAssertEqual(plan.requests.count, 2); XCTAssertTrue(plan.requests.allSatisfy { $0.httpMethod == "POST" })
        XCTAssertEqual(Set(try body(plan.requests[0]).keys), ["text"])
    }

    func testMissingOrMalformedCapabilityNeverSubmits() async {
        for value in [#"{}"#, #"null"#, #"[]"#, #"{"app":"muster"}"#, #"{"app":"other","messageSendVersion":1}"#,
                      #"{"app":"muster","messageSendVersion":true}"#, #"{"app":"muster","messageSendVersion":"1"}"#,
                      #"{"app":"muster","messageSendVersion":null}"#, #"{"app":"muster","messageSendVersion":2}"#] {
            let (client, plan) = fixture([response(value, status: 200)])
            do { _ = try await client.sendOrdinary(text: "keep", to: target); XCTFail("Accepted capability: \(value)") }
            catch { XCTAssertTrue(error is ComposerSendError) }
            XCTAssertEqual(plan.requests.count, 1); XCTAssertEqual(plan.requests.first?.httpMethod, "GET")
        }
    }

    func testCapabilityProbeIsRepeatedForEachExplicitSend() async throws {
        let (client, plan) = fixture([health, accepted, health, accepted])
        _ = try await client.sendOrdinary(text: "one", to: target)
        _ = try await client.sendOrdinary(text: "two", to: target)
        XCTAssertEqual(plan.requests.map(\.httpMethod), ["GET", "POST", "GET", "POST"])
    }

    func testUnexpectedStatusesNeverAcknowledgeSend() async {
        for status in [200, 201, 204, 409, 503] {
            let (client, plan) = fixture([health, response(#"{"ok":true,"threadId":"displayed-thread"}"#, status: status)])
            do { _ = try await client.sendOrdinary(text: "keep", to: target); XCTFail("Accepted status \(status)") } catch {}
            XCTAssertEqual(plan.requests.count, 2)
        }
    }

    func testMalformedAcknowledgmentNeverClearsDraftContract() async {
        for value in [#"{}"#, #"null"#, #"[]"#, #"{"ok":false,"threadId":"displayed-thread"}"#,
                      #"{"ok":true}"#, #"{"ok":true,"threadId":"other-thread"}"#,
                      #"{"ok":true,"threadId":"displayed-thread","message":null}"#,
                      #"{"ok":true,"threadId":"displayed-thread","queued":null}"#,
                      #"{"ok":true,"threadId":"displayed-thread","messageId":null}"#,
                      #"{"ok":true,"threadId":"displayed-thread","queued":true}"#,
                      #"{"ok":true,"threadId":"displayed-thread","messageId":"../invalid"}"#,
                      #"{"ok":true,"threadId":"displayed-thread","message":{"id":"invalid/id","role":"user","kind":"text","text":"keep"}}"#,
                      #"{"ok":true,"threadId":"displayed-thread","message":{"id":"good","role":"bot","kind":"text","text":"keep"}}"#,
                      #"{"ok":true,"threadId":"displayed-thread","message":{"id":"good","role":"user","kind":"text","text":"wrong"}}"#,
                      #"{"ok":true,"threadId":"displayed-thread","messageId":"one","message":{"id":"two","role":"user","kind":"text","text":"keep"}}"#] {
            let (client, plan) = fixture([health, response(value)])
            do { _ = try await client.sendOrdinary(text: "keep", to: target); XCTFail("Accepted malformed receipt: \(value)") } catch {}
            XCTAssertEqual(plan.requests.count, 2)
        }
    }

    func testCanonicallyEquivalentEchoIsNotExactAcknowledgment() async {
        let (client, _) = fixture([health, response(#"{"ok":true,"threadId":"displayed-thread","message":{"id":"good","role":"user","kind":"text","text":"é"}}"#)])
        do { _ = try await client.sendOrdinary(text: "e\u{301}", to: target); XCTFail("Accepted different UTF16 echo") } catch {}
    }

    func testInvalidTargetsAndJavaScriptBlankTextSendNoRequests() async {
        let (client, plan) = fixture([])
        for id in ["", "bad/path", "é", String(repeating: "a", count: 129)] {
            do { _ = try await client.sendOrdinary(text: "valid", to: .init(kind: .bot, ownerId: id, threadId: "thread")); XCTFail("Accepted owner") } catch {}
            do { _ = try await client.sendOrdinary(text: "valid", to: .init(kind: .bot, ownerId: "owner", threadId: id)); XCTFail("Accepted thread") } catch {}
        }
        do { _ = try await client.sendOrdinary(text: "\u{FEFF}\n\u{00A0}", to: target); XCTFail("Accepted blank") } catch {}
        XCTAssertTrue(plan.requests.isEmpty)
        XCTAssertEqual(ComposerText.normalized("\u{FEFF} \u{0085} \u{FEFF}"), "\u{0085}")
        XCTAssertEqual(ComposerText.normalized("\u{180E}"), "\u{180E}")
        XCTAssertTrue(ComposerTarget.validId(String(repeating: "a", count: 128)))
    }

    func testCancellationDuringCapabilityProbeDoesNotSubmit() async {
        let (client, plan) = fixture([nil, accepted])
        let task = Task { try await client.sendOrdinary(text: "keep", to: target) }
        let deadline = Date().addingTimeInterval(2)
        while plan.requests.isEmpty && Date() < deadline { await Task.yield() }
        XCTAssertEqual(plan.requests.count, 1); task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled capability accepted") } catch {}
        XCTAssertEqual(plan.requests.count, 1); XCTAssertEqual(plan.requests.first?.httpMethod, "GET")
    }

    func testUnauthorizedCapabilityStopsBeforePost() async {
        let (client, plan) = fixture([response(#"{"error":"Not paired"}"#, status: 401)])
        do { _ = try await client.sendOrdinary(text: "keep", to: target); XCTFail("Accepted unauthorized probe") }
        catch { XCTAssertTrue((error as? APIError)?.isUnauthorized == true) }
        XCTAssertEqual(plan.requests.count, 1)
    }

    func testEncodedJSONByteLimitIncludesEscapingAndUTF8BeforeAnyProbe() async throws {
        let overhead = try JSONSerialization.data(withJSONObject: ["text": "", "expectedThreadId": target.threadId]).count
        let unit = "\n\"\\é"
        let unitBytes = try JSONSerialization.data(withJSONObject: ["text": unit, "expectedThreadId": target.threadId]).count - overhead
        let repeats = (1_000_000 - overhead) / unitBytes
        let exact = String(repeating: unit, count: repeats) + String(repeating: "a", count: 1_000_000 - overhead - repeats * unitBytes)
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: ["text": exact, "expectedThreadId": target.threadId]).count, 1_000_000)
        let (client, plan) = fixture([health, accepted])
        _ = try await client.sendOrdinary(text: exact, to: target)
        XCTAssertEqual(plan.requests.count, 2)
        let payload = try body(plan.requests[1]); XCTAssertTrue((payload["text"] as? String)?.utf16.elementsEqual(exact.utf16) == true)
        for excess in ["a", "é", "\n"] {
            let (oversized, rejectedPlan) = fixture([])
            do { _ = try await oversized.sendOrdinary(text: exact + excess, to: target); XCTFail("Submitted oversized JSON") }
            catch { XCTAssertTrue(error is ComposerSendError); XCTAssertTrue(error.localizedDescription.contains("too large")) }
            XCTAssertTrue(rejectedPlan.requests.isEmpty)
        }
    }
}
