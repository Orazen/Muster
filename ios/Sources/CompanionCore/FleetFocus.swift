// Crown-driven focus for the fleet roster (musterwatch plan §3.6 #4):
// which row the Digital Crown has reached, and when reaching one deserves a
// detent the wearer can feel.
//
// The view owns the @FocusState binding; the decision of *when to click*
// lives here so it is a pure function with tests instead of a rule buried
// in SwiftUI callback order.

/// One focusable row of the fleet roster, in the order the list draws them.
/// Keeping the identity here (rather than raw indices) means rows that come
/// and go — an approval answered, a bot hidden — can never shift the value
/// the crown is holding onto.
public enum FleetFocusRow: Hashable, Sendable {
    case mascot
    case approval(threadId: String, messageId: String)
    case bot(String)
    case room(String)
    case settings
}

/// Decides when a focus transition should click, one detent per row.
///
/// The rules, in order:
/// - Losing focus (`nil`) never clicks and clears the remembered row, so
///   navigating away and back starts fresh instead of replaying history.
/// - The first focused row after a reset is recorded *silently*. watchOS
///   lands focus on the top row the moment a list appears, and entering a
///   screen must not buzz — only moving the crown should.
/// - Every later move between two distinct rows clicks exactly once.
///   Re-focus of the same row does not click again.
public struct FocusDetentTracker: Sendable {
    private var settled: FleetFocusRow?

    public init() {}

    /// Observe a focus change. Returns true when a haptic detent is due.
    public mutating func focus(_ row: FleetFocusRow?) -> Bool {
        guard let row else {
            settled = nil
            return false
        }
        guard let previous = settled else {
            settled = row
            return false
        }
        guard previous != row else { return false }
        settled = row
        return true
    }

    /// Forget the current position — call when the roster appears or
    /// disappears, so each visit begins without a remembered row.
    public mutating func reset() {
        settled = nil
    }
}
