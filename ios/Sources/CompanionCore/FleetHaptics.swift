// The watch's haptic vocabulary (musterwatch plan §3.6 #3), as one pure
// decision instead of three scattered ones.
//
// Before this, the wrist buzzed from three independent places: a mood
// transition in the session, a count change in the fleet view, and the
// approval coordinator's confirmation. One approval arriving played
// `.notification` twice (mood *and* count), a new reply played the same
// `.notification` as an approval (both read as "unread"), and a bot
// finishing played nothing at all. Three sites could not agree on who owns
// an event, so the same event could speak twice — or not at all.
//
// This planner is the single owner: given the signals a frame carries, it
// decides *which single event* that frame is. The watch maps events to
// `WKInterfaceDevice` pulses; that mapping lives on the wrist because
// WatchKit is not available to a Foundation-only package, but the decision
// — including the priority when one frame carries two changes — is here,
// where it is testable.

/// One frame-worthy change to the fleet, in the order the planner prefers
/// them when a single frame carries more than one.
public enum FleetHapticEvent: String, Equatable, Sendable {
    /// A new question only the wrist can settle. The loudest thing that
    /// can happen to this product's owner.
    case approvalArrived
    /// A card left `pending` — answered here, on the phone, or allowed to
    /// expire. Distinct from arrival on purpose: one is the request, the
    /// other its resolution.
    case approvalAnswered
    /// A settled bot reply landed. The news the wearer is waiting for; it
    /// used to be indistinguishable from an approval.
    case replyArrived
    /// The last busy bot went quiet with no new reply to show for it —
    /// work ended without news.
    case settled
    /// The fleet went from no busy bots to at least one.
    case startedWorking
}

/// Decides which event a frame is, exactly once per frame.
///
/// Rules, in order:
/// - The first observation after `init`/`reset` only records a baseline.
///   Connections hydrate whole fleets into an empty state; replaying that
///   as events would buzz for history. The caller also refuses to observe
///   while not `.live`, so a reconnect's first live frame is silent too.
/// - Increases and decreases of the approval count are arrival and
///   resolution; a single count in a single frame cannot be both.
/// - Replies are counted (settled bot text across held transcripts), so a
///   batch of replies is one buzz, not two.
/// - Working-count edges are fleet-level: the fleet starts working
///   (0 → n) and settles (n → 0). A second bot joining a busy fleet is
///   not news on a wrist.
/// - When a frame carries two changes, exactly one event is returned —
///   back-to-back pulses read as noise, not meaning. Approval changes
///   outrank replies, replies outrank work edges (a reply landing as the
///   bot finishes *is* the reply).
public struct FleetHapticPlanner: Sendable {
    private var baseline: (approvals: Int, working: Int, replies: Int)?

    public init() {}

    /// Observe one frame. Returns the event this frame is, or nil.
    public mutating func observe(approvals: Int, working: Int, replies: Int) -> FleetHapticEvent? {
        let current = (approvals, working, replies)
        guard let previous = baseline else {
            baseline = current
            return nil
        }
        baseline = current
        if approvals > previous.approvals { return .approvalArrived }
        if approvals < previous.approvals { return .approvalAnswered }
        if replies > previous.replies { return .replyArrived }
        if previous.working > 0, working == 0 { return .settled }
        if previous.working == 0, working > 0 { return .startedWorking }
        return nil
    }

    /// Forget the baseline — pairing changed, sign-out, or the connection
    /// left `.live`. The next observation starts silent again.
    public mutating func reset() { baseline = nil }
}
