// The bot's face on the wrist — the same authored flower the phone and the
// web draw, with motion.
//
// The watch used to show an 8-point coloured circle. A bot the owner knows as
// "the orange flower" was a dot here, which is the one thing a companion app
// must not do to identity. The body path, the eye anchors and the pose table
// all come from CompanionCore, so there is exactly one flower in the codebase.
//
// The motion is a pure function of time (FlowerMotion), sampled by a
// TimelineView at 12fps. That is deliberate over `repeatForever` animations:
// the phase is seedable per bot so a roster never blinks in lockstep, the
// behaviour is unit-tested in the core, and the rate is a parameter rather
// than a property of a keyframe.
import SwiftUI
import CompanionCore

struct WatchFlower: View {
    /// An `AGENT_COLORS` name from the roster.
    let color: String
    /// Any state string the web would pass — run through `flowerPoseFor`.
    var state: String = "idle"
    var size: CGFloat = 44
    /// Blink and float. Off renders the state's resting pose.
    var animated: Bool = true
    /// Body pulse while a reply is being read aloud.
    var speaking: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Parsed once for the whole app — a roster redraws on every scroll.
    private static let body: Path = buildBody()

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

    private var animating: Bool { animated && !reduceMotion }

    var body: some View {
        Group {
            if animating {
                // 12fps is enough for a blink and a float, and a fraction of
                // what a display link would cost on a watch.
                TimelineView(.animation(minimumInterval: 1.0 / 12.0)) { timeline in
                    canvas(at: timeline.date.timeIntervalSinceReferenceDate)
                }
            } else {
                canvas(at: 0)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func canvas(at time: Double) -> some View {
        let pose = flowerPoseFor(state)
        let seed = FlowerMotion.seed(for: "\(color)|\(state)")
        let blink = animating ? FlowerMotion.blinkScale(seed: seed, at: time) : 1
        let float = animating ? FlowerMotion.floatOffset(at: time) : 0
        let pulse = speaking ? FlowerMotion.speakingScale(at: time) : 1

        return Canvas { context, canvasSize in
            let scale = min(canvasSize.width, canvasSize.height) / 224
            let centre = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)

            var bodyContext = context
            bodyContext.translateBy(x: centre.x, y: centre.y)
            bodyContext.scaleBy(x: scale, y: scale)
            bodyContext.translateBy(x: 0, y: pose.bdy + float)

            // The speech pulse pivots at the chin, 78% down the box — the
            // same point the web's poke reaction uses, so a speaking flower
            // and a poked one move from the same hinge.
            if pulse != 1 {
                let pivot = 0.78 * 224 - 112
                bodyContext.translateBy(x: 0, y: pivot)
                bodyContext.scaleBy(x: pulse, y: pulse)
                bodyContext.translateBy(x: 0, y: -pivot)
            }

            bodyContext.fill(Self.body, with: .color(colorValue))

            for (index, eye) in FlowerArtwork.eyes.enumerated() {
                var eyeContext = bodyContext
                eyeContext.translateBy(x: eye.x, y: eye.y)
                eyeContext.rotate(by: .degrees(-4))

                let wrap: Double = index == 0 ? -1 : 1
                let sel: Double = index == 0 ? 0 : 1
                let dx = pose.edx * wrap
                let dy = pose.edy + pose.edy2 * sel
                let tilt = pose.tilt * wrap + pose.tilt2 * sel
                let sx = pose.esx * (1 + pose.esx2 * sel)
                let sy = pose.esy * (1 + pose.esy2 * sel)
                eyeContext.translateBy(x: dx, y: dy)
                eyeContext.rotate(by: .degrees(tilt))
                eyeContext.scaleBy(x: sx, y: sy * blink)

                let capsule = CGRect(x: -10.5, y: -22, width: 21, height: 44)
                eyeContext.fill(
                    Path(roundedRect: capsule, cornerRadius: 10.5),
                    with: .color(Color(hex: "#f9f9f9"))
                )
            }
        }
    }

    private var colorValue: Color {
        Color(hex: FlowerArtwork.agentColorHex(color))
    }
}