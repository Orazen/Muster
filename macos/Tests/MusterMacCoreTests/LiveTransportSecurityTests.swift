import Foundation
import Network
import XCTest
import CompanionCore
@testable import MusterMacCore

/// Real HTTP over two ephemeral loopback listeners, never a URLProtocol
/// redirect simulation. Each fixture owns and awaits all of its connections.
private final class NativeRedirectOrigin: @unchecked Sendable {
    struct Request: Sendable { let method: String; let path: String; let cookie: String?; let body: Data }
    enum Response: Sendable {
        case reply(Int, [String: String], Data)
        case events(hold: Bool)
    }
    private let queue = DispatchQueue(label: "muster.owned-redirect.\(UUID())")
    private let listener: NWListener
    private let respond: @Sendable (Request) -> Response
    private var requests: [Request] = []
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var startup: CheckedContinuation<Void, Error>?
    private var shutdown: [CheckedContinuation<Bool, Never>] = []
    private var stopping = false
    private var listenerClosed = false
    private var actualPort: UInt16 = 0

    init(respond: @escaping @Sendable (Request) -> Response) throws {
        self.respond = respond
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }
    var port: Int { queue.sync { Int(actualPort) } }
    var received: [Request] { queue.sync { requests } }
    var activeConnections: Int { queue.sync { connections.count } }
    var url: String { "http://127.0.0.1:\(port)" }

    func start() async throws {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.startup = continuation
                self.listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        self.actualPort = self.listener.port!.rawValue
                        self.startup?.resume(); self.startup = nil
                    case let .failed(error):
                        self.startup?.resume(throwing: error); self.startup = nil; self.listener.cancel()
                    case .cancelled:
                        self.listenerClosed = true; self.finishStop()
                    default: break
                    }
                }
                self.listener.newConnectionHandler = { self.accept($0) }
                self.listener.start(queue: self.queue)
                self.queue.asyncAfter(deadline: .now() + 3) {
                    guard let startup = self.startup else { return }
                    self.startup = nil; self.listener.cancel()
                    startup.resume(throwing: URLError(.timedOut))
                }
            }
        }
    }

    func stop() async -> Bool {
        await withCheckedContinuation { continuation in
            queue.async {
                self.stopping = true; self.shutdown.append(continuation)
                for connection in Array(self.connections.values) { connection.cancel() }
                self.listener.cancel(); self.finishStop()
                self.queue.asyncAfter(deadline: .now() + 3) {
                    guard !self.shutdown.isEmpty else { return }
                    for connection in Array(self.connections.values) { connection.cancel() }
                    self.listener.cancel()
                    let waiters = self.shutdown; self.shutdown = []
                    for waiter in waiters { waiter.resume(returning: false) }
                }
            }
        }
    }
    private func finishStop() {
        guard stopping, listenerClosed, connections.isEmpty else { return }
        let waiters = shutdown; shutdown = []
        listener.newConnectionHandler = nil; listener.stateUpdateHandler = nil
        for waiter in waiters { waiter.resume(returning: true) }
    }
    private func accept(_ connection: NWConnection) {
        guard !stopping else { connection.cancel(); return }
        let id = ObjectIdentifier(connection); connections[id] = connection
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready: self.receive(connection, buffer: Data())
            case .cancelled, .failed:
                self.connections.removeValue(forKey: id); connection.stateUpdateHandler = nil; self.finishStop()
            default: break
            }
        }
        connection.start(queue: queue)
    }
    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, complete, error in
            var buffer = buffer; if let data { buffer.append(data) }
            guard buffer.count <= 65_536, !self.stopping else { connection.cancel(); return }
            if let split = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let header = String(decoding: buffer[..<split.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
                let first = header[0].split(separator: " ")
                var fields: [String: String] = [:]
                for line in header.dropFirst() {
                    if let colon = line.firstIndex(of: ":") {
                        fields[String(line[..<colon]).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    }
                }
                let length = Int(fields["content-length"] ?? "0") ?? -1
                guard length >= 0, length <= 32_768, first.count >= 2 else { connection.cancel(); return }
                if buffer.count - split.upperBound >= length {
                    let request = Request(method: String(first[0]), path: String(first[1]), cookie: fields["cookie"],
                        body: Data(buffer[split.upperBound..<split.upperBound + length]))
                    self.requests.append(request); self.send(self.respond(request), connection)
                    return
                }
            }
            if complete || error != nil { connection.cancel() }
            else { self.receive(connection, buffer: buffer) }
        }
    }
    private func send(_ response: Response, _ connection: NWConnection) {
        switch response {
        case let .reply(status, headers, body):
            var header = "HTTP/1.1 \(status) Fixture\r\nContent-Length: \(body.count)\r\nConnection: close\r\n"
            for (key, value) in headers { header += "\(key): \(value)\r\n" }
            connection.send(content: Data((header + "\r\n").utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
        case let .events(hold):
            let first = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"kind\":\"hello\",\"cursor\":\"owned:0\",\"resumed\":true}\n\n"
            connection.send(content: Data(first.utf8), completion: .contentProcessed { error in
                if error != nil { connection.cancel(); return }
                if hold { self.observeClose(connection) }
                else {
                    self.queue.asyncAfter(deadline: .now() + 0.04) {
                        guard !self.stopping else { return }
                        connection.send(content: Data("id: owned:1\ndata: {\"kind\":\"config\",\"seq\":1}\n\n".utf8), completion: .contentProcessed { _ in connection.cancel() })
                    }
                }
            })
        }
    }
    private func observeClose(_ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1024) { _, _, complete, error in
            if complete || error != nil || self.stopping { connection.cancel() }
            else { self.observeClose(connection) }
        }
    }
}

private final class NativeFollowRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var redirects = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return redirects }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        lock.lock(); redirects += 1; lock.unlock(); completionHandler(request)
    }
}


private final class NativeCookieProtocol: URLProtocol, @unchecked Sendable {
    private final class Requests: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [URLRequest] = []
        func append(_ value: URLRequest) { lock.lock(); defer { lock.unlock() }; values.append(value) }
        func take() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; let result = values; values = []; return result }
    }
    private static let requests = Requests()
    static func takeRequests() -> [URLRequest] { requests.take() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let host = request.url!.host!
        let cookie: String
        if host.hasPrefix("secure") { cookie = "__Secure-better-auth.session_token=secure-fixture; Path=/; Secure; HttpOnly" }
        else if host.hasPrefix("empty") { cookie = "better-auth.session_token=; Path=/" }
        else if host.hasPrefix("both") { cookie = "better-auth.session_token=plain-fixture; Path=/, __Secure-better-auth.session_token=secure-fixture; Path=/; Secure" }
        else { cookie = "better-auth.session_token=plain-fixture; Path=/; HttpOnly" }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": cookie])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let body = request.url!.path == "/api/bots" ? #"{"bots":[],"groups":[]}"# : "{}"
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class LiveTransportSecurityTests: XCTestCase {
    private func origin(_ respond: @escaping @Sendable (NativeRedirectOrigin.Request) -> NativeRedirectOrigin.Response) async throws -> NativeRedirectOrigin {
        let source = try NativeRedirectOrigin(respond: respond)
        addTeardownBlock { let stopped = await source.stop(); XCTAssertTrue(stopped, "Owned listener and connections must finish cancellation") }
        try await source.start()
        return source
    }
    private func session(delegate: URLSessionDelegate? = nil, cache: URLCache? = nil, cookies: Bool = false) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        if cookies { config.protocolClasses = [NativeCookieProtocol.self] }
        if let cache { config.urlCache = cache }
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        addTeardownBlock { session.invalidateAndCancel() }
        return session
    }
    private func transport(_ source: NativeRedirectOrigin, session: URLSession? = nil) throws -> MusterTransport {
        try MusterTransport(account: HarnessAccount(origin: source.url, cookieName: "better-auth.session_token", cookieValue: "owned-cookie-sentinel"), session: session)
    }
    private func assertRedirect(_ error: Error, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(error as? MusterTransportError, .redirectRefused, file: file, line: line)
    }

    func testUnprotected307ControlForwardsPasswordAndCookieAcrossOrigins() async throws {
        let target = try await origin { _ in .reply(200, [:], Data("{}".utf8)) }
        let location = "http://localhost:\(target.port)/capture"
        let source = try await origin { _ in .reply(307, ["Location": location], Data()) }
        var request = URLRequest(url: URL(string: source.url)!)
        request.httpMethod = "POST"
        request.httpBody = Data("synthetic-password".utf8)
        request.setValue("better-auth.session_token=owned-cookie-sentinel", forHTTPHeaderField: "Cookie")
        _ = try await session().data(for: request)
        XCTAssertEqual(target.received.count, 1)
        XCTAssertEqual(target.received.first?.body, request.httpBody)
        XCTAssertEqual(target.received.first?.cookie, request.value(forHTTPHeaderField: "Cookie"))
    }

    func testSignInRefusesEveryRedirectBeforePasswordReachesAnotherOrigin() async throws {
        for status in [301, 302, 303, 307, 308] {
            let target = try await origin { _ in .reply(200, ["Set-Cookie": "better-auth.session_token=owned; Path=/"], Data("{}".utf8)) }
            let location = "http://localhost:\(target.port)/capture"
            let source = try await origin { _ in .reply(status, ["Location": location], Data()) }
            let delegate = NativeFollowRedirects()
            do {
                _ = try await MusterTransport.signIn(originText: source.url, email: "owned@example.test", password: "synthetic-password", mode: .signIn, session: session(delegate: delegate))
                XCTFail("Must refuse \(status)")
            } catch { assertRedirect(error) }
            XCTAssertEqual(source.received.count, 1)
            let body = try JSONSerialization.jsonObject(with: XCTUnwrap(source.received.first?.body)) as? [String: String]
            XCTAssertEqual(body?["password"], "synthetic-password")
            XCTAssertEqual(target.received.count, 0, "No redirected password or cookie capture")
            XCTAssertEqual(delegate.count, 0, "Injected delegate cannot override task refusal")
        }
    }

    func testAuthenticatedReadAndWriteRefuseEveryRedirectBeforeCookieOrBodyIsForwarded() async throws {
        for status in [301, 302, 303, 307, 308] {
            let target = try await origin { _ in .reply(200, [:], Data(#"{"bots":[],"groups":[]}"#.utf8)) }
            let location = "http://localhost:\(target.port)/capture"
            let source = try await origin { _ in .reply(status, ["Location": location], Data()) }
            let client = try transport(source, session: session(delegate: NativeFollowRedirects()))
            do { _ = try await client.roster(messages: 0); XCTFail("Read must refuse redirect") }
            catch { assertRedirect(error) }
            do { _ = try await client.send(text: "owned mutation", to: "owned-bot", clientIntentId: "owned-intent"); XCTFail("Mutation must refuse redirect") }
            catch { assertRedirect(error) }
            XCTAssertEqual(source.received.count, 2)
            XCTAssertTrue(source.received.allSatisfy { $0.cookie == "better-auth.session_token=owned-cookie-sentinel" })
            XCTAssertEqual(target.received.count, 0)
        }
    }

    func testSameOriginRedirectCannotReplayMutationAtAnotherRoute() async throws {
        let source = try await origin { request in
            request.path == "/api/bots/owned/messages" ? .reply(307, ["Location": "/capture"], Data()) : .reply(200, [:], Data("{}".utf8))
        }
        do { _ = try await transport(source).send(text: "owned mutation", to: "owned", clientIntentId: "same-origin"); XCTFail("Must refuse") }
        catch { assertRedirect(error) }
        XCTAssertEqual(source.received.count, 1)
    }

    func testCachedPermanentRedirectCannotBypassRefusal() async throws {
        for status in [301, 308] {
            let target = try await origin { _ in .reply(200, ["Cache-Control": "no-store"], Data(#"{"bots":[],"groups":[]}"#.utf8)) }
            let location = target.url + "/capture"
            let source = try await origin { _ in .reply(status, ["Location": location, "Cache-Control": "public, max-age=3600"], Data()) }
            let cache = URLCache(memoryCapacity: 1_048_576, diskCapacity: 0)
            let connection = session(cache: cache)
            let request = URLRequest(url: URL(string: source.url + "/api/bots")!)
            _ = try await connection.data(for: request)
            _ = try await connection.data(for: request)
            XCTAssertEqual(source.received.count, 1)
            XCTAssertEqual(target.received.count, 2)
            do { _ = try await transport(source, session: connection).roster(messages: 0); XCTFail("Cached redirect must be refused") }
            catch { assertRedirect(error) }
            XCTAssertEqual(source.received.count, 2)
            XCTAssertEqual(target.received.count, 2)
            cache.removeAllCachedResponses()
        }
    }

    func testBackgroundSessionsAreRefusedBeforeSignInOrAuthenticatedRequest() async throws {
        let source = try await origin { _ in .reply(200, [:], Data()) }
        let config = URLSessionConfiguration.background(withIdentifier: "muster.native-fixture.\(UUID())")
        let connection = URLSession(configuration: config)
        addTeardownBlock { connection.invalidateAndCancel() }
        XCTAssertThrowsError(try transport(source, session: connection))
        do { _ = try await MusterTransport.signIn(originText: source.url, email: "owned@example.test", password: "fixture", mode: .signIn, session: connection); XCTFail("Must refuse background session") }
        catch { XCTAssertEqual((error as? URLError)?.code, .unsupportedURL) }
        XCTAssertEqual(source.received.count, 0)
    }

    func testSecureCookieRetainsItsNameAndOutgoingHeader() async throws {
        _ = NativeCookieProtocol.takeRequests()
        let connection = session(cookies: true)
        let account = try await MusterTransport.signIn(originText: "https://secure.fixture.invalid", email: "owned@example.test", password: "fixture", mode: .signIn, session: connection)
        XCTAssertEqual(account.cookieName, "__Secure-better-auth.session_token")
        XCTAssertEqual(account.cookieValue, "secure-fixture")
        _ = try await MusterTransport(account: account, session: connection).roster(messages: 0)
        let requests = NativeCookieProtocol.takeRequests()
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Cookie"), "__Secure-better-auth.session_token=secure-fixture")
        XCTAssertTrue(requests.allSatisfy { !$0.httpShouldHandleCookies })
        XCTAssertTrue(requests.allSatisfy { $0.cachePolicy == .reloadIgnoringLocalAndRemoteCacheData })
    }

    func testPlainCookieWorksOnHTTPSAndHTTP() async throws {
        for scheme in ["http", "https"] {
            let account = try await MusterTransport.signIn(originText: "\(scheme)://plain.fixture.invalid", email: "owned@example.test", password: "fixture", mode: .signIn, session: session(cookies: true))
            XCTAssertEqual(account.cookieName, "better-auth.session_token")
            XCTAssertEqual(account.cookieValue, "plain-fixture")
        }
    }

    func testHTTPSPrefersSecureCookieWhenBothArePresent() async throws {
        let account = try await MusterTransport.signIn(originText: "https://both.fixture.invalid", email: "owned@example.test", password: "fixture", mode: .signIn, session: session(cookies: true))
        XCTAssertEqual(account.cookieName, "__Secure-better-auth.session_token")
        XCTAssertEqual(account.cookieValue, "secure-fixture")
    }

    func testSecureOnlyCookieOnHTTPAndEmptyCookieProduceNoSession() async throws {
        for origin in ["http://secure.fixture.invalid", "https://empty.fixture.invalid"] {
            do { _ = try await MusterTransport.signIn(originText: origin, email: "owned@example.test", password: "fixture", mode: .signIn, session: session(cookies: true)); XCTFail("Invalid cookie must not become an account") }
            catch { XCTAssertEqual(error as? MusterTransportError, .noSession) }
        }
    }

    func testStreamStillRefusesCrossOriginRedirectBeforeAnyTargetRequest() async throws {
        let target = try await origin { _ in .events(hold: false) }
        let location = "http://localhost:\(target.port)/capture"
        let source = try await origin { _ in .reply(307, ["Location": location], Data()) }
        do { try await transport(source).events(lastEventId: nil, onEvent: { _ in XCTFail("No redirected frame") }, onHello: { _, _ in XCTFail("No redirected hello") }); XCTFail("Stream must refuse") }
        catch { guard case let APIError.status(code, _) = error else { return XCTFail("Unexpected \(error)") }; XCTAssertEqual(code, 307) }
        XCTAssertEqual(target.received.count, 0)
    }
}
