// CompanionHandoff — the phone shares its pairing with the watch.
//
// Flow: the phone pairs (QR / code / invite) exactly as it does today, then
// WatchConnectivity carries {connection, token} to the paired watch. The
// watch adopts it in place of the six-digit typing dance: same computer,
// same trust root (the computer issued the watch its own device token via
// the phone's credential), zero re-pairing.
//
// The payload is a plain Codable struct in CompanionCore so both sides and
// the tests share one codec — the WCSession shells stay thin and untested
// against a real radio, the data contract is fully pinned.
import Foundation

public struct CompanionHandoff: Codable, Equatable, Sendable {
    public var connection: Connection
    public var token: String
    public var sentAt: Date

    public init(connection: Connection, token: String, sentAt: Date = Date()) {
        self.connection = connection
        self.token = token
        self.sentAt = sentAt
    }
}

public enum CompanionHandoffCodec {
    /// The single key the phone writes and the watch reads. Both transports
    /// (application context, user-info transfer) use it.
    public static let key = "companion-handoff"
    /// Tombstone value: tells the watch "your phone unpaired — do the same".
    /// Lives here so both binaries share the exact bytes.
    public static let unpairMarker = "__unpair__"

    public static func encode(_ handoff: CompanionHandoff) -> Data? {
        try? JSONEncoder().encode(handoff)
    }

    public static func decode(from data: Data) -> CompanionHandoff? {
        try? JSONDecoder().decode(CompanionHandoff.self, from: data)
    }

    /// Decode out of an untyped WCSession dictionary. Anything missing,
    /// mistyped, or undecodable reads as "no handoff" — a malformed push
    /// must never crash the radio thread.
    public static func decode(from dictionary: [String: Any]) -> CompanionHandoff? {
        guard let data = dictionary[key] as? Data else { return nil }
        return decode(from: data)
    }
}
