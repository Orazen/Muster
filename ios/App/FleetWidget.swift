// FleetWidget — the mascot on the home screen and the Lock Screen (plan
// slice E). The widget and the Live Activity both render the fleet snapshot
// the app publishes (FleetSnapshotStore); the widget refreshes on the app's
// timeline pushes plus the system's own budget. The flower itself is drawn
// from the same CompanionCore artwork the in-app avatar uses — one character,
// every surface.
import WidgetKit
import SwiftUI
import ActivityKit
import CompanionCore

// MARK: - Live Activity attributes

struct FleetActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable, Sendable {
        var moodState: String
        var moodLabel: String
        var bots: [MascotBotLine]
    }
    var fleetName: String
}

struct MascotBotLine: Codable, Hashable, Sendable {
    var name: String
    var color: String
    var state: String
    var line: String
}

// MARK: - Live Activity view

/// The Lock Screen face: the flower, the mood, and the narrated line — the
/// same truthfulness contract as every other mascot surface (face is never
/// the whole message; the line is always present while the activity is).
struct FleetActivityView: View {
    let context: ActivityViewContext<FleetActivityAttributes>

    var body: some View {
        HStack(spacing: 12) {
            SnapshotFlower(state: context.state.moodState, colorHex: FlowerArtwork.flowerFallbackHex)
            VStack(alignment: .leading, spacing: 2) {
                Text(context.state.moodLabel)
                    .font(.system(size: 15, weight: .semibold))
                if let focus = context.state.bots.first(where: { !$0.line.isEmpty }) {
                    Text(focus.line)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
    }
}

// MARK: - Timeline entry

struct FleetEntry: TimelineEntry {
    let date: Date
    let snapshot: FleetSnapshot?
}

// MARK: - Provider

struct FleetProvider: TimelineProvider {
    func placeholder(in context: Context) -> FleetEntry {
        FleetEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (FleetEntry) -> Void) {
        completion(FleetEntry(date: Date(), snapshot: FleetSnapshotStore.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<FleetEntry>) -> Void) {
        // The app republishes on every state change, which bumps the widget's
        // timeline; the fallback refresh keeps a drifted widget from sticking.
        let entry = FleetEntry(date: Date(), snapshot: FleetSnapshotStore.readFresh())
        let next = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date().addingTimeInterval(900)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

// MARK: - The flower, snapshot-driven

struct SnapshotFlower: View {
    let state: String
    let colorHex: String
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        let pose = flowerPoseFor(state)
        FlowerArtworkCanvas(pose: pose, colorHex: colorHex)
            .frame(width: 44, height: 44)
    }
}

/// The vector flower drawn from CompanionCore's parsed path — the same shape
/// the phone roster draws, at any widget size.
struct FlowerArtworkCanvas: View {
    let pose: FlowerPose
    let colorHex: String

    var body: some View {
        GeometryReader { geometry in
            let scale = geometry.size.width / 224
            ZStack {
                ForEach(Array(FlowerArtwork.eyes.enumerated()), id: \.offset) { index, eye in
                    EyeShape(pose: pose, index: index)
                        .fill(Color("#f9f9f9"))
                        .frame(width: 21 * scale, height: 44 * scale)
                        .position(
                            x: (112 + eye.x) * scale,
                            y: (112 + eye.y) * scale
                        )
                }
                FlowerBodyShape()
                    .fill(colorHex.isEmpty ? Color(FlowerArtwork.flowerFallbackHex) : Color(colorHex))
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .offset(y: (pose.bdy) * scale)
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

struct FlowerBodyShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let scale = min(rect.width, rect.height) / 224
        for command in FlowerArtwork.body {
            switch command {
            case let .move(x, y):
                path.move(to: CGPoint(x: (112 + x) * scale, y: (112 + y) * scale))
            case let .curve(c1x, c1y, c2x, c2y, x, y):
                path.addCurve(
                    to: CGPoint(x: (112 + x) * scale, y: (112 + y) * scale),
                    control1: CGPoint(x: (112 + c1x) * scale, y: (112 + c1y) * scale),
                    control2: CGPoint(x: (112 + c2x) * scale, y: (112 + c2y) * scale)
                )
            case .close:
                path.closeSubpath()
            }
        }
        return path
    }
}

struct EyeShape: Shape {
    let pose: FlowerPose
    let index: Int

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 44
        var path = Path()
        let radius = 10.5 * scale
        path.addRoundedRect(
            in: CGRect(x: rect.midX - radius, y: rect.minY, width: radius * 2, height: rect.height),
            cornerSize: CGSize(width: radius, height: radius)
        )
        // The pose channels: per-eye scale and tilt, mirrored by index like
        // the web's eyeTransform.
        let wrap: Double = index == 0 ? -1 : 1
        let sx = (pose.esx) * (1 + (pose.esx2) * Double(index))
        let sy = (pose.esy) * (1 + (pose.esy2) * Double(index))
        let tilt = (pose.tilt) * wrap + (pose.tilt2) * Double(index)
        return path
            .applying(
                CGAffineTransform(translationX: (pose.edx) * wrap * scale, y: (pose.edy + pose.edy2 * Double(index)) * scale)
                    .rotated(by: tilt * .pi / 180)
                    .scaledBy(x: sx, y: sy)
            )
    }
}

// MARK: - Widget views

struct FleetWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: FleetEntry

    var body: some View {
        if let snapshot = entry.snapshot {
            content(snapshot)
        } else {
            placeholder
        }
    }

    private func content(_ snapshot: FleetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                SnapshotFlower(state: snapshot.moodState, colorHex: FlowerArtwork.flowerFallbackHex)
                VStack(alignment: .leading, spacing: 2) {
                    Text(snapshot.moodLabel)
                        .font(.system(size: 13, weight: .semibold))
                    if let focus = snapshot.bots.first(where: { !$0.line.isEmpty }) {
                        Text(focus.line)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            if family == .systemMedium {
                // The medium tile shows more of the team: up to three lines.
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(snapshot.bots.prefix(3), id: \.id) { bot in
                        if !bot.line.isEmpty {
                            HStack(spacing: 6) {
                                Circle().fill(Color(FlowerArtwork.agentColorHex(bot.color))).frame(width: 5, height: 5)
                                Text(bot.line).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
    }

    private var placeholder: some View {
        VStack(spacing: 6) {
            SnapshotFlower(state: "idle", colorHex: FlowerArtwork.flowerFallbackHex)
            Text("Open Muster").font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .padding(12)
    }
}

struct FleetWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.muster.fleet", provider: FleetProvider()) { entry in
            FleetWidgetView(entry: entry)
        }
        .configurationDisplayName("Muster mascot")
        .description("Your fleet's mascot and who needs you.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Entry point

// A WidgetKit extension must ship a @main entry. Without it the Swift
// compiler emits no __swift5_entry section in the appex binary and App
// Store validation rejects the build with error 90896 ("__swift5_entry
// section is missing") — the failure that stopped the first TestFlight
// upload. This file compiles into BOTH the app (sources: App) and the
// widget extension, so the bundle is guarded by the widget-only
// compilation condition set in project.yml; the app module keeps its
// own @main in CompanionApp.swift. The bundle also gives the future
// Live Activity a place to register beside the widget.
#if WIDGET_EXTENSION
/// The Lock Screen Live Activity, wrapped as a Widget so the bundle builder
/// accepts it (ActivityConfiguration is a WidgetConfiguration, not a Widget).
struct FleetLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: FleetActivityAttributes.self) { context in
            // Lock Screen presentation.
            FleetActivityView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    SnapshotFlower(state: context.state.moodState, colorHex: FlowerArtwork.flowerFallbackHex)
                        .frame(width: 36, height: 36)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.moodLabel)
                        .font(.system(size: 13, weight: .semibold))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let focus = context.state.bots.first(where: { !$0.line.isEmpty }) {
                        Text(focus.line)
                            .font(.system(size: 12))
                            .lineLimit(1)
                    }
                }
            } compactLeading: {
                SnapshotFlower(state: context.state.moodState, colorHex: FlowerArtwork.flowerFallbackHex)
                    .frame(width: 18, height: 18)
            } compactTrailing: {
                Text(context.state.moodLabel)
                    .font(.system(size: 11, weight: .semibold))
                    .frame(maxWidth: 44)
            } minimal: {
                SnapshotFlower(state: context.state.moodState, colorHex: FlowerArtwork.flowerFallbackHex)
                    .frame(width: 18, height: 18)
            }
        }
    }
}

@main
struct MusterFleetWidgetBundle: WidgetBundle {
    var body: some Widget {
        FleetWidget()
        // The Lock Screen Live Activity shares this extension and the same
        // FleetSnapshotStore source — one publisher, two surfaces.
        FleetLiveActivity()
    }
}
#endif

