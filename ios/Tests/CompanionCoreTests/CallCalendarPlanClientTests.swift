import XCTest
@testable import CompanionCore

private final class CalendarHTTPPlan: @unchecked Sendable {
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
private final class CalendarHTTPRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var plans: [String: CalendarHTTPPlan] = [:]
    func set(_ host: String, _ plan: CalendarHTTPPlan?) { lock.lock(); defer { lock.unlock() }; plans[host] = plan }
    func get(_ host: String) -> CalendarHTTPPlan? { lock.lock(); defer { lock.unlock() }; return plans[host] }
}
private final class CalendarHTTPProtocol: URLProtocol {
    static let registry = CalendarHTTPRegistry()
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

final class CallCalendarPlanClientTests: XCTestCase {
    private let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let capability = String(repeating: "ab", count: 32)
    private let calendarCapability = String(repeating: "cd", count: 32)
    private var sessions: [URLSession] = []
    private var hosts: [String] = []
    private var input: CallCalendarPlanRequest {
        .init(date: "2026-09-20", timeZone: "Europe/Rome", workStart: "09:00", workEnd: "17:00",
              commitments: [.init(title: "Prepare report", minutes: 45)])
    }
    override func tearDown() {
        sessions.forEach { $0.invalidateAndCancel() }; hosts.forEach { CalendarHTTPProtocol.registry.set($0, nil) }
        super.tearDown()
    }
    private func fixture(status: Int = 200, response: String = "{\"draft\":\"Review this proposal\",\"date\":\"2026-09-20\",\"timeZone\":\"Europe/Rome\",\"calendarId\":\"selected-calendar\"}") -> (CompanionClient, CalendarHTTPPlan) {
        let host = UUID().uuidString.lowercased() + ".invalid"
        let plan = CalendarHTTPPlan([.init(status: status, body: Data(response.utf8))])
        CalendarHTTPProtocol.registry.set(host, plan); hosts.append(host)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CalendarHTTPProtocol.self]
        let session = URLSession(configuration: config); sessions.append(session)
        return (CompanionClient(connection: Connection(name: "Owned", host: host, port: 8810), token: "paired-device", session: session), plan)
    }
    private func body(_ request: URLRequest) throws -> Data {
        if let data = request.httpBody { return data }
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open(); defer { stream.close() }
        var data = Data(), bytes = [UInt8](repeating: 0, count: 1024)
        while true { let size = stream.read(&bytes, maxLength: bytes.count); if size <= 0 { break }; data.append(contentsOf: bytes.prefix(size)) }
        return data
    }
    func testPreparationHasExactScopeHeadersBodyAndReturnsOnlyDraftWithoutDispatch() async throws {
        let (client, plan) = fixture()
        let result = try await client.prepareCallCalendarPlan(botId: "bot", callId: id, capability: capability, calendarCapability: calendarCapability, input: input)
        XCTAssertEqual(result.draft, "Review this proposal")
        XCTAssertEqual(result.date, input.date); XCTAssertEqual(result.timeZone, input.timeZone)
        XCTAssertEqual(result.calendarId, "selected-calendar")
        XCTAssertEqual(plan.requests.count, 1)
        let request = try XCTUnwrap(plan.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/bots/bot/calls/\(id)/prepare-calendar")
        XCTAssertNil(request.url?.query)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-device")
        XCTAssertTrue(request.value(forHTTPHeaderField: "X-Muster-Call-Token") == capability)
        XCTAssertTrue(request.value(forHTTPHeaderField: "X-Muster-Calendar-Token") == calendarCapability)
        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-cache, no-store")
        let data = try body(request)
        XCTAssertEqual(try JSONDecoder().decode(CallCalendarPlanRequest.self, from: data), input)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), Set(["date", "timeZone", "workStart", "workEnd", "commitments"]))
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(text.contains(capability)); XCTAssertFalse(text.contains(calendarCapability))
    }
    func testMalformedCapabilitiesAndTargetsNeverReachNetwork() async {
        let (client, plan) = fixture()
        for invalid in ["", String(repeating: "A", count: 64), String(repeating: "a", count: 63), "\r\nInvalid"] {
            do { _ = try await client.prepareCallCalendarPlan(botId: "bot", callId: id, capability: capability, calendarCapability: invalid, input: input); XCTFail("Accepted invalid calendar capability") } catch {}
        }
        for (bot, call, token) in [("../other", id, capability), ("bot", "../other", capability), ("bot", id, "invalid")] {
            do { _ = try await client.prepareCallCalendarPlan(botId: bot, callId: call, capability: token, calendarCapability: calendarCapability, input: input); XCTFail("Accepted invalid call scope") } catch {}
        }
        XCTAssertTrue(plan.requests.isEmpty)
    }
    func testStatusErrorsPreserveStatusWithoutRetryOrDispatch() async {
        for status in [400, 401, 403, 404, 409, 502] {
            let (client, plan) = fixture(status: status, response: "{\"error\":\"Calendar preparation unavailable\"}")
            do { _ = try await client.prepareCallCalendarPlan(botId: "bot", callId: id, capability: capability, calendarCapability: calendarCapability, input: input); XCTFail("Accepted error response") }
            catch APIError.status(let code, let message) { XCTAssertEqual(code, status); XCTAssertEqual(message, "Calendar preparation unavailable") }
            catch { XCTFail("Unexpected error type") }
            XCTAssertEqual(plan.requests.count, 1)
        }
    }
    func testIncompleteResponseCannotBecomeDraft() async {
        let (client, plan) = fixture(response: "{\"draft\":\"incomplete\"}")
        do { _ = try await client.prepareCallCalendarPlan(botId: "bot", callId: id, capability: capability, calendarCapability: calendarCapability, input: input); XCTFail("Accepted incomplete response") }
        catch APIError.transport(let message) { XCTAssertFalse(message.contains(capability)); XCTAssertFalse(message.contains(calendarCapability)) }
        catch { XCTFail("Unexpected error type") }
        XCTAssertEqual(plan.requests.count, 1)
    }
}
