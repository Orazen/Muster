// The mascot, drawn natively from the shared artwork.
//
// CompanionCore.FlowerArtwork publishes the body path as parsed path
// commands plus eye anchors and the agent palette — the same numbers every
// Muster client renders. This view is the Mac's: SwiftUI Path, no image
// assets, no copied artwork.

import CompanionCore
import SwiftUI

struct FlowerView: View {
    let colorName: String?
    let busy: Bool
    /// The authored -4° tilt, applied at the eye anchors like the phone.
    private let eyeTilt: Double = -4

    var body: some View {
        TimelineView(.animation(minimumInterval: busy ? 1.0 / 12.0 : nil)) { timeline in
            Canvas { context, size in
                let scale = min(size.width, size.height) / 240.0
                var body = context
                body.translateBy(x: size.width / 2, y: size.height / 2)
                body.scaleBy(x: scale, y: scale)
                // The artwork's viewBox is 200x200 centered on the origin.
                let petal = Path { path in
                    for command in FlowerArtwork.body {
                        switch command {
                        case let .move(x, y): path.move(to: CGPoint(x: x, y: y))
                        case let .curve(c1x, c1y, c2x, c2y, x, y):
                            path.addCurve(
                                to: CGPoint(x: x, y: y),
                                control1: CGPoint(x: c1x, y: c1y),
                                control2: CGPoint(x: c2x, y: c2y)
                            )
                        case .close: path.closeSubpath()
                        }
                    }
                }
                let tint = Color(hex: FlowerArtwork.agentColorHex(colorName ?? ""))
                body.fill(petal, with: .color(tint))
                body.stroke(petal, with: .color(tint.opacity(0.85)), lineWidth: 2)

                // Eyes: small discs at the anchors, tilted as authored.
                for eye in FlowerArtwork.eyes {
                    var eyeContext = body
                    eyeContext.translateBy(x: eye.x, y: eye.y)
                    eyeContext.rotate(by: .degrees(eyeTilt))
                    let disc = Path(ellipseIn: CGRect(x: -5, y: -7, width: 10, height: 14))
                    eyeContext.fill(disc, with: .color(.black.opacity(0.82)))
                }
            }
            .opacity(busy ? 1 : 0.94)
        }
        .accessibilityLabel("Muster Flower mascot")
    }
}

extension Color {
    /// CompanionCore publishes palette entries as authored hex strings so
    /// every client resolves the identical color.
    init(hex: String) {
        var value: UInt64 = 0
        let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        Scanner(string: cleaned).scanHexInt64(&value)
        self.init(
            red: Double((value >> 16) & 0xFF) / 255.0,
            green: Double((value >> 8) & 0xFF) / 255.0,
            blue: Double(value & 0xFF) / 255.0
        )
    }
}

#Preview {
    HStack(spacing: 20) {
        FlowerView(colorName: "blue", busy: false).frame(width: 80, height: 80)
        FlowerView(colorName: "purple", busy: true).frame(width: 80, height: 80)
        FlowerView(colorName: nil, busy: false).frame(width: 80, height: 80)
    }
    .padding()
}
