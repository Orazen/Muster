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

/// Which of the two messages a payload is. This discriminator is REQUIRED on
/// the wire, and it is what makes the two payloads tellable apart at all.
///
/// It exists because of a regression this file shipped: `isUnpair` used to ask
/// only "does a tombstone decode from this?", and a tombstone whose every field
/// was optional decoded from ANY JSON object — including a real pairing. Every
/// valid pairing was therefore classified as an unpair, and the watch signed
/// itself out of a working computer. Structure is not a discriminator; a
/// required field that says which message this is, is.
public enum CompanionHandoffKind: String, Codable, Sendable {
    case pair
    case unpair
}

public struct CompanionHandoff: Codable, Equatable, Sendable {
    public var connection: Connection
    public var token: String
    public var sentAt: Date
    /// Always `.pair`; decoded as absent-tolerant so a 1.20 payload still reads.
    public var kind: CompanionHandoffKind
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
        self.kind = .pair
        self.generation = generation
    }

    private enum CodingKeys: String, CodingKey { case connection, token, sentAt, kind, generation }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Refuse a tombstone. Without this the pair decoder would happily read a
        // payload carrying no connection at all... it would throw on the missing
        // `connection`, but the ORDER of these checks is what makes the intent
        // explicit, and an explicit kind check fails loudly if a future field
        // ever makes the structural difference ambiguous.
        if c.contains(.kind) {
            let kind = try c.decode(CompanionHandoffKind.self, forKey: .kind)
            guard kind == .pair else {
                throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "not a pairing payload")
            }
        }
        connection = try c.decode(Connection.self, forKey: .connection)
        token = try c.decode(String.self, forKey: .token)
        sentAt = try c.decode(Date.self, forKey: .sentAt)
        kind = .pair
        // Absent is the 1.20 payload. A present-but-wrong type is a decode
        // failure, not a silent zero: a corrupt number must not read as "oldest
        // ever" and quietly win an ordering comparison.
        generation = c.contains(.generation) ? try c.decodeIfPresent(UInt64.self, forKey: .generation) : nil
    }
}

/// The unpair tombstone, now a value rather than a bare magic string so it can
/// carry the generation that ordered it. `kind` is REQUIRED: it is the only
/// thing that distinguishes this from a pairing, so a payload without it is not
/// a tombstone and must not be treated as one.
public struct CompanionHandoffTombstone: Codable, Equatable, Sendable {
    public var kind: CompanionHandoffKind
    public var generation: UInt64?

    public init(generation: UInt64? = nil) {
        self.kind = .unpair
        self.generation = generation
    }

    private enum CodingKeys: String, CodingKey { case kind, generation }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Required, and required to be `.unpair`. A pairing payload reaching
        // here is rejected rather than silently accepted as a tombstone.
        let kind = try c.decode(CompanionHandoffKind.self, forKey: .kind)
        guard kind == .unpair else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "not an unpair payload")
        }
        self.kind = .unpair
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

    /// Which message is this, if it is either?
    ///
    /// One decision, asked once, so a caller can never pair-decode a tombstone
    /// or unpair-decode a pairing. The 1.20 bare marker is recognised here, which
    /// is the only compatibility case that has no discriminator in it.
    public enum MessageKind: Equatable, Sendable {
        case pair(CompanionHandoff)
        case unpair(CompanionHandoffTombstone)
    }

    public static func classify(_ data: Data) -> MessageKind? {
        if let text = String(data: data, encoding: .utf8), text == unpairMarker {
            return .unpair(CompanionHandoffTombstone(generation: nil))
        }
        // The discriminator decides, not the shape: whichever decodes first is
        // the answer, and the other decoder is guaranteed to reject it.
        if let handoff = decode(from: data) { return .pair(handoff) }
        if let tombstone = decodeTombstone(from: data) { return .unpair(tombstone) }
        return nil
    }

    /// Is this the unpair marker? True for the 1.20 bare string and for a typed
    /// tombstone that says so — and, critically, FALSE for a pairing payload,
    /// which is what a structural check got wrong.
    public static func isUnpair(_ data: Data) -> Bool {
        if case .unpair = classify(data) { return true }
        return false
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
