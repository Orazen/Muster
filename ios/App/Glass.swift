// The room's one floating-control language: every capsule, pill, and glyph
// button in the companion is the same glass, so the app reads as one object
// rather than a collection of buttons.
//
// Adapted from the OpenMausBot companion's Glass.swift
// (https://github.com/milind-soni/OpenMausBot, Apache-2.0 — full license
// text and attribution in public/third-party-notices.txt, shipped with the
// app), whose pattern this restates: native Liquid Glass on iOS 26, a
// material + hairline approximation below it. `import Glass` is a module
// reference, so the availability gate is a compile-time check, not a runtime
// branch.

import SwiftUI

extension View {
    /// The floating surface: native glass where the system has it, the
    /// closest honest approximation where it does not.
    @ViewBuilder func glassSurface<S: Shape>(in shape: S) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular.interactive(), in: shape)
        } else {
            self.background(.regularMaterial, in: shape)
                .overlay {
                    shape.fill(.clear)
                        .overlay {
                            shape.stroke(Color.primary.opacity(0.10), lineWidth: 0.5)
                        }
                }
        }
    }

    /// The header's search/profile pills.
    func glassCapsule() -> some View { glassSurface(in: Capsule()) }

    /// Sheets and cards: the same glass at the app's card radius.
    func glassSheet(cornerRadius: CGFloat = 28) -> some View {
        glassSurface(in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
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
