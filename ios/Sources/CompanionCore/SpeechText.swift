// What a reply sounds like when it is read aloud.
//
// The watch can speak an assistant message through AVSpeechSynthesizer, which
// is local, permission-free and needs no network. What it must not do is read
// the raw markdown: a voice reciting "asterisk asterisk important" or a wall
// of Swift is worse than silence, and the whole message usually does not need
// to be heard — the first few sentences carry it.
//
// Kept in the core rather than in the watch so the rules are testable without
// a screen or a speaker.
import Foundation

public enum SpeechText {
    /// The most a spoken reply may carry. Roughly thirty seconds of speech,
    /// which is already a long time to hold a wrist up.
    public static let maximumLength = 400

    /// Blocks that are never spoken. A fenced code block read aloud is the
    /// clearest category error available here, and a horizontal rule is
    /// punctuation with nothing on either side.
    private static func isSpeakable(_ block: MarkdownBlock) -> Bool {
        switch block {
        case .code, .rule: return false
        case .paragraph, .bullet, .ordered, .heading, .quote: return true
        }
    }

    /// The plain text of `block`, with list numbers and bullet markers gone —
    /// a voice saying "dash" before every line is noise.
    private static func plainText(_ block: MarkdownBlock) -> String? {
        switch block {
        case let .paragraph(text): return text
        case let .heading(_, text): return text
        case let .quote(text): return text
        case let .bullet(_, text): return text
        case let .ordered(_, _, text): return text
        case .code, .rule: return nil
        }
    }

    /// Turn markdown into something worth hearing, or nil when there is
    /// nothing to say.
    public static func spoken(_ source: String) -> String? {
        let joined = Markdown.blocks(source)
            .filter(isSpeakable)
            .compactMap(plainText)
            .joined(separator: ". ")

        let collapsed = joined
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        guard !collapsed.isEmpty else { return nil }
        return truncate(collapsed, to: maximumLength)
    }

    /// Cut at a word boundary so the last word is a word. Over the limit but
    /// with no space to cut on — one enormous token — takes the hard cut,
    /// because a partial word is still better than reading the whole thing.
    static func truncate(_ text: String, to limit: Int) -> String {
        guard text.count > limit else { return text }
        let head = text.prefix(limit)
        guard let boundary = head.lastIndex(of: " ") else { return String(head) }
        return String(head[head.startIndex..<boundary])
    }
}