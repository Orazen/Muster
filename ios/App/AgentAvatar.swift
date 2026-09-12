// The bot's identity kit — palette, the person's avatar, and hex colors.
//
// The bot's face itself now lives in FlowerAvatar.swift: the authored
// app-icon flower, the same default teammate body the web draws. The older
// cursor-mascot silhouette this file used to carry was retired when the
// flower became the canonical mark (git history keeps the path data).
import SwiftUI

enum AgentPalette {
    /// src/lib/mascot.ts — AGENT_COLORS
    static let agentHex: [String: String] = [
        "green": "#009957",
        "blue": "#377FE6",
        "red": "#D94B52",
        "orange": "#E78531",
        "purple": "#8057C8",
        "cyan": "#0EA5C6",
        "pink": "#D84F8B",
        "yellow": "#D8A729",
        "teal": "#01A492",
        "coral": "#E5634E",
    ]

    static func color(_ name: String) -> Color {
        Color(hex: agentHex[name] ?? "#8E8E93")
    }

}

/// The person, not a bot — the roster header and the settings row. A letter
/// rather than a mascot, deliberately: the mascots mean "this is a bot", and
/// giving the human one too would blur the only distinction the roster makes.
struct ProfileAvatar: View {
    let name: String
    var size: CGFloat = 34

    var body: some View {
        Circle()
            .fill(AgentPalette.color("green"))
            .frame(width: size, height: size)
            .overlay {
                Text(initial)
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(.white)
            }
    }

    private var initial: String {
        String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
    }
}

extension Color {
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&value)
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1
        )
    }
}
