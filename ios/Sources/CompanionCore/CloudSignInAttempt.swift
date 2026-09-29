import Foundation
import CryptoKit
import Security

/// Ephemeral identity handoff state. This grants no paired-device authority.
/// The caller serializes mutations on its actor and checks finish before
/// applying either a successful identity or a failed exchange result.
public struct CloudSignInAttempt: Sendable {
    /// Matches server/desktop-auth.ts EXCHANGE_VERSION.
    public static let exchangeVersion = 1
    public struct Proof: Equatable, Sendable {
        public let id: UUID
        public let state: String
        public let verifier: String
        public var challenge: String { CloudSignInAttempt.challenge(for: verifier) }
        public var queryItems: [URLQueryItem] {
            [URLQueryItem(name: "state", value: state),
             URLQueryItem(name: "code_challenge", value: challenge),
             URLQueryItem(name: "code_challenge_method", value: "S256")]
        }
    }
    public struct Exchange: Equatable, Sendable {
        public let attemptID: UUID
        public let code: String
        public let verifier: String
    }
    public enum Callback: Equatable, Sendable {
        case unrelated
        case rejected
        case duplicate
        case exchange(Exchange)
    }
    private struct Active: Sendable { let proof: Proof; var code: String? }
    private var active: Active?
    public init() {}
    public var activeID: UUID? { active?.proof.id }
    public var isExchanging: Bool { active?.code != nil }

    /// Each user-started attempt supersedes any older one with independent
    /// cryptographic state/verifier; neither value is persisted.
    @discardableResult
    public mutating func begin() throws -> Proof {
        let proof = Proof(id: UUID(), state: try Self.randomToken(), verifier: try Self.randomToken())
        active = Active(proof: proof)
        return proof
    }

    @discardableResult
    public mutating func cancel(_ id: UUID? = nil) -> Bool {
        guard let current = active, id == nil || id == current.proof.id else { return false }
        active = nil
        return true
    }

    public mutating func claim(_ url: URL) -> Callback {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "muster", components.host?.lowercased() == "oauth",
              components.percentEncodedPath == "/finish", components.user == nil,
              components.password == nil, components.port == nil, components.query == nil else { return .unrelated }
        guard let current = active, let fragment = components.percentEncodedFragment,
              fragment.utf8.count <= 2048 else { return .rejected }
        var parameters: [String: String] = [:]
        for field in fragment.split(separator: "&", omittingEmptySubsequences: false) {
            guard let equal = field.firstIndex(of: "="),
                  let name = String(field[..<equal]).removingPercentEncoding,
                  let value = String(field[field.index(after: equal)...]).removingPercentEncoding,
                  parameters[name] == nil else { return .rejected }
            parameters[name] = value
        }
        guard parameters["state"] == current.proof.state,
              parameters["v"] == String(Self.exchangeVersion),
              let code = parameters["code"], code.utf8.count == 43,
              code.utf8.allSatisfy({ byte in
                  (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte) || byte == 45 || byte == 95
              }) else { return .rejected }
        if let claimed = current.code { return claimed == code ? .duplicate : .rejected }
        active?.code = code
        return .exchange(Exchange(attemptID: current.proof.id, code: code, verifier: current.proof.verifier))
    }

    /// A late response cannot settle a canceled or superseded attempt.
    /// Consuming the attempt before the caller stores identity makes replay
    /// and success/failure double delivery idempotent.
    @discardableResult
    public mutating func finish(_ exchange: Exchange) -> Bool {
        guard let current = active, current.proof.id == exchange.attemptID,
              current.code == exchange.code, current.proof.verifier == exchange.verifier else { return false }
        active = nil
        return true
    }

    public static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
    private static func base64URL(_ bytes: Data) -> String {
        bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func randomToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let result = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard result == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(result)) }
        return base64URL(Data(bytes))
    }
}
