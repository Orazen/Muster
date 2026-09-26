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
    /// Monotonic pairing-event number assigned by the PHONE, counting pairs and
    /// unpairs alike. The watch keeps the highest it has seen and drops anything
    /// lower, which is what stops a queued delivery from reviving a revoked
    /// pairing. Optional because a phone that predates this sends none, and
    /// because absence is read as "cannot be shown to be newer" — see
    /// WatchHandoffOrdering.
    public var generation: UInt64?

    public init(connection: Connection, token: String, sentAt: Date = Date(), generation: UInt64? = nil) {
        self.connection = connection
        self.token = token
        self.sentAt = sentAt
        self.generation = generation
    }

    private enum CodingKeys: String, CodingKey { case connection, token, sentAt, generation }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connection = try c.decode(Connection.self, forKey: .connection)
        token = try c.decode(String.self, forKey: .token)
        sentAt = try c.decode(Date.self, forKey: .sentAt)
        // Absent is the 1.20 payload. A present-but-wrong type is a decode
        // failure, not a silent zero: a corrupt number must not read as "oldest
        // ever" and quietly win an ordering comparison.
        generation = c.contains(.generation) ? try c.decodeIfPresent(UInt64.self, forKey: .generation) : nil
    }
}

/// The unpair tombstone, now a value rather than a bare magic string so it can
/// carry the generation that ordered it. Decodes a legacy marker as nil.
public struct CompanionHandoffTombstone: Codable, Equatable, Sendable {
    public var generation: UInt64?

    public init(generation: UInt64? = nil) {
        self.generation = generation
    }

    private enum CodingKeys: String, CodingKey { case generation }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generation = c.contains(.generation) ? try c.decodeIfPresent(UInt64.self, forKey: .generation) : nil
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

    public static func encode(_ tombstone: CompanionHandoffTombstone) -> Data? {
        try? JSONEncoder().encode(tombstone)
    }

    public static func decode(from data: Data) -> CompanionHandoff? {
        try? JSONDecoder().decode(CompanionHandoff.self, from: data)
    }

    public static func decodeTombstone(from data: Data) -> CompanionHandoffTombstone? {
        try? JSONDecoder().decode(CompanionHandoffTombstone.self, from: data)
    }

    /// Is this the unpair marker? True for the 1.20 bare string and for the
    /// typed tombstone, so a phone on either version is understood.
    public static func isUnpair(_ data: Data) -> Bool {
        if let text = String(data: data, encoding: .utf8), text == unpairMarker { return true }
        return decodeTombstone(from: data) != nil
    }

    /// Decode out of an untyped WCSession dictionary. Anything missing,
    /// mistyped, or undecodable reads as "no handoff" — a malformed push
    /// must never crash the radio thread.
    public static func decode(from dictionary: [String: Any]) -> CompanionHandoff? {
        guard let data = dictionary[key] as? Data else { return nil }
        return decode(from: data)
    }

    /// The tombstone out of an untyped dictionary, with its generation when the
    /// phone sent one.
    public static func decodeTombstone(from dictionary: [String: Any]) -> CompanionHandoffTombstone? {
        guard let data = dictionary[key] as? Data else { return nil }
        if String(data: data, encoding: .utf8) == unpairMarker {
            return CompanionHandoffTombstone(generation: nil)
        }
        return decodeTombstone(from: data)
    }
}
