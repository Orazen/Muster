// The live desktop transport: real accounts, real sends, real approvals.
//
// M0's HarnessProbe was deliberately GET-only against an unidentified
// origin. This slice replaces it as the app's primary transport and keeps
// the same discipline, widened:
//   - the origin is still explicit — no default endpoint, no discovery;
//   - the session cookie is held in memory and persisted only through the
//     caller-provided store (the app uses Keychain, matching the CLI's
//     owner-only file discipline; the transport itself never writes);
//   - every request carries the session cookie, never credentials in URLs;
//   - sign-in and authenticated requests refuse every redirect before any
//     credentials or mutation body can reach another destination;
//   - SSE frames are parsed by CompanionCore's own SSEParser/Frame, so the
//     desktop folds exactly what the phone folds.
//
// Send receipts follow the durable-intent contract: a send carries a
// clientIntentId and the FIRST response is authoritative — a retry with the
// same id is a lookup the server answers without duplicating.

import CompanionCore
import Foundation

public struct HarnessAccount: Codable, Sendable, Equatable {
    public var origin: String
    public var cookieName: String
    public var cookieValue: String
    public init(origin: String, cookieName: String, cookieValue: String) {
        self.origin = origin
        self.cookieName = cookieName
        self.cookieValue = cookieValue
    }
}

public enum MusterTransportError: Error, Equatable, Sendable {
    case badOrigin
    case redirectRefused
    case noSession
    case signInFailed(Int)
    case server(Int, String?)
    case unreadable
}

/// One send's authoritative receipt from the server.
public struct SendReceipt: Sendable, Equatable {
    public let intentId: String
    public let messageId: String
    public let threadId: String
    public let state: String
}

public struct ApprovalOutcome: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let outcome: String?
}

/// The desktop session client. Values, not singletons: tests build one
/// against a fixture origin with an injected URLSession.
private final class NativeRedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
    static let shared = NativeRedirectPolicy()

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    static func validate(_ session: URLSession) throws {
        // Background sessions do not honor this per-task redirect policy.
        guard session.configuration.identifier == nil else {
            throw URLError(.unsupportedURL)
        }
    }
}

public struct MusterTransport: Sendable {
    public let origin: URL
    private let account: HarnessAccount
    private let session: URLSession

    public init(account: HarnessAccount, session: URLSession? = nil) throws {
        guard let origin = URL(string: account.origin), let host = origin.host, !host.isEmpty else {
            throw MusterTransportError.badOrigin
        }
        self.origin = origin
        self.account = account
        self.session = session ?? Self.makeSession()
        try NativeRedirectPolicy.validate(self.session)
    }

    private static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        // The transport owns the cookie; no shared jar may leak it elsewhere.
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.urlCache = nil
        return URLSession(configuration: config)
    }

    // MARK: - Requests

    /// `query` is passed separately from `path` on purpose: assigning a
    /// "path?key=value" string to `URLComponents.path` percent-encodes the `?`,
    /// which reaches the server as `%3F` and silently drops the parameter.
    private func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil, extraHeaders: [String: String] = [:]) throws -> URLRequest {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            throw MusterTransportError.badOrigin
        }
        components.path = path
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw MusterTransportError.badOrigin }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        request.httpShouldHandleCookies = false
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("\(account.cookieName)=\(account.cookieValue)", forHTTPHeaderField: "Cookie")
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        for (name, value) in extraHeaders { request.setValue(value, forHTTPHeaderField: name) }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    private static func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard !(200...299).contains(http.statusCode) else { return }
        let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
        throw MusterTransportError.server(http.statusCode, message)
    }

    private static func redirectGuard(_ response: URLResponse) throws {
        if let http = response as? HTTPURLResponse, (300...399).contains(http.statusCode) {
            throw MusterTransportError.redirectRefused
        }
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        try NativeRedirectPolicy.validate(session)
        let (data, response) = try await session.data(for: request, delegate: NativeRedirectPolicy.shared)
        try Self.redirectGuard(response)
        try Self.check(response, data)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw MusterTransportError.unreadable
        }
    }

    // MARK: - Auth

    /// Sign in and capture the session cookie the server sets. The secure
    /// name is only accepted from an HTTPS origin, mirroring the CLI.
    public static func signIn(originText: String, email: String, password: String, mode: SignInMode, session: URLSession? = nil) async throws -> HarnessAccount {
        guard let origin = URL(string: originText), let host = origin.host, !host.isEmpty else {
            throw MusterTransportError.badOrigin
        }
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.path = mode == .signIn ? "/api/auth/sign-in/email" : "/api/auth/sign-up/email"
        let ownsSession = session == nil
        let session = session ?? makeSession()
        defer { if ownsSession { session.finishTasksAndInvalidate() } }
        try NativeRedirectPolicy.validate(session)
        var request = URLRequest(url: components.url!, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        request.httpShouldHandleCookies = false
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("muster-mac", forHTTPHeaderField: "User-Agent")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password, "name": mode == .signUp ? email : "Muster Desktop"])
        let (data, response) = try await session.data(for: request, delegate: NativeRedirectPolicy.shared)
        try Self.redirectGuard(response)
        try Self.check(response, data)
        let headers = (response as? HTTPURLResponse)?.allHeaderFields ?? [:]
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers as? [String: String] ?? [:], for: origin)
        let secureName = "__Secure-better-auth.session_token"
        let plainName = "better-auth.session_token"
        let secure = cookies.first { $0.name == secureName && !$0.value.isEmpty }
        let plain = cookies.first { $0.name == plainName && !$0.value.isEmpty }
        let cookie = origin.scheme == "https" ? (secure ?? plain) : plain
        if let cookie {
            return HarnessAccount(origin: originText, cookieName: cookie.name, cookieValue: cookie.value)
        }
        throw MusterTransportError.noSession
    }

    public enum SignInMode: Sendable { case signIn, signUp }

    // MARK: - Reads

    /// `messages` is the transcript page the caller wants. GET /api/bots only
    /// returns the slim page when the client asks for it: omitting `?messages=`
    /// makes the server hand back every bot's entire transcript with screen
    /// captures inline as base64 PNGs, which for a long-running bot is megabytes
    /// on every bootstrap and every refresh. The page size is therefore forwarded,
    /// including `0`.
    public func roster(messages: Int) async throws -> Fleet {
        precondition(messages >= 0, "a transcript page is a non-negative count")
        return try await send(
          request("GET", "/api/bots", query: [URLQueryItem(name: "messages", value: String(messages))]),
          as: Fleet.self)
    }

    public func threadMessages(threadId: String) async throws -> [Message] {
        struct Payload: Decodable { let messages: [Message] }
        return try await send(request("GET", "/api/threads/\(threadId)/messages"), as: Payload.self).messages
    }

    public func memory(botId: String) async throws -> String {
        struct Payload: Decodable { let text: String }
        return try await send(request("GET", "/api/bots/\(botId)/memory"), as: Payload.self).text
    }

    // MARK: - Writes (bounded, like every other surface)

    public func send(text: String, to botId: String, clientIntentId: String) async throws -> SendReceipt {
        struct Payload: Decodable {
            struct Intent: Decodable { let intentId: String; let messageId: String; let threadId: String; let state: String }
            let threadId: String
            let intent: Intent
        }
        let payload = try await send(
            request("POST", "/api/bots/\(botId)/messages", body: ["text": text, "clientIntentId": clientIntentId]),
            as: Payload.self)
        return SendReceipt(intentId: payload.intent.intentId, messageId: payload.intent.messageId, threadId: payload.intent.threadId, state: payload.intent.state)
    }

    public func respond(botId: String, requestId: String, behavior: String, message: String? = nil) async throws -> ApprovalOutcome {
        var body: [String: Any] = ["requestId": requestId, "behavior": behavior]
        if let message, !message.isEmpty { body["message"] = message }
        return try await send(request("POST", "/api/bots/\(botId)/respond", body: body), as: ApprovalOutcome.self)
    }

    // MARK: - Stream

    /// One live connection. `onEvent` fires per frame with its sequence; the
    /// caller derives the resume cursor (stream id from `hello` + the latest
    /// `seq`). CompanionCore's `eventStream` owns the wire discipline: lines
    /// split by hand (an empty line ENDS an event — `bytes.lines` would
    /// swallow it and every frame would buffer forever, which is exactly the
    /// silence this slice reproduced and fixed), bytes held for the whole
    /// connection, redirect policy enforced, unknown frames absorbed.
    public func events(lastEventId: String?, onEvent: @escaping @Sendable (StreamFrame) -> Void, onHello: @escaping @Sendable (String, Bool) -> Void) async throws {
        var urlRequest = try request("GET", "/api/events")
        urlRequest.timeoutInterval = .infinity
        urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let lastEventId, !lastEventId.isEmpty {
            urlRequest.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
        }
        for try await streamFrame in eventStream(request: urlRequest, session: session) {
            switch streamFrame.frame {
            case let .hello(cursor, resumed):
                onHello(cursor, resumed)
            default:
                onEvent(streamFrame)
            }
        }
    }
}
