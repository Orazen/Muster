// FleetActivitySync — the Lock Screen Live Activity's lifecycle, driven by
// the same throttled snapshot publishes that feed the widget. One rule above
// all: the activity must never lie. It exists only while the fleet has
// something to say (working, needs-you, new replies) and ends the moment the
// fleet goes idle or the connection drops — a stale "Working" on the Lock
// Screen while the companion is offline is worse than no activity at all.
import Foundation
import ActivityKit
import CompanionCore

@MainActor
enum FleetActivitySync {
    /// Upsert the activity from a freshly published snapshot. Idle and
    /// offline snapshots end any live activity instead of starting one.
    static func sync(_ snapshot: FleetSnapshot) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // "sleepy" is the offline mood, "idle" the up-to-date mood — both are
        // "nothing to say", which the Lock Screen should not claim.
        guard snapshot.moodState != "idle", snapshot.moodState != "sleepy" else {
            endAll()
            return
        }
        let content = ActivityContent(state: buildState(snapshot), staleDate: Date())
        let existing = Activity<FleetActivityAttributes>.activities
        if existing.isEmpty {
            _ = try? Activity<FleetActivityAttributes>.request(
                attributes: FleetActivityAttributes(fleetName: "Muster"),
                content: content,
                pushType: nil
            )
        } else {
            Task {
                for activity in existing {
                    await activity.update(content)
                }
            }
        }
    }

    /// End every live fleet activity (unpair, sign-out, app teardown).
    static func endAll() {
        let existing = Activity<FleetActivityAttributes>.activities
        guard !existing.isEmpty else { return }
        Task {
            for activity in existing {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    private static func buildState(_ snapshot: FleetSnapshot) -> FleetActivityAttributes.ContentState {
        FleetActivityAttributes.ContentState(
            moodState: snapshot.moodState,
            moodLabel: snapshot.moodLabel,
            bots: snapshot.bots.prefix(4).map {
                MascotBotLine(name: $0.name, color: $0.color, state: $0.state, line: $0.line)
            }
        )
    }
}
