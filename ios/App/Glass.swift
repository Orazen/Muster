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

extension ToolbarContent {
    /// Drop the system's own Liquid Glass background from a toolbar item.
    ///
    /// On iOS 26 a toolbar item is given a shared glass background by the
    /// navigation bar. This app draws its own glass on the items it wants
    /// glass on, so leaving the system's in place stacks two of them — a
    /// muddy ring around a capsule that already has an edge. Hiding it
    /// leaves exactly one layer. Before iOS 26 there is no system
    /// background to hide, and the modifier does not exist.
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

/// A row of glass controls that should read as one object.
///
/// Adjacent Liquid Glass surfaces merge where they touch, and the merge is
/// what makes a cluster of buttons look like a single control rather than
/// several overlapping ones. That effect only happens inside a container
/// that knows the surfaces belong together, so this wraps them and drops
/// the wrapper where the API does not exist — before iOS 26 the controls
/// are simply siblings, which is what they already were.
struct GlassCluster<Content: View>: View {
    var spacing: CGFloat
    private let content: () -> Content

    init(spacing: CGFloat = 10, @ViewBuilder content: @escaping () -> Content) {
        self.spacing = spacing
        self.content = content
    }

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content() }
        } else {
            content()
        }
    }
}
