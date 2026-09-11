import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Where a companion connects, and with what. The token is *not* held here
/// — it lives in the keychain and is handed to the client at construction,
/// so a `Connection` can be written to disk without writing a credential.
public enum ConnectionScheme: String, Codable, Hashable, Sendable {
    case http, https
    public var defaultPort: Int { self == .https ? 443 : 80 }
}

public struct Connection: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var host: String
    public var port: Int
    public var scheme: ConnectionScheme

    public init(id: String = UUID().uuidString, name: String, host: String, port: Int, scheme: ConnectionScheme = .http) {
        self.id = id; self.name = name; self.host = Self.urlHost(host); self.port = port; self.scheme = scheme
    }

    private enum CodingKeys: String, CodingKey { case id, name, host, port, scheme }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        host = try c.decode(String.self, forKey: .host)
        port = try c.decode(Int.self, forKey: .port)
        // Only absence is legacy HTTP. Null, unknown and wrongly typed schemes fail.
        scheme = c.contains(.scheme) ? try c.decode(ConnectionScheme.self, forKey: .scheme) : .http
        guard !id.isEmpty, baseURL != nil else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid saved companion address"))
        }
    }

    public static func urlHost(_ host: String) -> String {
        let bare = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
        return bare.contains(":") ? "[\(bare)]" : bare
    }

    /// Explicit URLs use standard ports; an unqualified manual address keeps
    /// the companion listener's legacy default. No scheme is silently discarded.
    public static func parse(_ text: String, defaultPort: Int = 8810) -> Connection? {
        guard !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }), !text.contains("\\") else { return nil }
        var address = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { return nil }
        var scheme = ConnectionScheme.http
        var explicit = false
        if let marker = address.range(of: "://") {
            guard let parsed = ConnectionScheme(rawValue: address[..<marker.lowerBound].lowercased()) else { return nil }
            scheme = parsed; explicit = true
            address = String(address[marker.upperBound...])
        }
        if address.hasSuffix("/") { address.removeLast() }
        guard !address.isEmpty, !address.contains(where: { $0.isWhitespace || "/?#@\\".contains($0) }) else { return nil }
        var host: String
        var port = explicit ? scheme.defaultPort : defaultPort
        if address.hasPrefix("[") {
            guard let close = address.firstIndex(of: "]") else { return nil }
            host = String(address[address.index(after: address.startIndex)..<close])
            let remainder = String(address[address.index(after: close)...])
            if !remainder.isEmpty {
                guard remainder.hasPrefix(":"), let parsed = parsePort(String(remainder.dropFirst())) else { return nil }
                port = parsed
            }
            // URI zone delimiters are escaped; the stored host keeps the raw zone.
            if let percent = host.range(of: "%25") { host.replaceSubrange(percent, with: "%") }
            guard host.contains(":") else { return nil }
        } else {
            let count = address.filter { $0 == ":" }.count
            guard !address.contains("["), !address.contains("]"), !explicit || count <= 1 else { return nil }
            if count == 1, let colon = address.lastIndex(of: ":") {
                host = String(address[..<colon])
                guard let parsed = parsePort(String(address[address.index(after: colon)...])) else { return nil }
                port = parsed
            } else { host = address }
        }
        guard validHost(host), (1...65535).contains(port) else { return nil }
        return Connection(name: host, host: host, port: port, scheme: scheme)
    }

    private static func parsePort(_ value: String) -> Int? {
        guard !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }), let number = Int(value), (1...65535).contains(number) else { return nil }
        return number
    }

    private static func validHost(_ input: String) -> Bool {
        let host: String
        if input.hasPrefix("[") && input.hasSuffix("]") {
            host = String(input.dropFirst().dropLast())
            guard host.contains(":") else { return false }
        } else { host = input }
        guard !host.isEmpty, !host.contains(where: { $0.isWhitespace || "/?#@[]\\".contains($0) }),
              !host.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return false }
        if host.contains(":") {
            let pieces = host.split(separator: "%", omittingEmptySubsequences: false)
            guard pieces.count <= 2 else { return false }
            if pieces.count == 2 {
                guard !pieces[1].isEmpty, pieces[1].utf8.allSatisfy({ isASCIINameByte($0) || $0 == 95 || $0 == 46 || $0 == 126 }) else { return false }
            }
            var address = in6_addr()
            return String(pieces[0]).withCString { inet_pton(AF_INET6, $0, &address) } == 1
        }
        guard !host.contains("%"), host.utf8.count <= 253 else { return false }
        let dns = host.hasSuffix(".") ? String(host.dropLast()) : host
        let labels = dns.split(separator: ".", omittingEmptySubsequences: false)
        guard !labels.isEmpty, labels.allSatisfy({ label in
            !label.isEmpty && label.utf8.count <= 63 && label.first != "-" && label.last != "-"
                && label.utf8.allSatisfy(isASCIINameByte)
        }) else { return false }
        // Do not let URL loading reinterpret shortened, octal, hexadecimal or
        // integer IPv4 forms as a different authority than the user entered.
        if labels.allSatisfy({ label in
            label.utf8.allSatisfy({ (48...57).contains($0) }) || label.lowercased().hasPrefix("0x")
        }) {
            return labels.count == 4 && labels.allSatisfy { label in
                label.utf8.allSatisfy({ (48...57).contains($0) }) && (label.count == 1 || label.first != "0")
                    && Int(label).map({ (0...255).contains($0) }) == true
            } && !host.hasSuffix(".")
        }
        return true
    }

    private static func isASCIINameByte(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) || byte == 45
    }

    /// Public fields are mutable, so every use revalidates the authority.
    public var baseURL: URL? {
        guard Self.validHost(host), (1...65535).contains(port) else { return nil }
        var components = URLComponents()
        components.scheme = scheme.rawValue
        components.host = Self.urlHost(host)
        components.port = port
        return components.url
    }

    /// Showing an explicit scheme prevents a TLS connection becoming HTTP
    /// when the displayed address is copied or placed back in an input field.
    public var displayAddress: String { baseURL?.absoluteString ?? "Invalid companion address" }
}

/// A pairing window handed from the desktop to the app as a QR/deep link.
/// It contains only the address and a short-lived, single-use credential.
/// New desktop builds put a high-entropy token in the QR; older builds carry
/// the same six-digit code shown on screen. The long-lived device token is
/// created later by `CompanionClient.pair` and never appears in the link.
public struct PairingInvite: Equatable, Sendable {
    public let connection: Connection
    public let credential: String

    public init(connection: Connection, credential: String) {
        self.connection = connection
        self.credential = credential
    }

    public static func parse(_ url: URL) -> PairingInvite? {
        guard url.scheme?.lowercased() == "muster", url.host?.lowercased() == "pair",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil, components.port == nil,
              components.percentEncodedHost?.lowercased() == "pair",
              components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/",
              components.fragment == nil, let query = components.percentEncodedQuery else { return nil }
        // Split before decoding: escaped separators belong to their field.
        var values: [String: String] = [:]
        for field in query.split(separator: "&", omittingEmptySubsequences: false) {
            guard let equal = field.firstIndex(of: "="),
                  let name = String(field[..<equal]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  let value = String(field[field.index(after: equal)...]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  ["address", "token", "code", "name"].contains(name), values[name] == nil else { return nil }
            values[name] = value
        }
        guard let address = values["address"],
              let credential = Self.credential(from: values),
              var connection = Connection.parse(address)
        else { return nil }

        if let name = values["name"]?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            let cleaned = name.filter {
                (!$0.isASCII && !$0.isNewline) || $0.asciiValue.map { $0 >= 32 && $0 != 127 } == true
            }
            if !cleaned.isEmpty { connection.name = String(cleaned.prefix(80)) }
        }
        return PairingInvite(connection: connection, credential: credential)
    }

    private static func credential(from values: [String: String]) -> String? {
        if let token = values["token"] {
            guard token.hasPrefix("omb_pair_"),
                  token.utf8.count == 52,
                  token.dropFirst("omb_pair_".count).utf8.allSatisfy({
                      (48...57).contains($0) || (65...90).contains($0) ||
                      (97...122).contains($0) || $0 == 45 || $0 == 95
                  })
            else { return nil }
            return token
        }
        guard let code = values["code"],
              code.utf8.count == 6,
              code.utf8.allSatisfy({ (48...57).contains($0) })
        else { return nil }
        return code
    }
}
