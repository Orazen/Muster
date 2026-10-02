// Approved GAIA presentation, resolved against the user's saved appearance.
// Keep semantic status colors and specialist identities separate from chrome.
import AppKit
import SwiftUI

enum MusterAppearance {
    static let accent = Color(red: 0, green: 112.0 / 255, blue: 224.0 / 255)
    static let canvas = adaptive(light: 0xffffff, dark: 0x111111)
    static let sidebar = adaptive(light: 0xfafafa, dark: 0x141414)
    static let panel = adaptive(light: 0xffffff, dark: 0x191919)
    static let raised = adaptive(light: 0xf3f3f3, dark: 0x242424)
    static let border = adaptive(light: 0xe6e6e6, dark: 0x2b2b2b)

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: Double((value >> 16) & 255) / 255,
                           green: Double((value >> 8) & 255) / 255,
                           blue: Double(value & 255) / 255, alpha: 1)
        })
    }
}
