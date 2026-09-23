// The composer's chip row, as data: one saved prompt per chip, with the
// label it wears and the glyph it carries — the pieces worth testing, kept
// away from SwiftUI so the editor and the composer read the same list.
//
// Adapted from the OpenMausBot companion's ChatPreferences.swift
// (https://github.com/milind-soni/OpenMausBot, Apache-2.0 — full license
// text and attribution in public/third-party-notices.txt, shipped with
// the app), which carries this model and its decode rules.
import Foundation

/// One chip on the composer's quick-reply row.
public struct QuickReply: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var prompt: String
    public var icon: String

    public init(id: String = UUID().uuidString, title: String, prompt: String, icon: String) {
        self.id = id
        self.title = title
        self.prompt = prompt
        self.icon = icon
    }

    /// Where the row's list lives, shared by the settings editor and the
    /// composer so both read and write the same storage.
    public static let storageKey = "companion.quickReplies"

    /// The four the composer shipped with, kept as the reset target.
    public static let defaults: [QuickReply] = [
        QuickReply(id: "default.diff", title: "Show diff", prompt: "Show latest git diff", icon: "arrow.triangle.pull"),
        QuickReply(id: "default.tests", title: "Run tests", prompt: "Run all automated tests", icon: "checkmark.seal"),
        QuickReply(id: "default.explain", title: "Explain steps", prompt: "Explain the changes in detail", icon: "text.bubble"),
        QuickReply(id: "default.next", title: "What's next?", prompt: "What should we do next?", icon: "sparkles"),
    ]

    /// Icons offered by the editor. Small on purpose: a full symbol browser
    /// is a different feature, and twelve covers what a chip is ever for.
    public static let iconChoices = [
        "sparkles", "arrow.triangle.pull", "checkmark.seal", "text.bubble",
        "hammer", "ladybug", "doc.text", "terminal",
        "paperplane", "magnifyingglass", "clock.arrow.circlepath", "list.bullet",
    ]

    public static func encode(_ replies: [QuickReply]) -> String {
        guard let data = try? JSONEncoder().encode(replies) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Anything unreadable becomes the defaults. An empty *string* is a
    /// store that has never been written; an empty *list* is a row the user
    /// deliberately cleared, and those must not mean the same thing.
    public static func decode(_ json: String) -> [QuickReply] {
        guard !json.isEmpty, let data = json.data(using: .utf8) else { return defaults }
        guard let decoded = try? JSONDecoder().decode([QuickReply].self, from: data) else { return defaults }
        let ids = decoded.map { $0.id.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard ids.allSatisfy({ !$0.isEmpty }), Set(ids).count == ids.count else { return defaults }
        return decoded
    }
}
