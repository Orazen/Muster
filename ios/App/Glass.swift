// Shared native chrome for the approved solid GAIA presentation.
// The helper names remain stable so existing controls retain their behavior.
// Original helper organization adapted from OpenMausBot (Apache-2.0);
// attribution is retained in public/third-party-notices.txt.
import SwiftUI
import UIKit

enum MusterPalette {
    static let accent = Color(red: 0, green: 112.0 / 255, blue: 224.0 / 255)
    static let canvas = adaptive(light: 0xffffff, dark: 0x111111)
    static let panel = adaptive(light: 0xfafafa, dark: 0x191919)
    static let raised = adaptive(light: 0xf3f3f3, dark: 0x242424)
    static let border = adaptive(light: 0xe6e6e6, dark: 0x2b2b2b)
    static let secondaryInk = adaptive(light: 0x626262, dark: 0xadadad)
    static let errorInk = adaptive(light: 0xb42318, dark: 0xffb4ab)

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: Double((value >> 16) & 255) / 255,
                           green: Double((value >> 8) & 255) / 255,
                           blue: Double(value & 255) / 255, alpha: 1)
        })
    }
}

extension View {
    /// A solid adaptive surface, without transparency or extra motion.
    func glassSurface<S: Shape>(in shape: S) -> some View {
        background(MusterPalette.panel, in: shape)
            .overlay { shape.stroke(MusterPalette.border, lineWidth: 1).allowsHitTesting(false) }
    }

    func glassCapsule() -> some View { glassSurface(in: Capsule()) }

    func glassSheet(cornerRadius: CGFloat = 16) -> some View {
        glassSurface(in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}

extension ToolbarContent {
    /// Our controls supply their own solid surface; hide the system's extra
    /// shared toolbar material on iOS 26 while keeping native toolbar behavior.
    @ToolbarContentBuilder func bareToolbarBackground() -> some ToolbarContent {
        if #available(iOS 26.0, *) {
            self.sharedBackgroundVisibility(.hidden)
        } else {
            self
        }
    }
}

/// A round floating glyph button — the toolbar's unit. 44pt is the touch
/// floor; the label carries the accessibility name, the glyph stays quiet.
struct GlassButton: View {
    let systemImage: String
    let label: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .medium))
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassSurface(in: Circle())
        .accessibilityLabel(label)
    }
}

/// Compatibility container for the existing control layout. Solid controls
/// retain independent hit targets rather than visually merging together.
struct GlassCluster<Content: View>: View {
    var spacing: CGFloat
    private let content: () -> Content

    init(spacing: CGFloat = 10, @ViewBuilder content: @escaping () -> Content) {
        self.spacing = spacing
        self.content = content
    }

    var body: some View {
        content()
    }
}
