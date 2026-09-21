// MusterWatchComplication — the fleet's face on the watch face.
//
// WidgetKit complications render out-of-process from the watch app, so they
// read the FleetSnapshot the app publishes to the shared app-group store
// (FleetSnapshotStore) — the same store and freshness contract the phone's
// widget renders from. The complication never opens a socket; it is a
// renderer, the app is the source of truth. A snapshot older than the
// store's maxAge reads as offline: a stale "2 need you" on the watch face
// would send the wearer to a dead app.
//
// Families, and why: .accessoryCircular carries the flower alone (the
// glance answers "how is the fleet?"), .accessoryInline is the one-line
// text ("2 need you"), .accessoryCorner is the flower + curved label for
// the Infograph corners, and .accessoryRectangular is the richest — flower,
// mood label, and the one line that says which bot matters right now.
import WidgetKit
import SwiftUI
import CompanionCore

// MARK: - Timeline

struct FleetComplicationEntry: TimelineEntry {
    let date: Date
    let snapshot: FleetSnapshot?
}

struct FleetComplicationProvider: TimelineProvider {
    func placeholder(in context: Context) -> FleetComplicationEntry {
        FleetComplicationEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (FleetComplicationEntry) -> Void) {
        completion(FleetComplicationEntry(date: Date(), snapshot: FleetSnapshotStore.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<FleetComplicationEntry>) -> Void) {
        // The app republishes on every state change; the budget-friendly
        // fallback re-reads later so a drifted complication self-heals.
        let entry = FleetComplicationEntry(date: Date(), snapshot: FleetSnapshotStore.readFresh())
        let next = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date().addingTimeInterval(900)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

// MARK: - The flower, at complication scale

/// Same geometry as the phone widget's canvas (224-unit art space), small
/// enough to read at circular-complication size. The mood state picks the
/// pose; the flower keeps its brand color so it reads as Muster at a glance.
struct ComplicationFlower: View {
    let state: String
    var colorHex: String = FlowerArtwork.flowerFallbackHex

    var body: some View {
        let pose = flowerPoseFor(state)
        GeometryReader { geometry in
            let scale = geometry.size.width / 224
            ZStack {
                ForEach(Array(FlowerArtwork.eyes.enumerated()), id: \.offset) { index, eye in
                    ComplicationEyeShape(pose: pose, index: index)
                        .fill(Color.white)
                        .frame(width: 21 * scale, height: 44 * scale)
                        .position(x: (112 + eye.x) * scale, y: (112 + eye.y) * scale)
                }
                ComplicationFlowerBody()
                    .fill(Color(colorHex))
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .offset(y: pose.bdy * scale)
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

struct ComplicationFlowerBody: Shape {
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

struct ComplicationEyeShape: Shape {
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
        let wrap: Double = index == 0 ? -1 : 1
        let sx = pose.esx * (1 + pose.esx2 * Double(index))
        let sy = pose.esy * (1 + pose.esy2 * Double(index))
        let tilt = pose.tilt * wrap + pose.tilt2 * Double(index)
        return path
            .applying(
                CGAffineTransform(translationX: pose.edx * wrap * scale, y: (pose.edy + pose.edy2 * Double(index)) * scale)
                    .rotated(by: tilt * .pi / 180)
                    .scaledBy(x: sx, y: sy)
            )
    }
}

// MARK: - Views per family

struct FleetComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: FleetComplicationEntry

    var body: some View {
        // A missing snapshot is the placeholder — never a wrong answer.
        guard let snapshot = entry.snapshot ?? FleetSnapshotStore.readFresh() else {
            return AnyView(placeholderView)
        }
        return AnyView(content(snapshot))
    }

    @ViewBuilder
    private func content(_ snapshot: FleetSnapshot) -> some View {
        let focus = snapshot.bots.first(where: { !$0.line.isEmpty })
        switch family {
        case .accessoryCircular:
            ComplicationFlower(state: snapshot.moodState)
                .widgetLabel(focus?.line.isEmpty == false ? focus!.line : snapshot.moodLabel)
        case .accessoryInline:
            Text("\(snapshot.moodLabel)\(focus.map { " — \($0.line)" } ?? "")")
                .lineLimit(1)
        case .accessoryCorner:
            ComplicationFlower(state: snapshot.moodState)
                .widgetLabel(snapshot.moodLabel)
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    ComplicationFlower(state: snapshot.moodState)
                        .frame(width: 26, height: 26)
                    Text(snapshot.moodLabel)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                }
                if let focus {
                    Text(focus.line)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        default:
            ComplicationFlower(state: snapshot.moodState)
        }
    }

    private var placeholderView: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                ComplicationFlower(state: "idle")
                    .frame(width: 26, height: 26)
                Text("Muster")
                    .font(.system(size: 13, weight: .semibold))
            }
            Text("Open Muster to connect")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Widget

struct FleetComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.muster.fleet.watch", provider: FleetComplicationProvider()) { entry in
            FleetComplicationView(entry: entry)
        }
        .configurationDisplayName("Fleet mood")
        .description("Your fleet's face: how it's doing and who needs you.")
        .supportedFamilies([.accessoryCircular, .accessoryInline, .accessoryCorner, .accessoryRectangular])
    }
}

@main
struct MusterFleetComplicationBundle: WidgetBundle {
    var body: some Widget {
        FleetComplication()
    }
}
