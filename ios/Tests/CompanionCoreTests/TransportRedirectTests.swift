import Foundation
import Network
import XCTest
@testable import CompanionCore

/// Real HTTP over two ephemeral loopback listeners, never a URLProtocol
/// redirect simulation. Each fixture owns and awaits all of its connections.
private final class RedirectOrigin: @unchecked Sendable {
    struct Request: Sendable { let method: String; let path: String; let authorization: String?; let body: Data }
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
                    let request = Request(method: String(first[0]), path: String(first[1]), authorization: fields["authorization"],
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

private final class FollowRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var redirects = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return redirects }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        lock.lock(); redirects += 1; lock.unlock(); completionHandler(request)
    }
}

final class TransportRedirectTests: XCTestCase {
    private func origin(_ respond: @escaping @Sendable (RedirectOrigin.Request) -> RedirectOrigin.Response) async throws -> RedirectOrigin {
        let origin = try RedirectOrigin(respond: respond)
        addTeardownBlock {
            let stopped = await origin.stop()
            XCTAssertTrue(stopped, "Owned HTTP listener and connections must finish cancellation within three seconds")
        }
        try await origin.start()
        return origin
    }
    private func session(delegate: URLSessionDelegate? = nil, cache: URLCache? = nil) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3
        if let cache { configuration.urlCache = cache }
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        addTeardownBlock { session.invalidateAndCancel() }
        return session
    }
    private func client(_ origin: RedirectOrigin, session: URLSession) -> CompanionClient {
        CompanionClient(connection: Connection(name: "Owned redirect", host: "127.0.0.1", port: origin.port), token: "owned-bearer-sentinel", session: session)
    }
    private func redirectError(_ error: Error, status: Int) {
        guard case let APIError.status(code, message) = error else { return XCTFail("Expected redirect error, got \(error)") }
        XCTAssertEqual(code, status); XCTAssertTrue(message?.contains("direct address") == true)
        XCTAssertFalse(message?.contains("owned-bearer") == true)
    }

    func testUnprotectedControlDemonstratesBodyCanReachRedirectTarget() async throws {
        let target = try await origin { _ in .reply(200, [:], Data("{}".utf8)) }
        let location = target.url + "/captured"
        let source = try await origin { _ in .reply(307, ["Location": location], Data()) }
        var request = URLRequest(url: URL(string: source.url + "/original")!)
        request.httpMethod = "POST"; request.httpBody = Data("owned-control-body".utf8)
        _ = try await session().data(for: request)
        XCTAssertEqual(source.received.count, 1); XCTAssertEqual(target.received.count, 1)
        XCTAssertEqual(target.received.first?.body, Data("owned-control-body".utf8))
    }

    func testRESTRejectsAllRedirectCodesWithoutForwardingBodyOrBearer() async throws {
        for status in [301, 302, 303, 307, 308] {
            let target = try await origin { _ in .reply(200, [:], Data("{}".utf8)) }
            let location = target.url + "/capture"
            let source = try await origin { _ in .reply(status, ["Location": location], Data()) }
            let delegate = FollowRedirects(); let client = client(source, session: session(delegate: delegate))
            do { try await client.send(text: "  owned raw\nbody  ", toBot: "owned-bot"); XCTFail("Expected redirect refusal") }
            catch { redirectError(error, status: status) }
            XCTAssertEqual(source.received.count, 1); XCTAssertEqual(target.received.count, 0)
            XCTAssertEqual(delegate.count, 0, "Per-task policy must override an injected follow delegate")
            XCTAssertEqual(source.received.first?.authorization, "Bearer owned-bearer-sentinel")
            let body = try JSONSerialization.jsonObject(with: XCTUnwrap(source.received.first?.body)) as? [String: String]
            XCTAssertEqual(body?["text"], "  owned raw\nbody  ")
        }
    }

    func testSameOriginRedirectCannotReplayAtAnotherRoute() async throws {
        let source = try await origin { request in
            request.path.hasPrefix("/api/bots") ? .reply(302, ["Location": "/different-route"], Data())
                : .reply(200, [:], Data(#"{"bots":[],"groups":[]}"#.utf8))
        }
        do { _ = try await client(source, session: session()).fleet(); XCTFail("Expected same-origin refusal") }
        catch { redirectError(error, status: 302) }
        XCTAssertEqual(source.received.count, 1)
    }

    func testPreexistingCachedRedirectsCannotRedirectTheClient() async throws {
        for status in [301, 308] {
            let target = try await origin { _ in .reply(200, ["Cache-Control": "no-store"], Data(#"{"bots":[],"groups":[]}"#.utf8)) }
            let location = target.url + "/captured"
            let source = try await origin { _ in .reply(status, ["Location": location, "Cache-Control": "public, max-age=3600"], Data()) }
            let cache = URLCache(memoryCapacity: 1_048_576, diskCapacity: 0)
            let delegate = FollowRedirects(); let session = session(delegate: delegate, cache: cache)
            var request = URLRequest(url: URL(string: source.url + "/api/bots")!)
            request.setValue("Bearer owned-bearer-sentinel", forHTTPHeaderField: "Authorization")
            // Prime using an actual unprotected request. The second request
            // proves a cached redirect, rather than just populating a cache API.
            _ = try await session.data(for: request)
            _ = try await session.data(for: request)
            XCTAssertEqual(source.received.count, 1, "The control must use the cached permanent redirect")
            XCTAssertEqual(target.received.count, 2)
            let originalRequests = source.received.count
            let followed = delegate.count
            do { _ = try await client(source, session: session).fleet(); XCTFail("Expected cached redirect refusal") }
            catch { redirectError(error, status: status) }
            // Client deliberately bypasses cached responses, re-requests the
            // paired origin, then refuses its redirect through the task policy.
            XCTAssertEqual(source.received.count, originalRequests + 1)
            XCTAssertEqual(target.received.count, 2, "Cached redirects cannot bypass the per-task policy")
            XCTAssertEqual(delegate.count, followed)
            cache.removeAllCachedResponses()
        }
    }

    func testBackgroundSessionIsRejectedBeforeRESTOrStreamStarts() async throws {
        let source = try await origin { _ in .reply(200, [:], Data()) }
        let configuration = URLSessionConfiguration.background(withIdentifier: "muster.owned-redirect.\(UUID())")
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        func rejected(_ error: Error) {
            guard case let APIError.transport(message) = error else { return XCTFail("Expected unsupported session error") }
            XCTAssertTrue(message.contains("Background sessions"))
        }
        do { _ = try await client(source, session: session).fleet(); XCTFail("Expected unsupported session") }
        catch { rejected(error) }
        do {
            let request = URLRequest(url: URL(string: source.url + "/events")!)
            for try await _ in eventStream(request: request, session: session) { XCTFail("No background stream frame") }
            XCTFail("Expected unsupported stream session")
        } catch { rejected(error) }
        XCTAssertEqual(source.received.count, 0)
    }

    func testPairingCredentialsStayAtInitialOrigin() async throws {
        for status in [307, 308] {
            let target = try await origin { _ in .reply(200, [:], Data("{}".utf8)) }
            let location = target.url + "/capture"
            let source = try await origin { _ in .reply(status, ["Location": location], Data()) }
            let credential = "omb_pair_" + String(repeating: "q", count: 43)
            do {
                _ = try await CompanionClient.pair(connection: Connection(name: "Owned pair", host: "127.0.0.1", port: source.port),
                    credential: credential, deviceName: "Owned fixture", session: session(delegate: FollowRedirects()))
                XCTFail("Expected pairing redirect refusal")
            } catch { redirectError(error, status: status) }
            XCTAssertEqual(target.received.count, 0); XCTAssertEqual(source.received.count, 1)
            XCTAssertNil(source.received.first?.authorization)
            let body = try JSONSerialization.jsonObject(with: XCTUnwrap(source.received.first?.body)) as? [String: String]
            XCTAssertEqual(body?["credential"], credential)
        }
    }

    func testInjectedSSESessionRejectsRedirectBeforeAnyFrameOrTargetRequest() async throws {
        let target = try await origin { _ in .events(hold: false) }
        let location = target.url + "/stream"
        let source = try await origin { _ in .reply(307, ["Location": location], Data()) }
        var request = URLRequest(url: URL(string: source.url + "/events")!)
        request.setValue("Bearer owned-stream-sentinel", forHTTPHeaderField: "Authorization")
        let delegate = FollowRedirects(); var frames = 0
        do {
            for try await _ in eventStream(request: request, session: session(delegate: delegate)) { frames += 1 }
            XCTFail("Expected stream redirect refusal")
        } catch { redirectError(error, status: 307) }
        XCTAssertEqual(frames, 0); XCTAssertEqual(target.received.count, 0); XCTAssertEqual(source.received.count, 1)
        XCTAssertEqual(delegate.count, 0)
    }

    func testDefaultClientEventStreamAlsoRejectsRedirect() async throws {
        let target = try await origin { _ in .events(hold: false) }
        let location = target.url + "/stream"
        let source = try await origin { _ in .reply(308, ["Location": location], Data()) }
        do {
            for try await _ in try client(source, session: session()).events(since: "owned:5") { XCTFail("No redirected frame") }
            XCTFail("Expected redirect refusal")
        } catch { redirectError(error, status: 308) }
        XCTAssertEqual(target.received.count, 0); XCTAssertEqual(source.received.count, 1)
        XCTAssertTrue(source.received.first?.path.contains("since=owned:5") == true)
    }

    func testOrdinaryRESTAndSeparatedSSEChunksStillWork() async throws {
        let source = try await origin { request in
            request.path.hasPrefix("/api/bots") ? .reply(200, ["Content-Type": "application/json"], Data(#"{"bots":[],"groups":[]}"#.utf8)) : .events(hold: false)
        }
        let session = session(delegate: FollowRedirects()); let client = client(source, session: session)
        let fleet = try await client.fleet(); XCTAssertTrue(fleet.bots.isEmpty)
        let request = URLRequest(url: URL(string: source.url + "/events")!)
        var frames: [StreamFrame] = []
        for try await frame in eventStream(request: request, session: session) { frames.append(frame) }
        XCTAssertEqual(frames.count, 2); XCTAssertEqual(frames.last?.seq, 1); XCTAssertEqual(source.received.count, 2)
    }

    func testSSECancellationAfterARealFrameClosesOwnedConnection() async throws {
        let source = try await origin { _ in .events(hold: true) }
        let first = expectation(description: "Received an actual frame before cancellation")
        let request = URLRequest(url: URL(string: source.url + "/events")!)
        let session = session()
        let task = Task {
            var count = 0
            do { for try await _ in eventStream(request: request, session: session) { count += 1; if count == 1 { first.fulfill() } } }
            catch { }
            return count
        }
        await fulfillment(of: [first], timeout: 3)
        task.cancel(); let count = await task.value
        XCTAssertGreaterThanOrEqual(count, 1)
        let deadline = Date().addingTimeInterval(3)
        while source.activeConnections > 0 && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(source.activeConnections, 0)
    }
}
