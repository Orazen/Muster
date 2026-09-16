// What the fleet looks like from across the room.
//
// The watch's root is a mascot, and a mascot has exactly one face at a time.
// Which face that is has to be decided somewhere, and a wrist cannot afford a
// list scan to answer "does anything need me?" — so the precedence lives here,
// as a pure function, instead of being implied by the order of rows in a view.
//
// Offline outranks everything: a stale "2 need you" while the connection is
// down is worse than useless, because acting on it is impossible.
import Foundation

public enum FleetMood: Equatable, Sendable {
    case needsYou(Int)
    case working
    case unread
    case idle
    case offline

    /// The state string the flower's keyword chain maps to a pose.
    public var state: String {
        switch self {
        case .needsYou: return "notifying"
        case .working: return "working"
        case .unread: return "surprised"
        case .idle: return "idle"
        case .offline: return "sleepy"
        }
    }

    /// What the root prints under the mascot. Terse: it is read at a glance.
    public var label: String {
        switch self {
        case let .needsYou(count): return count == 1 ? "1 needs you" : "\(count) need you"
        case .working: return "Working"
        case .unread: return "New replies"
        case .idle: return "Up to date"
        case .offline: return "Offline"
        }
    }

    /// What the mascot says when tapped. A label can be a fragment; a spoken
    /// sentence cannot.
    public var spoken: String {
        switch self {
        case let .needsYou(count):
            return count == 1 ? "One bot needs your approval" : "\(count) bots need your approval"
        case .working: return "Your bots are working"
        case .unread: return "You have new replies"
        case .idle: return "Everything is up to date"
        case .offline: return "The watch is offline"
        }
    }

    /// The precedence, in one place. Negative counts are treated as zero: a
    /// caller that has not loaded the fleet yet must not read as "needs you".
    public static func from(isOffline: Bool, approvals: Int, working: Int, unread: Int) -> FleetMood {
        if isOffline { return .offline }
        if approvals > 0 { return .needsYou(approvals) }
        if working > 0 { return .working }
        if unread > 0 { return .unread }
        return .idle
    }
}