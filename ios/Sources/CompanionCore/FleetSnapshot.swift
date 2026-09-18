// FleetSnapshot — the mascot's state on surfaces outside the app process
// (widget, Lock Screen Live Activity). The app publishes a small snapshot to
// a shared app-group store after every state change; the extension reads it
// when the system renders. Pure data + JSON, so the phone app and the widget
// cannot disagree about what the fleet is doing.
import Foundation

public struct FleetBotSnapshot: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var color: String
    /// The flower state string (CompanionCore flowerState vocabulary).
    public var state: String
    /// The narrated line: never empty while the bot is not idle.
    public var line: String

    public init(id: String, name: String, color: String, state: String, line: String) {
        self.id = id
        self.name = name
        self.color = color
        self.state = state
        self.line = line
    }
}

public struct FleetSnapshot: Codable, Equatable, Sendable {
    public static let currentVersion = 1

    public var version: Int
    public var generatedAt: Date
    public var moodState: String
    public var moodLabel: String
    public var bots: [FleetBotSnapshot]

    public init(moodState: String, moodLabel: String, bots: [FleetBotSnapshot]) {
        self.version = Self.currentVersion
        self.generatedAt = Date()
        self.moodState = moodState
        self.moodLabel = moodLabel
        self.bots = bots
    }
}

/// The narrated line for a bot snapshot, mirroring the web's statusLine
/// wording. Idle bots carry no line — silence is the honest idle.
public func fleetLine(for bot: Bot) -> String {
    let state = flowerState(for: bot)
    if state == "idle" || state == "sleeping" { return "" }
    if bot.busy == true { return "Working — \(bot.name)" }
    if bot.unread { return "Done — \(bot.name) has news" }
    return ""
}

/// Build the snapshot from the live companion state and the FleetMood the
/// watch already derives. Kept here so app and extensions share one builder.
public func fleetSnapshot(state: CompanionState, mood: FleetMood) -> FleetSnapshot {
    let bots = state.bots.filter { $0.hidden != true }.prefix(6).map { bot in
        FleetBotSnapshot(
            id: bot.id,
            name: bot.name,
            color: bot.color,
            state: flowerState(for: bot),
            line: fleetLine(for: bot)
        )
    }
    return FleetSnapshot(moodState: mood.state, moodLabel: mood.label, bots: Array(bots))
}

/// The shared store. The app-group container is only available when both
/// targets carry the entitlement; without it every write is a silent no-op
/// and every read returns nil, so a misconfigured build degrades to the
/// widget's placeholder instead of crashing or showing stale data.
public enum FleetSnapshotStore {
    /// The app group id. Matched by the entitlements in project.yml.
    public static let appGroupId = "group.com.muster.companion"
    private static let key = "muster.fleet-snapshot.v1"

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroupId)
    }

    public static func publish(_ snapshot: FleetSnapshot) {
        guard let defaults = defaults else { return }
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: key)
    }

    public static func read() -> FleetSnapshot? {
        guard let defaults = defaults, let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(FleetSnapshot.self, from: data)
    }

    /// A snapshot older than this is treated as offline rather than shown:
    /// a stale "Working" on the lock screen is worse than no mascot.
    public static let maxAge: TimeInterval = 15 * 60

    public static func readFresh(now: Date = Date()) -> FleetSnapshot? {
        guard let snapshot = read() else { return nil }
        guard now.timeIntervalSince(snapshot.generatedAt) < maxAge else { return nil }
        return snapshot
    }
}
