// The bot's face — the app-icon flower, the same geometry the web draws,
// now animated.
//
// The pose table, the artwork and the motion functions live in
// CompanionCore (`FlowerMotion.swift`, `FlowerArtwork.swift`) so the phone
// and the watch share one expression table. What remains here is the
// drawing: the body, the two eye capsules, and the one piece of state logic
// that needs a `Bot`.
//
// The animation is the watch's, carried to the phone. `FlowerMotion`'s
// functions are pure functions of time, so a `TimelineView` at a low frame
// rate is enough: the blink and float are computed from the clock rather
// than driven by `repeatForever`, the phase is seedable per bot so a roster
// does not blink in lockstep, and Reduce Motion draws the same face at rest.
//
// Poses are truthful status only — busy reads as focused, unread as the same
// raised look the web's "notifying" maps to. A face never stands in for
// approval, uncertainty or completion text; those always arrive as words on
// the cards and in the transcript.
import SwiftUI
import CompanionCore

/// The flower, at whatever size the row needs.
///
/// `flowerState(for:)` used to live beside this view; it moved to
/// CompanionCore when the watch needed the same answer.
struct FlowerAvatar: View {
    /// An `AGENT_COLORS` name; an unknown name falls back to the brand
    /// orange, exactly as the web's FlowerBot does.
    let color: String
    var size: CGFloat = 52
    /// Any state string the web would pass — run through `flowerPoseFor`.
    var state: String = "idle"
    /// A stable per-instance identity, used only to phase the blink so two
    /// bots never close their eyes on the same frame. Pass the bot's id;
    /// when it is empty the colour stands in, which is a weaker phase but
    /// never wrong.
    var seed: String = ""
    /// Body pulse while this face is the one being read aloud. Driven by the
    /// speaker's published `VoiceActivity`, so the flower that moves is the
    /// flower being spoken about.
    var speaking: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Parsed once — a chat list is hundreds of avatars redrawn on scroll.
    private static let body: Path = buildBody()

    /// ≈12 fps. Fast enough that a blink reads as a blink, slow enough that
    /// a roster of faces is not a per-frame redraw.
    private static let frameInterval: Double = 1.0 / 12.0

    private static func buildBody() -> Path {
        var path = Path()
        for command in FlowerArtwork.body {
            switch command {
            case let .move(x, y):
                path.move(to: CGPoint(x: x, y: y))
            case let .curve(c1x, c1y, c2x, c2y, x, y):
                path.addCurve(
                    to: CGPoint(x: x, y: y),
                    control1: CGPoint(x: c1x, y: c1y),
                    control2: CGPoint(x: c2x, y: c2y)
                )
            case .close:
                path.closeSubpath()
            }
        }
        return path
    }

    /// FNV-1a phase from the bot's identity, so a roster desynchronises.
    private var phaseSeed: Double {
        FlowerMotion.seed(for: seed.isEmpty ? color : seed)
    }

    var body: some View {
        Group {
            if reduceMotion {
                face(at: 0)
            } else {
                TimelineView(.periodic(from: .now, by: Self.frameInterval)) { timeline in
                    face(at: timeline.date.timeIntervalSinceReferenceDate)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func face(at t: Double) -> some View {
        Canvas { context, canvasSize in
            // The web renders a square 224×224 viewBox centred on the origin.
            let scale = min(canvasSize.width, canvasSize.height) / 224
            let centre = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)

            let pose = flowerPoseFor(state)
            // Whole-body vertical offset: the pose's own `bdy`, plus the
            // float the web calls `flower-bot-float`.
            let float = reduceMotion ? 0 : FlowerMotion.floatOffset(at: t)
            // Eyelid Y scale: 1 outside a blink, down to 0.08 inside it.
            let blink = reduceMotion ? 1 : FlowerMotion.blinkScale(seed: phaseSeed, at: t)

            var bodyContext = context
            bodyContext.translateBy(x: centre.x, y: centre.y)
            bodyContext.scaleBy(x: scale, y: scale)
            bodyContext.translateBy(x: 0, y: pose.bdy + float)

            // The speech pulse pivots at the chin, 78% down the box — the
            // same hinge the watch and the web's poke reaction use.
            if speaking, !reduceMotion {
                let pulse = FlowerMotion.speakingScale(at: t)
                let pivot = 0.78 * 224 - 112
                bodyContext.translateBy(x: 0, y: pivot)
                bodyContext.scaleBy(x: pulse, y: pulse)
                bodyContext.translateBy(x: 0, y: -pivot)
            }

            bodyContext.fill(Self.body, with: .color(flowerColor))

            for (index, eye) in FlowerArtwork.eyes.enumerated() {
                // each eye: place it, then the artwork's authored -4° tilt
                var eyeContext = bodyContext
                eyeContext.translateBy(x: eye.x, y: eye.y)
                eyeContext.rotate(by: .degrees(-4))

                // then the pose channels, composed about the eye's own
                // centre — identical math to FlowerBot's eyeTransform
                let wrap: Double = index == 0 ? -1 : 1
                let sel: Double = index == 0 ? 0 : 1
                let dx = pose.edx * wrap
                let dy = pose.edy + pose.edy2 * sel
                let tilt = pose.tilt * wrap + pose.tilt2 * sel
                let sx = pose.esx * (1 + pose.esx2 * sel)
                // blink rides on the pose's own Y scale
                let sy = pose.esy * (1 + pose.esy2 * sel) * blink
                eyeContext.translateBy(x: dx, y: dy)
                eyeContext.rotate(by: .degrees(tilt))
                eyeContext.scaleBy(x: sx, y: sy)

                // the portrait capsule: x -10.5, y -22, 21×44, rx 10.5
                let capsule = CGRect(x: -10.5, y: -22, width: 21, height: 44)
                eyeContext.fill(
                    Path(roundedRect: capsule, cornerRadius: 10.5),
                    with: .color(Color(hex: "#f9f9f9"))
                )
            }
        }
    }

    private var flowerColor: Color {
        Color(hex: FlowerArtwork.agentColorHex(color))
    }
}